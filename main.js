// 参谋电报机：菜单栏常驻，检测 hoi4 进程，全局快捷键语音提问，GPT 查本机游戏文件后回答。
const { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, net, nativeImage, Notification, systemPreferences, session, protocol, desktopCapturer, shell } = require('electron');
const { pathToFileURL } = require('url');
const { Gfx } = require('./lib/gfx');
const path = require('path');
const config = require('./lib/config');
const { GameData, isProcessRunning } = require('./lib/gamedata');
const { Agent, explain } = require('./lib/agent');
const { liveSessionBody } = require('./lib/live-prompt');
const { FishLiveSession } = require('./lib/fish-live');
const { Telegraph } = require('./lib/hw-serial');
const autostart = require('./lib/autostart');

// 自检时用独立的数据目录，不和正在用的参谋抢单实例锁
if (process.env.ADVISOR_SNAPSHOT) app.setPath('userData', path.join(app.getPath('temp'), 'hoi4-advisor-selfcheck'));
if (!app.requestSingleInstanceLock()) app.exit(0);

// gfx:// 协议：把从游戏里转出来的贴图交给窗口
protocol.registerSchemesAsPrivileged([{ scheme: 'gfx', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);

let cfg = config.load();
let gd = new GameData({ gameDir: cfg.gameDir, userDir: cfg.userDir });
let gfx = null;
let win = null;
let tray = null;
let running = false;
const agent = new Agent({
  config: cfg, gamedata: gd, fetchImpl: (url, opts) => net.fetch(url, opts), getRunning: () => running,
  captureScreen: () => captureGame(),
  onCountry: (ov) => send('country', ov),
});

// 截游戏画面：优先截游戏窗口；截整屏时先把参谋窗口藏起来，免得挡住画面
async function captureGame({ region } = {}) {
  if (process.platform === 'darwin' && systemPreferences.getMediaAccessStatus('screen') !== 'granted') {
    throw new Error(`没有屏幕录制权限：系统设置 → 隐私与安全性 → 屏幕与系统录音，打开「${process.execPath.includes('参谋电报机.app') ? '参谋电报机' : 'Electron'}」，然后重启参谋`);
  }
  const size = { width: 1920, height: 1200 };
  let src = (await desktopCapturer.getSources({ types: ['window'], thumbnailSize: size }))
    .find((s) => /^(Hearts of Iron IV|hoi4)$/i.test(s.name.trim()));
  const hide = !src && win && win.isVisible();
  const opacity = win ? win.getOpacity() : 1;
  if (hide) { win.setOpacity(0); await new Promise((r) => setTimeout(r, 150)); }
  try {
    if (!src) src = (await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size }))[0];
  } finally { if (hide) win.setOpacity(opacity); }
  if (!src || src.thumbnail.isEmpty()) throw new Error('截不到画面');
  let img = src.thumbnail;
  if (region === 'flag') {
    const { width, height } = img.getSize();
    img = img.crop({ x: 0, y: 0, width: Math.round(width * 0.25), height: Math.round(height * 0.14) });
  }
  return 'data:image/jpeg;base64,' + img.toJPEG(region === 'flag' ? 90 : 75).toString('base64');
}

// 游戏在跑、国家又认不出来（新开局还没存档）时，隔一会儿看一眼左上角国旗
let detecting = false;
let lastDetect = 0;
async function watchCountry() {
  if (!cfg.watchScreen || !running || detecting || !cfg.apiKey || Date.now() - lastDetect < 45000) return;
  detecting = true;
  lastDetect = Date.now();
  try {
    const st = await gd.gameState(true);
    if (!st.country_uncertain) return;
    const j = await agent.identifyCountry(await captureGame({ region: 'flag' }));
    if (!j) return; // 画面不是游戏（玩家切到别的窗口了），下次再看
    const byName = gd.tagByName(j.country);
    const ov = gd.setCountry(byName ? byName.tag : j.tag, (byName && byName.ideology) || j.ideology);
    if (ov) send('country', ov);
  } catch (e) { logErr('watch-country', e.message); }
  finally { detecting = false; }
}

// 出错记到 userData/advisor.log，排查“连不上”不用靠猜
const LOG_FILE = () => path.join(app.getPath('userData'), 'advisor.log');
function logErr(where, msg) {
  try { require('fs').appendFileSync(LOG_FILE(), `[${new Date().toLocaleString('zh-CN')}] ${where}: ${String(msg).slice(0, 600)}\n`); } catch {}
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function createWindow() {
  win = new BrowserWindow({
    width: 440, height: 660, minWidth: 360, minHeight: 420,
    show: false, frame: false, transparent: false, resizable: true,
    backgroundColor: '#1d1a14', alwaysOnTop: true, skipTaskbar: true,
    // 平时窗口藏着，声音和通话都在里面跑：不能让 Chromium 把后台窗口降频
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  win.webContents.on('render-process-gone', (_e, d) => { logErr('renderer', '窗口进程退出：' + d.reason); if (!app.isQuitting) setTimeout(() => win && !win.isDestroyed() && win.reload(), 1000); });
  // 浮在全屏游戏上面
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // 窗口里的报错（含通话断线、界面上显示的错误）也记下来
  win.webContents.on('console-message', (e) => { if (e.level === 'error' || e.level === 3) logErr('renderer', e.message); });
  win.on('close', (e) => { if (!app.isQuitting) { e.preventDefault(); win.hide(); } });
}

function showWindow(focus = true) {
  if (!win) return;
  if (focus) { win.show(); win.focus(); } else win.showInactive();
}

function refreshTray() {
  if (!tray) return;
  tray.setTitle(running ? '● 参谋' : '○ 参谋');
  tray.setToolTip(running ? '钢铁雄心4 运行中，参谋在线' : '等待钢铁雄心4启动');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: running ? '钢铁雄心4：运行中' : '钢铁雄心4：未运行', enabled: false },
    { type: 'separator' },
    { label: '打开参谋窗口', click: () => showWindow(true) },
    { label: `语音提问（${cfg.hotkey}）`, click: () => { showWindow(false); send('hotkey'); } },
    { label: '新对话', click: () => { agent.reset(); send('reset'); } },
    { type: 'separator' },
    { label: telegraph && telegraph.connected ? `电报机：${telegraph.summary}已接入` : '电报机：未接入', enabled: false },
    ...(autostart.packagedExec() ? [{ label: '开机自动在后台启动', type: 'checkbox', checked: cfg.autoStart !== false, click: (it) => setAutoStart(it.checked) }] : []),
    { type: 'separator' },
    { label: '退出', click: () => { app.isQuitting = true; app.quit(); } },
  ]));
}

function warm() {
  setTimeout(() => { try { gd.refreshIfChanged(); gd.warm(); } catch (e) { console.error('预热失败', e); } }, 200);
}

// 游戏开起来时参谋报到（不提“检测到钢铁雄心4”这种软件腔，开局时国家和日期多半还不确定，所以不带称谓和占位）
const START_LINES = ['参谋部报到，请指示。', '参谋部值班，候令。', '指挥所通信就绪，请指示。', '作战参谋就位，待命。', '线路畅通，参谋部候令。', '参谋部到位，随时候命。'];

async function pollGame() {
  const now = await isProcessRunning('hoi4');
  watchCountry();
  if (now !== running) {
    running = now;
    refreshTray();
    if (!running) gd.clearCountry(); // 先清，窗口收到状态后再来读局面
    const line = running ? START_LINES[Math.floor(Math.random() * START_LINES.length)] : null;
    send('game-status', { running, line });
    if (running) {
      warm();
      if (Notification.isSupported()) new Notification({ title: '参谋电报机', body: line }).show();
    }
  }
}

// 国内中转走代理反而连不上，可以在设置里关掉
function applyProxy() {
  return session.defaultSession.setProxy(cfg.useProxy === false ? { mode: 'direct' } : { mode: 'system' });
}

function registerHotkey() {
  if (process.env.ADVISOR_SNAPSHOT) return; // 自检实例不抢用户正在用的快捷键
  globalShortcut.unregisterAll();
  if (!cfg.hotkey) return;
  const ok = globalShortcut.register(cfg.hotkey, () => { showWindow(false); send('hotkey'); });
  if (!ok) send('toast', `快捷键 ${cfg.hotkey} 被占用，换一个`);
}

// 网络层的报错（连不上、证书、代理）也翻成人话
const netHint = (e) => (/net::|fetch failed|ECONN|ENOTFOUND|ETIMEDOUT|certificate/i.test(e.message)
  ? `连不上接口：${cfg.useProxy === false ? '现在没走代理，官方 OpenAI 需要打开「走系统代理」' : '现在走系统代理，国内中转可以试试关掉「走系统代理」'}。（${e.message}）`
  : e.message);
ipcMain.handle('ask', async (_e, text) => {
  try { return { ok: true, ...(await agent.ask(text, (ev) => send('agent-event', ev))) }; }
  catch (e) { logErr('ask', e.stack || e.message); return { ok: false, error: netHint(e) }; }
});
ipcMain.handle('transcribe', async (_e, audio, mime) => {
  try { return { ok: true, text: await agent.transcribe(Buffer.from(audio), mime) }; }
  catch (e) { logErr('transcribe', e.message); return { ok: false, error: netHint(e) }; }
});
ipcMain.handle('tts', async (_e, text) => {
  try { return { ok: true, audio: await agent.speak(text) }; }
  catch (e) { logErr('tts', e.message); return { ok: false, error: e.message }; }
});
ipcMain.handle('list-models', async (_e, opts) => {
  try { return { ok: true, models: await agent.listModels(opts) }; }
  catch (e) { return { ok: false, error: netHint(e) }; }
});
// GPT-Live：主进程拿官方 Key 建会话，只把 SDP answer 交给窗口
ipcMain.handle('live-create', async (_e, sdp) => {
  if (!cfg.liveApiKey) return { ok: false, error: '先在设置里填「GPT Live 官方 Key」' };
  try {
    const res = await net.fetch(cfg.liveBaseURL.replace(/\/+$/, '') + '/live/sessions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.liveApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(liveSessionBody(cfg, sdp)),
    });
    const text = await res.text();
    if (!res.ok) { logErr('live-create', `${res.status} ${text}`); return { ok: false, error: explain(res.status, text) }; }
    const data = JSON.parse(text);
    return { ok: true, id: data.session && data.session.id, sdp: data.transport && data.transport.sdp };
  } catch (e) { logErr('live-create', e.message); return { ok: false, error: netHint(e) }; }
});
ipcMain.handle('game-state', async () => {
  try { return await gd.gameState(running); } catch (e) { return { error: e.message }; }
});
ipcMain.handle('get-config', () => ({ ...cfg, apiKey: '', liveApiKey: '', doubaoToken: '', fishApiKey: '', hasKey: !!cfg.apiKey, hasLiveKey: !!cfg.liveApiKey, hasFishKey: !!cfg.fishApiKey, running }));
ipcMain.handle('save-config', async (_e, patch) => {
  const next = { ...cfg, ...patch };
  if (!patch.apiKey) next.apiKey = cfg.apiKey; // 留空表示不改
  if (!patch.liveApiKey) next.liveApiKey = cfg.liveApiKey;
  if (!patch.doubaoToken) next.doubaoToken = cfg.doubaoToken;
  if (!patch.fishApiKey) next.fishApiKey = cfg.fishApiKey;
  const dirsChanged = next.gameDir !== cfg.gameDir || next.userDir !== cfg.userDir;
  Object.assign(cfg, next);
  config.save(cfg);
  if (dirsChanged) { gd = new GameData({ gameDir: cfg.gameDir, userDir: cfg.userDir }); agent.gd = gd; if (gfx) gfx.gd = gd; warm(); }
  registerHotkey();
  refreshTray();
  await applyProxy();
  return { ok: true };
});
ipcMain.handle('reset', () => { agent.reset(); return true; });
ipcMain.handle('gfx-ui', async () => {
  try {
    const st = await gd.gameState(running);
    const s = st.latest_save || {};
    return { ...(await gfx.ui()), flag: st.country_uncertain ? null : await gfx.flag(s.player_tag, s.player_ideology) };
  } catch (e) { return {}; }
});
ipcMain.handle('flag', async (_e, tag, ideology) => {
  try { return await gfx.flag(tag, ideology); } catch { return null; }
});
// 游戏自带的真实音效（从玩家本机游戏目录读，不进仓库）
const SFX_FILES = {
  near: ['explosion_big_01', 'explosion_large_01', 'explosion_large_03', 'explosion_large_05'].map((f) => `audiofiles/${f}.wav`),
  far: ['explosion_large_02', 'explosion_large_04', 'explosion_large_06', 'explosion_small_01', 'explosion_small_02', 'explosion_small_03', 'impact_low_01'].map((f) => `audiofiles/${f}.wav`),
  gun: ['colt_fire_01', 'colt_fire_03', 'luger_fire_01', 'luger_fire_02', 'luger_fire_04', 'revolver_fire_02', 'revolver_fire_05'].map((f) => `pistol_sound_assets/pistol_${f}.wav`),
};
ipcMain.handle('sfx-bank', () => {
  const root = path.join(gd.gameDir, 'sound');
  const out = {};
  for (const [k, list] of Object.entries(SFX_FILES)) {
    out[k] = list.map((f) => { try { return require('fs').readFileSync(path.join(root, f)); } catch { return null; } }).filter(Boolean);
  }
  return out;
});

// 流式朗读：一边从 OpenAI 收 mp3 一边推给窗口播放，第一句话不用等整段生成完
ipcMain.on('tts-stream', async (e, { id, text }) => {
  const sender = e.sender;
  try {
    if (cfg.ttsEngine === 'doubao') {
      const buf = await agent.speak(text);
      if (!sender.isDestroyed()) { sender.send('tts-chunk', { id, chunk: buf }); sender.send('tts-chunk', { id, done: true }); }
      return;
    }
    const res = await agent.speakStream(text);
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!sender.isDestroyed()) sender.send('tts-chunk', { id, chunk: value });
    }
    if (!sender.isDestroyed()) sender.send('tts-chunk', { id, done: true });
  } catch (err) {
    logErr('tts-stream', err.message);
    if (!sender.isDestroyed()) sender.send('tts-chunk', { id, error: err.message });
  }
});

// 通话换声：Fish 实时流式合成。每轮回答一条会话，音频片段沿用 tts-chunk 推给窗口
const fishSessions = new Map();
let fishSpare = null; // 提前连好、发过 start 的备用会话，省掉建连接的时间
function newFishSession() {
  const s = new FishLiveSession({
    apiKey: cfg.fishApiKey, model: cfg.fishModel, voice: cfg.fishVoice, speed: cfg.fishSpeed,
    onAudio: (buf) => s.sender && !s.sender.isDestroyed() && s.sender.send('tts-chunk', { id: s.id, chunk: buf }),
    onFinish: () => { fishSessions.delete(s.id); if (s.id && s.sender && !s.sender.isDestroyed()) s.sender.send('tts-chunk', { id: s.id, done: true }); if (s === fishSpare) fishSpare = null; },
    onError: (e) => { fishSessions.delete(s.id); logErr('fish-live', e.message); if (s.id && s.sender && !s.sender.isDestroyed()) s.sender.send('tts-chunk', { id: s.id, error: e.message }); if (s === fishSpare) fishSpare = null; },
  });
  s.createdAt = Date.now();
  return s;
}
ipcMain.on('fishlive', (e, { op, id, text }) => {
  if (op === 'prewarm') {
    if (!cfg.fishApiKey) return;
    if (fishSpare && (fishSpare.done || Date.now() - fishSpare.createdAt > 50000)) { fishSpare.cancel(); fishSpare = null; }
    if (!fishSpare) fishSpare = newFishSession();
    return;
  }
  if (op === 'start') {
    let s = fishSpare && !fishSpare.done ? fishSpare : newFishSession();
    if (s === fishSpare) fishSpare = null;
    s.id = id;
    s.sender = e.sender;
    fishSessions.set(id, s);
    return;
  }
  const s = fishSessions.get(id);
  if (!s) return;
  if (op === 'text') s.text(text);
  else if (op === 'flush') s.flush();
  else if (op === 'stop') { s.flush(); s.stop(); }
  else if (op === 'cancel') { s.cancel(); fishSessions.delete(id); }
});

// 固定短句（“收到，正在核对。”）生成一次缓存到磁盘，发问时立刻播
ipcMain.handle('tts-cached', async (_e, text) => {
  const fs = require('fs');
  const voiceKey = { doubao: cfg.doubaoVoice + cfg.doubaoSpeed, fish: cfg.fishVoice + cfg.fishModel + cfg.fishSpeed }[cfg.ttsEngine] || cfg.ttsModel + (cfg.ttsVoice || cfg.liveVoice) + cfg.ttsInstructions;
  const key = require('crypto').createHash('md5').update([text, cfg.ttsEngine, voiceKey].join('|')).digest('hex');
  const dir = path.join(app.getPath('userData'), 'tts-cache');
  const file = path.join(dir, key + '.mp3');
  try {
    if (fs.existsSync(file)) return fs.readFileSync(file);
    const buf = Buffer.from(await agent.speak(text));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, buf);
    return buf;
  } catch (err) { logErr('tts-cached', err.message); return null; }
});
ipcMain.handle('focus-icons', async (_e, ids) => {
  try { return await gfx.focusIcons((ids || []).slice(0, 60)); } catch { return {}; }
});
// ---------- 参谋电报机硬件 ----------
let telegraph = null;
function startTelegraph() {
  if (process.env.ADVISOR_SNAPSHOT && !process.env.ADVISOR_HW) return; // 自检实例不抢正在用的电报机
  telegraph = new Telegraph({
    find: process.env.ADVISOR_HW_PORT ? async () => process.env.ADVISOR_HW_PORT : undefined, // 自检：指定一个假串口
    log: (m) => logErr('telegraph', m),
    onEvent: (e) => {
      send('hw', e);
      if (e.type === 'btn') logErr('telegraph', `按键：${{ base: '主箱', handset: '手柄' }[e.role] || '?'} ${{ DIAL: '拨打', HANG: '挂断', PTT: '说话', SEND: '发送', DEL: '删除' }[e.key] || e.key} ${e.down ? '按下' : '松开'}`);
      if (e.type === 'status') { logErr('telegraph', e.connected ? `已接入：${e.summary}` : '电报机全部断开'); refreshTray(); }
    },
  });
  telegraph.start();
}
ipcMain.handle('hw-status', () => ({ connected: !!(telegraph && telegraph.connected), boards: telegraph ? telegraph.boards : [], summary: telegraph ? telegraph.summary : '' }));
function setAutoStart(on) {
  cfg = { ...cfg, autoStart: on };
  config.save(cfg);
  if (on) autostart.enable(); else autostart.disable();
}

ipcMain.handle('mic-permission', async () => {
  if (process.platform !== 'darwin') return true;
  return systemPreferences.askForMediaAccess('microphone');
});
ipcMain.on('hide', () => win && win.hide());
ipcMain.on('peek', () => showWindow(false)); // 浮出来给人看一眼，不抢游戏的焦点

// 没有屏幕录制权限：先向系统申请一次（这样「参谋电报机」才会出现在系统设置的列表里），窗口里再提示去打开
function checkScreenPermission() {
  if (process.platform !== 'darwin' || process.env.ADVISOR_SNAPSHOT) return;
  if (systemPreferences.getMediaAccessStatus('screen') === 'granted') return;
  desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } }).catch(() => {});
  win.webContents.once('did-finish-load', () => send('need-screen'));
}
ipcMain.on('open-screen-settings', () => shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'));

app.on('second-instance', () => showWindow(true));
app.on('activate', () => showWindow(true)); // 参谋已在运行时再点一次 App 图标
app.whenReady().then(() => {
  if (app.dock) app.dock.hide(); // 纯后台，不占 Dock
  applyProxy();
  gfx = new Gfx({ gamedata: gd, cacheDir: require('path').join(app.getPath('userData'), 'gfx-cache') });
  protocol.handle('gfx', (req) => {
    const file = gfx.fileFor(req.url);
    if (!file) return new Response('not found', { status: 404 });
    return new Response(require('fs').readFileSync(file), { headers: { 'content-type': 'image/png', 'access-control-allow-origin': '*' } });
  });
  tray = new Tray(nativeImage.createEmpty());
  tray.on('click', () => (win.isVisible() ? win.hide() : showWindow(true)));
  createWindow();
  checkScreenPermission();
  refreshTray();
  registerHotkey();
  pollGame();
  setInterval(pollGame, 3000);
  warm();
  // 自己点开 App 就看到窗口；开机自启（--hidden）只在菜单栏待命，没填 Key 时例外
  if (!process.env.ADVISOR_SNAPSHOT && (!process.argv.includes('--hidden') || !cfg.apiKey)) win.once('ready-to-show', () => showWindow(true));
  if (cfg.autoStart !== false && autostart.packagedExec() && !autostart.isEnabled()) autostart.enable();
  startTelegraph();
  if (process.env.ADVISOR_SNAPSHOT) selfCheck(process.env.ADVISOR_SNAPSHOT);
});

// 自检：ADVISOR_SNAPSHOT=图片路径 npm start，几秒后截窗口、打印状态然后退出
async function selfCheck(file) {
  await new Promise((r) => setTimeout(r, 7000));
  // 隐形：全透明、点不到，免得用户以为是正式窗口在里面提问
  win.setOpacity(0);
  win.setIgnoreMouseEvents(true);
  showWindow(false);
  // ADVISOR_PROBE_TIMES=1：记下声音开口、结论上屏、完整卡片、电台字幕各自的时间，看文字和声音谁先谁后
  if (process.env.ADVISOR_PROBE_TIMES) await win.webContents.executeJavaScript(`(() => {
    const t0 = performance.now(); window.__ev = [];
    const mark = (k) => window.__ev.push(k + ' ' + ((performance.now() - t0) / 1000).toFixed(2) + 's');
    const _vs = window.voiceStarted; window.voiceStarted = function () { mark('声音开口'); return _vs(); };
    const _dd = window.didi; window.didi = function () { mark('滴滴滴'); return _dd(); };
    const _hv = window.hushVoice; if (_hv) window.hushVoice = function () { mark('挂断键打断朗读'); return _hv(); };
    window.api && 0;
    new MutationObserver((ms) => ms.forEach((m) => m.addedNodes.forEach((n) => {
      const c = n.classList; if (!c) return;
      if (c.contains('early')) mark('结论上屏');
      else if (c.contains('route') || c.contains('bot')) mark('完整卡片');
      else if (c.contains('cap')) mark('电台字幕');
      else if (c.contains('sys')) mark('系统行「' + n.textContent.slice(0, 10) + '」');
    }))).observe(document.getElementById('log'), { childList: true });
  })()`);
  if (process.env.ADVISOR_ASK) await win.webContents.executeJavaScript(`document.getElementById('text').value=${JSON.stringify(process.env.ADVISOR_ASK)};document.getElementById('btnSend').click();`);
  if (process.env.ADVISOR_LIVE) {
    // 自检 GPT Live：把一段 wav 换成“麦克风”，接通 2.5 秒后播放一遍
    const b64 = require('fs').readFileSync(process.env.ADVISOR_LIVE).toString('base64');
    await win.webContents.executeJavaScript(`(async () => {
      const bytes = Uint8Array.from(atob('${b64}'), (c) => c.charCodeAt(0));
      const ctx = new AudioContext();
      const buf = await ctx.decodeAudioData(bytes.buffer);
      const dest = ctx.createMediaStreamDestination();
      const keep = ctx.createConstantSource(); keep.offset.value = 0; keep.connect(dest); keep.start();
      navigator.mediaDevices.getUserMedia = async () => dest.stream;
      const play = (b) => { const src = ctx.createBufferSource(); src.buffer = b; src.connect(dest); src.start(); return b.duration * 1000; };
      ${process.env.ADVISOR_LIVE_NOISE ? `const noise = await ctx.decodeAudioData(Uint8Array.from(atob('${require('fs').readFileSync(process.env.ADVISOR_LIVE_NOISE).toString('base64')}'), (c) => c.charCodeAt(0)).buffer);` : 'const noise = null;'}
      const t = setInterval(async () => {
        if (live && live.state === 'on') {
          clearInterval(t);
          await new Promise((r) => setTimeout(r, 2000));
          // 先在静音状态放一段“旁边人聊天”，再按住讲话问正题
          if (noise) { console.log('SELFCHECK-STEP 放背景人声（静音中）'); await new Promise((r) => setTimeout(r, play(noise) + 1500)); }
          if (cfg.livePushToTalk !== false) setTalk(live, true);
          console.log('SELFCHECK-STEP 按住讲话，提问');
          await new Promise((r) => setTimeout(r, play(buf) + 800));
          if (cfg.livePushToTalk !== false) setTalk(live, false);
        }
      }, 200);
      if (${!!process.env.ADVISOR_PROBE_SYNC}) {
        window.__s = { voices: [], card: 0, ahead: 0, samples: 0 };
        const _vs = window.voiceStarted; window.voiceStarted = function () { window.__s.voices.push(performance.now()); return _vs(); };
        const _add = window.add; window.add = function (c, h) { if (c === 'route' && !window.__s.card) window.__s.card = performance.now(); return _add(c, h); };
        setInterval(() => { for (const p of fl.players) { if (p.cap && !p.audio.paused) { window.__s.samples++; const said = p.audio.currentTime * fl.cps; if (p.shown > said + 4) window.__s.ahead++; } } }, 150);
      }
      startLive();
    })()`);
  }
  await new Promise((r) => setTimeout(r, Number(process.env.ADVISOR_WAIT || 2000)));
  if (process.env.ADVISOR_LIVE) await win.webContents.executeJavaScript('stopLive("自检结束")');
  if (process.env.ADVISOR_PROBE_TIMES) console.log('TIMES ' + (await win.webContents.executeJavaScript('(window.__ev || []).join(" | ")')));
  console.log('LOG\n' + (await win.webContents.executeJavaScript("document.getElementById('log').innerText")));
  require('fs').writeFileSync(file, (await win.webContents.capturePage()).toPNG());
  // ADVISOR_SHOTS='[{"js":"…","file":"…"}]'：再拍几张不同状态
  for (const shot of JSON.parse(process.env.ADVISOR_SHOTS || '[]')) {
    await win.webContents.executeJavaScript(shot.js);
    await new Promise((r) => setTimeout(r, 800));
    require('fs').writeFileSync(shot.file, (await win.webContents.capturePage()).toPNG());
    if (shot.dump) console.log('SHOT-DUMP\n' + (await win.webContents.executeJavaScript(shot.dump)));
  }
  console.log('SELFCHECK', JSON.stringify({ running, tray: tray.getTitle() }));
  app.isQuitting = true;
  app.quit();
}
app.on('before-quit', () => { app.isQuitting = true; }); // 系统退出/SIGTERM 也要真退出，不能被“关窗只隐藏”拦住
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', (e) => e.preventDefault());
