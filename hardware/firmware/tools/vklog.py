#!/usr/bin/env python3
"""读语音键盘的调试串口：发 'i' 打印状态，然后继续显示日志 N 秒（默认 2 秒，最多 55 秒）。"""
import os, re, select, subprocess, sys, termios, time, tty
secs = min(float(sys.argv[1]) if len(sys.argv) > 1 else 2.0, 55.0)
out = subprocess.run(["ioreg", "-r", "-c", "IOUSBHostDevice", "-l", "-w0"], capture_output=True, text=True).stdout
devs = [d for b in re.split(r"\n(?=\+-o )", out) if '"USB Product Name" = "Voice Keyboard' in b
        for d in re.findall(r'"IOCalloutDevice" = "([^"]+)"', b)]
if not devs:
    sys.exit("没找到 Voice Keyboard 的调试串口")
fd = os.open(devs[0], os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
tty.setraw(fd)
a = termios.tcgetattr(fd); a[2] &= ~termios.HUPCL; termios.tcsetattr(fd, termios.TCSANOW, a)
time.sleep(0.3)
os.write(fd, b"i")
end = time.time() + secs
while time.time() < end:
    r, _, _ = select.select([fd], [], [], 0.2)
    if r:
        try:
            sys.stdout.write(os.read(fd, 4096).decode(errors="replace")); sys.stdout.flush()
        except BlockingIOError:
            pass
