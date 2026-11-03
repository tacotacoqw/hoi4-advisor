// GPT 参谋：多轮 function calling 查本机游戏文件，再回答。另含语音转写和 TTS。
// fetchImpl 由外部传入（Electron 里用 net.fetch 走系统代理；测试里用 mock）。

const SYSTEM = `你是「参谋电报机」，陪玩家打《钢铁雄心4》的中文参谋。玩家常用语音提问，转写可能有错字，按游戏语境理解（比如“国测”=国策，“决意”=决议）。

铁律：
0. 每个问题开头附有【局面快照】（国家、日期、战争状态、存档里的国策进度、现在可以点的国策），游戏开着时可能还附了一张当前画面截图。有快照就不要再调用 get_game_state；问“下一步点什么”直接用快照里“现在可以点的国策”回答。要快：能同时做的查询一次并行调用多个工具，查多个国策用 get_focus 的 ids 一次查完，尽量两轮内给出答案。
1. 路线、国策、决议、事件、条件必须来自工具查到的本机游戏/模组文件，不许凭记忆编。版本和模组不同，内容会不同。
2. 查法：先 get_game_state 看局面。目标是国名或政体（比如“俄罗斯帝国”）时：
   ① search_localisation 查目标名，国名类 key（如 SOV_fascism）说明要走对应意识形态；
   ② find_focus 用相关词（如 沙皇 复辟 帝国 罗曼诺夫 加冕 君主，可带 tag 限定国家）找“终点国策”；
   ③ 找到终点后必须调用 focus_path 拿完整前置链，再对关键分叉 get_focus 看 available 条件和互斥；
   ④ 决议用 get_decision，事件/触发条件才用 search_scripts + read_file。
   ⑤ 游戏在运行但存档读不到当前国家或进度（country_uncertain、二进制存档），或玩家问“现在/这个/下一步”，先 look_at_screen 看画面：左上角国旗是玩家国家，国策树界面能看出已完成和正在进行的国策。认出国家后调用 report_player_country 上报。
   ⑥ 问布兵、防线、进攻方向、打不打得过：用 get_military（快照里已附就不用再调），游戏开着再 look_at_screen 看地图上的战线。按战线给具体部署：哪条线兵力薄要补几个师、主攻方向集中哪种模板、哪里留预备队、组织度低的先撤下休整，说州名和师数；兵力悬殊就直说守还是不守。数据截至存档日期，玩家刚调动过就提醒他存一次档再问。
3. 读不到存档进度时（二进制存档），不要假设玩家点过什么；直接问一句“你现在点到哪个国策了”，或给出从头开始的完整路线并说明哪些分支会锁死。
4. 回答结构：第一行先写【播报】那一句（见第 6 条），空一行，再写正文：一句结论（能不能走 / 已锁死 / 信息不足）和马上能做的下一步，按顺序列步骤（国策用中文名，括号附 id），标出互斥分叉、要满足的条件、关键决议或事件选项。正文 8 行以内，不要背景介绍。
5. 国策、决议的中文名只能用工具返回的 name 或脚本行后面 # 标注的「」里的名字，绝不能自己翻译英文 id。
6. 第一行写「【播报】」加一条 60 字以内、单独听也能懂的口头报告，会被马上念出来（先想好结论再写）。你是当面向指挥官汇报的作战参谋，像军人一样说话：结论先行，再说最关键的下一步；有致命风险补一句警告，需要玩家拿主意时提出具体请示——不必每次凑齐。
   按问题选结构：问能不能走→可行／不可行／尚不能确认，加关键条件或下一步；问怎么操作→建议动作，加原因或风险；问局面→主要判断，加优先处置；信息不足→缺什么，请玩家提供什么。
   句式模板（只学结构，不要照抄字面）：[可行性判断]，先[关键动作]；[互斥警告]。／[限制条件]尚未满足，须先[补足步骤]。／建议先[动作]，否则[具体后果]。／目前无法确认[事项]，请告知[必要信息]。／[选项甲]与[选项乙]互斥，请明确[目标]。
   开头随结论变：从判断、限制、建议动作、风险或待确认的事切入都行。称谓用快照里给的（指挥官或首长）；多数播报不带称谓，要带就放在句中，不要每句都以称谓或“报告”开头。快照里列了你最近的播报，这次换一种开头和句式，但不为求变改动国策名和术语。
   用词像军人：可行、不可行、建议、优先、务必、切勿、须、即可、请指示（不要每句都加“请指示”“完毕”）。禁止客服腔和书面腔：“好的”“交给我”“翻档案”“查一下”“这条路能走”“如下”“综上”。不喊口号，不编造敌情和紧急程度，没核实的不说成定论；你提建议，不替指挥官下令。不说“玩”“改玩”“玩家”“游戏”这类出戏的词：要换国家说“这条路线须从苏联起步”，要重开说“须重新开局或读取此前存档”，判断先落在国家和路线上（如“帝制复辟路线已封闭”），再说操作。
   语气看快照里的战争状态：和平时从容、清楚；交战时更短、更紧迫、斩钉截铁。
7. 玩家说的人和事默认都发生在这局《钢铁雄心4》里：“某某死了”“被暗杀”“阵亡”“被俘”“政变”“投降”“被轰炸”都是游戏内事件（国家领导人去世、将领或顾问阵亡/被撤换、内战与政变等）。照游戏机制查清楚再答：发生了什么、有什么影响、谁接任、现在该怎么处理（需要时用 search_localisation / search_scripts 查相关事件和顾问）。不知道是谁、哪个事件时，先给通用处置（空出的是哪类职位、去哪个界面补任、空缺有什么影响），再请玩家报姓名或事件名，不要只反问。用参谋身份在战局里回应（如“参谋长殉职，须尽快任命继任者”），不要当成现实中有人去世来安慰、劝人求助，也不要跳出来解释“这是游戏”。只有玩家明确说的是现实生活里自己或身边人的事（如“我现实中…”“我家里…”），才放下角色，认真关心他。`;

const TOOLS = [
  { name: 'get_game_state', description: '当前局面：游戏是否在运行、版本、启用模组、最新存档（玩家国家 tag、日期、是否二进制）、文本存档里的已完成国策/当前国策。', parameters: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'look_at_screen', description: '截取玩家现在的游戏画面（左上角国旗=玩家国家，顶栏日期，国策树/事件/决议界面上的内容）。存档读不到当前局面、或玩家问“现在/这个/下一步”时先看画面。截图会作为下一条消息附上。', parameters: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'report_player_country', description: '从画面或玩家的话确认了玩家正在玩的国家后上报，界面会切换国旗。tag 用三位国家代码（如 GER、SOV、USA），ideology 填 fascism/communism/democratic/neutrality 或留空。', parameters: { type: 'object', properties: { tag: { type: 'string' }, ideology: { type: 'string' } }, required: ['tag'], additionalProperties: false } },
  { name: 'search_localisation', description: '在游戏+启用模组的本地化文本里按关键词搜（中文名或 key 片段，空格分隔=都要包含）。返回 key、中文、类型（国策/决议/国名/事件/国家精神）。用来把中文名换成脚本 id。', parameters: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer', description: '默认 25，最多 60' } }, required: ['query'], additionalProperties: false } },
  { name: 'find_focus', description: '按中文名/描述关键词搜国策（空格分隔，任意词命中都算，按命中多少排序），可用 tag（如 SOV）限定国家。用来找目标对应的“终点国策”。', parameters: { type: 'object', properties: { query: { type: 'string' }, tag: { type: 'string' }, limit: { type: 'integer' } }, required: ['query'], additionalProperties: false } },
  { name: 'get_focus', description: '查国策：中文名、所在国策树和适用国家、耗时、前置（all_of 里每组 any_of 任选一个）、互斥、解锁的后续国策、available 条件、完成奖励、是否已完成。查一个用 id，一次查多个用 ids（最多 8 个）。', parameters: { type: 'object', properties: { id: { type: 'string' }, ids: { type: 'array', items: { type: 'string' } } }, additionalProperties: false } },
  { name: 'focus_path', description: '从国策树根到目标国策的完整前置链（按先后顺序），含每步互斥、是否已被锁死、多选一分叉(or_choices)、剩余天数。', parameters: { type: 'object', properties: { target: { type: 'string', description: '目标国策 id' } }, required: ['target'], additionalProperties: false } },
  { name: 'get_military', description: '兵力部署（读最新文本存档）：玩家和所有交战国（按师数排，最多 4 个）的陆军——师数、平均组织度、主要师模板及编成（几个步兵营/炮兵营、支援连）、按州分布（州名、该州现归属、各模板师数）。想对比还没开战的国家，用 tags 传它们的三位代码（如 ["POL"]）。', parameters: { type: 'object', properties: { tags: { type: 'array', items: { type: 'string' } } }, additionalProperties: false } },
  { name: 'get_decision', description: '查一个决议：中文名、分类、脚本（可见条件、可用条件、花费、效果）。', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false } },
  { name: 'search_scripts', description: '在生效的脚本文件（common/ events/ history/，模组已覆盖原版）里按正则搜，返回文件、行号、该行。dir 可限定前缀如 "common/decisions/" 或 "events/"。', parameters: { type: 'object', properties: { pattern: { type: 'string' }, dir: { type: 'string' }, limit: { type: 'integer' } }, required: ['pattern'], additionalProperties: false } },
  { name: 'read_file', description: '读生效脚本文件的行区间（每次最多 250 行），路径用游戏目录下的相对路径。', parameters: { type: 'object', properties: { file: { type: 'string' }, start: { type: 'integer' }, end: { type: 'integer' } }, required: ['file'], additionalProperties: false } },
];

const TOOL_LABEL = {
  get_game_state: '查看局面', look_at_screen: '查看战况画面', report_player_country: '确认国别', search_localisation: '查中文名', find_focus: '找国策', get_focus: '查国策', focus_path: '推演路线',
  get_decision: '查决议', get_military: '查兵力部署', search_scripts: '翻脚本', read_file: '读文件',
};

class Agent {
  constructor({ config, gamedata, fetchImpl, getRunning, captureScreen, onCountry }) {
    this.config = config;
    this.gd = gamedata;
    this.captureScreen = captureScreen; // async () => 'data:image/jpeg;base64,…'
    this.onCountry = onCountry || (() => {});
    this.pendingImages = [];
    // 每个请求都限时：中转卡住时不能让整条提问队列一直挂着
    this.fetch = (url, opts = {}) => {
      const ctl = new AbortController();
      const ms = opts.timeoutMs || this.config.requestTimeoutMs || 120000;
      const timer = setTimeout(() => ctl.abort(), ms);
      return fetchImpl(url, { ...opts, signal: ctl.signal })
        .catch((e) => { throw ctl.signal.aborted ? new Error(`接口 ${Math.round(ms / 1000)} 秒没回应，已放弃这次请求，再发一次试试。`) : e; })
        .finally(() => clearTimeout(timer));
    };
    this.getRunning = getRunning || (() => undefined);
    this.recentSpeech = []; // 最近几次播报，随快照发回去，免得每次一个开头（新对话也不清）
    this.reset();
  }

  reset() {
    this.usage = { calls: 0, input: 0, output: 0 };
    this.history = [];
    this.chatHistory = [];
  }

  base() { return (this.config.baseURL || 'https://api.openai.com/v1').replace(/\/+$/, ''); }

  headers(extra = {}) {
    if (!this.config.apiKey) throw new Error('还没填 OpenAI API Key：点窗口右上角「设置」填上。');
    return { Authorization: `Bearer ${this.config.apiKey}`, ...extra };
  }

  async post(pathname, body) {
    this.usage.calls++;
    const res = await this.fetch(this.base() + pathname, {
      method: 'POST', headers: this.headers({ 'Content-Type': 'application/json' }), body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(explain(res.status, text));
    const data = JSON.parse(text);
    const u = data.usage || {};
    this.usage.input += u.input_tokens || u.prompt_tokens || 0;
    this.usage.output += u.output_tokens || u.completion_tokens || 0;
    return data;
  }

  // 中转的模型名常带前缀，直接问接口要列表
  async listModels({ apiKey, baseURL } = {}) {
    const key = apiKey || this.config.apiKey;
    if (!key) throw new Error('先填 API Key');
    const base = (baseURL || this.base()).replace(/\/+$/, '');
    const res = await this.fetch(base + '/models', { headers: { Authorization: `Bearer ${key}` } });
    const text = await res.text();
    if (!res.ok) throw new Error(`获取模型失败 ${res.status}: ${text.slice(0, 300)}`);
    const data = JSON.parse(text);
    return (data.data || data.models || []).map((m) => (typeof m === 'string' ? m : m.id)).filter(Boolean).sort();
  }

  async runTool(name, args) {
    const gd = this.gd;
    gd.refreshIfChanged();
    switch (name) {
      case 'get_game_state': return gd.gameState(this.getRunning());
      case 'look_at_screen': {
        if (!this.captureScreen) return { error: '这台电脑上截不了屏' };
        const shot = await this.captureScreen();
        this.pendingImages.push(shot);
        return { ok: true, note: '截图已作为下一条消息附上；如果画面不是钢铁雄心（玩家切到了别的窗口），就直接问玩家' };
      }
      case 'report_player_country': {
        const ov = gd.setCountry(args.tag, args.ideology);
        if (ov) this.onCountry(ov);
        return ov ? { ok: true, tag: ov.tag, ideology: ov.ideology, country: gd.name(`${ov.tag}_${ov.ideology}`) || gd.name(ov.tag) } : { error: '国家代码不对' };
      }
      case 'search_localisation': return gd.searchLocalisation(args.query, args.limit);
      case 'find_focus': return gd.findFocus(args.query, args.tag, args.limit);
      case 'get_focus': return args.ids && args.ids.length ? args.ids.slice(0, 8).map((x) => gd.getFocus(x)) : gd.getFocus(args.id);
      case 'focus_path': return gd.focusPath(args.target);
      case 'get_decision': return gd.getDecision(args.id);
      case 'get_military': return gd.military(args.tags);
      case 'search_scripts': return gd.searchScripts(args.pattern, args.dir, args.limit);
      case 'read_file': return gd.readFile(args.file, args.start, args.end);
      default: return { error: `未知工具 ${name}` };
    }
  }

  async callTool(name, rawArgs, onEvent) {
    let args = {};
    try { args = JSON.parse(rawArgs || '{}'); } catch {}
    const brief = args.query || args.id || (args.ids && args.ids.join('、')) || args.target || args.pattern || args.file || '';
    onEvent({ type: 'tool', name, label: TOOL_LABEL[name] || name, detail: String(brief) });
    let out;
    try { out = await this.runTool(name, args); } catch (e) { out = { error: e.message }; }
    if (name === 'focus_path' && out && !out.error) this.turnRoute = out;
    const s = JSON.stringify(out);
    return s.length > 16000 ? s.slice(0, 16000) + '…(结果过长已截断，请缩小范围)' : s;
  }

  // 返回 { text, speech, usage }；usage 是这一问花掉的调用次数和 token（次卡按次扣，额度卡按 token 扣）
  async ask(userText, onEvent = () => {}) {
    this.usage = { calls: 0, input: 0, output: 0 };
    this.turnRoute = null;
    this.earlySpeech = null;
    const ctx = await this.buildContext(onEvent, userText);
    const question = `${ctx.text}\n\n玩家问：${userText}`;
    if (ctx.image) this.pendingImages.push(ctx.image);
    const raw = this.config.apiStyle === 'chat' ? await this.askChat(question, onEvent) : await this.askResponses(question, onEvent);
    const out = splitSpeech(raw);
    if (out.speech) this.recentSpeech = [...this.recentSpeech, out.speech].slice(-4);
    return { ...out, usage: { ...this.usage }, route: slimRoute(this.turnRoute) };
  }

  // 对话记录自己存、每轮完整发送：中转普遍不支持 previous_response_id（要求官方账号）
  // 流式请求：边收边看，第一行【播报】一写完就发 speech 事件（先念起来），最后返回完整 response
  async postStream(pathname, body, onEvent) {
    this.usage.calls++;
    const res = await this.fetch(this.base() + pathname, {
      method: 'POST', headers: this.headers({ 'Content-Type': 'application/json' }), body: JSON.stringify({ ...body, stream: true }),
    });
    if (!res.ok) throw new Error(explain(res.status, await res.text()));
    if (!/event-stream/.test(res.headers.get('content-type') || '')) {
      // 中转不支持流式就当普通请求
      const data = JSON.parse(await res.text());
      this.addUsage(data.usage);
      return data;
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '', text = '', spoke = false, done = null;
    const items = []; // 有的中转在 completed 里不带 output，要自己从 output_item.done 拼
    for (;;) {
      const { value, done: end } = await reader.read();
      if (end) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith('data:')) continue;
        const raw = line.slice(5).trim();
        if (!raw || raw === '[DONE]') continue;
        let ev;
        try { ev = JSON.parse(raw); } catch { continue; }
        if (ev.type === 'response.output_text.delta' && ev.delta) {
          text += ev.delta;
          if (!spoke) {
            const m = text.match(/【播报】[:：]?\s*([^\n]+)\n/);
            if (m) { spoke = true; this.earlySpeech = m[1].replace(/[*#`]/g, '').trim(); onEvent({ type: 'speech', text: this.earlySpeech }); }
          }
        } else if (ev.type === 'response.output_item.done' && ev.item) {
          items[typeof ev.output_index === 'number' ? ev.output_index : items.length] = ev.item;
        } else if (ev.type === 'response.completed' || ev.type === 'response.incomplete') done = ev.response;
        else if (ev.type === 'response.failed' || ev.type === 'error') throw new Error('OpenAI 出错：' + JSON.stringify(ev.response?.error || ev.error || ev).slice(0, 300));
      }
    }
    if (!done) throw new Error('流式回答中断了，再问一次试试');
    if (!done.output || !done.output.length) done.output = items.filter(Boolean);
    this.addUsage(done.usage);
    return done;
  }

  addUsage(u = {}) {
    this.usage.input += u.input_tokens || u.prompt_tokens || 0;
    this.usage.output += u.output_tokens || u.completion_tokens || 0;
  }

  // 本地把局面整理好随问题一起发，省掉模型专门去查的那一轮
  async buildContext(onEvent, question = '') {
    if (!this.gd) return { text: '' };
    let st;
    try { st = await this.gd.gameState(this.getRunning()); } catch { return { text: '' }; }
    const s = st.latest_save || {};
    const cur = st.screen_country || (st.country_uncertain ? null : s.player_tag && { tag: s.player_tag, ideology: s.player_ideology, country: s.player_country });
    const lines = [`游戏${st.hoi4_running ? '正在运行' : '没有运行'}；版本 ${st.game_version || '未知'}；启用模组：${(st.enabled_mods || []).join('、') || '无'}`];
    if (!st.hoi4_running) lines.push(`玩家国家：游戏没在运行，不确定接下来玩哪国${cur ? `（上一局存档是${cur.country}（${cur.tag}），仅供参考）` : ''}；问到具体局面先问玩家`);
    else lines.push(cur ? `玩家国家：${cur.country}（${cur.tag}，${cur.ideology || '意识形态未知'}）${st.screen_country ? '，从游戏画面认出' : ''}` : '玩家国家：还不确定（新开局还没存档）');
    if (st.hoi4_running && st.log_game_date) lines.push(`游戏内日期：${st.log_game_date}`);
    if (!st.hoi4_running) lines.push('战争状态：游戏没在运行——播报从容清楚');
    else if (st.at_war === true) lines.push(`战争状态：交战中（对 ${st.enemies.map((e) => `${e.name}，${e.since} 开战`).join('；')}）——播报更短、更紧迫、斩钉截铁`);
    else if (st.at_war === false) lines.push('战争状态：和平，未参战——播报从容清楚，不喊口号、不渲染战火');
    lines.push(`称谓：${addressFor(st.hoi4_running ? cur : null)}（多数播报省略称谓）`);
    if (this.recentSpeech.length) lines.push(`你最近的播报（这次换开头和句式）：\n${this.recentSpeech.map((s) => '- ' + s).join('\n')}`);
    const p = st.player;
    const known = p && p.completed_focus && !st.player_note && !st.country_uncertain;
    if (known) {
      lines.push(`当前国策：${p.current_focus ? `${p.current_focus.name || ''}（${p.current_focus.id}）` : '无'}`);
      lines.push(`已完成国策 ${p.completed_focus.length} 个：${p.completed_focus.slice(-40).map((f) => f.name || f.id).join('、') || '无'}`);
      const tree = p.other_fields && p.other_fields.focus_tree;
      if (tree) {
        const next = this.gd.nextFocuses(tree, new Set(p.completed_focus.map((f) => f.id)), p.current_focus && p.current_focus.id);
        if (next.length) lines.push(`现在可以点的国策（前置已满足，括号里是 id、天数、互斥、条件）：\n${next.map((f) => `- ${f.name}（${f.id}，${f.days || '?'}天${f.mutex.length ? '，互斥：' + f.mutex.join('/') : ''}${f.available ? '，条件：' + f.available : ''}）`).join('\n')}`);
      }
    } else {
      lines.push('国策进度：存档里读不到（二进制存档或新开局），以画面为准，必要时问玩家');
    }
    let image = null;
    if (st.hoi4_running && !known && this.captureScreen) {
      try { image = await this.captureScreen(); onEvent({ type: 'tool', name: 'look_at_screen', label: '查看战况画面', detail: '' }); } catch {}
    }
    // 问题里提到的国名：先在本地查好对应国家和候选终点国策，省掉“查中文名”那一轮
    try {
      const hints = this.gd.goalHints(question);
      if (hints.length) lines.push(`问题里提到的国名（已替你查好）：\n${hints.map((h) => `- 「${h.name}」= ${h.tag}${h.ideology ? ` 的${h.ideology}国名` : ''}${h.focuses.length ? `；候选终点国策：${h.focuses.join('、')}` : ''}`).join('\n')}\n确认终点后直接调用 focus_path。`);
    } catch {}
    if (/布兵|布防|兵力|部署|防线|战线|前线|进攻|防守|主攻|推进|守得住|打得过|打不过|调兵|师|部队|军队/.test(question) && st.hoi4_running && !st.country_uncertain) {
      try {
        const mil = this.gd.military();
        if (!mil.error) lines.push(`兵力部署（已替你查好，等同 get_military 的结果）：${JSON.stringify(mil)}`);
      } catch {}
    }
    return { text: `【局面快照】\n${lines.join('\n')}`, image };
  }

  async askResponses(userText, onEvent) {
    const tools = TOOLS.map((t) => ({ type: 'function', ...t }));
    const h = this.history;
    if (this.pendingImages.length) {
      h.push({ role: 'user', content: [{ type: 'input_text', text: userText }, ...this.pendingImages.map((u) => ({ type: 'input_image', image_url: u, detail: 'high' }))] });
      this.pendingImages = [];
    } else h.push({ role: 'user', content: userText });
    for (let step = 0; step < 16; step++) {
      trimHistory(h);
      const body = { model: this.config.model, instructions: SYSTEM, input: h, tools, store: false };
      if (this.config.reasoningEffort) body.reasoning = { effort: this.config.reasoningEffort };
      const r = await this.postStream('/responses', body, onEvent);
      const out = r.output || [];
      const calls = out.filter((o) => o.type === 'function_call');
      const text = out.filter((o) => o.type === 'message').flatMap((o) => o.content || [])
        .filter((c) => c.type === 'output_text').map((c) => c.text).join('\n');
      // 回传时去掉 id、不带 reasoning 条目：带 id 的 function_call 会被要求配对 reasoning，无状态时会报错
      for (const c of calls) h.push({ type: 'function_call', call_id: c.call_id, name: c.name, arguments: c.arguments });
      if (text) h.push({ role: 'assistant', content: text });
      if (!calls.length) { dropImages(h); return text || r.output_text || ''; }
      for (const c of calls) {
        h.push({ type: 'function_call_output', call_id: c.call_id, output: await this.callTool(c.name, c.arguments, onEvent) });
      }
      if (this.pendingImages.length) {
        h.push({ role: 'user', content: [{ type: 'input_text', text: '（系统附图：玩家当前的游戏画面）' }, ...this.pendingImages.map((u) => ({ type: 'input_image', image_url: u, detail: 'high' }))] });
        this.pendingImages = [];
      }
    }
    throw new Error('查了太多轮还没结论，换个更具体的问法试试。');
  }

  async askChat(userText, onEvent) {
    const tools = TOOLS.map((t) => ({ type: 'function', function: t }));
    if (!this.chatHistory.length) this.chatHistory.push({ role: 'system', content: SYSTEM });
    if (this.pendingImages.length) {
      this.chatHistory.push({ role: 'user', content: [{ type: 'text', text: userText }, ...this.pendingImages.map((u) => ({ type: 'image_url', image_url: { url: u } }))] });
      this.pendingImages = [];
    } else this.chatHistory.push({ role: 'user', content: userText });
    for (let step = 0; step < 16; step++) {
      trimHistory(this.chatHistory);
      const body = { model: this.config.model, messages: this.chatHistory, tools };
      if (this.config.reasoningEffort) body.reasoning_effort = this.config.reasoningEffort;
      const r = await this.post('/chat/completions', body);
      const msg = r.choices[0].message;
      this.chatHistory.push(msg);
      if (!msg.tool_calls || !msg.tool_calls.length) { dropImages(this.chatHistory); return msg.content || ''; }
      for (const c of msg.tool_calls) {
        this.chatHistory.push({ role: 'tool', tool_call_id: c.id, content: await this.callTool(c.function.name, c.function.arguments, onEvent) });
      }
      if (this.pendingImages.length) {
        this.chatHistory.push({ role: 'user', content: [{ type: 'text', text: '（系统附图：玩家当前的游戏画面）' }, ...this.pendingImages.map((u) => ({ type: 'image_url', image_url: { url: u } }))] });
        this.pendingImages = [];
      }
    }
    throw new Error('查了太多轮还没结论，换个更具体的问法试试。');
  }

  // 看左上角截图认玩家国家；不是钢铁雄心画面就返回 null
  async identifyCountry(dataUrl) {
    const prompt = '这是电脑屏幕左上角的截图。如果它是《钢铁雄心4》游戏画面，左上角方框里的国旗就是玩家的国家。只输出一行 JSON，不要别的：{"hoi4":true或false,"country":"中文国名","tag":"三位国家代码，如 GER SOV USA ENG FRA ITA JAP CHI PRC","ideology":"fascism/communism/democratic/neutrality/unknown"}';
    const model = this.config.visionModel || 'gpt-6-luna';
    let text;
    if (this.config.apiStyle === 'chat') {
      const r = await this.post('/chat/completions', { model, messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: dataUrl } }] }] });
      text = r.choices[0].message.content || '';
    } else {
      const r = await this.post('/responses', { model, store: false, input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }, { type: 'input_image', image_url: dataUrl, detail: 'high' }] }] });
      text = (r.output || []).filter((o) => o.type === 'message').flatMap((o) => o.content || []).filter((c) => c.type === 'output_text').map((c) => c.text).join('');
    }
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const j = JSON.parse(m[0]);
    return j.hoi4 ? j : null;
  }

  async transcribe(audio, mime = 'audio/webm') {
    if (this.config.sttEngine === 'local') return require('./stt-local').transcribeLocal(audio, mime, this.config);
    const boundary = '----hoi4advisor' + Date.now().toString(16);
    const field = (k, v) => Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`);
    const ext = mime.includes('mp4') ? 'm4a' : mime.includes('wav') ? 'wav' : 'webm';
    const body = Buffer.concat([
      field('model', this.config.transcribeModel),
      field('language', 'zh'),
      field('prompt', '钢铁雄心4 国策 决议 俄罗斯帝国 苏联 沙皇 罗曼诺夫 法西斯 共产主义 民主 中立 内战 政变 互斥 前置'),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="speech.${ext}"\r\nContent-Type: ${mime}\r\n\r\n`),
      Buffer.from(audio),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const res = await this.fetch(this.base() + '/audio/transcriptions', {
      method: 'POST', headers: this.headers({ 'Content-Type': `multipart/form-data; boundary=${boundary}` }), body,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`语音转写失败 ${res.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text).text || '';
  }

  // 流式朗读：返回 Response，调用方边读边播
  async speakStream(text) { return this.config.ttsEngine === 'fish' ? this.fishRequest(text) : this.speechRequest(text); }

  // Fish Audio：按音色模型 id 合成，返回流式 mp3
  async fishRequest(text) {
    const c = this.config;
    if (!c.fishApiKey) throw new Error('Fish Audio 没配置：设置里填 Fish API Key');
    const res = await this.fetch('https://api.fish.audio/v1/tts', {
      method: 'POST',
      headers: { Authorization: `Bearer ${c.fishApiKey}`, 'Content-Type': 'application/json', model: c.fishModel || 's2.1-pro' },
      body: JSON.stringify({
        text: String(text).slice(0, 500),
        reference_id: c.fishVoice,
        format: 'mp3',
        latency: 'balanced',
        temperature: 0.5, // 随机度低一点，咬字更稳
        top_p: 0.6,
        prosody: { speed: Number(c.fishSpeed) || 1 },
      }),
      timeoutMs: 60000,
    });
    if (!res.ok) {
      const body = (await res.text()).slice(0, 300);
      const why = res.status === 401 ? 'Key 不对' : res.status === 402 ? '账户余额不足' : `错误 ${res.status}`;
      throw new Error(`Fish Audio 朗读失败（${why}）：${body}`);
    }
    return res;
  }

  async speak(text) {
    if (this.config.ttsEngine === 'doubao') return this.doubaoSpeak(text);
    if (this.config.ttsEngine === 'fish') return new Uint8Array(await (await this.fishRequest(text)).arrayBuffer());
    const res = await this.speechRequest(text);
    return new Uint8Array(await res.arrayBuffer());
  }

  // 火山引擎豆包语音（HTTP 一次返回整段 mp3）
  async doubaoSpeak(text) {
    const c = this.config;
    if (!c.doubaoAppId || !c.doubaoToken) throw new Error('豆包朗读没配置：设置里填 AppID 和 Token');
    const res = await this.fetch('https://openspeech.bytedance.com/api/v1/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer;' + c.doubaoToken },
      body: JSON.stringify({
        app: { appid: c.doubaoAppId, token: c.doubaoToken, cluster: c.doubaoCluster || 'volcano_tts' },
        user: { uid: 'hoi4-advisor' },
        audio: { voice_type: c.doubaoVoice, encoding: 'mp3', speed_ratio: Number(c.doubaoSpeed) || 1.1 },
        request: { reqid: require('crypto').randomUUID(), text: String(text).slice(0, 300), text_type: 'plain', operation: 'query' },
      }),
      timeoutMs: 30000,
    });
    const j = await res.json();
    if (j.code !== 3000 || !j.data) throw new Error(`豆包朗读失败 code=${j.code} ${j.message || ''}`);
    return new Uint8Array(Buffer.from(j.data, 'base64'));
  }

  // 朗读：填了官方 Key 就走官方 OpenAI（中转一般没有朗读模型），音色默认跟 GPT Live 一样
  async speechRequest(text) {
    const c = this.config;
    const official = !!c.liveApiKey;
    const base = official ? (c.liveBaseURL || 'https://api.openai.com/v1').replace(/\/+$/, '') : this.base();
    const key = official ? c.liveApiKey : c.apiKey;
    if (!key) throw new Error('朗读需要 API Key');
    const body = { model: c.ttsModel, voice: c.ttsVoice || c.liveVoice || 'cedar', input: text, response_format: 'mp3' };
    if (c.ttsInstructions) body.instructions = c.ttsInstructions;
    const res = await this.fetch(base + '/audio/speech', {
      method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`朗读失败 ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return res;
  }
}

// 界面画国策链只需要这些字段
function slimRoute(r) {
  if (!r || !Array.isArray(r.steps)) return null;
  return {
    target: r.target,
    progress_known: !!r.progress_known,
    locked: !!r.locked,
    remaining_days: r.remaining_days,
    steps: r.steps.map((s) => ({
      id: s.id, name: s.name, days: s.days, completed: s.completed,
      mutex: (s.mutually_exclusive || []).map((m) => m.name || m.id),
      locked_by: (s.locked_by_completed || []).map((m) => m.name || m.id),
    })),
    or_choices: (r.or_choices || []).map((c) => ({
      for: c.for && c.for.id, picked: c.picked,
      options: (c.any_of || []).map((o) => ({ id: o.id, name: o.name, feasible: o.feasible })),
    })),
  };
}

// 一问结束后把截图换成文字，免得之后每轮都重发几百 KB 的图
function dropImages(h) {
  for (const item of h) {
    if (item.role === 'user' && Array.isArray(item.content) && item.content.some((c) => c.type === 'input_image' || c.type === 'image_url')) {
      const text = item.content.filter((c) => c.type === 'input_text' || c.type === 'text').map((c) => c.text).join('\n');
      item.content = `${text}\n（当时附的游戏画面截图已省略）`;
    }
  }
}

// 对话太长时，从最早的工具结果开始省略，控制每轮发送的 token（截图的 base64 不算进长度）
function trimHistory(h, maxChars = 120000) {
  let size = JSON.stringify(h, (k, v) => (k === 'image_url' || k === 'url' ? '' : v)).length;
  for (const item of h) {
    if (size <= maxChars) break;
    const key = item.type === 'function_call_output' ? 'output' : item.role === 'tool' ? 'content' : null;
    if (!key || item[key].length < 200) continue;
    size -= item[key].length - 20;
    item[key] = '(较早的查询结果已省略)';
  }
}

// 常见报错翻译成人话
function explain(status, text) {
  const raw = `（${status}）${text.slice(0, 300)}`;
  if (/insufficient_quota|credit|balance|余额|额度不足/i.test(text)) return '账户没余额了：官方 OpenAI 要去 platform.openai.com 充值；用中转就去中转查额度。' + raw;
  if (status === 401 || /invalid_api_key|Incorrect API key/i.test(text)) return 'API Key 不对，或者和接口地址不匹配（中转的 Key 要配中转的地址）。' + raw;
  if (status === 404 || /model_not_found|does not exist|无可用渠道|model.*not/i.test(text)) return '模型名不对或这个接口不支持：在设置里点「获取模型」选一个；中转不支持 Responses 就把接口类型换成 Chat。' + raw;
  if (status === 429) return '请求太频繁，等几秒再问。' + raw;
  return 'OpenAI 出错' + raw;
}

// 参谋怎么称呼玩家：共产主义政体叫“首长”，其余叫“指挥官”（不用“元首”“陛下”这类）
function addressFor(cur) {
  return cur && cur.ideology === 'communism' ? '首长' : '指挥官';
}

// 把「【播报】…」拆出来：屏幕显示全文，嘴只念这一句
function splitSpeech(raw) {
  const text = String(raw || '').trim();
  // 新格式：【播报】在第一行
  const first = text.match(/^\s*\**【播报】[:：]?\s*([^\n]+)\n?/);
  if (first) return { text: text.slice(first[0].length).trim(), speech: first[1].replace(/[*#`]/g, '').trim() };
  const m = text.match(/【播报】[:：]?\s*([\s\S]+?)\s*$/);
  if (m) return { text: text.slice(0, m.index).replace(/\s*\*+\s*$/, '').trim(), speech: m[1].replace(/[*#`]/g, '').trim() };
  const plain = text.replace(/[*#`>|-]/g, '').replace(/\s+/g, ' ').trim();
  return { text, speech: plain.slice(0, 80) };
}

module.exports = { Agent, TOOLS, SYSTEM, splitSpeech, explain, addressFor };
