// 不用真硬件测串口协议：python 开一个伪终端假装电报机，回 HELLO、发按键、最后“拔线”
const assert = require('assert');
const { spawn } = require('child_process');
const { Telegraph } = require('../lib/hw-serial');

const DEVICE = `
import os, pty, sys, time, select
m, s = pty.openpty()
print(os.ttyname(s), flush=True)
buf, pings, sent = b'', 0, False
end = time.time() + 8
while time.time() < end:
    r, _, _ = select.select([m], [], [], 0.1)
    if r:
        buf += os.read(m, 256)
        while b'\\n' in buf:
            line, buf = buf.split(b'\\n', 1)
            line = line.strip()
            if line == b'HELLO': os.write(m, 'HELLO fw=1 name=参谋电报机\\n'.encode())
            if line == b'PING': pings += 1
    if pings >= 2 and not sent:
        sent = True
        os.write(m, b'# boot ok\\nBTN DIAL DOWN\\nBTN DIAL UP\\nBTN PTT DOWN\\nBTN PTT UP\\nBTN HANG DOWN\\n')
        time.sleep(0.5)
        print('PINGS', pings, flush=True)
        os.close(m)
        os.close(s)
        break
`;

(async () => {
  const py = spawn('python3', ['-c', DEVICE]);
  const ttyPath = await new Promise((res) => py.stdout.once('data', (d) => res(String(d).trim().split('\n')[0])));
  let tail = '';
  py.stdout.on('data', (d) => { tail += d; });
  const events = [];
  const logs = [];
  let served = false;
  const tg = new Telegraph({
    find: async () => (served ? null : ((served = true), ttyPath)),
    onEvent: (e) => events.push(e),
    log: (l) => logs.push(l),
    pollMs: 200,
  });
  tg.start();
  await new Promise((r) => py.on('exit', r));
  await new Promise((r) => setTimeout(r, 400));
  tg.stop();

  const btn = events.filter((e) => e.type === 'btn').map((e) => `${e.key}${e.down ? '↓' : '↑'}`).join(' ');
  assert(events.some((e) => e.type === 'status' && e.connected && /参谋电报机/.test(e.hello || '')), '没收到 HELLO：' + JSON.stringify(events));
  assert.strictEqual(btn, 'DIAL↓ DIAL↑ PTT↓ PTT↑ HANG↓', '按键顺序不对：' + btn);
  assert(logs.some((l) => /boot ok/.test(l)), '调试日志没进 log');
  assert(events[events.length - 1].type === 'status' && events[events.length - 1].connected === false, '拔线后应报断开');
  assert(/PINGS [2-9]/.test(tail), '心跳没发到设备：' + tail);
  console.log('串口协议 OK（HELLO、按键、日志、心跳、拔线）');

  // 插着一块卡死的板子（不回 HELLO）+ 一块好的：要跳过坏的、连上好的
  const TWO = `
import os, pty, time, select
dm, ds = pty.openpty(); lm, ls = pty.openpty()
print(os.ttyname(ds) + ' ' + os.ttyname(ls), flush=True)
buf = b''; end = time.time() + 6
while time.time() < end:
    r, _, _ = select.select([dm, lm], [], [], 0.1)
    if dm in r: os.read(dm, 256)            # 坏板子：只收不回
    if lm in r:
        buf += os.read(lm, 256)
        if b'HELLO' in buf: os.write(lm, 'HELLO fw=1 name=参谋电报机\\n'.encode()); buf = b''
`;
  const py2 = spawn('python3', ['-c', TWO]);
  const [dead, good] = await new Promise((res) => py2.stdout.once('data', (d) => res(String(d).trim().split(' '))));
  const ev2 = [];
  const tg2 = new Telegraph({ find: async () => [dead, good], onEvent: (e) => ev2.push(e), pollMs: 150, helloMs: 600 });
  tg2.start();
  await new Promise((r) => setTimeout(r, 2500));
  assert(tg2.connected && tg2.port === good, `没跳过卡死的板子：连在 ${tg2.port}`);
  assert(!ev2.some((e) => e.type === 'status' && e.connected === false), '坏板子不该报“断开”');
  tg2.stop();
  py2.kill();
  console.log('多块板子 OK（跳过不回应的，连上好的）');

  // 主箱 + 手柄两块同时插着：两块都连上，按键带上是哪块按的
  const PAIR = `
import os, pty, time, select
bm, bs = pty.openpty(); hm, hs = pty.openpty()
print(os.ttyname(bs) + ' ' + os.ttyname(hs), flush=True)
role = {bm: b'base', hm: b'handset'}; buf = {bm: b'', hm: b''}; pings = {bm: 0, hm: 0}; sent = False
end = time.time() + 6
while time.time() < end:
    r, _, _ = select.select([bm, hm], [], [], 0.1)
    for m in r:
        buf[m] += os.read(m, 256)
        while b'\\n' in buf[m]:
            line, buf[m] = buf[m].split(b'\\n', 1)
            if line.strip() == b'HELLO': os.write(m, 'HELLO fw=2 name=参谋电报机 role='.encode() + role[m] + b'\\n')
            if line.strip() == b'PING': pings[m] += 1
    if not sent and pings[bm] >= 1 and pings[hm] >= 1:
        sent = True
        os.write(bm, b'BTN DIAL DOWN\\n'); time.sleep(0.2); os.write(hm, b'BTN PTT DOWN\\nBTN PTT UP\\n')
`;
  const py3 = spawn('python3', ['-c', PAIR]);
  const [basePort, handPort] = await new Promise((res) => py3.stdout.once('data', (d) => res(String(d).trim().split(' '))));
  const ev3 = [];
  const tg3 = new Telegraph({ find: async () => [basePort, handPort], onEvent: (e) => ev3.push(e), pollMs: 150, helloMs: 800 });
  tg3.start();
  await new Promise((r) => setTimeout(r, 3500));
  const roles = tg3.boards.map((b) => b.role).sort().join(',');
  assert.strictEqual(roles, 'base,handset', '两块没都连上：' + roles);
  assert.strictEqual(tg3.summary, tg3.boards.map((b) => ({ base: '主箱', handset: '手柄' })[b.role]).join('、'));
  const btn3 = ev3.filter((e) => e.type === 'btn').map((e) => `${e.role}:${e.key}${e.down ? '↓' : '↑'}`).join(' ');
  assert.strictEqual(btn3, 'base:DIAL↓ handset:PTT↓ handset:PTT↑', '按键来源不对：' + btn3);
  tg3.stop();
  py3.kill();
  console.log('主箱 + 手柄 OK（两块都连上，按键分得清是哪块）');
})().catch((e) => { console.error(e); process.exit(1); });
