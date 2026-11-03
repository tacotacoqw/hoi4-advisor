// Fish Audio 实时流式合成（WebSocket + MessagePack）：一边送字一边出声，整轮回答是一条连贯的声音。
// 协议：start（带音色等配置）→ 多个 text → 需要立刻出声时 flush → stop；服务器回 audio（mp3 片段）和 finish。
const WebSocket = require('ws');
const { encode, decode } = require('@msgpack/msgpack');

class FishLiveSession {
  constructor({ apiKey, model, voice, speed, onAudio, onFinish, onError }) {
    this.onAudio = onAudio;
    this.onFinish = onFinish;
    this.onError = onError;
    this.pending = []; // 连上之前先攒着
    this.done = false;
    this.ws = new WebSocket('wss://api.fish.audio/v1/tts/live', {
      headers: { Authorization: `Bearer ${apiKey}`, model: model || 's2.1-pro' },
    });
    this.ws.on('open', () => {
      this.raw({
        event: 'start',
        request: {
          text: '',
          reference_id: voice,
          format: 'mp3',
          latency: 'balanced',
          temperature: 0.5,
          top_p: 0.6,
          prosody: { speed: Number(speed) || 1 },
        },
      });
      for (const m of this.pending) this.raw(m);
      this.pending = [];
    });
    this.ws.on('message', (data) => {
      let msg;
      try { msg = decode(data); } catch { return; }
      if (msg.event === 'audio' && msg.audio) this.onAudio(Buffer.from(msg.audio));
      else if (msg.event === 'finish') { this.finish(msg.reason === 'error' ? new Error('Fish 合成出错') : null); }
    });
    this.ws.on('error', (e) => this.finish(e));
    this.ws.on('close', () => this.finish(null));
  }

  raw(obj) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(encode(obj));
    else if (this.ws.readyState === WebSocket.CONNECTING) this.pending.push(obj);
  }

  text(t) { if (t) this.raw({ event: 'text', text: t }); }
  flush() { this.raw({ event: 'flush' }); }
  stop() { this.raw({ event: 'stop' }); }
  cancel() { this.done = true; try { this.ws.terminate(); } catch {} }

  finish(err) {
    if (this.done) return;
    this.done = true;
    if (err) this.onError(err); else this.onFinish();
    try { this.ws.close(); } catch {}
  }
}

module.exports = { FishLiveSession };
