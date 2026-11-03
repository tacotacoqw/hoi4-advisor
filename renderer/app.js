// 参谋窗口：录音、发问、显示回答、滴滴滴、朗读
const $ = (id) => document.getElementById(id);
const api = window.advisor;
let cfg = {};
let busy = false;

// ---------- 电报声 ----------
let actx = null;
const ctx = () => (actx ||= new AudioContext());
function tone(at, dur, vol = 0.25, freq = 760) {
  const c = ctx();
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = 'square';
  o.frequency.value = freq;
  const lp = c.createBiquadFilter();
  lp.type = 'lowpass'; lp.frequency.value = 1800;
  g.gain.setValueAtTime(0, at);
  g.gain.linearRampToValueAtTime(vol, at + 0.005);
  g.gain.setValueAtTime(vol, at + dur - 0.01);
  g.gain.linearRampToValueAtTime(0, at + dur);
  o.connect(lp).connect(g).connect(c.destination);
  o.start(at); o.stop(at + dur + 0.02);
}
// 按摩尔斯节奏播放，"." 滴 "-" 嗒，返回总时长（秒）
function morse(pattern, vol = 0.25, unit = 0.075) {
  const c = ctx();
  let t = c.currentTime + 0.03;
  for (const ch of pattern) {
    if (ch === '.') { tone(t, unit, vol); t += unit * 2; }
    else if (ch === '-') { tone(t, unit * 3, vol); t += unit * 4; }
    else t += unit * 3;
  }
  return t - c.currentTime;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function didi() { if (cfg.beep) await sleep(morse('...') * 1000 + 120); }
// 现在有没有人声在放（打字朗读 / 电台分句合成 / Fish 实时流）
function voiceBusy() {
  const on = (a) => a && !a.paused && !a.ended;
  return on(speaking) || lv.playing || fl.players.some((p) => on(p.audio));
}
// 回复到了先滴滴滴；电台里正有人说话（比如“收到，正在核实”）就等这句说完，等太久就不滴了
async function didiWhenQuiet(maxMs = 5000) {
  const t = Date.now();
  while (voiceBusy() && Date.now() - t < maxMs) await sleep(100);
  if (!voiceBusy()) await didi();
}

// 思考时轻轻的“收报声”
let tickTimer = null;
function startTicking() {
  if (!cfg.beepWhileThinking) return;
  const letters = ['.-', '-...', '-.-.', '..', '.--.', '--.-', '...-', '-.', '.-..', '--'];
  const loop = () => {
    const d = morse(letters[Math.floor(Math.random() * letters.length)], 0.05, 0.06);
    tickTimer = setTimeout(loop, d * 1000 + 350 + Math.random() * 500);
  };
  loop();
}
function stopTicking() { clearTimeout(tickTimer); tickTimer = null; }

// ---------- 界面 ----------
const log = $('log');
function scroll() { log.scrollTop = log.scrollHeight; }
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function rich(s) {
  return esc(s)
    .replace(/^#{1,4}\s*(.+)$/gm, '<b>$1</b>')
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/`([^`]+)`/g, '$1');
}
function add(cls, html) {
  if (cls === 'user') html = `<b class="stamp">去电</b>${html}`;
  if (cls === 'cap') html = `<b class="lbl">电台</b>${html}`;
  if (cls === 'err') console.error('[界面报错] ' + String(html).replace(/<[^>]+>/g, ''));
  const d = document.createElement('div');
  d.className = 'msg ' + cls;
  d.innerHTML = html;
  log.appendChild(d);
  scroll();
  return d;
}
function toast(text, ms = 2500) {
  const t = $('toast');
  t.textContent = text;
  t.classList.remove('hidden');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.add('hidden'), ms);
}
function setLamp() {
  const lamp = $('lamp');
  lamp.className = 'lamp' + (recording || (live && live.talking) ? ' rec' : busy ? ' busy' : live ? ' live' : cfg.running ? ' on' : '');
}

async function refreshStatus() {
  const st = await api.gameState();
  if (st.error) { $('status').textContent = '读局面失败：' + st.error; return; }
  cfg.running = st.hoi4_running;
  setLamp();
  const s = st.latest_save || {};
  const cur = currentCountry(st);
  const on = st.hoi4_running;
  const parts = [on ? '游戏运行中' : '游戏未运行'];
  if (on) parts.push(cur ? `${cur.country || ''} ${cur.tag}` : '国别待确认');
  const wasWar = atWar;
  atWar = on && st.at_war === true; // 游戏关了就不算交战（不放炮火）
  if (wasWar !== atWar && live && live.state === 'on' && !live.byUs) {
    live.client.append('thinking', atWar ? `战争状态更新：玩家国家刚刚进入交战（对 ${st.enemies.map((e) => e.name).join('、')}），从现在起报告更短、更紧迫。` : '战争状态更新：玩家国家已经停战，语气改回从容沉稳。');
  }
  if (on && st.log_game_date) parts.push(st.log_game_date);
  else if (on && st.last_save_title) parts.push(st.last_save_title);
  let html = esc(parts.join(' · '));
  if (!on) { /* 上一局的国家、战争状态都不显示 */ }
  else if (st.at_war === true) html += ` · <span class="war" title="${esc(st.enemies.map((e) => `${e.name}（${e.since} 开战）`).join('、'))}">交战：${esc(st.enemies.map((e) => e.name).join('、'))}</span>`;
  else if (st.at_war === false) html += ' · <span class="peace">和平</span>';
  if (st.latest_save && st.latest_save.format === 'binary') html += ' · <span class="warn" title="二进制存档读不到国策进度：settings.txt 里 save_as_binary=no 后重新存档">二进制存档</span>';
  $('status').innerHTML = html;
  $('status').title = !on ? '开局后参谋会认出你玩的国家' : cur ? '' : '切回游戏画面，参谋会看左上角国旗认出国家（或存一次档）';
  const key = cur ? `${cur.tag}_${cur.ideology}` : '';
  if (key !== lastCountry) {
    lastCountry = key;
    const url = key ? await api.flag(cur.tag, cur.ideology) : null;
    if (url) $('flag').src = url;
    $('flag').hidden = !url;
  }
}
let lastCountry = null;
// 当前国家：画面认出来的 > 最新存档（新开局还没存档时为 null）
function currentCountry(st) {
  const s = st.latest_save || {};
  if (!st.hoi4_running) return null; // 游戏关了：上一局的国家不再显示
  if (st.screen_country) return st.screen_country;
  if (st.country_uncertain || !s.player_tag) return null;
  return { tag: s.player_tag, ideology: s.player_ideology, country: s.player_country };
}
api.on('country', () => refreshStatus());

let speaking = null;
let atWar = false; // 来自存档：玩家国家是否正在交战。和平时不放枪炮声
const battleOn = () => cfg.battleSfx !== false && atWar && window.Battle;

// 人声处理：稍加厚低频和齿音、适度压缩，更饱满有力；不加过载，免得有电子味
let vctx = null;
let vin = null;
function voiceInput() {
  if (vin) return vin;
  vctx = new AudioContext();
  const low = vctx.createBiquadFilter(); low.type = 'lowshelf'; low.frequency.value = 140; low.gain.value = 3;
  const pres = vctx.createBiquadFilter(); pres.type = 'peaking'; pres.frequency.value = 2800; pres.Q.value = 0.9; pres.gain.value = 2;
  const comp = vctx.createDynamicsCompressor();
  comp.threshold.value = -22; comp.knee.value = 10; comp.ratio.value = 4; comp.attack.value = 0.005; comp.release.value = 0.2;
  const makeup = vctx.createGain(); makeup.gain.value = 1.4;
  // 末端限幅：和炮声叠在一起也不破音
  const limit = vctx.createDynamicsCompressor();
  limit.threshold.value = -6; limit.knee.value = 0; limit.ratio.value = 20; limit.attack.value = 0.001; limit.release.value = 0.08;
  low.connect(pres).connect(comp).connect(makeup).connect(limit).connect(vctx.destination);
  vin = low;
  return vin;
}
function voiceOut(el) {
  try {
    const input = voiceInput();
    vctx.createMediaElementSource(el).connect(input);
    if (vctx.state === 'suspended') vctx.resume();
  } catch (e) { console.warn('喊话效果没接上', e); }
}
function voiceStream(stream) {
  try {
    const input = voiceInput();
    vctx.createMediaStreamSource(stream).connect(input);
    if (vctx.state === 'suspended') vctx.resume();
  } catch (e) { console.warn('通话喊话效果没接上', e); }
}

// 流式朗读：主进程一边收 mp3 一边推过来，MediaSource 边收边播
let ttsSeq = 0;
const ttsJobs = new Map();
api.on('tts-chunk', (m) => {
  const j = ttsJobs.get(m.id);
  if (!j) return;
  if (m.error) j.fail(m.error);
  else if (m.done) j.end();
  else j.push(m.chunk);
});
// 边收边播的播放器：mp3 片段陆续 push 进来，MediaSource 接着播；返回 { id, audio }
// minLead：攒够这么多秒的声音才开播（缓冲垫），免得边收边播时念一半卡住
function streamPlayer({ onFail, autoplay = true, minLead = 0 } = {}) {
  const id = ++ttsSeq;
  const ms = new MediaSource();
  const audio = new Audio();
  audio.src = URL.createObjectURL(ms);
  voiceOut(audio);
  const queue = [];
  let sb = null, ended = false, started = false, want = autoplay;
  const lead = () => (audio.buffered.length ? audio.buffered.end(audio.buffered.length - 1) - audio.currentTime : 0);
  const tryStart = () => {
    if (want && !started && (lead() >= minLead || (ended && !queue.length && audio.buffered.length))) {
      started = true;
      audio.play().catch(() => {});
    }
  };
  const pump = () => {
    if (!sb || sb.updating) return;
    if (queue.length) sb.appendBuffer(queue.shift());
    else if (ended && ms.readyState === 'open') { try { ms.endOfStream(); } catch {} tryStart(); }
  };
  ms.addEventListener('sourceopen', () => {
    sb = ms.addSourceBuffer('audio/mpeg');
    sb.addEventListener('updateend', () => { tryStart(); pump(); });
    pump();
  });
  ttsJobs.set(id, {
    push: (c) => { queue.push(c); pump(); },
    end: () => { ended = true; ttsJobs.delete(id); pump(); },
    fail: (err) => { ttsJobs.delete(id); ended = true; pump(); if (onFail) onFail(err); },
  });
  return { id, audio, start: () => { want = true; tryStart(); } };
}

function speakStream(text) {
  return new Promise((resolve) => {
    const { id, audio } = streamPlayer({
      onFail: (err) => { toast('朗读接口用不了，改用系统声音：' + String(err).slice(0, 60), 4000); systemSpeak(text); resolve(); },
    });
    audio.onplaying = () => { if (battleOn()) Battle.start(); voiceStarted(); };
    audio.onended = () => { if (battleOn()) Battle.stop(400); URL.revokeObjectURL(audio.src); resolve(); };
    audio.onpause = () => { if (battleOn()) Battle.stop(0); };
    if (speaking) speaking.pause();
    speaking = audio;
    api.ttsStream(id, text);
  });
}

// 发问时立刻回一句（预先生成缓存好的），配一声炮响，不用干等答案
// 只表示“听到了、开始核对”，不提前下结论；不用“好的/交给我/翻档案”这类客服腔
const ACKS = {
  war: ['收到，立即核对！', '明白，立即核实！', '收到，正在核实！', '明白，稍候！', '查明后立即报告！', '收到，马上核对！', '明白，正在核对！', '收到，稍候！'],
  peace: ['收到。', '明白。', '收到，正在核对。', '明白，正在核实。', '正在核对。', '稍候，查明后报告。', '收到，查明后报告。', '明白，稍候。'],
};
const lastAck = { war: -1, peace: -1 };
function pickIndex(n, last) { // 随机，但不和上一次相同
  if (n < 2) return 0;
  let i = Math.floor(Math.random() * (n - 1));
  return i >= last ? i + 1 : i;
}
const ackClips = { war: [], peace: [] };
async function preloadAcks() {
  if (cfg.ttsEngine === 'system' || !cfg.speak) return;
  for (const kind of ['peace', 'war']) {
    for (const t of ACKS[kind]) {
      const buf = await api.ttsCached(t);
      if (buf) ackClips[kind].push(new Blob([buf], { type: 'audio/mpeg' }));
    }
  }
}
function playAck() {
  if (!cfg.speak || liveMode()) return;
  if (battleOn()) Battle.opener(); // 交战时才有那一声炮响
  const kind = atWar ? 'war' : 'peace';
  const clips = ackClips[kind];
  if (!clips.length) return;
  lastAck[kind] = pickIndex(clips.length, lastAck[kind]);
  const a = new Audio(URL.createObjectURL(clips[lastAck[kind]]));
  voiceOut(a);
  if (speaking) speaking.pause();
  speaking = a;
  a.play().catch(() => {});
}
function systemSpeak(text) {
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'zh-CN';
  u.rate = 1.1;
  u.onstart = () => battleOn() && Battle.start();
  u.onend = () => battleOn() && Battle.stop(400);
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
}
async function speakText(text) {
  if (!cfg.speak || !text) return;
  voiceGate = waitVoice(4000);
  if (cfg.ttsEngine === 'system') { systemSpeak(text); return; }
  if (window.MediaSource && MediaSource.isTypeSupported('audio/mpeg')) return speakStream(text);
  const r = await api.tts(text);
  if (!r.ok) {
    // 接口不支持朗读时，用 macOS 自带的中文声音顶上
    if (!speakText.warned) { toast('朗读接口用不了，改用系统声音：' + r.error.slice(0, 80), 5000); speakText.warned = true; }
    systemSpeak(text);
    return;
  }
  if (speaking) speaking.pause();
  const url = URL.createObjectURL(new Blob([r.audio], { type: 'audio/mpeg' }));
  speaking = new Audio(url);
  voiceOut(speaking);
  // 开口一声炮响，说话期间远处交火，说完停
  speaking.onplaying = () => battleOn() && Battle.start();
  speaking.onended = () => { URL.revokeObjectURL(url); if (battleOn()) Battle.stop(400); };
  speaking.onpause = () => battleOn() && Battle.stop(0);
  await speaking.play().catch(() => {});
}

let steps = null;
let agentChain = Promise.resolve();
// 等下一次“声音开口”（最多等 ms 毫秒）：答案卡片和声音一起出现，不让文字抢在前面
let voiceWaiters = [];
function voiceStarted() { voiceWaiters.forEach((f) => f()); voiceWaiters = []; }
function waitVoice(ms) { return new Promise((res) => { voiceWaiters.push(res); setTimeout(res, ms); }); }
const k = (n) => (n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n));
const plainText = (t) => String(t || '').replace(/[*#`>]/g, '').replace(/\n{2,}/g, '\n').trim();

// 问后台参谋；排队执行，打字提问和通话里的委派不会撞车
let queued = 0;
let currentJob = null; // 正在问的这一问：流式回答里【播报】一写完就交给它
function runAgent(text, { showUser = true, inLive = false, shouldRun, onAnswer, beforeShow, onSpeech } = {}) {
  if (showUser) add('user', esc(text));
  const mySteps = document.createElement('div');
  mySteps.className = 'steps';
  mySteps.innerHTML = busy || queued ? '<div>排队中，前一份电报还没译完…</div>' : '<div>收报中…</div>';
  log.appendChild(mySteps); scroll();
  queued++;
  const job = async () => {
    queued--;
    if (shouldRun && !shouldRun()) { mySteps.remove(); return { ok: false, skipped: true }; }
    busy = true; setLamp();
    steps = mySteps;
    steps.innerHTML = '<div>收报中…</div>';
    if (!inLive) { speechSynthesis.cancel(); startTicking(); if (battleOn() && cfg.speak) Battle.waitBarrage(true); }
    // 结论一写出来就先念；念的同时把这句结论先上屏（详述还在写），整份答复到了再原地补全成完整卡片
    let early = null, shown = false, beeped = false;
    currentJob = { onSpeech: (sp) => {
      // 回复到了：收报声停，先“滴滴滴”——这时语音还在准备（合成/电台要一两秒），不会和人声撞上
      stopTicking();
      beeped = true;
      didiWhenQuiet();
      if (onSpeech) onSpeech(sp);
      Promise.resolve(beforeShow ? beforeShow() : null).then(() => {
        if (shown || early) return;
        early = add('bot early', `<span class="speech"><b class="lbl">来电</b>${esc(sp)}</span><div class="early-note">参谋详述译电中…</div>`);
      });
    } };
    const r = await api.ask(inLive ? `（语音通话转写，可能有错字）玩家说：「${text}」` : text);
    currentJob = null;
    stopTicking();
    if (window.Battle) Battle.waitBarrage(false);
    busy = false; setLamp();
    if (!r.ok) { shown = true; if (early) early.querySelector('.early-note').remove(); add('err', esc(r.error)); return r; }
    if (onAnswer) onAnswer(r); // 答案一到就去要语音，和滴滴声同时进行
    if (!early) { // 结论还没上屏：先滴滴滴（流式时已经响过）、等声音开口再出卡片
      if (!beeped) await didi();
      if (beforeShow) await beforeShow(r);
    }
    shown = true;
    const card = r.route && r.route.steps && r.route.steps.length
      ? renderRoute(r)
      : add('bot', rich(r.text) + (r.speech ? `<span class="speech"><b class="lbl">来电</b>${esc(r.speech)}</span>` : ''));
    if (early) { early.replaceWith(card); scroll(); }
    // 用量不打断沉浸感：鼠标悬停才看得到
    if (r.usage) card.title = `本次调用 ${r.usage.calls} 次 · 输入 ${k(r.usage.input)} / 输出 ${k(r.usage.output)} tokens`;
    return r;
  };
  const p = agentChain.then(job, job);
  agentChain = p.catch(() => {});
  return p;
}

let voiceGate = null;
async function ask(text) {
  text = text.trim();
  if (!text) return;
  voiceGate = null;
  await refreshStatus(); // 刚宣战也能马上切到交战（炮火、语气）
  playAck();
  const inCall = () => live && live.state === 'on' && !live.byUs;
  const willSpeak = () => !inCall() && cfg.speak && cfg.ttsEngine !== 'system';
  let spokenEarly = false;
  const r = await runAgent(text, {
    onSpeech: (sp) => { if (!inCall()) { spokenEarly = true; speakText(sp); } }, // 答案还在写，这一句先念起来
    onAnswer: (a) => { if (!inCall() && !spokenEarly) speakText(a.speech); },
    beforeShow: () => (willSpeak() ? voiceGate : null),
  });
  if (!r || !r.ok) return;
  if (inCall()) live.client.append('thinking', `玩家刚才打字问：「${text}」。后台答复：${plainText(r.text).slice(0, 600)}`);
}

// ---------- 国策树推演：把 focus_path 的结构化结果画成游戏里的国策链 ----------
const SVG_X = '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M2 2l6 6M8 2L2 8" stroke="currentColor" stroke-width="1.7"/></svg>';
const SVG_FORK = '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M5 9.5V5.5M5 5.5L1.8 1M5 5.5L8.2 1" stroke="currentColor" stroke-width="1.5" fill="none"/></svg>';
const SVG_LOCK = '<svg viewBox="0 0 10 10" aria-hidden="true"><rect x="2" y="4.6" width="6" height="4.6" fill="currentColor"/><path d="M3.3 4.6V3.2a1.7 1.7 0 0 1 3.4 0v1.4" stroke="currentColor" stroke-width="1.2" fill="none"/></svg>';

function nodeHtml(s, { target, choice }) {
  const cls = ['node', target && 'target', s.completed && 'done', s.locked_by && s.locked_by.length && 'locked'].filter(Boolean).join(' ');
  const tags = [];
  // 标签是 flex，文字要包一层，不然 gap 会把每个字隔开
  for (const m of (s.locked_by || []).slice(0, 2)) tags.push(`<span class="tag lockedby">${SVG_LOCK}<span>已被「${esc(m)}」锁死</span></span>`);
  for (const m of (s.mutex || []).slice(0, 2)) tags.push(`<span class="tag mutex">${SVG_X}<span>互斥：${esc(m)}</span></span>`);
  if ((s.mutex || []).length > 2) tags.push(`<span class="tag mutex">${SVG_X}<span>另有 ${s.mutex.length - 2} 个互斥</span></span>`);
  if (choice) tags.push(`<span class="tag choice">${SVG_FORK}<span>前置任选其一：${choice.options.map((o) => (o.id === choice.picked ? `<b>${esc(o.name || o.id)}</b>` : esc(o.name || o.id))).join(' / ')}</span></span>`);
  const days = [s.days ? `${s.days} 天` : '', s.completed ? '已完成' : ''].filter(Boolean).join(' · ');
  return `<div class="${cls}" data-id="${esc(s.id)}" title="${esc(s.id)}"><img class="icon" alt=""><div class="name">${esc(s.name || s.id)}</div>${days ? `<div class="days">${days}</div>` : ''}${tags.length ? `<div class="tags">${tags.join('')}</div>` : ''}</div>`;
}

function renderRoute(r) {
  const route = r.route;
  const t = route.target || {};
  const steps = route.steps;
  const choices = {};
  for (const c of route.or_choices || []) if (c.for) choices[c.for] = c;
  const verdict = route.locked ? '已锁死' : '可以走';
  const meta = [`${steps.length} 步`, `约 ${route.remaining_days || 0} 天`, route.progress_known ? '' : '进度未知'].filter(Boolean).join(' · ');
  const html = (list) => list.map((s) => nodeHtml(s, { target: s.id === t.id, choice: choices[s.id] })).join('');
  const fold = steps.length > 7;
  const head = fold ? steps.slice(0, 2) : steps;
  const mid = fold ? steps.slice(2, -3) : [];
  const tail = fold ? steps.slice(-3) : [];
  const wrap = add('route', `
    <div class="plate"><div class="verdict${route.locked ? ' locked' : ''}">${verdict} · ${esc(t.name || t.id)}</div><div class="meta">${meta}</div></div>
    <div class="chain">${html(head)}${fold ? `<div class="fold"><button class="btn small" type="button">展开中间 ${mid.length} 步</button></div>${html(tail)}` : ''}</div>
    ${r.speech ? `<span class="speech"><b class="lbl">来电</b>${esc(r.speech)}</span>` : ''}
    <details class="details"><summary>参谋详述（条件与注意事项）</summary><div class="msg bot">${rich(r.text)}</div></details>`);
  const foldEl = wrap.querySelector('.fold');
  if (foldEl) foldEl.querySelector('button').onclick = () => {
    foldEl.insertAdjacentHTML('afterend', html(mid));
    foldEl.remove();
    loadIcons(wrap);
  };
  loadIcons(wrap);
  return wrap;
}

async function loadIcons(root) {
  const nodes = [...root.querySelectorAll('.node')].filter((n) => !n.querySelector('.icon').src);
  if (!nodes.length) return;
  const map = await api.focusIcons(nodes.map((n) => n.dataset.id));
  for (const n of nodes) { const u = map[n.dataset.id]; if (u) n.querySelector('.icon').src = u; }
}

// 从本机游戏转出的贴图；拿不到就保持 no-gfx 的纯 CSS 外观
async function loadGfx() {
  const u = await api.gfxUi();
  const vars = { frame: '--tex-frame', tile: '--tex-tile', topbar: '--tex-topbar', plate: '--tex-plate', button: '--tex-button', buttonSmall: '--tex-button-small' };
  let ok = true;
  for (const [k, v] of Object.entries(vars)) {
    if (u[k]) document.documentElement.style.setProperty(v, `url("${u[k]}")`);
    else ok = false;
  }
  document.body.classList.toggle('no-gfx', !ok);
}

api.on('agent-event', (ev) => {
  if (ev.type === 'speech') { if (currentJob && currentJob.onSpeech) currentJob.onSpeech(ev.text); return; }
  if (ev.type !== 'tool' || !steps) return;
  const d = document.createElement('div');
  d.textContent = ev.label + (ev.detail ? '：' + ev.detail.slice(0, 40) : '');
  steps.appendChild(d);
  scroll();
});

// ---------- 录音 ----------
let recording = false, starting = false, cancelStart = false, recorder = null, chunks = [], stream = null;
async function startRec() {
  if (recording || starting || busy) return;
  starting = true; cancelStart = false;
  try {
    if (!(await api.micPermission())) { toast('没有麦克风权限：系统设置 → 隐私与安全性 → 麦克风，允许 Electron'); return; }
    let s;
    try { s = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch (e) { toast('打不开麦克风：' + e.message, 4000); return; }
    if (cancelStart) { s.getTracks().forEach((t) => t.stop()); return; } // 等权限时已经松手了
    if (speaking) speaking.pause();
    if (window.Battle) Battle.stop(0);
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/mp4';
    stream = s;
    recorder = new MediaRecorder(s, { mimeType: mime });
    chunks = [];
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    recorder.start();
    recording = true; setLamp();
    $('btnMic').classList.add('rec');
    $('btnMic').textContent = '松开';
    if (cfg.beep) morse('.', 0.15);
  } finally { starting = false; }
}
// draft=true：转好的字先放进输入框、不发出（手柄说话键用：看一眼，按“发送”才发，按“删除”清掉）
async function stopRec(draft = false) {
  if (starting) { cancelStart = true; return; }
  if (!recording) return;
  recording = false; setLamp();
  $('btnMic').classList.remove('rec');
  $('btnMic').textContent = '话筒';
  const rec = recorder, st = stream, got = chunks;
  recorder = null; stream = null;
  const done = new Promise((r) => (rec.onstop = r));
  rec.stop();
  await done;
  st.getTracks().forEach((t) => t.stop());
  const blob = new Blob(got, { type: rec.mimeType });
  if (blob.size < 2000) { toast('未听清，请再讲。'); return; }
  toast('转写中…', 8000);
  const r = await api.transcribe(new Uint8Array(await blob.arrayBuffer()), rec.mimeType.split(';')[0]);
  $('toast').classList.add('hidden');
  if (!r.ok) { add('err', esc(r.error) + '\n（如果是中转不支持语音转写，先直接打字提问）'); return; }
  if (!r.text.trim()) { toast('未听清，请再讲。'); return; }
  if (!draft) return ask(r.text);
  ta.value = (ta.value.trim() ? ta.value.trim() + ' ' : '') + r.text.trim();
  api.peek();
  toast('点一下说话键发出，按删除键清掉', 4000);
}
const liveMode = () => cfg.voiceMode === 'live';
const toggleLive = () => (live ? stopLive() : startLive());
const ptt = () => cfg.livePushToTalk !== false;
const onCall = () => live && live.state === 'on';
// 快捷键没有“松开”事件：通话中按一下开始讲、再按一下结束
api.on('hotkey', () => {
  if (!liveMode()) return recording || starting ? stopRec() : startRec();
  if (!live) return startLive();
  if (onCall() && ptt()) return setTalk(live, !live.talking);
  if (!ptt()) stopLive();
});
$('btnMic').addEventListener('mousedown', () => {
  if (!liveMode()) return startRec();
  if (!live) return startLive();
  if (onCall() && ptt()) setTalk(live, true);
  else if (!ptt()) stopLive();
});
const releaseMic = () => {
  if (!liveMode()) return (recording || starting) && stopRec();
  if (onCall() && ptt() && live.talking) setTalk(live, false);
};
$('btnMic').addEventListener('mouseup', releaseMic);
$('btnMic').addEventListener('mouseleave', releaseMic);
$('btnHang').onclick = () => stopLive();

// ---------- 通话里换声音：GPT Live 说的话交给朗读音色念 ----------
const ttsInCall = () => cfg.liveUseTtsVoice !== false && cfg.ttsEngine !== 'system';
const lv = { buf: '', timer: null, queue: [], playing: false, gen: 0, audio: null };
// Fish：一轮回答一条实时合成流，字一来就送；第一个逗号和每个句末立刻出声，停顿 1.5 秒算这轮说完
const fl = { cur: null, players: [], idle: null, since: 0, cps: 4.6 }; // cps：每秒念几个字，用来让字幕跟上声音
// 字幕跟着声音走：开口才出气泡，按播放进度一个字一个字显示，不会比声音先冒出来
function flReveal(p, all) {
  if (!p.cap) return;
  const n = all ? p.text.length : Math.min(p.flushed, Math.floor(p.audio.currentTime * fl.cps) + 1);
  if (n > p.shown) { p.cap.appendChild(document.createTextNode(p.text.slice(p.shown, n))); p.shown = n; scroll(); }
}
function flFeed(delta) {
  if (!fl.cur) {
    const p = streamPlayer({ autoplay: false, minLead: 2.5, onFail: () => {} });
    Object.assign(p, { text: '', flushed: 0, shown: 0, cap: null, tick: null });
    fl.cur = p;
    fl.since = 0;
    api.fishLive('start', p.id);
    fl.players.push(p);
    p.audio.onplaying = () => {
      if (battleOn()) Battle.start({ opener: !Battle.isActive() });
      if (!p.cap) { p.cap = add('cap', ''); p.tick = setInterval(() => flReveal(p), 90); voiceStarted(); }
    };
    p.audio.onended = () => {
      clearInterval(p.tick); flReveal(p, true);
      if (isFinite(p.audio.duration) && p.audio.duration > 1) fl.cps = 0.7 * fl.cps + 0.3 * (p.text.length / p.audio.duration);
      fl.players.shift(); URL.revokeObjectURL(p.audio.src);
      const next = fl.players[0]; if (next) next.start(); else if (battleOn()) Battle.stop(1200);
    };
    if (fl.players.length === 1) p.start(); // 前一轮还在念就排在后面
  }
  const p = fl.cur;
  p.text += delta;
  api.fishLive('text', p.id, delta);
  fl.since += delta.length;
  // 每段至少攒 10 个字再合成：短句（“收到！”）单独合成，念得比合成快，就会卡
  if ((fl.since >= 10 && /[。！？!?；;…]/.test(delta)) || (fl.since >= 18 && /[，,]/.test(delta))) { api.fishLive('flush', p.id); fl.since = 0; p.flushed = p.text.length; }
  clearTimeout(fl.idle);
  fl.idle = setTimeout(flEnd, 1500);
}
function flEnd() {
  if (!fl.cur) return;
  fl.cur.flushed = fl.cur.text.length;
  api.fishLive('stop', fl.cur.id);
  fl.cur = null;
  api.fishLive('prewarm'); // 再备一条
}
function flStop() {
  clearTimeout(fl.idle);
  if (fl.cur) { api.fishLive('cancel', fl.cur.id); fl.cur = null; }
  for (const p of fl.players) { p.audio.pause(); ttsJobs.delete(p.id); clearInterval(p.tick); flReveal(p, true); }
  fl.players = [];
}

function lvFeed(delta) {
  lv.buf += delta;
  clearTimeout(lv.timer);
  // 句末标点就切；太长时在逗号处切，开口更快
  let cut = -1;
  const m = lv.buf.match(/[\s\S]*[。！？!?；;…]/);
  if (m) cut = m[0].length;
  else if (lv.buf.length >= 22) { const i = Math.max(lv.buf.lastIndexOf('，'), lv.buf.lastIndexOf(',')); if (i > 6) cut = i + 1; }
  if (cut > 0) { lvEnqueue(lv.buf.slice(0, cut)); lv.buf = lv.buf.slice(cut); }
  lv.timer = setTimeout(() => { if (lv.buf.trim()) lvEnqueue(lv.buf); lv.buf = ''; }, 700); // 停顿了就把剩下的念掉
}
function lvEnqueue(text) {
  text = text.trim();
  if (!text.replace(/[，。！？、,.!?…\s]/g, '')) return;
  // 立刻开始合成，播放按顺序；失败重试一次，不让字丢掉
  lv.queue.push({ gen: lv.gen, text, p: api.tts(text).then((r) => (r && r.ok ? r : api.tts(text))) });
  if (!lv.playing) lvNext();
}
async function lvNext() {
  const item = lv.queue.shift();
  if (!item) { lv.playing = false; lv.audio = null; if (battleOn()) Battle.stop(1200); return; }
  lv.playing = true;
  const r = await item.p;
  if (item.gen !== lv.gen) return; // 已被打断
  if (!r || !r.ok) return lvNext();
  const a = new Audio(URL.createObjectURL(new Blob([r.audio], { type: 'audio/mpeg' })));
  voiceOut(a);
  lv.audio = a;
  a.onplaying = () => {
    if (battleOn()) Battle.start({ opener: !Battle.isActive() });
    if (!a.captioned && live) { a.captioned = true; caption(live, 'bot', item.text); voiceStarted(); }
  };
  a.onended = () => { URL.revokeObjectURL(a.src); lvNext(); };
  a.play().catch(() => lvNext());
}
function lvStop() {
  flStop();
  lv.gen++;
  lv.queue = [];
  lv.buf = '';
  clearTimeout(lv.timer);
  if (lv.audio) lv.audio.pause();
  lv.audio = null;
  lv.playing = false;
}

// ---------- GPT Live 实时通话 ----------
// GPT-Live 负责听和说；它判断要查游戏内容时发 session.delegation.created，我们拿转写去问参谋，再把结论塞回去让它念。
// 每通电话是一个独立的 sess 对象：异步回来的结果只认自己那通，挂断/重连后不会串线。
let live = null;
const isActive = (sess) => !!sess && live === sess && !sess.byUs;

function setMicLabel() {
  const b = $('btnMic');
  $('btnHang').classList.toggle('hidden', !(liveMode() && live && ptt()));
  if (liveMode()) {
    if (!live) b.textContent = '接通';
    else if (live.state !== 'on') b.textContent = '…';
    else if (!ptt()) b.textContent = '挂断';
    else b.textContent = live.talking ? '松开' : '讲话';
    b.classList.toggle('rec', !!(live && (ptt() ? live.talking : true)));
  } else if (!recording) { b.textContent = '话筒'; b.classList.remove('rec'); }
}

// 按住讲话：不讲的时候麦克风轨道关掉并告诉电台静音，背景人声进不来
function setTalk(sess, on) {
  if (!isActive(sess) || !sess.client || !sess.client.stream) return;
  sess.talking = on;
  if (on) { lvStop(); if (window.Battle) Battle.stop(0); sess.capUser = null; sess.capBot = null; }
  sess.client.stream.getAudioTracks().forEach((t) => { t.enabled = on; });
  sess.client.send(on ? 'session.input_audio.unmute' : 'session.input_audio.mute');
  if (on && cfg.beep) morse('.', 0.1);
  setMicLabel();
  setLamp();
  resetIdle(sess);
}

function endLive(sess) {
  if (live !== sess) return;
  lvStop();
  clearTimeout(sess.idle);
  live = null;
  setLamp(); setMicLabel();
}

async function startLive() {
  if (live) return;
  if (!cfg.hasLiveKey) { toast('先在设置里填「GPT Live 官方 Key」'); openSettings(); return; }
  // 先占位再 await，连按不会建出两路连接
  const sess = (live = { state: 'starting', frags: [], capUser: null, capBot: null, lastUser: 0, lastBot: 0, seconds: 0, pending: 0, idle: null, byUs: false, client: null });
  setLamp(); setMicLabel();
  if (!(await api.micPermission())) { toast('没有麦克风权限：系统设置 → 隐私与安全性 → 麦克风，允许 Electron'); endLive(sess); return; }
  let mic;
  try { mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }); }
  catch (e) { toast('打不开麦克风：' + e.message, 4000); endLive(sess); return; }
  if (!isActive(sess)) { mic.getTracks().forEach((t) => t.stop()); endLive(sess); return; } // 等麦克风时已经按了挂断
  if (speaking) speaking.pause();
  speechSynthesis.cancel();
  sess.state = 'connecting';
  sess.client = new LiveClient({ createSession: (sdp) => api.liveCreate(sdp), onEvent: (ev) => onLiveEvent(sess, ev), onRemoteStream: (stream) => { if (!ttsInCall()) voiceStream(stream); } });
  toast('呼叫参谋部…', 8000);
  try { await sess.client.connect(mic); }
  catch (e) {
    sess.client.cleanup();
    if (live === sess) { $('toast').classList.add('hidden'); add('err', esc('线路不通：' + e.message)); }
    endLive(sess);
  }
}

function liveCost(sec) { return (sec / 60 * 0.05 * 7.2).toFixed(2); }

async function stopLive(reason) {
  const sess = live;
  if (!sess || sess.byUs) return;
  sess.byUs = true;
  clearTimeout(sess.idle);
  sess.state = 'closing'; setMicLabel();
  // 一按挂断就安静：麦克风关掉、电台和本地朗读都停；服务器确认用量（最多 15 秒）在后台等
  if (sess.client) {
    if (sess.client.stream) sess.client.stream.getAudioTracks().forEach((t) => { t.enabled = false; });
    if (sess.client.audio) sess.client.audio.muted = true;
  }
  lvStop();
  if (window.Battle) Battle.stop(0);
  const closed = sess.client ? await sess.client.close() : null;
  endLive(sess);
  if (!sess.client) return; // 还没连上就取消了
  const sec = (closed && closed.usage && closed.usage.seconds) || sess.seconds;
  add('sys', reason || '已挂断').title = `本次通话 ${sec} 秒，约 ${liveCost(sec)} 元${closed ? '' : '（最终用量未确认）'}`;
}

function resetIdle(sess) {
  if (!isActive(sess)) return;
  clearTimeout(sess.idle);
  const sec = Number(cfg.liveIdleSeconds) || 0;
  if (sec > 0) sess.idle = setTimeout(() => {
    if (!isActive(sess)) return;
    if (sess.pending > 0) resetIdle(sess);
    else stopLive('长时间无通话，线路已关闭');
  }, sec * 1000);
}

// 字幕：两个人的字幕各自累积、互不打断（GPT Live 是全双工，会夹杂空白片段）；
// 只有换了一轮（重新按讲话、汇报结果、长时间停顿）才另起气泡
function caption(sess, who, delta) {
  const key = who === 'user' ? 'capUser' : 'capBot';
  const last = who === 'user' ? 'lastUser' : 'lastBot';
  if (!delta) return;
  if (!delta.trim() && !sess[key]) return; // 空白片段不开新气泡
  const now = Date.now();
  if (!sess[key] || now - sess[last] > (who === 'user' ? 2500 : 5000)) sess[key] = add(who === 'user' ? 'user' : 'cap', ''); // 参谋说话常有停顿，门槛放宽
  sess[last] = now;
  sess[key].appendChild(document.createTextNode(delta));
  scroll();
}

async function sendLiveContext(sess) {
  const st = await api.gameState();
  if (!isActive(sess) || st.error) return;
  const s = st.latest_save || {};
  const parts = [`游戏${st.hoi4_running ? '正在运行' : '没有运行'}`];
  const cur = currentCountry(st);
  if (cur) parts.push(`玩家国家：${cur.country}（${cur.tag}）`);
  else if (!st.hoi4_running) parts.push('游戏没在运行，上一局的国家不算数；问到具体局面时先问玩家要玩哪国');
  else parts.push('玩家国家还不确定（新开局还没存档），需要时问玩家在玩哪国');
  if (st.hoi4_running && st.log_game_date) parts.push(`游戏内日期：${st.log_game_date}`);
  if (!st.hoi4_running) { /* 游戏没开：不报战争状态，语气从容 */ }
  else if (st.at_war === true) parts.push(`战争状态：正在交战（对 ${st.enemies.map((e) => e.name).join('、')}），报告更短、更紧迫`);
  else if (st.at_war === false) parts.push('战争状态：和平、未参战，语气从容沉稳，别渲染炮火');
  parts.push(`称谓：${cur && cur.ideology === 'communism' ? '首长' : '指挥官'}（多数句子不带称谓）`);
  if (s.format === 'binary') parts.push('存档是二进制，后台读不到已点国策，必要时问玩家点到哪了');
  sess.client.append('thinking', '当前局面：' + parts.join('；') + '。');
}

// 按时间轴取这次委派对应的那段话：委派时刻之前、还没被用过的转写片段；转写可能晚到，先等一下再取
function questionFor(sess, offsetMs) {
  const cut = offsetMs + 300;
  const mine = sess.frags.filter((f) => !f.used && f.start < cut);
  mine.forEach((f) => { f.used = true; });
  let q = mine.map((f) => f.text).join('').trim();
  if (!q) q = sess.frags.filter((f) => f.start > offsetMs - 15000 && f.start < cut).map((f) => f.text).join('').trim();
  return q;
}

async function runDelegation(sess, id, offsetMs) {
  sess.latestDelegation = id;
  let sent = false, early = false;
  const sendEarly = (sp) => { if (!isActive(sess) || early) return; early = true; sess.client.append('commentary', `结论：${sp}`, id); };
  const sendResult = (r) => {
    if (sent) return;
    sent = true;
    const plain = plainText(r.text);
    if (early) sess.client.append('thinking', '后台完整答复（玩家要详细步骤时照这个念）：' + plain.slice(0, 1400), id);
    else {
      sess.client.append('commentary', `结论：${r.speech}\n要点：${plain.slice(0, 220)}`.slice(0, 300), id);
      if (plain.length > 220) sess.client.append('thinking', '完整答复（玩家要详细步骤时照这个念）：' + plain.slice(220, 1420), id);
    }
  };
  const current = () => isActive(sess) && sess.latestDelegation === id;
  try {
    await sleep(700);
    if (!isActive(sess)) return;
    const question = questionFor(sess, offsetMs);
    if (!current()) { sess.client.append('thinking', '这个请求已被玩家后面的话取代，不必回答。', id); return; }
    if (question.replace(/[\s，。！？、,.!?…嗯啊哦呃]/g, '').length < 2) { sess.client.append('commentary', '没听清，请玩家按住讲话再说一遍。', id); return; }
    sess.client.append('thinking', '后台参谋正在查本机游戏文件，结果出来前不要猜。', id);
    // 排队期间挂断了就不再花钱去查
    let gate = null;
    const r = await runAgent(question, {
      showUser: false, inLive: true, shouldRun: current,
      onSpeech: (sp) => { sendEarly(sp); gate = ttsInCall() ? waitVoice(8000) : null; },
      // 结论先交给 GPT Live，卡片等它开口汇报再弹出
      onAnswer: (a) => { if (a.ok && isActive(sess)) { sendResult(a); if (!gate) gate = ttsInCall() ? waitVoice(8000) : null; } },
      beforeShow: () => gate,
    });
    if (!isActive(sess)) return;
    if (r.skipped) { sess.client.append('thinking', '这个请求已被玩家后面的话取代，不必回答。', id); return; }
    sess.capBot = null;
    if (!r.ok) { sess.client.append('commentary', `后台查询失败：${r.error.slice(0, 150)}。告诉玩家稍后再试。`, id); return; }
  } finally {
    sess.pending--;
    resetIdle(sess);
  }
}

function onLiveEvent(sess, ev) {
  if (live !== sess) return; // 旧电话的迟到事件
  switch (ev.type) {
    case 'session.started':
      sess.state = 'on'; setLamp(); setMicLabel();
      $('toast').classList.add('hidden');
      if (ptt()) setTalk(sess, false);
      if (ttsInCall() && cfg.ttsEngine === 'fish') api.fishLive('prewarm');
      const hello = ['参谋部，请讲。', '线路接通，请讲。', '参谋部在线，请指示。'][Math.floor(Math.random() * 3)];
      add('sys', ptt() ? `${hello}按住「讲话」说话。` : hello);
      if (cfg.beep) morse('-.-', 0.12);
      sendLiveContext(sess);
      resetIdle(sess);
      break;
    case 'session.input_transcript.delta':
      sess.frags.push({ text: ev.delta, start: ev.start_ms || 0 });
      caption(sess, 'user', ev.delta);
      resetIdle(sess);
      break;
    case 'session.output_transcript.delta':
      if (ttsInCall()) (cfg.ttsEngine === 'fish' ? flFeed : lvFeed)(ev.delta); // 换声时字幕由声音那边按进度显示
      else { caption(sess, 'bot', ev.delta); if (battleOn()) Battle.keepAlive(); }
      resetIdle(sess);
      break;
    case 'session.delegation.created':
      sess.capBot = null; // 后面的话另起气泡，别拼回查询步骤上面
      sess.pending++;
      runDelegation(sess, ev.delegation.id, ev.offset_ms || 0);
      break;
    case 'session.usage.updated':
      sess.seconds = ev.usage.seconds;
      break;
    case 'session.closed':
      if (!sess.byUs) {
        const sec = (ev.usage && ev.usage.seconds) || sess.seconds;
        const why = { expired: '通话时限已到，通信结束', content: '线路被切断', remote_hangup: '参谋部结束通话', connection_lost: '通信中断' }[ev.reason] || '通信中断';
        sess.byUs = true;
        sess.client.cleanup();
        endLive(sess);
        add('sys', why).title = `本次通话 ${sec} 秒，约 ${liveCost(sec)} 元`;
      }
      break;
    case 'client.disconnected':
      if (!sess.byUs) { sess.byUs = true; sess.client.cleanup(); endLive(sess); add('sys', '通信中断'); }
      break;
    case 'error':
      if (sess.byUs) break; // 我们自己挂断（比如刚拨出就按了挂断）引起的报错，不算故障
      add('err', esc('电台故障：' + ((ev.error && ev.error.message) || JSON.stringify(ev).slice(0, 200))));
      break;
  }
}

// ---------- 输入和按钮 ----------
const ta = $('text');
ta.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); const v = ta.value; ta.value = ''; ask(v); }
});
ta.addEventListener('input', () => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; });
$('btnSend').onclick = () => { const v = ta.value; ta.value = ''; ask(v); };
$('btnHide').onclick = () => api.hide();
const clearLog = () => log.querySelectorAll('.msg:not(.sys), .steps, .usage').forEach((n) => n.remove());
$('btnNew').onclick = async () => { await api.reset(); clearLog(); toast('已开新电'); };
api.on('reset', clearLog);
api.on('toast', (t) => toast(t, 4000));
// 没有屏幕录制权限：新开局时认不出国家、也看不到地图，提示一次并给个直达按钮
api.on('need-screen', () => {
  const d = add('sys', '参谋看不到战况画面：新开局认不出你玩的国家，也看不到战线。请在系统设置里打开「参谋电报机」的屏幕录制权限，然后退出参谋再重新打开。<br><button class="btn perm">打开系统设置</button>');
  d.querySelector('.perm').onclick = () => api.openScreenSettings();
});
api.on('game-status', ({ running, line }) => {
  cfg.running = running;
  refreshStatus();
  if (running) { add('sys', line || '参谋部报到，请指示。'); if (cfg.beep) morse('-.-'); }
});

// ---------- 参谋电报机硬件 ----------
// 主箱：拨打 = 接通电台，挂断 = 挂断 / 作废录音 / 打断朗读
// 手柄（壳上只有两个键）：说话 = 按住说、松开把字放进输入框，点一下 = 发出输入框的字（通话中 = 按住对讲）；
//   删除 = 作废录音 / 清空输入框 / 打断参谋。载板上要是还留着“发送”键（B2）也照样能用
// 录了一半按挂断：这段不发
function cancelRec(quiet = false) {
  if (starting) { cancelStart = true; return; }
  if (!recording) return;
  recording = false; setLamp();
  const rec = recorder, st = stream;
  recorder = null; stream = null;
  rec.onstop = null;
  rec.stop();
  st.getTracks().forEach((t) => t.stop());
  setMicLabel();
  if (!quiet) toast('已作废');
}
function hushVoice() {
  if (speaking) speaking.pause();
  lvStop();
  speechSynthesis.cancel();
  if (window.Battle) Battle.stop(0);
}
let hwOn = false, hwSummary = '';
let pttDownAt = 0, pttDraft = '';
function hwStatus(on, first, summary = '') {
  window.hw && hw.rescan();
  if (on === hwOn && summary === hwSummary) return;
  const was = hwOn, lostHandset = hwSummary.includes('手柄') && !summary.includes('手柄');
  hwOn = on; hwSummary = summary;
  if (!first) add('sys', on ? `电报机已接入（${summary}）。` : '电报机已断开，改用电脑的麦克风和喇叭。');
  if ((on || !was) && !lostHandset) return;
  { // 拔线（或只拔了手柄）时别悄悄换别的麦克风继续：通话不管在哪一步都挂断，录了一半的作废
    if (live) stopLive('电报机断开，通信结束');
    if (recording || starting) cancelRec();
  }
}
api.hwStatus().then((s) => hwStatus(!!s.connected, true, s.summary));
api.on('hw', (e) => {
  if (e.type === 'status') return hwStatus(!!e.connected, false, e.summary || '');
  if (e.type !== 'btn') return;
  if (e.key === 'DIAL') { if (e.down) (live ? stopLive() : startLive()); return; } // 拨打键：没通话 = 接通，通话中再按 = 挂断
  if (e.key === 'HANG') {
    if (!e.down) return;
    if (live) return stopLive();
    if (recording || starting) return cancelRec();
    return hushVoice();
  }
  if (e.key === 'PTT') {
    if (live) { if (onCall() && ptt()) setTalk(live, e.down); return; }
    // 没在通话：按下先开始录（不知道是点还是按住）；松开时按得短 = 点一下 = 发出输入框的字，按得久 = 说了一句，放进输入框
    if (e.down) { pttDownAt = Date.now(); pttDraft = ta.value.trim(); return startRec(); }
    if (Date.now() - pttDownAt >= 450) return stopRec(true);
    cancelRec(true);
    if (!pttDraft) return toast('按住说话，说完松开');
    ta.value = '';
    return ask(pttDraft);
  }
  if (!e.down) return;
  if (e.key === 'SEND') {
    if (recording || starting) return stopRec();
    const v = ta.value.trim();
    if (v) { ta.value = ''; ask(v); }
    return;
  }
  if (e.key === 'DEL') {
    if (recording || starting) return cancelRec();
    if (ta.value.trim()) { ta.value = ''; toast('已清除'); return; }
    return hushVoice();
  }
});

// ---------- 设置 ----------
const fields = { sFishVoice: 'fishVoice', sDbApp: 'doubaoAppId', sDbVoice: 'doubaoVoice', sVoiceMode: 'voiceMode', sLiveVoice: 'liveVoice', sLiveIdle: 'liveIdleSeconds', sSttEngine: 'sttEngine', sTtsEngine: 'ttsEngine', sBase: 'baseURL', sStyle: 'apiStyle', sModel: 'model', sEffort: 'reasoningEffort', sStt: 'transcribeModel', sTts: 'ttsModel', sVoice: 'ttsVoice', sHotkey: 'hotkey' };
const checks = { sLiveTts: 'liveUseTtsVoice', sBattle: 'battleSfx', sPtt: 'livePushToTalk', sProxy: 'useProxy', sSpeak: 'speak', sBeep: 'beep', sTick: 'beepWhileThinking' };
$('sFetch').onclick = async () => {
  $('sModels').textContent = '获取中…';
  const r = await api.listModels({ apiKey: $('sKey').value.trim(), baseURL: $('sBase').value.trim() });
  if (!r.ok) { $('sModels').textContent = r.error; return; }
  $('modelList').innerHTML = r.models.map((m) => `<option value="${esc(m)}">`).join('');
  const pick = (re) => r.models.filter((m) => re.test(m));
  const gpt = pick(/gpt/i).filter((m) => !/tts|transcri|whisper|audio|realtime|image/i.test(m));
  const stt = pick(/transcri|whisper/i);
  const tts = pick(/tts/i);
  $('sModels').textContent = `共 ${r.models.length} 个模型（点输入框可下拉选）\nGPT：${gpt.slice(0, 12).join('  ') || '无'}\n转写：${stt.join('  ') || '无（语音提问用不了，可以打字）'}\n朗读：${tts.join('  ') || '无（会改用系统声音）'}`;
};
function openSettings() {
  for (const [id, k] of Object.entries(fields)) $(id).value = cfg[k] || '';
  for (const [id, k] of Object.entries(checks)) $(id).checked = !!cfg[k];
  $('sKey').value = '';
  $('sLiveKey').value = '';
  $('sDbToken').value = '';
  $('sFishKey').value = '';
  $('sFishKey').placeholder = cfg.hasFishKey ? '已填写（留空=不修改）' : '在 fish.audio 的 API Keys 页面创建';
  $('sLiveKey').placeholder = cfg.hasLiveKey ? '已填写（留空=不修改）' : 'sk-…（官方 OpenAI）';
  $('sModels').textContent = '';
  $('sKey').placeholder = cfg.hasKey ? '已填写（留空=不修改）' : 'sk-…';
  $('settings').classList.remove('hidden');
  $('settings').scrollTop = 0;
}
$('btnSettings').onclick = openSettings;
$('sCancel').onclick = () => $('settings').classList.add('hidden');
$('sSave').onclick = async () => {
  const patch = { apiKey: $('sKey').value.trim(), liveApiKey: $('sLiveKey').value.trim(), doubaoToken: $('sDbToken').value.trim(), fishApiKey: $('sFishKey').value.trim() };
  for (const [id, key] of Object.entries(fields)) patch[key] = $(id).value.trim();
  patch.liveIdleSeconds = Number(patch.liveIdleSeconds) || 0;
  for (const [id, k] of Object.entries(checks)) patch[k] = $(id).checked;
  await api.saveConfig(patch);
  await loadConfig();
  $('settings').classList.add('hidden');
  toast('已保存');
};

function prettyHotkey(h) {
  return (h || '').replace(/CommandOrControl|Command|Cmd/g, '⌘').replace(/Shift/g, '⇧').replace(/Alt|Option/g, '⌥').replace(/Control|Ctrl/g, '⌃').replace(/\+/g, '');
}
async function loadConfig() {
  cfg = await api.getConfig();
  $('intro').textContent = liveMode() ? (ptt() ? '按「接通」接通参谋部，按住「讲话」说话。' : '按「接通」，接通参谋部电话。') : '按住「话筒」口述电文，或者直接拟电文发报。';
  setLamp();
  setMicLabel();
}

(async () => {
  loadGfx();
  api.sfxBank().then((b) => window.Battle && Battle.loadBank(b)).catch(() => {});
  await loadConfig();
  preloadAcks();
  refreshStatus();
  setInterval(refreshStatus, 10000);
  if (!cfg.hasKey) { add('sys', '先在「设置」里填 OpenAI API Key。'); openSettings(); }
})();
