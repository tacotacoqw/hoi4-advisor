#!/usr/bin/env python3
"""让要烧的那块板子进下载模式，打印下载用的串口（芯片自带 USB 串口 303A:1001）。
用法：enter_download.py base|handset

- 正常运行的板子：先问 HELLO 核对角色（主箱 base / 手柄 handset），对上了才发 BOOT 和 esptool 的 DTR/RTS 复位序列，
  然后只认**同一个 USB 口**上冒出来的下载口，不会烧到另一块。
- 已经手动按 B+R 进了下载模式的板子：只有一块在下载模式、而且另一块（如果插着）报的是另一个角色，才用它。
"""
import fcntl, os, re, struct, subprocess, sys, termios, time

NAMES = {"base": "主箱", "handset": "手柄"}
TELEGRAPH = ((0x303A, 0x8D01), (0x05AC, 0x024F))   # 参谋电报机；之前烧过的语音键盘固件也认 DTR/RTS 复位序列
DOWNLOAD = (0x303A, 0x1001)


def ports():
    """串口 → (vid, pid, USB 物理位置)"""
    out = subprocess.run(["ioreg", "-r", "-c", "IOUSBHostDevice", "-l", "-w0"], capture_output=True, text=True).stdout
    res = {}
    for block in re.split(r"\n(?=\+-o )", out):
        vid = re.search(r'"idVendor" = (\d+)', block); pid = re.search(r'"idProduct" = (\d+)', block)
        loc = re.search(r'"locationID" = (\d+)', block)
        for dev in re.findall(r'"IOCalloutDevice" = "([^"]+)"', block):
            res[dev] = (int(vid.group(1)) if vid else 0, int(pid.group(1)) if pid else 0, int(loc.group(1)) if loc else None)
    return res


def raw_open(dev):
    fd = os.open(dev, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
    attrs = termios.tcgetattr(fd)
    attrs[0] = attrs[1] = attrs[3] = 0
    attrs[2] = termios.CS8 | termios.CREAD | termios.CLOCAL
    attrs[4] = attrs[5] = termios.B115200
    termios.tcsetattr(fd, termios.TCSANOW, attrs)
    return fd


def role_of(dev):
    """问板子 HELLO，返回它报的角色（base / handset）；老固件没有角色返回 ''；不回应返回 None。"""
    try:
        fd = raw_open(dev)
    except OSError:
        return None
    try:
        time.sleep(0.2)
        os.write(fd, b"HELLO\n")
        buf, end = b"", time.time() + 1.0
        while time.time() < end:
            try:
                buf += os.read(fd, 1024)
            except BlockingIOError:
                time.sleep(0.05)
        if b"HELLO" not in buf:
            return None
        m = re.search(rb"role=(\w+)", buf)
        return m.group(1).decode() if m else ""
    finally:
        os.close(fd)


def set_lines(fd, dtr, rts):
    bits = struct.unpack("I", fcntl.ioctl(fd, termios.TIOCMGET, struct.pack("I", 0)))[0]
    bits = (bits | termios.TIOCM_DTR) if dtr else (bits & ~termios.TIOCM_DTR)
    bits = (bits | termios.TIOCM_RTS) if rts else (bits & ~termios.TIOCM_RTS)
    fcntl.ioctl(fd, termios.TIOCMSET, struct.pack("I", bits))


want = sys.argv[1] if len(sys.argv) > 1 else ""
name = NAMES.get(want, "要烧的那块")
bpr = f"在{name}那块板子上按住 B 键、点一下 R 键、松开 B 键，然后重试。"
now = ports()
downloads = [d for d, (v, p, _) in now.items() if (v, p) == DOWNLOAD]
running = {d: role_of(d) for d, (v, p, _) in now.items() if (v, p) in TELEGRAPH}

# 已经有板子在下载模式（手动按了 B+R）
if downloads:
    if len(downloads) > 1:
        sys.exit("有好几块板子都在下载模式，分不清哪块是" + name + "。只留一块在下载模式再试。")
    if any(r == want for r in running.values()):
        sys.exit(f"另一块正常运行的板子才是{name}，下载模式里的那块不是。{bpr}")
    print(downloads[0])
    sys.exit(0)

mine = [d for d, r in running.items() if r == want]
if not mine:
    # 第一次烧：板子还没有角色（老固件），只有一块时就是它；报了别的角色的不碰
    unknown = [d for d, r in running.items() if r in ("", None)]
    others = [d for d, r in running.items() if r and r != want]
    if len(unknown) == 1:
        mine = unknown
    elif others and not unknown:
        sys.exit(f"插着的是{'、'.join(NAMES.get(r, r) for r in set(running.values()) if r)}，没找到{name}。{bpr}")
    elif not running:
        sys.exit(f"没找到板子。{bpr}")
    else:
        sys.exit(f"插着好几块板子，分不清哪块是{name}。{bpr}")
if len(mine) > 1:
    sys.exit(f"有两块都说自己是{name}，请只插一块再试。")

target = mine[0]
loc = now[target][2]
try:
    fd = raw_open(target)
    try:
        os.write(fd, b"BOOT\n")
        set_lines(fd, True, True); time.sleep(0.05)
        set_lines(fd, False, True); time.sleep(0.1)
        set_lines(fd, True, False); time.sleep(0.05)
        set_lines(fd, False, False)
    finally:
        os.close(fd)
except OSError:
    pass

# 只认同一个 USB 口上冒出来的下载口
for _ in range(50):
    time.sleep(0.2)
    for d, (v, p, l) in ports().items():
        if (v, p) == DOWNLOAD and (loc is None or l == loc):
            print(d)
            sys.exit(0)
sys.exit(f"{name}没进下载模式。{bpr}")
