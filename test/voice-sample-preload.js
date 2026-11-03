const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('probe', {
  liveCreate: (sdp) => ipcRenderer.invoke('live-create', sdp),
  log: (s) => ipcRenderer.send('probe-log', s),
  save: (buf) => ipcRenderer.send('probe-save', buf),
  done: (code) => ipcRenderer.send('probe-done', code),
});
