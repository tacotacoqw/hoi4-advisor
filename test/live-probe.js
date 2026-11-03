// GPT-Live 真机探针：隐藏窗口里把一段合成语音当麦克风，真连一次 GPT-Live（会花几秒通话费，约 0.1 元）。
// 用法：PROBE_AUDIO=问题.wav npx electron test/live-probe.js
const { app, BrowserWindow, ipcMain, net } = require('electron');
const path = require('path');
const fs = require('fs');
const config = require('../lib/config');
const { explain } = require('../lib/agent');
const { liveSessionBody } = require('../lib/live-prompt');

app.setPath('userData', path.join(app.getPath('temp'), 'hoi4-live-probe'));
const cfg = config.load();

ipcMain.handle('live-create', async (_e, sdp) => {
  const res = await net.fetch(cfg.liveBaseURL.replace(/\/+$/, '') + '/live/sessions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.liveApiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(liveSessionBody(cfg, sdp)),
  });
  const text = await res.text();
  if (!res.ok) return { ok: false, error: explain(res.status, text) };
  const d = JSON.parse(text);
  return { ok: true, id: d.session.id, sdp: d.transport.sdp };
});
ipcMain.handle('probe-audio', () => fs.readFileSync(process.env.PROBE_AUDIO));
ipcMain.on('probe-log', (_e, line) => console.log(line));
ipcMain.on('probe-done', (_e, code) => app.exit(code));

app.whenReady().then(() => {
  if (!cfg.liveApiKey) { console.log('PROBE 没有 liveApiKey'); app.exit(2); return; }
  const win = new BrowserWindow({ show: false, webPreferences: { preload: path.join(__dirname, 'live-probe-preload.js'), contextIsolation: true } });
  win.loadFile(path.join(__dirname, 'live-probe.html'));
  setTimeout(() => { console.log('PROBE 超时'); app.exit(3); }, 90000);
});
