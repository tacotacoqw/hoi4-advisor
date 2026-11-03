const fs = require('fs');
const path = require('path');

// 自检/测试用 ADVISOR_CONFIG 指到别的文件，免得动到真正的 Key
const FILE = process.env.ADVISOR_CONFIG || path.join(__dirname, '..', 'config.json');

const DEFAULTS = {
  apiKey: '',
  baseURL: 'https://api.openai.com/v1', // 用中转就改成中转地址（要带 /v1）
  apiStyle: 'responses', // 中转不支持 Responses API 就改成 chat
  model: 'gpt-6.1-sol',
  visionModel: 'gpt-6-luna', // 认国旗用的便宜识图模型
  watchScreen: true, // 游戏运行而国家不明时，定时看左上角国旗
  reasoningEffort: 'low', // 要快；复杂问题可改 medium；模型不支持就留空
  voiceMode: 'local', // local=本地转写+朗读；live=GPT-Live 实时通话（需官方 Key）
  liveApiKey: '', // GPT-Live 只能走官方 OpenAI，和中转的 apiKey 分开存
  liveBaseURL: 'https://api.openai.com/v1',
  liveModel: 'gpt-live-1',
  liveVoice: 'marin',
  liveUseTtsVoice: true, // 通话时不播 GPT Live 原声，把它说的话交给朗读音色（如 Fish 贾小军）念
  livePushToTalk: true, // 通话时按住「讲话」才收音，旁边有人说话不会被录进去
  liveIdleSeconds: 120, // 这么久没人说话就自动挂断（按秒计费）
  sttEngine: 'local', // local=本机 whisper.cpp（免费离线）；openai=走接口的转写模型
  transcribeModel: 'gpt-transcribe',
  whisperModel: '', // 留空自动找 ~/.cache/whisper-cpp 里的模型
  ttsEngine: 'system', // system=Mac 自带中文声音；openai=OpenAI 朗读；doubao=火山引擎豆包；fish=Fish Audio 社区音色
  fishApiKey: '', // Fish Audio（fish.audio）的 API Key
  fishVoice: '80cf680e668c44fc8d5795f80d903f7a', // 「贾小军」（原创，纪录片解说风）
  fishModel: 's2.1-pro',
  fishSpeed: 1.0, // 原速；想快可调到 1.5，1.7 以上开始吐字不清
  doubaoAppId: '',
  doubaoToken: '',
  doubaoCluster: 'volcano_tts',
  doubaoVoice: 'zh_male_baqiqingshu_mars_bigtts', // 霸气青叔
  doubaoSpeed: 1.1,
  ttsModel: 'gpt-4o-mini-tts',
  ttsVoice: '', // 留空=跟 GPT Live 音色一样
  ttsInstructions: '你是二战前线冲锋前的指挥官，正冒着炮火用电台嘶吼着下达命令。情绪极度激昂、热血沸腾、斩钉截铁，音量大、气势猛，每一句都像军令；语速快，但每个字都要吐清楚。说中文。',
  speak: true,
  beep: true,
  beepWhileThinking: true,
  autoStart: true, // 开机自动在后台启动（只对装好的 App 生效）
  battleSfx: true, // 播报时的战场音效（开口一声炮响，之后远处炮击、枪声）
  hotkey: 'CommandOrControl+Shift+K',
  useProxy: true, // 走系统代理；国内中转连不上时关掉
  gameDir: '',
  userDir: '',
};

function load() {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch {}
  const cfg = { ...DEFAULTS, ...saved };
  if (!cfg.apiKey && process.env.OPENAI_API_KEY) cfg.apiKey = process.env.OPENAI_API_KEY;
  if (!saved.baseURL && process.env.OPENAI_BASE_URL) cfg.baseURL = process.env.OPENAI_BASE_URL;
  return cfg;
}

function save(cfg) {
  const out = {};
  for (const k of Object.keys(DEFAULTS)) out[k] = cfg[k];
  fs.writeFileSync(FILE, JSON.stringify(out, null, 2));
}

module.exports = { load, save, DEFAULTS, FILE };
