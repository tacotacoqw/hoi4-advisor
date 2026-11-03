// 播报时的战场音效：开口前一声近处炮响，说话期间远处断续的炮击、步枪、机枪。全部 WebAudio 现场合成，不用素材。
(function () {
  let ac = null;
  let bus = null; // 音效总线：压缩 → 总音量
  let wet = null; // 远处的声音多走混响
  let noise = null;
  let timer = null;
  let stopTimer = null;
  let active = false;
  let volume = 0.85;
  let waiting = false; // 等答案时：只有远处炮击，稀一点、小一点
  const bank = { near: [], far: [], gun: [] }; // 游戏里的真实爆炸、枪声录音
  const pick = (a) => a[Math.floor(Math.random() * a.length)];

  // 播一段录音：远的更闷（低通）、更多混响；rate < 1 声音更沉更大
  function sample(buf, { distance = 0.5, pan = 0, rate = 1, gain = 1, at = 0 } = {}) {
    const t = ac.currentTime + 0.01 + at;
    const s = ac.createBufferSource();
    s.buffer = buf;
    s.playbackRate.value = rate;
    const lp = ac.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 18000 - distance * 15500;
    const g = ac.createGain();
    g.gain.value = gain * (1 - distance * 0.55);
    s.connect(lp).connect(g).connect(out(distance, pan));
    s.start(t);
  }

  function init() {
    if (ac) return;
    ac = new AudioContext();
    const comp = ac.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.ratio.value = 6;
    comp.attack.value = 0.003;
    comp.release.value = 0.25;
    bus = ac.createGain();
    bus.gain.value = volume;
    const limit = ac.createDynamicsCompressor(); // 末端限幅
    limit.threshold.value = -10; limit.knee.value = 0; limit.ratio.value = 20; limit.attack.value = 0.001; limit.release.value = 0.1;
    comp.connect(bus).connect(limit).connect(ac.destination);
    // 自制混响：两秒半衰减噪声当冲激响应
    const len = Math.floor(ac.sampleRate * 2.5);
    const ir = ac.createBuffer(2, len, ac.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
    }
    const verb = ac.createConvolver();
    verb.buffer = ir;
    wet = ac.createGain();
    wet.gain.value = 0.9;
    wet.connect(verb).connect(comp);
    bus.input = comp;
    const n = ac.createBuffer(1, ac.sampleRate * 3, ac.sampleRate);
    const nd = n.getChannelData(0);
    for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
    noise = n;
  }

  // distance：0 近 … 1 远。远的更小声、更闷、混响更多
  function out(distance, pan = 0) {
    const g = ac.createGain();
    const p = ac.createStereoPanner();
    p.pan.value = pan;
    const dry = ac.createGain();
    dry.gain.value = 1 - distance * 0.75;
    const send = ac.createGain();
    send.gain.value = 0.25 + distance * 0.6;
    g.connect(p);
    p.connect(dry).connect(bus.input);
    p.connect(send).connect(wet);
    return g;
  }

  function explosion(distance = 0.5, size = 1) {
    const list = distance < 0.35 ? bank.near : bank.far.length ? bank.far : bank.near;
    if (list.length) {
      sample(pick(list), { distance: distance * 0.7, pan: (Math.random() - 0.5) * (distance < 0.35 ? 0.5 : 1.4), rate: 0.8 + Math.random() * 0.2, gain: 1.6 * size * (waiting ? 0.55 : 1) });
      if (distance < 0.35) thump(size); // 近处再叠一下胸口的低频冲击
      return;
    }
    synthExplosion(distance, size);
  }

  function thump(size) {
    const t = ac.currentTime + 0.01;
    const o = ac.createOscillator();
    o.frequency.setValueAtTime(58, t);
    o.frequency.exponentialRampToValueAtTime(26, t + 0.6);
    const g = ac.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.9 * size, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.001, t + 1.1);
    o.connect(g).connect(bus.input);
    o.start(t);
    o.stop(t + 1.2);
  }

  function synthExplosion(distance = 0.5, size = 1) {
    const t = ac.currentTime + 0.01;
    const dest = out(distance, (Math.random() - 0.5) * 1.2);
    const level = (1 - distance * 0.6) * size;
    // 爆破的噪声：低通从亮到闷扫下去
    const src = ac.createBufferSource();
    src.buffer = noise;
    src.playbackRate.value = 0.6 + Math.random() * 0.3;
    const lp = ac.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(3500 - distance * 2500, t);
    lp.frequency.exponentialRampToValueAtTime(120, t + 1.6);
    const ng = ac.createGain();
    ng.gain.setValueAtTime(0, t);
    ng.gain.linearRampToValueAtTime(level, t + 0.008);
    ng.gain.exponentialRampToValueAtTime(0.001, t + 2.2 * size);
    src.connect(lp).connect(ng).connect(dest);
    src.start(t, Math.random());
    src.stop(t + 2.5 * size);
    // 胸口那一下：正弦从 60Hz 掉到 28Hz
    const o = ac.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(62, t);
    o.frequency.exponentialRampToValueAtTime(28, t + 0.5);
    const og = ac.createGain();
    og.gain.setValueAtTime(0, t);
    og.gain.linearRampToValueAtTime(level * 1.3, t + 0.01);
    og.gain.exponentialRampToValueAtTime(0.001, t + 0.9);
    o.connect(og).connect(dest);
    o.start(t);
    o.stop(t + 1);
    // 碎屑落地的噼啪声
    for (let i = 0; i < 6; i++) crackle(dest, t + 0.25 + Math.random() * 1.2, level * 0.25);
  }

  function crackle(dest, t, level) {
    const s = ac.createBufferSource();
    s.buffer = noise;
    const bp = ac.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1500 + Math.random() * 3000;
    bp.Q.value = 2;
    const g = ac.createGain();
    g.gain.setValueAtTime(level, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.04);
    s.connect(bp).connect(g).connect(dest);
    s.start(t, Math.random() * 2);
    s.stop(t + 0.05);
  }

  function shot(distance = 0.7, at = 0, pan = 0, rate) {
    if (bank.gun.length) {
      // 手枪录音压低音调当步枪/机枪
      sample(pick(bank.gun), { distance, pan, at, rate: rate || 0.72 + Math.random() * 0.12, gain: 0.9 });
      return;
    }
    const t = ac.currentTime + 0.01 + at;
    const dest = out(distance, pan);
    const level = Math.min(1, (1 - distance * 0.6) * 1.3);
    const s = ac.createBufferSource();
    s.buffer = noise;
    const hp = ac.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 300;
    const bp = ac.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1800 - distance * 900;
    bp.Q.value = 0.8;
    const g = ac.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(level, t + 0.001);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.12 + distance * 0.1);
    s.connect(hp).connect(bp).connect(g).connect(dest);
    s.start(t, Math.random() * 2);
    s.stop(t + 0.3);
    const o = ac.createOscillator();
    o.frequency.setValueAtTime(140, t);
    o.frequency.exponentialRampToValueAtTime(60, t + 0.06);
    const og = ac.createGain();
    og.gain.setValueAtTime(level * 0.6, t);
    og.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
    o.connect(og).connect(dest);
    o.start(t);
    o.stop(t + 0.1);
  }

  function burst(distance = 0.75) {
    const n = 6 + Math.floor(Math.random() * 10);
    const pan = (Math.random() - 0.5) * 1.6;
    const rate = 0.85 + Math.random() * 0.1; // 同一挺机枪音调一致
    for (let i = 0; i < n; i++) shot(distance, i * (0.072 + Math.random() * 0.018), pan, rate + (Math.random() - 0.5) * 0.04);
  }

  function rifles(distance = 0.8) {
    const n = 1 + Math.floor(Math.random() * 3);
    for (let i = 0; i < n; i++) shot(distance, Math.random() * 0.9, (Math.random() - 0.5) * 1.8);
  }

  // 说话期间：每隔 0.7~2.4 秒来一下，远处为主，偶尔近一点的炮
  function tick() {
    if (!active) return;
    const r = Math.random();
    if (r < 0.4) explosion(0.5 + Math.random() * 0.35, 1 + Math.random() * 0.3);
    else if (r < 0.7) explosion(0.3 + Math.random() * 0.15, 1.1);
    else if (r < 0.78) explosion(0.12 + Math.random() * 0.1, 1.1);
    else if (r < 0.9) burst(0.45 + Math.random() * 0.3);
    else rifles(0.5 + Math.random() * 0.3);
    timer = setTimeout(tick, (waiting ? 2200 : 550) + Math.random() * (waiting ? 2200 : 1100));
  }

  const Battle = {
    setVolume(v) { volume = v; if (bus) bus.gain.value = v; },
    // 把游戏音效解码进来：{ near: [Uint8Array], far: [...], gun: [...] }
    async loadBank(files) {
      init();
      for (const k of Object.keys(bank)) {
        for (const u8 of (files && files[k]) || []) {
          try { bank[k].push(await ac.decodeAudioData(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength))); } catch {}
        }
      }
      return bank.near.length + bank.far.length + bank.gun.length;
    },
    opener() { init(); if (ac.state === 'suspended') ac.resume(); explosion(0.08, 1.2); },
    // 开始：先一声近处炮响，0.5 秒后进入远处交火
    start({ opener = true } = {}) {
      init();
      if (ac.state === 'suspended') ac.resume();
      clearTimeout(stopTimer);
      bus.gain.cancelScheduledValues(ac.currentTime);
      bus.gain.setValueAtTime(volume, ac.currentTime);
      if (waiting) { waiting = false; active = false; clearTimeout(timer); } // 从“等待炮击”切到正式交火
      if (active) return;
      active = true;
      if (opener) explosion(0.08, 1.2);
      timer = setTimeout(tick, opener ? 900 : 300);
    },
    // 收尾：停止新的声响，已经响起的自然衰减
    stop(delay = 0) {
      clearTimeout(stopTimer);
      stopTimer = setTimeout(() => {
        active = false;
        clearTimeout(timer);
      }, delay);
    },
    // 等答案期间远处炮击；说话开始时 start() 会切回正常交火
    waitBarrage(on) {
      init();
      if (on) {
        if (ac.state === 'suspended') ac.resume();
        if (active) return;
        waiting = true;
        active = true;
        clearTimeout(stopTimer);
        timer = setTimeout(tick, 1500);
      } else if (waiting) {
        waiting = false;
        active = false;
        clearTimeout(timer);
      }
    },
    isActive() { return active && !waiting; },
    bankSize() { return { near: bank.near.length, far: bank.far.length, gun: bank.gun.length }; },
    // GPT Live 说话时不停调用：没在响就开始，最后一次调用 1.5 秒后自动停
    keepAlive() {
      if (!active) this.start({ opener: true });
      this.stop(1500);
    },
    explosion: (d, s) => { init(); explosion(d, s); },
    ctx() { init(); return ac; },
    // 测试用：把音效总线接一路出来录音
    tap() { init(); const d = ac.createMediaStreamDestination(); bus.connect(d); return d.stream; },
    tapInto(node) { init(); bus.connect(node); },
    burst: (d) => { init(); burst(d); },
  };
  window.Battle = Battle;
})();
