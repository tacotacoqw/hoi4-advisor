const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('probe', {
  liveCreate: (sdp) => ipcRenderer.invoke('live-create', sdp),
  audio: () => ipcRenderer.invoke('probe-audio'),
  log: (s) => ipcRenderer.send('probe-log', s),
  done: (code) => ipcRenderer.send('probe-done', code),
});
