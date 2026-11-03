// 参谋电报机硬件接入后：所有声音（朗读、滴滴声、战场音效、通话）走电报机的喇叭，录音和通话用电报机的麦克风。
// 在其它脚本之前加载：接管 AudioContext / Audio 元素 / getUserMedia，原有代码不用改。
(() => {
  const NAME = '参谋电报机';
  const hw = (window.hw = { mic: null, sink: null, ctxs: new Set(), rescan: () => scan() });

  const NativeAC = window.AudioContext;
  window.AudioContext = class extends NativeAC {
    constructor(opts) {
      super(hw.sink ? { ...(opts || {}), sinkId: hw.sink } : opts);
      hw.ctxs.add(this);
    }
  };

  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () {
    const want = hw.sink || '';
    if (this.setSinkId && this.sinkId !== want) this.setSinkId(want).catch(() => {});
    return play.call(this);
  };

  const md = navigator.mediaDevices;
  const gum = md.getUserMedia.bind(md);
  md.getUserMedia = async (c = {}) => {
    if (c.audio && !hw.mic) {
      const r = await scan();
      // 还没给过麦克风权限时设备名是空的，认不出电报机：先拿一次权限再扫
      if (!r.mic && r.unlabeled) { (await gum({ audio: true })).getTracks().forEach((t) => t.stop()); await scan(); }
    }
    if (hw.mic && c.audio) c = { ...c, audio: { ...(c.audio === true ? {} : c.audio), deviceId: { exact: hw.mic } } };
    return gum(c);
  };

  const real = (d) => d.deviceId !== 'default' && d.deviceId !== 'communications' && d.label.includes(NAME);
  // 麦克风只用手柄的、喇叭只用主箱的：主箱上的麦克风不用，手柄上没有功放；缺哪块就回到电脑自己的
  const pick = (list, kind, want) => list.find((d) => d.kind === kind && real(d) && d.label.includes(want));
  async function scan() {
    let list = [];
    try { list = await md.enumerateDevices(); } catch {}
    const mic = pick(list, 'audioinput', '手柄');
    const out = pick(list, 'audiooutput', '主箱');
    hw.mic = mic ? mic.deviceId : null;
    const sink = out ? out.deviceId : null;
    if (sink !== hw.sink) {
      hw.sink = sink;
      for (const c of hw.ctxs) if (c.setSinkId && c.state !== 'closed') c.setSinkId(sink || '').catch(() => {});
    }
    return { mic: !!mic, speaker: !!out, unlabeled: list.some((d) => d.kind === 'audioinput' && !d.label) };
  }
  md.addEventListener('devicechange', () => scan());
  scan();
})();
