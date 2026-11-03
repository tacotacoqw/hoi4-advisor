// 本地语音转写：ffmpeg 转成 16k wav → whisper.cpp（whisper-cli），免费、离线，不依赖中转支不支持转写
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const PROMPT = '以下是普通话的句子。钢铁雄心4 国策 决议 俄罗斯帝国 苏联 沙皇 罗曼诺夫 法西斯 共产主义 民主 中立 内战 政变 互斥 前置';

// 从 Finder/.command 启动时 PATH 很短，按常见位置找
function findBin(name, preferred) {
  const list = [preferred, `/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`, `/usr/bin/${name}`].filter(Boolean);
  return list.find((p) => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } });
}

function defaultModel() {
  const dir = path.join(os.homedir(), '.cache/whisper-cpp');
  const prefer = ['ggml-large-v3-turbo-q5_0.bin', 'ggml-large-v3-turbo.bin', 'ggml-medium.bin', 'ggml-small.bin', 'ggml-base.bin'];
  for (const f of prefer) if (fs.existsSync(path.join(dir, f))) return path.join(dir, f);
  return '';
}

function run(bin, args, timeout = 60000) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout, maxBuffer: 4 << 20 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${path.basename(bin)} 失败：${(stderr || err.message).toString().slice(-300)}`));
      else resolve(stdout.toString());
    });
  });
}

function available(cfg = {}) {
  return !!(findBin('ffmpeg', cfg.ffmpegBin) && findBin('whisper-cli', cfg.whisperBin) && (cfg.whisperModel || defaultModel()));
}

async function transcribeLocal(audio, mime, cfg = {}) {
  const ffmpeg = findBin('ffmpeg', cfg.ffmpegBin);
  const whisper = findBin('whisper-cli', cfg.whisperBin);
  const model = cfg.whisperModel || defaultModel();
  if (!ffmpeg || !whisper || !model) throw new Error('本地转写不可用：需要 ffmpeg、whisper-cli 和 ~/.cache/whisper-cpp 里的模型（brew install ffmpeg whisper-cpp）');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hoi4-stt-'));
  try {
    const input = path.join(dir, 'in.' + (mime.includes('mp4') ? 'm4a' : mime.includes('wav') ? 'wav' : 'webm'));
    const wav = path.join(dir, 'out.wav');
    fs.writeFileSync(input, Buffer.from(audio));
    await run(ffmpeg, ['-y', '-loglevel', 'error', '-i', input, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav]);
    const out = await run(whisper, ['-m', model, '-l', 'zh', '-nt', '-np', '--prompt', PROMPT, '-f', wav]);
    return out.replace(/\[[^\]]*\]/g, '').replace(/\s+/g, ' ').trim();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { transcribeLocal, available };
