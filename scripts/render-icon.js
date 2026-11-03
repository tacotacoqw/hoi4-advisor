// 用 Electron 离屏渲染 icon.svg → 1024px PNG（本机没有 rsvg/ImageMagick）
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const out = process.argv[process.argv.length - 1];
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1024, height: 1024, transparent: true, frame: false, webPreferences: { offscreen: true } });
  win.webContents.setFrameRate(1);
  const svg = fs.readFileSync(path.join(__dirname, 'icon.svg'), 'utf8');
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<style>html,body{margin:0;background:transparent}</style>${svg}`));
  await new Promise((r) => setTimeout(r, 300));
  const img = await win.webContents.capturePage();
  fs.writeFileSync(out, img.resize({ width: 1024, height: 1024 }).toPNG());
  app.exit(0);
});
