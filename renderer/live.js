// GPT-Live 的 WebRTC 客户端：麦克风/扬声器走媒体轨道，事件走 oai-events 数据通道。
// 建会话（带官方 Key）在主进程做，这里只交换 SDP。
class LiveClient {
  constructor({ createSession, onEvent, onRemoteStream }) {
    this.createSession = createSession; // (sdp) => Promise<{ ok, sdp, id, error }>
    this.onEvent = onEvent;
    this.onRemoteStream = onRemoteStream; // 拿到对方的声音流后交给外部加效果
    this.pc = null;
    this.dc = null;
    this.stream = null;
    this.audio = null;
    this.ready = false;
    this.closing = null;
    this.seq = 0;
  }

  async connect(stream) {
    this.stream = stream;
    const pc = (this.pc = new RTCPeerConnection());
    this.audio = new Audio();
    this.audio.autoplay = true;
    pc.addEventListener('track', (e) => {
      const stream = new MediaStream([e.track]);
      this.audio.srcObject = stream;
      // 外部接管时元素静音（Chrome 要求远端流挂在元素上才会流动），声音走 WebAudio 处理链
      if (this.onRemoteStream) { this.audio.muted = true; this.onRemoteStream(stream); }
      this.audio.play().catch(() => {});
    });
    for (const t of stream.getAudioTracks()) pc.addTrack(t, stream);
    // 数据通道要在 createOffer 之前建好
    const dc = (this.dc = pc.createDataChannel('oai-events'));
    dc.addEventListener('message', ({ data }) => {
      let ev;
      try { ev = JSON.parse(data); } catch { return; }
      if (ev.type === 'session.started') this.ready = true;
      if (ev.type === 'session.closed') { this.ready = false; if (this.closing) this.closing.resolve(ev); }
      this.onEvent(ev);
    });
    dc.addEventListener('close', () => {
      if (this.closing) this.closing.resolve(null);
      else if (this.pc) this.onEvent({ type: 'client.disconnected' });
    });
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await this.waitIce();
    const r = await this.createSession(pc.localDescription.sdp);
    if (!r.ok) throw new Error(r.error);
    await pc.setRemoteDescription({ type: 'answer', sdp: r.sdp });
    return r.id;
  }

  waitIce() {
    const pc = this.pc;
    if (pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pc.removeEventListener('icegatheringstatechange', on); reject(new Error('收集网络候选超时')); }, 10000);
      function on() {
        if (pc.iceGatheringState !== 'complete') return;
        clearTimeout(timer);
        pc.removeEventListener('icegatheringstatechange', on);
        resolve();
      }
      pc.addEventListener('icegatheringstatechange', on);
    });
  }

  send(type, fields = {}) {
    if (!this.dc || this.dc.readyState !== 'open') return null;
    const event_id = `c${Date.now().toString(36)}_${++this.seq}`;
    this.dc.send(JSON.stringify({ type, event_id, ...fields }));
    return event_id;
  }

  // 单次 append 上限 500 token；中文大约一字一 token，按 300 字切留足余量
  append(kind, content, delegationId = null) {
    const chunks = [];
    for (let i = 0; i < content.length; i += 300) chunks.push(content.slice(i, i + 300));
    for (const c of chunks) this.send(`session.${kind}.append`, { delegation_id: delegationId, content: c });
  }

  // 优雅挂断：发 session.close，等 session.closed（拿最终用量）再释放
  async close(timeout = 15000) {
    let usage = null;
    if (this.ready && this.dc && this.dc.readyState === 'open') {
      const done = new Promise((resolve) => { this.closing = { resolve }; });
      this.send('session.close');
      usage = await Promise.race([done, new Promise((r) => setTimeout(() => r(null), timeout))]);
    }
    this.cleanup();
    return usage;
  }

  cleanup() {
    this.ready = false;
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    try { this.dc && this.dc.close(); } catch {}
    try { this.pc && this.pc.close(); } catch {}
    if (this.audio) this.audio.srcObject = null;
    this.pc = this.dc = this.stream = null;
  }
}

window.LiveClient = LiveClient;
