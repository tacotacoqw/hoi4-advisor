const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('advisor', {
  ask: (text) => ipcRenderer.invoke('ask', text),
  transcribe: (audio, mime) => ipcRenderer.invoke('transcribe', audio, mime),
  tts: (text) => ipcRenderer.invoke('tts', text),
  gameState: () => ipcRenderer.invoke('game-state'),
  listModels: (opts) => ipcRenderer.invoke('list-models', opts),
  liveCreate: (sdp) => ipcRenderer.invoke('live-create', sdp),
  gfxUi: () => ipcRenderer.invoke('gfx-ui'),
  focusIcons: (ids) => ipcRenderer.invoke('focus-icons', ids),
  sfxBank: () => ipcRenderer.invoke('sfx-bank'),
  ttsStream: (id, text) => ipcRenderer.send('tts-stream', { id, text }),
  ttsCached: (text) => ipcRenderer.invoke('tts-cached', text),
  fishLive: (op, id, text) => ipcRenderer.send('fishlive', { op, id, text }),
  flag: (tag, ideology) => ipcRenderer.invoke('flag', tag, ideology),
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (patch) => ipcRenderer.invoke('save-config', patch),
  reset: () => ipcRenderer.invoke('reset'),
  micPermission: () => ipcRenderer.invoke('mic-permission'),
  hide: () => ipcRenderer.send('hide'),
  peek: () => ipcRenderer.send('peek'),
  openScreenSettings: () => ipcRenderer.send('open-screen-settings'),
  hwStatus: () => ipcRenderer.invoke('hw-status'),
  on: (channel, fn) => {
    const allowed = ['hotkey', 'agent-event', 'game-status', 'reset', 'toast', 'country', 'tts-chunk', 'need-screen', 'hw'];
    if (allowed.includes(channel)) ipcRenderer.on(channel, (_e, payload) => fn(payload));
  },
});
