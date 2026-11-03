/*
 * The MIT License (MIT)
 *
 * Copyright (c) 2019 Ha Thach (tinyusb.org)
 * Copyright (c) 2020 Jerzy Kasenbreg
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 *
 */

#include "tusb.h"
#include "uac_descriptors.h"

//--------------------------------------------------------------------+
// Device Descriptors
//--------------------------------------------------------------------+
tusb_desc_device_t const desc_device = {
    .bLength            = sizeof(tusb_desc_device_t),
    .bDescriptorType    = TUSB_DESC_DEVICE,
    .bcdUSB             = 0x0200,

    // Use Interface Association Descriptor (IAD) for CDC
    // As required by USB Specs IAD's subclass must be common class (2) and protocol must be IAD (1)
    .bDeviceClass       = TUSB_CLASS_MISC,
    .bDeviceSubClass    = MISC_SUBCLASS_COMMON,
    .bDeviceProtocol    = MISC_PROTOCOL_IAD,
    .bMaxPacketSize0    = CFG_TUD_ENDPOINT0_SIZE,

    .idVendor           = CONFIG_UAC_TUSB_VID,
    .idProduct          = CONFIG_UAC_TUSB_PID,
    .bcdDevice          = 0x0100,

    .iManufacturer      = 0x01,
    .iProduct           = 0x02,
    .iSerialNumber      = 0x03,

    .bNumConfigurations = 0x01
};

// Invoked when received GET DEVICE DESCRIPTOR
// Application return pointer to descriptor
uint8_t const *tud_descriptor_device_cb(void)
{
    return (uint8_t const *)&desc_device;
}

//--------------------------------------------------------------------+
// Configuration Descriptor
//--------------------------------------------------------------------+
// 音频控制 + 扬声器流 + 麦克风流 + CDC 两接口，共五个接口。
#define ITF_NUM_CDC ITF_NUM_TOTAL
#define ITF_NUM_ALL (ITF_NUM_TOTAL + 2)
#define CONFIG_TOTAL_LEN (TUD_CONFIG_DESC_LEN + TUD_AUDIO_DEVICE_DESC_LEN + TUD_CDC_DESC_LEN)
#define EPNUM_AUDIO_OUT 0x01
#define EPNUM_AUDIO_FB 0x81
#define EPNUM_AUDIO_IN 0x82
#define EPNUM_CDC_NOTIF 0x83
#define EPNUM_CDC_OUT 0x02
#define EPNUM_CDC_IN 0x84
#define STRID_CDC (5 + (SPEAK_CHANNEL_NUM ? 1 : 0) + (MIC_CHANNEL_NUM ? 1 : 0))

uint8_t const desc_configuration[] = {
    // Config number, interface count, string index, total length, attribute, power in mA
    TUD_CONFIG_DESCRIPTOR(1, ITF_NUM_ALL, 0, CONFIG_TOTAL_LEN, 0x00, 100),
    // Interface number, string index, EP Out & EP In address, EP size
    TUD_AUDIO_DESCRIPTOR(ITF_NUM_AUDIO_CONTROL, 4, EPNUM_AUDIO_OUT, EPNUM_AUDIO_IN, EPNUM_AUDIO_FB),
    // Interface number, string index, EP notification address and size, EP data address (out, in) and size
    TUD_CDC_DESCRIPTOR(ITF_NUM_CDC, STRID_CDC, EPNUM_CDC_NOTIF, 8, EPNUM_CDC_OUT, EPNUM_CDC_IN, 64),

};

// Invoked when received GET CONFIGURATION DESCRIPTOR
// Application return pointer to descriptor
// Descriptor contents must exist long enough for transfer to complete
uint8_t const *tud_descriptor_configuration_cb(uint8_t index)
{
    (void)index; // for multiple configurations
    return desc_configuration;
}

//--------------------------------------------------------------------+
// String Descriptors
//--------------------------------------------------------------------+

// array of pointer to string descriptors
char const *string_desc_arr [] = {
    (const char[]) { 0x09, 0x04 },  // 0: is supported language is English (0x0409)
    CONFIG_UAC_TUSB_MANUFACTURER,       // 1: Manufacturer
    CONFIG_UAC_TUSB_PRODUCT,            // 2: Product
    CONFIG_UAC_TUSB_SERIAL_NUM,         // 3: Serials, should use chip ID
    // 本工程的改动：macOS 用“接口名”当麦克风的名字，所以接口名也填产品名
    CONFIG_UAC_TUSB_PRODUCT,        // 4: UAC control Interface
#if SPEAK_CHANNEL_NUM
    CONFIG_UAC_TUSB_PRODUCT,                     // 5: Speak Interface
#endif
#if MIC_CHANNEL_NUM
    CONFIG_UAC_TUSB_PRODUCT,        // 6: Mic Interface
#endif
    "参谋电报机 CDC",         // CDC 调试串口
};

static uint16_t _desc_str[32];

// 主箱 / 手柄两块板子要分得清：产品名（macOS 里声卡就叫这个）和序列号由 main.c 在 USB 初始化前填好
const char *g_usb_product = CONFIG_UAC_TUSB_PRODUCT;
const char *g_usb_serial = CONFIG_UAC_TUSB_SERIAL_NUM;

// Invoked when received GET STRING DESCRIPTOR request
// Application return pointer to descriptor, whose contents must exist long enough for transfer to complete
uint16_t const *tud_descriptor_string_cb(uint8_t index, uint16_t langid)
{
    (void)langid;

    uint8_t chr_count;

    if (index == 0) {
        memcpy(&_desc_str[1], string_desc_arr[0], 2);
        chr_count = 1;
    } else {

        if (!(index < sizeof(string_desc_arr) / sizeof(string_desc_arr[0]))) {
            return NULL;
        }

        const char *str = string_desc_arr[index];
        const uint8_t last = sizeof(string_desc_arr) / sizeof(string_desc_arr[0]) - 1;   // 最后一个是 CDC 串口名
        if (index == 3) str = g_usb_serial;
        else if (index != 1 && index != last) str = g_usb_product;

        // USB 字符串用 UTF-16；校验 UTF-8，非 BMP 字符输出代理对。
        chr_count = 0;
        const uint8_t *p = (const uint8_t *)str;
        while(*p && chr_count < 31) {
            uint32_t cp = *p++;
            unsigned extra = 0;
            uint32_t min = 0;
            if(cp >= 0xc2 && cp <= 0xdf) { cp &= 0x1f; extra = 1; min = 0x80; }
            else if(cp >= 0xe0 && cp <= 0xef) { cp &= 0x0f; extra = 2; min = 0x800; }
            else if(cp >= 0xf0 && cp <= 0xf4) { cp &= 7; extra = 3; min = 0x10000; }
            else if(cp >= 0x80) cp = 0xfffd;
            bool valid = true;
            for(unsigned i = 0; i < extra; i++) {
                if((*p & 0xc0) != 0x80) { valid = false; break; }
                cp = (cp << 6) | (*p++ & 0x3f);
            }
            if(!valid || cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) cp = 0xfffd;
            if(cp > 0xffff) {
                if(chr_count > 29) break;
                cp -= 0x10000;
                _desc_str[++chr_count] = 0xd800 | (cp >> 10);
                _desc_str[++chr_count] = 0xdc00 | (cp & 0x3ff);
            } else _desc_str[++chr_count] = cp;
        }
    }

    // first byte is length (including header), second byte is string type
    _desc_str[0] = (uint16_t)((TUSB_DESC_STRING << 8) | (2 * chr_count + 2));

    return _desc_str;
}
