// 参谋电报机硬件：找到 USB 串口（VID 0x303A / PID 0x8D01），读按键行，每秒发 PING 心跳。
// 主箱、手柄是两块板子、各插一根 USB：两块都连上，按键哪块来的都认（HELLO 里报 role=base / handset）。
// 协议见 hardware/通信约定.md。只用 Node 自带模块：串口当普通文件读写，stty 设成原始模式。
const fs = require('fs');
const { execFile } = require('child_process');

const VID = 0x303a;
const PID = 0x8d01;
const ROLE_NAME = { base: '主箱', handset: '手柄' };

// 在 ioreg 里按 VID/PID 找串口设备文件（/dev/cu.usbmodemXXXX），全部列出来
function findPorts() {
  return new Promise((resolve) => {
    execFile('ioreg', ['-r', '-c', 'IOUSBHostDevice', '-l', '-w0'], { maxBuffer: 16 << 20, timeout: 5000 }, (err, out) => {
      if (err || !out) return resolve([]);
      const list = [];
      for (const block of out.split(/\n(?=\+-o )/)) {
        const vid = Number((block.match(/"idVendor" = (\d+)/) || [])[1]);
        const pid = Number((block.match(/"idProduct" = (\d+)/) || [])[1]);
        if (vid !== VID || pid !== PID) continue;
        const dev = (block.match(/"IOCalloutDevice" = "([^"]+)"/) || [])[1];
        if (dev) list.push(dev);
      }
      resolve(list);
    });
  });
}

class Telegraph {
  // onEvent({ type: 'status', connected, boards: [{ port, role }], hello }) / ({ type: 'btn', key: 'DIAL'|'HANG'|'PTT'|'SEND'|'DEL', down, role })
  constructor({ onEvent = () => {}, log = () => {}, find = findPorts, pollMs = 2000, helloMs = 3000 } = {}) {
    this.onEvent = onEvent;
    this.log = log;
    this.find = find;
    this.pollMs = pollMs;
    this.helloMs = helloMs;
    this.links = new Map(); // 串口路径 → { fd, buf, hello, role }
    this.bad = new Map();   // 不回 HELLO 的口（卡死的板子）：一分钟内先不再试
  }

  start() {
    this.scan();
    this.timer = setInterval(() => this.scan(), this.pollMs);
    this.ping = setInterval(() => this.send('PING'), 1000);
  }

  stop() {
    clearInterval(this.timer);
    clearInterval(this.ping);
    for (const link of [...this.links.values()]) this.close(link, true);
  }

  // 回过 HELLO 的才算接上
  get boards() { return [...this.links.values()].filter((l) => l.hello).map((l) => ({ port: l.port, role: l.role })); }
  get connected() { return this.boards.length > 0; }
  get port() { return (this.boards[0] || {}).port || null; }
  get hello() { const l = [...this.links.values()].find((x) => x.hello); return l ? l.hello : null; }
  get summary() {
    const names = this.boards.map((b) => ROLE_NAME[b.role] || '电报机');
    return names.length ? names.join('、') : '';
  }

  async scan() {
    if (this.scanning) return;
    this.scanning = true;
    try {
      let ports = await this.find();
      if (!Array.isArray(ports)) ports = ports ? [ports] : [];
      const now = Date.now();
      for (const port of ports) {
        if (!this.links.has(port) && !(this.bad.get(port) > now)) await this.open(port);
      }
    } finally { this.scanning = false; }
  }

  open(port) {
    return new Promise((resolve) => {
      // 原始模式：不回显、不把 \n 变 \r\n；CDC 不在乎波特率
      execFile('stty', ['-f', port, 'raw', '-echo', '115200'], () => {
        fs.open(port, fs.constants.O_RDWR | fs.constants.O_NOCTTY | fs.constants.O_NONBLOCK, (err, fd) => {
          if (err) { this.log(`打不开 ${port}：${err.message}`); return resolve(); }
          const link = { port, fd, buf: '', hello: null, role: null };
          this.links.set(port, link);
          this.readLoop(link);
          this.write(link, 'HELLO');
          // 等它回 HELLO 才算接上；插着一块卡死的板子时不会一直连着它
          link.helloTimer = setTimeout(() => {
            if (this.links.get(port) !== link || link.hello) return;
            this.log(`${port} 没有回应，先跳过`);
            this.bad.set(port, Date.now() + 60000);
            this.close(link, true);
          }, this.helloMs);
          resolve();
        });
      });
    });
  }

  // 非阻塞读：没数据（EAGAIN）就过 30 毫秒再读；读出错（拔线）就关掉，等下次扫描
  readLoop(link) {
    const chunk = Buffer.alloc(512);
    const tick = () => {
      if (this.links.get(link.port) !== link) return;
      fs.read(link.fd, chunk, 0, chunk.length, null, (err, n) => {
        if (this.links.get(link.port) !== link) return;
        if (err && err.code === 'EAGAIN') return setTimeout(tick, 30);
        if (err || n === 0) { if (err) this.log(`串口断开：${err.code || err.message}`); return this.close(link); }
        this.feed(link, chunk.toString('utf8', 0, n));
        setImmediate(tick);
      });
    };
    tick();
  }

  feed(link, text) {
    link.buf += text;
    let i;
    while ((i = link.buf.indexOf('\n')) >= 0) {
      const line = link.buf.slice(0, i).replace(/\r$/, '').trim();
      link.buf = link.buf.slice(i + 1);
      if (line) this.line(link, line);
    }
    if (link.buf.length > 4096) link.buf = '';
  }

  line(link, line) {
    if (line.startsWith('#')) return this.log(`设备${ROLE_NAME[link.role] ? '（' + ROLE_NAME[link.role] + '）' : ''}：` + line.slice(1).trim());
    const m = line.match(/^BTN (DIAL|HANG|PTT|SEND|DEL) (DOWN|UP)$/);
    if (m) return this.onEvent({ type: 'btn', key: m[1], down: m[2] === 'DOWN', role: link.role });
    if (line.startsWith('HELLO')) {
      const first = !link.hello;
      this.bad.delete(link.port);
      link.hello = line;
      link.role = (line.match(/role=(\w+)/) || [])[1] || null;
      if (first) this.status();
    }
  }

  status() {
    this.onEvent({ type: 'status', connected: this.connected, boards: this.boards, hello: this.hello, summary: this.summary });
  }

  write(link, cmd) {
    fs.write(link.fd, cmd + '\n', (err) => { if (err && err.code !== 'EAGAIN' && this.links.get(link.port) === link) this.close(link); });
  }

  send(cmd) {
    for (const link of this.links.values()) this.write(link, cmd);
  }

  close(link, silent) {
    if (this.links.get(link.port) !== link) return;
    this.links.delete(link.port);
    clearTimeout(link.helloTimer);
    fs.close(link.fd, () => {});
    if (!silent && link.hello) this.status();
  }
}

module.exports = { Telegraph, findPorts, VID, PID, ROLE_NAME };
