// 录 GPT-Live 某个音色的中文样音：PROBE_VOICE=cedar PROBE_OUT=cedar.webm npx electron test/voice-sample.js
const { app, BrowserWindow, ipcMain, net } = require('electron');
const path = require('path');
const fs = require('fs');
const config = require('../lib/config');
const { explain } = require('../lib/agent');
const { liveSessionBody } = require('../lib/live-prompt');

const voice = process.env.PROBE_VOICE;
app.setPath('userData', path.join(app.getPath('temp'), 'hoi4-voice-' + voice));
const cfg = { ...config.load(), liveVoice: voice };

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
ipcMain.on('probe-log', (_e, s) => console.log(`[${voice}] ${s}`));
ipcMain.on('probe-save', (_e, buf) => { fs.writeFileSync(process.env.PROBE_OUT, Buffer.from(buf)); });
ipcMain.on('probe-done', (_e, code) => app.exit(code));
app.whenReady().then(() => {
  const win = new BrowserWindow({ show: false, webPreferences: { preload: path.join(__dirname, 'voice-sample-preload.js'), contextIsolation: true, autoplayPolicy: 'no-user-gesture-required' } });
  win.loadFile(path.join(__dirname, 'voice-sample.html'));
  setTimeout(() => { console.log(`[${voice}] 超时`); app.exit(3); }, 60000);
});
