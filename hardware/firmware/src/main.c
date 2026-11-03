// 参谋电报机 E0.1：USB 双向声卡 + CDC 控制
#include <assert.h>
#include <math.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/semphr.h"
#include "freertos/stream_buffer.h"
#include "driver/gpio.h"
#include "driver/i2s_std.h"
#include "esp_err.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "esp_rom_sys.h"
#include "esp_mac.h"
#include "soc/rtc_cntl_reg.h"
#include "soc/system_reg.h"
#include "soc/usb_serial_jtag_reg.h"
#include "tusb.h"
#include "usb_device_uac.h"
#include "prompt_pcm.h"

// 两块板子同一份代码，编译时选角色（platformio.ini 的 env:base / env:handset）：
// 主箱 = 拨打 D0、挂断 D1、功放；手柄 = 麦克风、PTT（D0 或 D2，另一脚接 GND 或 3V3 都认）。D6/D7 是两板之间的串口线，不碰
#define ROLE_BASE 1
#define ROLE_HANDSET 2
#ifndef TELEGRAPH_ROLE
#define TELEGRAPH_ROLE ROLE_BASE
#endif
#if TELEGRAPH_ROLE == ROLE_HANDSET
#define ROLE_NAME "handset"
#define USB_PRODUCT "参谋电报机 手柄"
#else
#define ROLE_NAME "base"
#define USB_PRODUCT "参谋电报机 主箱"
#endif
extern const char *g_usb_product, *g_usb_serial;

#define MIC_SD_GPIO 7
#define MIC_SCK_GPIO 8
#define MIC_WS_GPIO 9
#define SD_CARD_CS_GPIO 21
#define SAMPLE_RATE CONFIG_UAC_SAMPLE_RATE
#define FRAME_SAMPLES (SAMPLE_RATE / 100)
#define MIC_RATE 16000                     // INMP441 实际采样率（见 capture_task 的说明）
#define MIC_FRAME (MIC_RATE / 100)
#define GAIN_DB 18.0f

static i2s_chan_handle_t s_rx, s_tx;
static StreamBufferHandle_t s_sb, s_spk_sb;
static SemaphoreHandle_t s_log_lock;
static portMUX_TYPE s_state_lock = portMUX_INITIALIZER_UNLOCKED;
static volatile float s_level_db = -120;
static volatile uint32_t s_spikes;          // 去掉了几个读错位的突刺
static volatile uint32_t s_sessions, s_underruns, s_stream_bytes, s_spk_underruns;
static volatile uint32_t s_btn_loops;     // 按键任务转了几圈：确认它活着
static bool s_go_download, s_hello_pending, s_prompt_pending;
static int64_t s_ping_us, s_spk_us, s_prompt_us, s_mount_us;
static bool s_seen_ping, s_initial_done;

// CDC 缓冲不足或串口未打开就丢弃，绝不等待电脑。
static volatile uint32_t s_cdc_dropped;   // 实在发不出去丢掉的行（INFO 里报）
static void cdc_line(const char *fmt, ...)
{
    if(!tud_cdc_connected()) return;
    // 别的任务正在写就等一下（最多 50 ms），不要直接丢——按键消息丢了，软件就没反应
    if(xSemaphoreTake(s_log_lock, pdMS_TO_TICKS(50)) != pdTRUE) { s_cdc_dropped++; return; }
    char line[256];
    va_list ap;
    va_start(ap, fmt);
    int n = vsnprintf(line, sizeof(line) - 1, fmt, ap);
    va_end(ap);
    if(n >= 0) {
        if(n > sizeof(line) - 2) n = sizeof(line) - 2;
        line[n++] = '\n';
        // 发送缓冲满了就先推一下、等它腾出地方（最多 50 ms）
        for(int t = 0; t < 50 && tud_cdc_write_available() < n; t++) { tud_cdc_write_flush(); vTaskDelay(1); }
        if(tud_cdc_write_available() >= n) {
            tud_cdc_write(line, n);
            tud_cdc_write_flush();
        } else s_cdc_dropped++;
    }
    xSemaphoreGive(s_log_lock);
}

static bool online_locked(int64_t now)
{
    return s_seen_ping && now - s_ping_us < 3000000;
}

static void request_prompt(bool automatic)
{
    int64_t now = esp_timer_get_time();
    portENTER_CRITICAL(&s_state_lock);
    if((!s_spk_us || now - s_spk_us >= 100000) &&
       (!automatic || (!online_locked(now) && (!s_prompt_us || now - s_prompt_us >= 10000000)))) {
        s_prompt_pending = true;
    }
    portEXIT_CRITICAL(&s_state_lock);
}

static void mic_i2s_init(void)
{
    i2s_chan_config_t chan_cfg = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_0, I2S_ROLE_MASTER);
    chan_cfg.dma_desc_num = 6;
    chan_cfg.dma_frame_num = MIC_FRAME;
    ESP_ERROR_CHECK(i2s_new_channel(&chan_cfg, NULL, &s_rx));

    i2s_std_config_t std_cfg = {
        .clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(MIC_RATE),
        .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_32BIT, I2S_SLOT_MODE_MONO),
        .gpio_cfg = {
            .mclk = I2S_GPIO_UNUSED,
            .bclk = MIC_SCK_GPIO,
            .ws = MIC_WS_GPIO,
            .dout = I2S_GPIO_UNUSED,
            .din = MIC_SD_GPIO,
        },
    };
    std_cfg.slot_cfg.slot_mask = I2S_STD_SLOT_LEFT;
    // 实测（inmp441-serial-rec 关卡抓原始比特）：这块板读 INMP441 必须 MSB 对齐（bit_shift=false），
    // 标准 Philips 读法会晚一位、丢掉符号位，声音里出现满幅爆音。
    std_cfg.slot_cfg.bit_shift = false;
    ESP_ERROR_CHECK(i2s_channel_init_std_mode(s_rx, &std_cfg));
    ESP_ERROR_CHECK(i2s_channel_enable(s_rx));
}

// 麦克风实际按 16 kHz 采：时钟 1.024 MHz（48 kHz 时是 3.072 MHz）。杜邦线上 3 MHz 的时钟会偶尔读错一位，
// 实测每秒约 5 个幅度 ±4096 的“咔哒”突刺；降到三分之一，读数据的时间余量大三倍。人声在 8 kHz 以下，够用。
// 读进来先去突刺、去直流、放大，再用 48 阶低通插值升到 48 kHz 交给 USB 声卡。
#define UP (SAMPLE_RATE / MIC_RATE)
#define FIR_TAPS 48
static float s_fir[FIR_TAPS];

static void fir_init(void)
{
    const float fc = 7200.0f / SAMPLE_RATE;            // 截止 7.2 kHz，挡住插值产生的镜像
    float sum = 0;
    for(int k = 0; k < FIR_TAPS; k++) {
        float t = k - (FIR_TAPS - 1) / 2.0f;
        float sinc = 2 * fc * (t == 0 ? 1.0f : sinf(2 * (float)M_PI * fc * t) / (2 * (float)M_PI * fc * t));
        float w = 0.5f - 0.5f * cosf(2 * (float)M_PI * k / (FIR_TAPS - 1));   // Hann 窗
        s_fir[k] = sinc * w;
        sum += s_fir[k];
    }
    for(int k = 0; k < FIR_TAPS; k++) s_fir[k] *= UP / sum;   // 插了零，补回 UP 倍
}

// 不管电脑在不在录音，都一直读 INMP441 → 去突刺 → 去直流 → 放大 → 升到 48 kHz，塞进 s_sb。
// 麦克风从不停时钟，所以第二次、第三次录音和第一次完全一样，不会出现“重新上电还没稳定”的全 0。
static void capture_task(void *arg)
{
    static int32_t raw[MIC_FRAME];
    static float up[FIR_TAPS - 1 + FRAME_SAMPLES];       // 前面留着上一块的尾巴
    static int16_t pcm[FRAME_SAMPLES];
    const float a = expf(-2.0f * (float)M_PI * 80.0f / MIC_RATE);   // 一阶高通 80 Hz：INMP441 有很大的直流和低频漂移
    const float g = powf(10.0f, GAIN_DB / 20.0f) / 256.0f;          // 24 位 → 16 位，再放大 GAIN_DB
    const float spike = 2000.0f / g;                                 // 换算到 24 位刻度：输出里突然跳 2000 以上算突刺
    float x1 = 0, y1 = 0, p2 = 0, p1 = 0;                            // p2、p1：前两个原始样本（去突刺要看前后）
    bool first = true;
    double acc = 0;
    uint32_t accn = 0;
    fir_init();
    memset(up, 0, sizeof(up));

    while(1) {
        size_t n = 0;
        if(i2s_channel_read(s_rx, raw, sizeof(raw), &n, pdMS_TO_TICKS(100)) != ESP_OK || n == 0) continue;
        int cnt = (int)(n / 4);
        if(cnt > MIC_FRAME) cnt = MIC_FRAME;
        memmove(up, up + cnt * UP, (FIR_TAPS - 1) * sizeof(float));
        float *dst = up + FIR_TAPS - 1;
        for(int i = 0; i < cnt; i++) {
            float c = (float)(raw[i] >> 8);                  // 24 位数据在 bit31~bit8
            if(first) { p2 = p1 = x1 = c; first = false; }
            // 去突刺（晚一个样本处理）：中间那个比前后都突出很多、而前后彼此接近 → 是读错的位，用前后平均补上
            float m = (p2 + c) / 2;
            float b = p1;
            if(fabsf(b - m) > spike && fabsf(p2 - c) < spike / 4) { b = m; s_spikes++; }
            p2 = p1; p1 = c;
            float y = b - x1 + a * y1;                        // 高通
            x1 = b;
            y1 = y;
            dst[i * UP] = y * g;
            for(int k = 1; k < UP; k++) dst[i * UP + k] = 0;  // 插零，再交给低通
        }
        int outn = cnt * UP;
        for(int j = 0; j < outn; j++) {
            float v = 0;
            const float *u = up + j + FIR_TAPS - 1;
            for(int k = 0; k < FIR_TAPS; k++) v += s_fir[k] * u[-k];
            if(v > 32767.0f) v = 32767.0f;
            else if(v < -32768.0f) v = -32768.0f;
            pcm[j] = (int16_t)v;
            acc += (double)v * v;
        }
        accn += outn;
        // 电脑没在取数据时缓冲会满，满了就不再塞；下一次开始录音时会先把旧数据清掉
        xStreamBufferSend(s_sb, pcm, outn * sizeof(int16_t), 0);

        if(accn >= SAMPLE_RATE) {
            double ms = acc / accn;
            s_level_db = ms > 0 ? (float)(10.0 * log10(ms / (32768.0 * 32768.0))) : -120.0f;
            acc = 0;
            accn = 0;
        }
    }
}

// USB 麦克风每 10 ms 来要一次数据
static esp_err_t mic_read_cb(uint8_t *buf, size_t len, size_t *bytes_read, void *ctx)
{
    static int64_t last_us;
    static uint8_t junk[512];
    int64_t now = esp_timer_get_time();

    // 隔了一阵才又来要 = 新的一次录音：先把攒着的旧声音全部丢掉，保证给的是“现在”的声音
    if(now - last_us > 60000) {
        while(xStreamBufferReceive(s_sb, junk, sizeof(junk), 0) > 0) {}
        s_sessions++;

    }
    last_us = now;

    size_t got = 0;
    int64_t deadline = now + 25000;
    while(got < len) {
        int64_t left = deadline - esp_timer_get_time();
        if(left <= 0) break;
        got += xStreamBufferReceive(s_sb, buf + got, len - got, pdMS_TO_TICKS(left / 1000 + 1));
    }
    if(got < len) {                                   // 极少发生：补静音并记一次
        memset(buf + got, 0, len - got);
        s_underruns++;
    }
    s_stream_bytes += len;
    *bytes_read = len;
    return ESP_OK;
}

// 功放始终运行：USB 单声道或提示音复制到左右两个 Philips 槽。
static void speaker_init(void)
{
    i2s_chan_config_t cfg = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_1, I2S_ROLE_MASTER);
    cfg.dma_desc_num = 6;
    cfg.dma_frame_num = 48;
    ESP_ERROR_CHECK(i2s_new_channel(&cfg, &s_tx, NULL));
    i2s_std_config_t std = {
        .clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(SAMPLE_RATE),
        .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_STEREO),
        .gpio_cfg = {.mclk = I2S_GPIO_UNUSED, .bclk = 4, .ws = 5, .dout = 6, .din = I2S_GPIO_UNUSED},
    };
    ESP_ERROR_CHECK(i2s_channel_init_std_mode(s_tx, &std));
    ESP_ERROR_CHECK(i2s_channel_enable(s_tx));
}

static esp_err_t speaker_cb(uint8_t *buf, size_t len, void *ctx)
{
    // 电脑把声卡选成输出后会一直送全 0：只有真有声音才算“电脑在放”，否则提示音永远放不出来
    const int16_t *s = (const int16_t *)buf;
    bool loud = false;
    for(size_t i = 0; i < len / 2; i++) if(s[i] > 64 || s[i] < -64) { loud = true; break; }
    if(loud) {
        portENTER_CRITICAL(&s_state_lock);
        s_spk_us = esp_timer_get_time();
        s_prompt_pending = false;
        portEXIT_CRITICAL(&s_state_lock);
    }
    // 有限等待让反馈 FIFO 的消耗速率跟随 I2S 时钟。
    if(xStreamBufferSend(s_spk_sb, buf, len, pdMS_TO_TICKS(20)) != len) s_spk_underruns++;
    return ESP_OK;
}

static void speaker_task(void *arg)
{
    int16_t mono[48], stereo[96];
    size_t prompt_pos = 0;
    bool playing = false, was_host = false;
    while(1) {
        int64_t now = esp_timer_get_time();
        portENTER_CRITICAL(&s_state_lock);
        bool host = s_spk_us && now - s_spk_us < 100000;
        if(host) playing = false;
        if(s_prompt_pending && !host) {
            s_prompt_pending = false;
            s_prompt_us = now;
            prompt_pos = 0;
            playing = true;
        }
        portEXIT_CRITICAL(&s_state_lock);
        memset(mono, 0, sizeof(mono));
        size_t got = xStreamBufferReceive(s_spk_sb, mono, sizeof(mono), 0);
        if(playing && !host) { memset(mono, 0, sizeof(mono)); got = 0; }   // 放提示音时电脑送来的是静音，丢掉
        if(host && was_host && got < sizeof(mono)) s_spk_underruns++;
        was_host = host;
        for(size_t i = 0; i < 48; i++) {
            if(playing && !got) {
                // 16 → 48 kHz，线性插值，每个源采样扩成三个输出采样。
                size_t j = prompt_pos / 3;
                if(j < PROMPT_PCM_LEN) {
                    int32_t a = PROMPT_PCM[j];
                    int32_t b = j + 1 < PROMPT_PCM_LEN ? PROMPT_PCM[j + 1] : 0;
                    mono[i] = a + (b - a) * (prompt_pos % 3) / 3;
                    prompt_pos++;
                } else playing = false;
            }
            stereo[2*i] = stereo[2*i+1] = mono[i];
        }
        size_t sent = 0;
        while(sent < sizeof(stereo)) {
            size_t n = 0;
            esp_err_t err = i2s_channel_write(s_tx, (uint8_t *)stereo + sent, sizeof(stereo) - sent, &n, 100);
            sent += n;
            if(err != ESP_OK) { s_spk_underruns++; vTaskDelay(1); break; }   // 出错也让一下 CPU，别空转饿死别的任务
        }
    }
}

// 按键接法各不相同：有的另一脚接 GND，有的接 3V3（用户的载板上还有下拉电阻，没按时是低、按下是高），一律自动认。
// 每次轮流开上拉、下拉各读一次，分成三种状态：被拉到低（00）、被拉到高（11）、悬空（10）。
// 开机时记下每个脚“没按时”的状态；之后变成另一种“被拉住”的状态就算按下（悬空的脚：变成 00 或 11 都算）。
enum { PIN_LOW = 0, PIN_ODD = 1, PIN_FLOAT = 2, PIN_HIGH = 3 };
static int pin_class(int pin)
{
    gpio_set_pull_mode(pin, GPIO_PULLUP_ONLY);
    esp_rom_delay_us(30);
    int up = gpio_get_level(pin);
    gpio_set_pull_mode(pin, GPIO_PULLDOWN_ONLY);
    esp_rom_delay_us(30);
    int down = gpio_get_level(pin);
    gpio_set_pull_mode(pin, GPIO_PULLUP_ONLY);
    return up * 2 + down;
}

static bool is_pressed(int idle, int now)
{
    if(now == idle) return false;
    if(idle == PIN_FLOAT || idle == PIN_ODD) return now == PIN_LOW || now == PIN_HIGH;
    return now == (idle == PIN_LOW ? PIN_HIGH : PIN_LOW);
}

typedef struct { int gpio; const char *name; } key_def_t;
#if TELEGRAPH_ROLE == ROLE_HANDSET
// 手柄（2026-10-06 拆线后的接法）：B1=D0 说话（点一下 = 发送），D1、D2 上的键都算删除
static const key_def_t KEYS[] = {{1, "PTT"}, {2, "DEL"}, {3, "DEL"}};
#else
// 主箱（2026-10-06 实测）：拨打键（载板 B3）的线在 D1，挂断在 D0；D2 空着，接上也算挂断
static const key_def_t KEYS[] = {{1, "HANG"}, {2, "DIAL"}, {3, "HANG"}};
#endif
#define NKEYS (sizeof(KEYS) / sizeof(KEYS[0]))
static uint32_t s_key_count[NKEYS];
static int s_key_idle[NKEYS];        // 每个键“没按时”的状态（INFO 里报，排查接线用）

static void button_task(void *arg)
{
    int idle[NKEYS], last[NKEYS];
    int64_t since[NKEYS], changed[NKEYS] = {0};
    bool raw[NKEYS] = {false}, stable[NKEYS] = {false};
    // 开机时（假定没按）连读 20 次，多数是什么就当“没按时”的状态
    for(int i = 0; i < NKEYS; i++) {
        int votes[4] = {0};
        for(int k = 0; k < 20; k++) { votes[pin_class(KEYS[i].gpio)]++; vTaskDelay(1); }
        idle[i] = 0;
        for(int c = 1; c < 4; c++) if(votes[c] > votes[idle[i]]) idle[i] = c;
        last[i] = idle[i];
        since[i] = esp_timer_get_time();
    }
    while(1) {
        int64_t now = esp_timer_get_time();
        for(int i = 0; i < NKEYS; i++) {
            int c = pin_class(KEYS[i].gpio);
            if(c != last[i]) { last[i] = c; since[i] = now; }
            // 同一个“按下”状态连续 60 秒：多半是开机时就按着或接线变了，改认它为“没按”
            if(c != idle[i] && now - since[i] > 60000000) idle[i] = c;
            s_key_idle[i] = idle[i];
            bool down = is_pressed(idle[i], c);
            if(down != raw[i]) { raw[i] = down; changed[i] = now; }
            if(raw[i] != stable[i] && now - changed[i] >= 25000) {
                stable[i] = raw[i];
                cdc_line("BTN %s %s", KEYS[i].name, stable[i] ? "DOWN" : "UP");
                if(stable[i]) { s_key_count[i]++; request_prompt(true); }
            }
        }
        s_btn_loops++;
        vTaskDelay(pdMS_TO_TICKS(2));
    }
}

// 排查接线用：报 D0/D1/D2/D6/D7 在上拉、下拉时各读到什么（两次都是 0 = 被按键接到 GND，两次都是 1 = 接到 3V3）
static void report_pins(void)
{
    static const int gp[] = {1, 2, 3, 43, 44};
    static const int dn[] = {0, 1, 2, 6, 7};
    char buf[96];
    int n = 0;
    for(int i = 0; i < 5; i++) {
        gpio_set_direction(gp[i], GPIO_MODE_INPUT);
        gpio_set_pull_mode(gp[i], GPIO_PULLUP_ONLY);
        esp_rom_delay_us(50);
        int up = gpio_get_level(gp[i]);
        gpio_set_pull_mode(gp[i], GPIO_PULLDOWN_ONLY);
        esp_rom_delay_us(50);
        int down = gpio_get_level(gp[i]);
        gpio_set_pull_mode(gp[i], gp[i] >= 43 ? GPIO_FLOATING : GPIO_PULLUP_ONLY);   // D6/D7 是两板之间的线，放回悬空
        n += snprintf(buf + n, sizeof(buf) - n, " D%d=%d%d", dn[i], up, down);
    }
    cdc_line("# pins%s loops=%lu", buf, (unsigned long)s_btn_loops);
}

// 从“电报机”（USB-OTG）完整切回芯片自带的下载口（USB 串口/JTAG），再重启进下载模式。
// 只改 PHY 选择、不关 OTG、不开下载口的上拉，会卡在半路（实测板子死机、USB 不断开）；这里照 Arduino 的 usb_switch_to_cdc_jtag 做全套
static void enter_download(void)
{
    // 先从 USB 上“拔出”一会儿：不然切换时 D+ 一直被拉着，电脑察觉不到换了设备，
    // 下载口出现了也不去认（实测：板子已在下载模式，电脑还挂着旧的“参谋电报机”）
    tud_disconnect();
    vTaskDelay(pdMS_TO_TICKS(300));
    SET_PERI_REG_MASK(SYSTEM_PERIP_RST_EN0_REG, SYSTEM_USB_RST);          // 关掉 USB-OTG：保持复位、关时钟
    CLEAR_PERI_REG_MASK(SYSTEM_PERIP_CLK_EN0_REG, SYSTEM_USB_CLK_EN);
    CLEAR_PERI_REG_MASK(RTC_CNTL_USB_CONF_REG,                              // PHY 交还给 USB 串口/JTAG
        RTC_CNTL_SW_HW_USB_PHY_SEL | RTC_CNTL_SW_USB_PHY_SEL | RTC_CNTL_USB_PAD_ENABLE);
    CLEAR_PERI_REG_MASK(USB_SERIAL_JTAG_CONF0_REG, USB_SERIAL_JTAG_PHY_SEL);
    CLEAR_PERI_REG_MASK(USB_SERIAL_JTAG_CONF0_REG, USB_SERIAL_JTAG_PAD_PULL_OVERRIDE |
        USB_SERIAL_JTAG_DP_PULLUP | USB_SERIAL_JTAG_DP_PULLDOWN | USB_SERIAL_JTAG_DM_PULLUP | USB_SERIAL_JTAG_DM_PULLDOWN);
    SET_PERI_REG_MASK(USB_SERIAL_JTAG_CONF0_REG, USB_SERIAL_JTAG_USB_PAD_ENABLE);
    SET_PERI_REG_MASK(USB_SERIAL_JTAG_CONF0_REG, USB_SERIAL_JTAG_DP_PULLUP); // 下载口自己的 D+ 上拉：电脑这时才看到“插入”
    SET_PERI_REG_MASK(SYSTEM_PERIP_CLK_EN1_REG, SYSTEM_USB_DEVICE_CLK_EN);  // 打开下载口
    CLEAR_PERI_REG_MASK(SYSTEM_PERIP_RST_EN1_REG, SYSTEM_USB_DEVICE_RST);
    REG_WRITE(RTC_CNTL_OPTION1_REG, RTC_CNTL_FORCE_DOWNLOAD_BOOT);
    esp_restart();
}

// 保留已验证的 esptool DTR/RTS 下载序列。
void tud_cdc_line_state_cb(uint8_t itf, bool dtr, bool rts)
{
    static int64_t rts_only_us;
    static bool last_dtr;
    int64_t now = esp_timer_get_time();
    portENTER_CRITICAL(&s_state_lock);
    if(dtr && !last_dtr) s_hello_pending = true;
    last_dtr = dtr;
    if(!dtr && rts) rts_only_us = now;
    else if(dtr && !rts) {
        if(rts_only_us && now - rts_only_us < 1000000) s_go_download = true;
        rts_only_us = 0;
    }
    portEXIT_CRITICAL(&s_state_lock);
}

void tud_cdc_line_coding_cb(uint8_t itf, cdc_line_coding_t const *coding)
{
    if(coding->bit_rate == 1200) {
        portENTER_CRITICAL(&s_state_lock);
        s_go_download = true;
        portEXIT_CRITICAL(&s_state_lock);
    }
}

static void command(const char *line)
{
    if(!strcmp(line, "HELLO")) cdc_line("HELLO fw=2 name=参谋电报机 role=" ROLE_NAME);
    else if(!strcmp(line, "PING")) {
        portENTER_CRITICAL(&s_state_lock);
        s_ping_us = esp_timer_get_time();
        s_seen_ping = true;
        portEXIT_CRITICAL(&s_state_lock);
    } else if(!strcmp(line, "PROMPT")) request_prompt(false);
    else if(!strcmp(line, "PINS")) report_pins();
    else if(!strcmp(line, "BOOT")) {
        portENTER_CRITICAL(&s_state_lock);
        s_go_download = true;
        portEXIT_CRITICAL(&s_state_lock);
    } else if(!strcmp(line, "INFO")) {
        portENTER_CRITICAL(&s_state_lock);
        bool online = online_locked(esp_timer_get_time());
        portEXIT_CRITICAL(&s_state_lock);
        cdc_line("# mic level=%.1f dBFS spikes=%lu underruns=%lu sessions=%lu bytes=%lu", s_level_db, (unsigned long)s_spikes,
                 (unsigned long)s_underruns, (unsigned long)s_sessions, (unsigned long)s_stream_bytes);
        cdc_line("# speaker underruns=%lu cdc_dropped=%lu", (unsigned long)s_spk_underruns, (unsigned long)s_cdc_dropped);
        cdc_line("# idle %s=%d %s=%d %s=%d（0 平时低 / 2 悬空 / 3 平时高）", KEYS[0].name, s_key_idle[0], KEYS[1].name, s_key_idle[1], KEYS[2].name, s_key_idle[2]);
        cdc_line("# buttons %s=%lu %s=%lu %s=%lu online=%d", KEYS[0].name, (unsigned long)s_key_count[0],
                 KEYS[1].name, (unsigned long)s_key_count[1], KEYS[2].name, (unsigned long)s_key_count[2], online);
    }
}

static void control_task(void *arg)
{
    char line[128];
    size_t used = 0;
    bool overflow = false, mounted_before = false, connected_before = false;
    while(1) {
        int64_t now = esp_timer_get_time();
        bool mounted = tud_mounted();
        bool connected = tud_cdc_connected();
        if(!connected || !connected_before) { used = 0; overflow = false; }
        connected_before = connected;
        portENTER_CRITICAL(&s_state_lock);
        if(mounted && !mounted_before) {
            s_mount_us = now; s_initial_done = false; s_seen_ping = false;
        }
        bool initial = mounted && !s_initial_done && now - s_mount_us >= 8000000;
        if(initial) { s_initial_done = true; initial = !s_seen_ping; }
        bool hello = s_hello_pending;
        s_hello_pending = false;
        bool boot = s_go_download;
        portEXIT_CRITICAL(&s_state_lock);
        mounted_before = mounted;
        if(hello) cdc_line("HELLO fw=2 name=参谋电报机 role=" ROLE_NAME);
        if(boot) {
            vTaskDelay(pdMS_TO_TICKS(100));
            enter_download();
        }
        while(tud_cdc_available()) {
            char c = tud_cdc_read_char();
            if(c == '\n') {
                if(!overflow) { line[used] = 0; command(line); }
                used = 0; overflow = false;
            } else if(c != '\r') {
                if(used < sizeof(line) - 1 && c) line[used++] = c;
                else overflow = true;
            }
        }
        if(initial) request_prompt(true);
        vTaskDelay(pdMS_TO_TICKS(5));
    }
}

void app_main(void)
{
    gpio_config_t cs = {.pin_bit_mask = 1ULL << SD_CARD_CS_GPIO, .mode = GPIO_MODE_OUTPUT};
    ESP_ERROR_CHECK(gpio_config(&cs));
    gpio_set_level(SD_CARD_CS_GPIO, 1);
    gpio_config_t btn = {
        .pin_bit_mask = (1ULL << 1) | (1ULL << 2) | (1ULL << 3),   // 主箱 D0 拨打、D1 挂断；手柄 D0/D2 PTT
        .mode = GPIO_MODE_INPUT, .pull_up_en = GPIO_PULLUP_ENABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
    };
    ESP_ERROR_CHECK(gpio_config(&btn));
    s_log_lock = xSemaphoreCreateMutex();
    s_sb = xStreamBufferCreate(FRAME_SAMPLES * 2 * 16, 1);
    s_spk_sb = xStreamBufferCreate(48 * 2 * 8, 1);
    assert(s_log_lock && s_sb && s_spk_sb);
    mic_i2s_init();
    speaker_init();
    xTaskCreatePinnedToCore(capture_task, "capture", 4096, NULL, 6, NULL, 1);
    xTaskCreate(speaker_task, "speaker", 4096, NULL, 6, NULL);
    static char serial[13];
    uint8_t mac[6];
    esp_read_mac(mac, ESP_MAC_WIFI_STA);
    snprintf(serial, sizeof(serial), "%02X%02X%02X%02X%02X%02X", mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
    g_usb_product = USB_PRODUCT;
    g_usb_serial = serial;                                    // 两块板子序列号不同，电脑才不会把它们当成同一个
    uac_device_config_t config = {.input_cb = mic_read_cb, .output_cb = speaker_cb};
    ESP_ERROR_CHECK(uac_device_init(&config));
    xTaskCreate(button_task, "button", 3072, NULL, 5, NULL);
    xTaskCreate(control_task, "control", 4096, NULL, 3, NULL);
}
