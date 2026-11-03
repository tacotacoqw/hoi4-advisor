#!/bin/zsh
# 参谋电报机：编译 + 免按键烧录。用法：./flash.sh base（主箱）或 ./flash.sh handset（手柄）
# 先让板子进下载模式（自动找口；两块都插着时按角色挑），再烧录，烧完重启进固件
cd "$(dirname "$0")"
ROLE=${1:-}
[[ "$ROLE" == base || "$ROLE" == handset ]] || { echo "用法：./flash.sh base（主箱）或 ./flash.sh handset（手柄）"; exit 1; }
pio run -e "$ROLE" || exit 1
# 参谋开着的话它也在读这些串口，会把板子回的 HELLO 抢走、认不出角色：先退出，烧完再在后台打开
APP="/Applications/参谋电报机.app"
if pgrep -f "$APP/Contents/MacOS/Electron" >/dev/null; then
  osascript -e 'quit app "参谋电报机"' 2>/dev/null || pkill -f "$APP/Contents/MacOS/Electron"
  for i in {1..40}; do pgrep -f "$APP/Contents/MacOS/Electron" >/dev/null || break; sleep 0.25; done
  REOPEN=1
fi
# 不管烧成没烧成，结束时都把参谋（在后台）开回来
reopen() { [[ -n "$REOPEN" ]] && { sleep 1; pgrep -f "$APP/Contents/MacOS/Electron" >/dev/null || open -g "$APP" --args --hidden; }; }
trap reopen EXIT
PORT=$(python3 tools/enter_download.py "$ROLE") || exit 1
echo "下载口：$PORT"
# 刚进下载模式时口偶尔还没准备好（“port is busy”），重试几次
ok=0
for i in 1 2 3; do
  pio run -e "$ROLE" -t upload --upload-port "$PORT" && { ok=1; break; }
  echo "烧录没成功，2 秒后重试（第 $i 次）…"; sleep 2
done
[[ $ok == 1 ]] || exit 1
# 按 B+R 手动进的下载模式，烧完常常还停在下载模式（电脑只看到 “USB JTAG/serial debug unit”）：
# 用看门狗复位把它拉回固件
sleep 2
if ioreg -r -c IOUSBHostDevice -l -w0 | grep -q '"idProduct" = 4097'; then
  echo "板子还在下载模式，重启进固件…"
  ~/.platformio/penv/bin/python ~/.platformio/packages/tool-esptoolpy/esptool.py --port "$PORT" --before no_reset --after watchdog_reset chip_id >/dev/null
fi
