// 读本机钢铁雄心4的游戏文件、模组和存档，给 GPT 当工具用。不依赖 Electron，可以直接用 node 测。
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const pdx = require('./pdx');

const HOME = os.homedir();
const DEFAULT_GAME_DIR = path.join(HOME, 'Library/Application Support/Steam/steamapps/common/Hearts of Iron IV');
const DEFAULT_USER_DIR = path.join(HOME, 'Documents/Paradox Interactive/Hearts of Iron IV');
const SCRIPT_DIRS = ['common', 'events', 'history'];

const readText = (p) => fs.readFileSync(p, 'utf8');
const exists = (p) => { try { fs.accessSync(p); return true; } catch { return false; } };

function walk(dir, out = []) {
  let list;
  try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const d of list) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) walk(p, out);
    else if (/\.(txt|yml)$/i.test(d.name)) out.push(p);
  }
  return out;
}

function isProcessRunning(name = 'hoi4') {
  return new Promise((resolve) => execFile('pgrep', ['-x', name], (err) => resolve(!err)));
}

class GameData {
  constructor({ gameDir, userDir } = {}) {
    this.gameDir = gameDir || DEFAULT_GAME_DIR;
    this.userDir = userDir || DEFAULT_USER_DIR;
    this.textCache = new Map();
    this._files = null;
    this._loc = null;
    this._focus = null;
    this._decisions = null;
    this._saveCache = null;
    this._sig = null;
    this.countryOverride = null; // 从游戏画面认出来的国家 { tag, ideology, at }
  }

  // 画面识别/AI 上报的国家：比最新存档和本次开局都新才算数
  // 游戏关掉时清掉画面认出的国家，下一局重新认
  clearCountry() { this.countryOverride = null; }

  setCountry(tag, ideology) {
    tag = String(tag || '').toUpperCase();
    if (!/^[A-Z][A-Z0-9]{2}$/.test(tag)) return null;
    const ideo = /^(fascism|communism|democratic|neutrality)$/.test(ideology || '') ? ideology : this.startingIdeology(tag);
    this.countryOverride = { tag, ideology: ideo, at: new Date() };
    return this.countryOverride;
  }

  // history/countries/TAG - xxx.txt 里的开局执政党
  startingIdeology(tag) {
    try {
      const dir = path.join(this.gameDir, 'history/countries');
      const f = fs.readdirSync(dir).find((x) => x.startsWith(tag + ' '));
      return (fs.readFileSync(path.join(dir, f), 'utf8').match(/ruling_party\s*=\s*(\w+)/) || [])[1] || null;
    } catch { return null; }
  }

  // 问题里提到的国名（含随意识形态变化的国名）→ 对应国家和意识形态；再按意识形态搜几个候选终点国策
  goalHints(question) {
    if (!this._countryNames) {
      this._countryNames = [];
      for (const [key, v] of this.loc()) {
        const m = key.match(/^([A-Z][A-Z0-9]{2})(?:_(fascism|communism|democratic|neutrality))?$/);
        const name = v.text.replace(/§./g, '').trim();
        if (m && name.length >= 2 && !/[\[$]/.test(name)) this._countryNames.push({ name, tag: m[1], ideology: m[2] || null });
      }
      this._countryNames.sort((a, b) => b.name.length - a.name.length);
    }
    const q = String(question || '');
    const hits = [];
    for (const c of this._countryNames) {
      if (q.includes(c.name) && !hits.some((h) => h.name.includes(c.name))) hits.push(c);
      if (hits.length >= 3) break;
    }
    // 关键词别用意识形态本身（“法西斯”会把“反法西斯政策”也搜出来），用这种政体终点常见的字眼
    const words = { fascism: '帝国 沙皇 复辟 王朝 加冕 皇帝 君主', communism: '共产 苏维埃 革命 人民 公社', democratic: '民主 共和 选举 宪法 议会', neutrality: '君主 王国 摄政 复辟 王朝' };
    return hits.map((h) => ({
      ...h,
      focuses: h.ideology ? this.findFocus(words[h.ideology], h.tag, 6).results.map((f) => `${f.name}（${f.id}）`) : [],
    }));
  }

  // 中文国名 → 国家代码（如「德意志国」→ GER/fascism）
  tagByName(name) {
    const n = String(name || '').trim();
    if (!n) return null;
    for (const [key, v] of this.loc()) {
      const m = key.match(/^([A-Z][A-Z0-9]{2})(?:_(fascism|communism|democratic|neutrality))?$/);
      if (m && v.text === n) return { tag: m[1], ideology: m[2] || null };
    }
    return null;
  }

  // 启用模组或模组文件变了（切模组、创意工坊更新）就丢掉所有索引
  refreshIfChanged() {
    let sig = '';
    try { sig = readText(path.join(this.userDir, 'dlc_load.json')); } catch {}
    for (const m of this.mods()) {
      try { sig += '|' + m.dir + ':' + fs.statSync(m.dir).mtimeMs; } catch {}
    }
    if (sig === this._sig) return false;
    const first = this._sig === null;
    this._sig = sig;
    if (!first) { this._files = this._loc = this._focus = this._decisions = null; this.textCache.clear(); }
    return !first;
  }

  // ---------- 模组和“生效文件” ----------
  mods() {
    let enabled = [];
    try { enabled = JSON.parse(readText(path.join(this.userDir, 'dlc_load.json'))).enabled_mods || []; } catch {}
    return enabled.map((rel) => {
      const descPath = path.join(this.userDir, rel);
      let text = '';
      try { text = readText(descPath); } catch { return null; }
      const name = (text.match(/^\s*name\s*=\s*"([^"]*)"/m) || [])[1] || rel;
      let p = (text.match(/^\s*path\s*=\s*"([^"]*)"/m) || [])[1];
      if (p && !path.isAbsolute(p)) p = path.join(this.userDir, p);
      const replace = [...text.matchAll(/^\s*replace_path\s*=\s*"([^"]*)"/gm)].map((m) => m[1].replace(/\\/g, '/').replace(/\/$/, ''));
      return { name, dir: p, replace, ok: !!p && exists(p) };
    }).filter(Boolean);
  }

  // 相对路径 → 实际文件（后加载的模组覆盖前面的，replace_path 清掉原版对应目录）
  files() {
    if (this._sig === null) this.refreshIfChanged();
    if (this._files) return this._files;
    const map = new Map();
    const add = (root) => {
      for (const sub of [...SCRIPT_DIRS, 'localisation']) {
        for (const abs of walk(path.join(root, sub))) {
          map.set(path.relative(root, abs).split(path.sep).join('/'), abs);
        }
      }
    };
    add(this.gameDir);
    for (const m of this.mods()) {
      if (!m.ok) continue;
      for (const dir of m.replace) {
        for (const rel of [...map.keys()]) if (rel.startsWith(dir + '/')) map.delete(rel);
      }
      add(m.dir);
    }
    this._files = map;
    return map;
  }

  text(abs) {
    let t = this.textCache.get(abs);
    if (t === undefined) {
      t = readText(abs).replace(/^﻿/, '');
      this.textCache.set(abs, t);
    }
    return t;
  }

  scriptFiles(prefix) {
    const out = [];
    for (const [rel, abs] of this.files()) {
      if (!rel.endsWith('.txt')) continue;
      if (prefix ? rel.startsWith(prefix) : SCRIPT_DIRS.some((d) => rel.startsWith(d + '/'))) out.push([rel, abs]);
    }
    return out;
  }

  // ---------- 本地化（中文名） ----------
  loc() {
    if (this._loc) return this._loc;
    const map = new Map();
    const lineRe = /^\s*([A-Za-z0-9_.\-']+):\d*\s*"(.*)"\s*(?:#.*)?$/;
    const load = (wanted) => {
      let n = 0;
      for (const [rel, abs] of this.files()) {
        if (!rel.startsWith('localisation/') || !rel.includes(wanted)) continue;
        for (const line of this.text(abs).split('\n')) {
          const m = line.match(lineRe);
          if (m) { map.set(m[1], { text: m[2], file: rel }); n++; }
        }
        this.textCache.delete(abs); // 本地化文件很大，读完就丢
      }
      return n;
    };
    load('l_english'); // 先读英文兜底（模组可能没汉化），再用中文覆盖
    load('l_simp_chinese');
    this._loc = map;
    return map;
  }

  name(key) {
    const e = this.loc().get(key);
    return e ? e.text.replace(/§./g, '').replace(/\\n/g, ' ') : null;
  }

  // ---------- 国策树 ----------
  focusIndex() {
    if (this._focus) return this._focus;
    const focuses = new Map();
    const trees = new Map();
    const parseFocus = (block, rel, line, tree) => {
      const e = pdx.entries(block);
      const id = pdx.get(e, 'id');
      if (!id) return;
      const prereq = pdx.getAll(e, 'prerequisite').map((p) =>
        pdx.entries(p.block || '').filter((x) => x.key === 'focus').map((x) => x.value));
      const mutex = pdx.getAll(e, 'mutually_exclusive').flatMap((p) =>
        pdx.entries(p.block || '').filter((x) => x.key === 'focus').map((x) => x.value));
      const iconRaw = pdx.get(e, 'icon');
      const icon = typeof iconRaw === 'string' ? ((iconRaw.match(/GFX_[\w.\-]+/) || [])[0] || null) : null;
      focuses.set(id, {
        id, tree, file: rel, line, icon,
        cost: Number(pdx.get(e, 'cost')) || null,
        prereq, mutex,
        available: pdx.get(e, 'available') || '',
        bypass: pdx.get(e, 'bypass') || '',
        reward: pdx.get(e, 'completion_reward') || '',
        selectEffect: pdx.get(e, 'select_effect') || '',
      });
    };
    for (const [rel, abs] of this.scriptFiles('common/national_focus/')) {
      const text = this.text(abs);
      const lineOf = pdx.lineIndexer(text);
      for (const top of pdx.entries(text)) {
        if (top.key === 'focus_tree' && top.block !== undefined) {
          const te = pdx.entries(text, top.blockOffset, top.blockOffset + top.block.length);
          const treeId = pdx.get(te, 'id') || rel;
          const country = pdx.get(te, 'country') || '';
          trees.set(treeId, {
            id: treeId, file: rel,
            tags: [...new Set([...country.matchAll(/\b(?:original_)?tag\s*=\s*([A-Z0-9]{3})/g)].map((m) => m[1]))],
            shared: te.filter((x) => x.key === 'shared_focus' && x.value).map((x) => x.value),
          });
          for (const f of te) {
            if (f.key === 'focus' && f.block !== undefined) parseFocus(f.block, rel, lineOf(f.offset), treeId);
          }
        } else if ((top.key === 'shared_focus' || top.key === 'joint_focus') && top.block !== undefined) {
          parseFocus(top.block, rel, lineOf(top.offset), 'shared');
        }
      }
      this.textCache.delete(abs);
    }
    const children = new Map();
    for (const f of focuses.values()) {
      for (const group of f.prereq) for (const p of group) {
        if (!children.has(p)) children.set(p, []);
        children.get(p).push(f.id);
      }
    }
    this._focus = { focuses, trees, children };
    return this._focus;
  }

  // ---------- 决议 ----------
  decisionIndex() {
    if (this._decisions) return this._decisions;
    const map = new Map();
    for (const [rel, abs] of this.scriptFiles('common/decisions/')) {
      if (rel.includes('/categories/')) continue;
      const text = this.text(abs);
      const lineOf = pdx.lineIndexer(text);
      for (const cat of pdx.entries(text)) {
        if (!cat.key || cat.block === undefined) continue;
        for (const d of pdx.entries(text, cat.blockOffset, cat.blockOffset + cat.block.length)) {
          if (d.key && d.block !== undefined) map.set(d.key, { id: d.key, category: cat.key, file: rel, line: lineOf(d.offset), block: d.block });
        }
      }
      this.textCache.delete(abs);
    }
    this._decisions = map;
    return map;
  }

  kindOf(key) {
    if (this.focusIndex().focuses.has(key)) return 'focus(国策)';
    if (this.decisionIndex().has(key)) return 'decision(决议)';
    if (key.endsWith('_desc')) {
      const base = key.slice(0, -5);
      if (this.focusIndex().focuses.has(base)) return 'focus_desc(国策描述)';
      if (this.decisionIndex().has(base)) return 'decision_desc(决议描述)';
    }
    if (/\.\d+\.(t|d|desc|[a-z])$/.test(key)) return 'event(事件文本)';
    if (/^[A-Z0-9]{3}_(fascism|communism|democratic|neutrality)(_DEF|_ADJ)?$/.test(key)) return 'country_name(国名，随意识形态变化)';
    if (/_idea$|_spirit/.test(key)) return 'idea(国家精神)';
    return 'other';
  }

  // ---------- 存档和局面 ----------
  latestSave() {
    const dir = path.join(this.userDir, 'save games');
    let list = [];
    try { list = fs.readdirSync(dir).filter((f) => f.endsWith('.hoi4')).map((f) => ({ f, st: fs.statSync(path.join(dir, f)) })); } catch {}
    list.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
    if (!list.length) return null;
    const p = path.join(dir, list[0].f);
    const head = Buffer.alloc(256);
    const fd = fs.openSync(p, 'r');
    fs.readSync(fd, head, 0, 256, 0);
    fs.closeSync(fd);
    const magic = head.toString('latin1', 0, 7);
    let tag = null;
    let ideology = null;
    if (magic === 'HOI4bin') {
      // 二进制存档开头：player="TAG"（字符串 0x000f + 长度 3 + TAG），紧跟 ideology=xxx（标识符 0x0017 + 长度 + 文本）
      const i = head.indexOf(Buffer.from([0x0f, 0x00, 0x03, 0x00]));
      if (i >= 0) tag = head.toString('latin1', i + 4, i + 7);
      const j = head.indexOf(Buffer.from([0x17, 0x00]), i >= 0 ? i : 0);
      if (j >= 0 && j < 96) {
        const len = head.readUInt16LE(j + 2);
        const word = head.toString('latin1', j + 4, j + 4 + len);
        if (/^[a-z_]{3,20}$/.test(word)) ideology = word;
      }
    } else {
      const txt = head.toString('utf8');
      tag = (txt.match(/player\s*=\s*"([A-Z0-9]{3})"/) || [])[1] || null;
      ideology = (txt.match(/ideology\s*=\s*"?([a-z_]+)"?/) || [])[1] || null;
    }
    return { file: list[0].f, path: p, mtime: list[0].st.mtime, size: list[0].st.size, format: magic === 'HOI4bin' ? 'binary' : 'text', tag, ideology };
  }

  // 文本存档：把玩家国家块里能确定的信息挑出来（已完成国策、当前国策、执政党等）
  parseTextSave(save) {
    if (this._saveCache && this._saveCache.key === save.path + save.mtime) return this._saveCache.value;
    const text = readText(save.path);
    const result = { completed_focus: [], current_focus: null, scalars: {}, country_found: false, focus_found: false, wars: [] };
    // 正在进行的战争：两国关系里的 war_relation={ first="A" second="B" start_date="…" }
    for (const m of text.matchAll(/war_relation=\{\s*first="([A-Z0-9]{3})"\s*second="([A-Z0-9]{3})"\s*start_date="([\d.]+)"/g)) {
      result.wars.push({ a: m[1], b: m[2], since: m[3] });
    }
    const ci = text.search(/\ncountries\s*=\s*\{/);
    // 只认 countries={ 下面紧挨着的一层（一个制表符），更深层的 TAG={ 是别国外交关系等
    const re = new RegExp(`\\n\\t"?${save.tag}"?=\\{`, 'g');
    re.lastIndex = ci < 0 ? 0 : ci;
    const m = re.exec(text);
    if (m) {
      result.country_found = true;
      const open = m.index + m[0].length - 1;
      const close = pdx.matchBrace(text, open);
      const block = text.slice(open + 1, close < 0 ? text.length : close);
      const top = pdx.entries(block);
      for (const k of ['stability', 'war_support', 'major', 'cosmetic_tag', 'capital', 'focus_tree']) {
        const v = pdx.get(top, k);
        if (typeof v === 'string' && v.length < 80) result.scalars[k] = v;
      }
      const focusBlock = pdx.get(top, 'focus');
      if (typeof focusBlock === 'string') {
        result.focus_found = true;
        const fe = pdx.entries(focusBlock);
        result.current_focus = pdx.get(fe, 'current') || null;
        result.focus_progress = pdx.get(fe, 'progress') || null;
        for (const e of fe) {
          if (!/complete/.test(e.key || '')) continue;
          if (e.value) result.completed_focus.push(e.value);
          if (e.block) result.completed_focus.push(...pdx.entries(e.block).map((x) => x.value).filter(Boolean));
        }
      }
      if (!result.completed_focus.length) {
        for (const mm of block.matchAll(/completed(?:_focus)?\s*=\s*"?([A-Za-z0-9_]+)"?/g)) result.completed_focus.push(mm[1]);
        if (result.completed_focus.length) result.focus_found = true;
      }
      const politics = pdx.get(top, 'politics');
      if (typeof politics === 'string') result.ruling_party = pdx.get(pdx.entries(politics), 'ruling_party') || null;
    }
    result.completed_focus = [...new Set(result.completed_focus)];
    this._saveCache = { key: save.path + save.mtime, value: result };
    return result;
  }

  // ---------- 兵力部署（只读文本存档：存档那一刻的陆军） ----------
  // 省份 → 州：history/states 里 state={ id=… name="STATE_…" provinces={ … } }，州名用本地化
  provinceStates() {
    if (this._provState) return this._provState;
    const map = new Map();
    for (const [, abs] of this.scriptFiles('history/states/')) {
      const t = this.text(abs);
      this.textCache.delete(abs);
      const id = (t.match(/\bid\s*=\s*(\d+)/) || [])[1];
      const key = (t.match(/\bname\s*=\s*"?(STATE_\d+|[A-Za-z0-9_]+)"?/) || [])[1];
      const pm = t.match(/\bprovinces\s*=\s*\{([^}]*)\}/);
      if (!id || !pm) continue;
      const st = { id, name: (key && this.name(key)) || key || `州${id}` };
      for (const prov of pm[1].trim().split(/\s+/)) if (prov) map.set(prov, st);
    }
    this._provState = map;
    return map;
  }

  militaryIndex(save) {
    if (this._milCache && this._milCache.key === save.path + save.mtime) return this._milCache.value;
    const text = readText(save.path);
    const counts = (block) => {
      const out = {};
      for (const m of block.matchAll(/\n\t*([a-z_0-9]+)=\{\s*x=/g)) out[m[1]] = (out[m[1]] || 0) + 1;
      return out;
    };
    const sub = (b, key) => {
      const i = b.search(new RegExp(`\\n\\t*${key}=\\{`));
      if (i < 0) return '';
      const open = b.indexOf('{', i);
      const close = pdx.matchBrace(b, open);
      return b.slice(open, close < 0 ? b.length : close);
    };
    // 师模板：id → 名字、所属国、营的组成
    const templates = new Map();
    for (const m of text.matchAll(/\n\tdivision_template=\{/g)) {
      const open = m.index + m[0].length - 1;
      const close = pdx.matchBrace(text, open);
      const b = text.slice(open, close < 0 ? open + 4000 : close);
      const id = (b.match(/\bid=\{\s*id=(\d+)/) || [])[1];
      if (!id) continue;
      templates.set(id, {
        name: (b.match(/\n\t\tname="([^"]*)"/) || [])[1] || `模板${id}`,
        country: (b.match(/\n\t\tcountry="([A-Z0-9]{3})"/) || [])[1] || null,
        regiments: counts(sub(b, 'regiments')),
        support: counts(sub(b, 'support')),
      });
    }
    // 各州现在归谁：存档 states={ 1={ … owner="FRA" … } }
    const owner = new Map();
    const si = text.search(/\nstates=\{/);
    if (si >= 0) {
      const sOpen = text.indexOf('{', si);
      const sClose = pdx.matchBrace(text, sOpen);
      const re = /\n\t(\d+)=\{/g;
      re.lastIndex = sOpen;
      let m;
      while ((m = re.exec(text)) && (sClose < 0 || m.index < sClose)) {
        const open = m.index + m[0].length - 1;
        const close = pdx.matchBrace(text, open);
        const own = /\n\t\towner="([A-Z0-9]{3})"/.exec(text.slice(open, close < 0 ? open + 20000 : close));
        if (own) owner.set(m[1], own[1]);
        re.lastIndex = close < 0 ? open + 1 : close;
      }
    }
    // 各国陆军：countries={ TAG={ … units={ division={ location=省份 division_template_id={ id=… } organisation=… } } } }
    const divisions = new Map();
    const ci = text.search(/\ncountries\s*=\s*\{/);
    if (ci >= 0) {
      const cOpen = text.indexOf('{', ci);
      const cClose = pdx.matchBrace(text, cOpen);
      const re = /\n\t"?([A-Z0-9]{3})"?=\{/g;
      re.lastIndex = cOpen;
      let m;
      while ((m = re.exec(text)) && (cClose < 0 || m.index < cClose)) {
        const open = m.index + m[0].length - 1;
        const close = pdx.matchBrace(text, open);
        const end = close < 0 ? text.length : close;
        const ui = text.indexOf('\n\t\tunits={', open);
        if (ui >= 0 && ui < end) {
          const uOpen = text.indexOf('{', ui);
          const uClose = pdx.matchBrace(text, uOpen);
          const list = [];
          const dre = /\n\t\t\tdivision=\{/g;
          dre.lastIndex = uOpen;
          let d;
          while ((d = dre.exec(text)) && d.index < uClose) {
            const dOpen = d.index + d[0].length - 1;
            const dClose = pdx.matchBrace(text, dOpen);
            const b = text.slice(dOpen, dClose < 0 ? dOpen + 5000 : dClose);
            list.push({
              loc: (b.match(/\n\t\t\t\tlocation=(\d+)/) || [])[1] || null,
              tpl: (b.match(/division_template_id=\{\s*id=(\d+)/) || [])[1] || null,
              org: Number((b.match(/\n\t\t\t\torganisation=([\d.]+)/) || [])[1]) || 0,
            });
            dre.lastIndex = dClose < 0 ? dOpen + 1 : dClose;
          }
          if (list.length) divisions.set(m[1], list);
        }
        re.lastIndex = end;
      }
    }
    const value = { date: (text.slice(0, 400).match(/date="([\d.]+)"/) || [])[1] || null, templates, owner, divisions };
    this._milCache = { key: save.path + save.mtime, value };
    return value;
  }

  // 一国陆军摘要：师数、平均组织度、按模板、按州（州名 + 现归属）
  armySummary(idx, tag, stateLimit = 25) {
    const divs = idx.divisions.get(tag) || [];
    const ps = this.provinceStates();
    const unit = (k) => this.name(k) || k;
    const byTpl = new Map();
    const byState = new Map();
    for (const d of divs) {
      byTpl.set(d.tpl, (byTpl.get(d.tpl) || 0) + 1);
      const st = ps.get(d.loc) || { id: '?', name: `省份${d.loc}` };
      const e = byState.get(st.id) || { state: st.name, owner: idx.owner.get(st.id) || null, divisions: 0, tpl: new Map() };
      e.divisions++;
      const tn = (idx.templates.get(d.tpl) || {}).name || '未知模板';
      e.tpl.set(tn, (e.tpl.get(tn) || 0) + 1);
      byState.set(st.id, e);
    }
    const comp = (t) => {
      const r = Object.entries(t.regiments).map(([k, n]) => `${unit(k)}×${n}`).join('、');
      const s = Object.keys(t.support);
      return r + (s.length ? `；支援：${s.map(unit).join('、')}` : '');
    };
    return {
      tag, name: this.name(tag) || tag,
      divisions: divs.length,
      avg_org: divs.length ? +(divs.reduce((a, d) => a + d.org, 0) / divs.length).toFixed(1) : 0,
      templates: [...byTpl].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([id, n]) => {
        const t = idx.templates.get(id);
        return { name: t ? t.name : '未知模板', count: n, composition: t ? comp(t) : '' };
      }),
      by_state: [...byState.values()].sort((a, b) => b.divisions - a.divisions).slice(0, stateLimit)
        .map((e) => ({ state: e.state, owner: e.owner, divisions: e.divisions, templates: Object.fromEntries(e.tpl) })),
      states_total: byState.size,
    };
  }

  // 兵力部署：玩家 + 交战国（+ 额外指定的国家）。数据截至最新文本存档
  military(tags = []) {
    const save = this.latestSave();
    if (!save) return { error: '找不到存档' };
    if (save.format !== 'text') return { error: '存档是二进制，读不到部队部署：settings.txt 里 save_as_binary=no，再存一次档' };
    const idx = this.militaryIndex(save);
    const player = (this.override && this.override.tag) || save.tag;
    const enemies = [];
    try {
      for (const w of this.parseTextSave(save).wars) {
        if (w.a === player && !enemies.includes(w.b)) enemies.push(w.b);
        if (w.b === player && !enemies.includes(w.a)) enemies.push(w.a);
      }
    } catch {}
    const extra = (tags || []).map((t) => String(t).toUpperCase()).filter((t) => t !== player && !enemies.includes(t));
    return {
      save_date: idx.date,
      save_country: save.tag,
      note: player !== save.tag ? `注意：最新存档是 ${save.tag} 的，玩家现在可能在玩别的国家，这份部署未必是这一局` : '部署截至存档日期；要最新情况请让玩家存一次档，或看画面',
      player: this.armySummary(idx, player),
      enemies: enemies.map((t) => this.armySummary(idx, t, 15)).sort((a, b) => b.divisions - a.divisions).slice(0, 4), // 主要敌人排前面
      others: extra.slice(0, 3).map((t) => this.armySummary(idx, t, 15)),
    };
  }

  completedSet() {
    const save = this.latestSave();
    if (!save || save.format !== 'text' || !save.tag) return null;
    try {
      const p = this.parseTextSave(save);
      return p.country_found && p.focus_found ? new Set(p.completed_focus) : null; // 结构认不出就当“未知”，别当“一个没点”
    } catch { return null; }
  }

  async gameState(running) {
    if (running === undefined) running = await isProcessRunning();
    const state = { hoi4_running: running };
    try { state.game_version = JSON.parse(readText(path.join(this.gameDir, 'launcher-settings.json'))).rawVersion; } catch {}
    try {
      const c = JSON.parse(readText(path.join(this.userDir, 'continue_game.json')));
      state.last_save_title = c.title; // 例如「俄罗斯联邦 1938.7.1.2」
    } catch {}
    try {
      const log = path.join(this.userDir, 'logs/game.log');
      const st = fs.statSync(log);
      const fd = fs.openSync(log, 'r');
      const len = Math.min(st.size, 8192);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, st.size - len);
      fs.closeSync(fd);
      const dates = [...buf.toString('utf8').matchAll(/\]\[(\d{3,4}\.\d{1,2}\.\d{1,2})(?:\.\d+)?\]/g)];
      if (dates.length) state.log_game_date = dates[dates.length - 1][1];
      state.log_updated = st.mtime.toISOString();
    } catch {}
    try {
      const s = readText(path.join(this.userDir, 'settings.txt'));
      state.save_as_binary = (s.match(/save_as_binary\s*=\s*(\w+)/) || [])[1] || 'unknown';
    } catch {}
    state.enabled_mods = this.mods().map((m) => m.name);
    const save = this.latestSave();
    const session = this.sessionStart();
    state.enemies = [];
    const ov = this.countryOverride;
    if (ov && (!save || ov.at > save.mtime) && (!session || ov.at > session.at)) {
      state.screen_country = { tag: ov.tag, ideology: ov.ideology, country: this.name(`${ov.tag}_${ov.ideology}`) || this.name(ov.tag), source: '游戏画面识别' };
    }
    if (save) {
      const country = save.tag ? this.name(`${save.tag}_${save.ideology}`) || this.name(save.tag) : null;
      state.latest_save = { file: save.file, saved_at: save.mtime.toISOString(), format: save.format, player_tag: save.tag, player_ideology: save.ideology, player_country: country };
      // 存档之后又开了一局（开局日期也对不上）：这局是哪国要等它第一份存档
      if (!state.screen_country && session && session.at > save.mtime && !sameDate(session.startDate, state.last_save_title)) {
        state.country_uncertain = true;
        state.note_country = `当前这局（${session.startDate} 开局）是在最新存档之后开的，国家还不确定，等游戏下次自动存档或手动存档后才能识别；需要时直接问玩家在玩哪国。`;
      }
      if (save.format === 'text' && save.tag) {
        try {
          const p = this.parseTextSave(save);
          if (!p.country_found || !p.focus_found) state.player_note = `文本存档里${p.country_found ? '没认出国策进度结构' : '没找到玩家国家块'}，国策进度当作未知，需要问玩家`;
          const mine = p.wars.filter((w) => w.a === save.tag || w.b === save.tag);
          state.at_war = mine.length > 0;
          state.enemies = mine.map((w) => { const t = w.a === save.tag ? w.b : w.a; return { tag: t, name: this.name(t) || t, since: w.since }; });
          state.player = {
            current_focus: p.current_focus && { id: p.current_focus, name: this.name(p.current_focus) },
            focus_progress: p.focus_progress,
            ruling_party: p.ruling_party,
            completed_focus: p.completed_focus.map((id) => ({ id, name: this.name(id) })),
            other_fields: p.scalars,
          };
        } catch (e) { state.player_error = '文本存档解析失败：' + e.message; }
      } else {
        state.note = '最新存档是二进制格式，读不到国策进度。想让参谋知道你点了哪些国策：退出游戏，把 settings.txt 里 save_as_binary 改成 no，进游戏后手动存一次档。在那之前，已完成国策需要直接问玩家。';
      }
    }
    // 存档之后（或画面认出国家之后）日志里出现的宣战，立刻算交战
    const tag = state.screen_country ? state.screen_country.tag : !state.country_uncertain && save && save.tag;
    if (tag) {
      const fresh = this.warsFromLog(tag, save && !state.screen_country ? save.mtime : session && session.at);
      for (const w of fresh) {
        if (!state.enemies.some((e) => e.name === w.name)) state.enemies.push({ tag: (this.tagByName(w.name) || {}).tag || null, name: w.name, since: w.since, from: '游戏日志' });
      }
      if (fresh.length) state.at_war = true;
    }
    return state;
  }

  // 某个国家所有可能出现的国名（随意识形态变化）
  countryNames(tag) {
    return [tag, ...['fascism', 'communism', 'democratic', 'neutrality'].map((i) => `${tag}_${i}`), `${tag}_DEF`]
      .map((k) => this.name(k)).filter(Boolean);
  }

  // game.log 是实时写的：存档之后玩家宣战/被宣战，立刻算交战（每月自动存档要等很久）
  warsFromLog(tag, after) {
    try {
      const log = path.join(this.userDir, 'logs/game.log');
      const st = fs.statSync(log);
      const names = new Set(this.countryNames(tag));
      const out = [];
      for (const m of fs.readFileSync(log, 'utf8').matchAll(/\[(\d\d):(\d\d):(\d\d)\]\[([\d.]+)\][^\n]*?: (.+?) is declaring war on ([^\n]+)/g)) {
        const at = new Date(st.mtime);
        at.setHours(+m[1], +m[2], +m[3], 0);
        if (at > st.mtime) at.setDate(at.getDate() - 1);
        if (after && at <= after) continue;
        const a = m[5].trim(), b = m[6].trim();
        if (names.has(a)) out.push({ name: b, since: m[4] });
        else if (names.has(b)) out.push({ name: a, since: m[4] });
      }
      return out;
    } catch { return []; }
  }

  // 本次游戏进程里最后一次“开局/读档”的时间和开局日期（读 game.log）
  sessionStart() {
    try {
      const log = path.join(this.userDir, 'logs/game.log');
      const st = fs.statSync(log);
      const text = fs.readFileSync(log, 'utf8');
      const all = [...text.matchAll(/\[(\d\d):(\d\d):(\d\d)\][^\n]*\n\s*\[\[ Launching [A-Z]+-game \]\]\s*\n\s*Start-date:\s*([\d.]+)/g)];
      const m = all[all.length - 1];
      if (!m) return null;
      const at = new Date(st.mtime);
      at.setHours(+m[1], +m[2], +m[3], 0);
      if (at > st.mtime) at.setDate(at.getDate() - 1);
      return { at, startDate: m[4] };
    } catch { return null; }
  }

  // ---------- 给 GPT 的工具 ----------
  searchLocalisation(query, limit = 25) {
    const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return { error: 'query 不能为空' };
    const hits = [];
    for (const [key, v] of this.loc()) {
      const hay = (key + ' ' + v.text).toLowerCase();
      if (words.every((w) => hay.includes(w))) hits.push({ key, text: v.text.replace(/§./g, '').slice(0, 160), file: v.file });
    }
    const rank = (h) => { const k = this.kindOf(h.key); return k.startsWith('focus(') ? 0 : k.startsWith('decision(') ? 1 : k.startsWith('country_name') ? 2 : k.includes('desc') ? 4 : 3; };
    hits.forEach((h) => { h.kind = this.kindOf(h.key); });
    hits.sort((a, b) => rank(a) - rank(b));
    return { total: hits.length, results: hits.slice(0, Math.min(limit, 60)) };
  }

  // 按中文名/描述搜国策（空格分隔的词任意命中都算，按命中多少排序），用来找“终点国策”
  findFocus(query, tag, limit = 20) {
    const words = String(query || '').split(/\s+/).filter(Boolean);
    if (!words.length) return { error: 'query 不能为空' };
    const { focuses, trees } = this.focusIndex();
    const hits = [];
    for (const f of focuses.values()) {
      const tree = trees.get(f.tree);
      if (tag && !(tree && tree.tags.includes(tag.toUpperCase())) && !f.id.startsWith(tag.toUpperCase() + '_')) continue;
      const name = this.name(f.id) || '';
      const desc = this.name(f.id + '_desc') || '';
      let score = 0;
      for (const w of words) {
        if (name.includes(w)) score += 3;
        if (desc.includes(w)) score += 1;
        if (f.id.toLowerCase().includes(w.toLowerCase())) score += 2;
      }
      if (score) hits.push({ id: f.id, name, tree: f.tree, countries: tree ? tree.tags : undefined, desc: desc.replace(/§./g, '').slice(0, 90), score });
    }
    hits.sort((a, b) => b.score - a.score);
    return { total: hits.length, results: hits.slice(0, Math.min(limit, 40)) };
  }

  // 给脚本行里的国策/决议 id 标上中文名，免得模型自己瞎翻译
  annotate(line) {
    const { focuses } = this.focusIndex();
    const decisions = this.decisionIndex();
    const names = [];
    for (const m of line.matchAll(/\b([A-Za-z][A-Za-z0-9_]{3,})\b/g)) {
      if ((focuses.has(m[1]) || decisions.has(m[1])) && this.name(m[1])) names.push(`${m[1]}=「${this.name(m[1])}」`);
    }
    return names.length ? `${line}    # ${[...new Set(names)].join(' ')}` : line;
  }

  searchScripts(pattern, dir, limit = 40) {
    let re;
    try { re = new RegExp(pattern, 'i'); } catch { re = new RegExp(String(pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); }
    const out = [];
    let total = 0;
    for (const [rel, abs] of this.scriptFiles(dir)) {
      const lines = this.text(abs).split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          total++;
          if (out.length < Math.min(limit, 80)) out.push({ file: rel, line: i + 1, text: this.annotate(lines[i].trim().slice(0, 200)) });
        }
      }
    }
    return { total, results: out };
  }

  readFile(file, start = 1, end) {
    let abs = this.files().get(String(file).replace(/^\/+/, ''));
    if (!abs && path.isAbsolute(String(file))) {
      const roots = [this.gameDir, this.userDir, ...this.mods().map((m) => m.dir).filter(Boolean)];
      const real = path.resolve(file);
      if (roots.some((r) => real.startsWith(path.resolve(r) + path.sep)) && exists(real)) abs = real;
    }
    if (!abs) return { error: `找不到文件 ${file}（用游戏目录下的相对路径，比如 common/national_focus/soviet.txt）` };
    if (abs.endsWith('.hoi4')) return { error: '存档请用 get_game_state' };
    const lines = this.text(abs).split('\n');
    start = Math.max(1, Number(start) || 1);
    end = Math.min(lines.length, Number(end) || start + 120, start + 249);
    return { file, total_lines: lines.length, start, end, content: lines.slice(start - 1, end).map((l, i) => `${start + i}: ${this.annotate(l)}`).join('\n') };
  }

  focusBrief(id, done) {
    return { id, name: this.name(id), completed: done ? done.has(id) : undefined };
  }

  getFocus(id) {
    const { focuses, trees, children } = this.focusIndex();
    const f = focuses.get(id);
    if (!f) return { error: `没有国策 ${id}。先用 search_localisation 按中文名找 id。` };
    const done = this.completedSet();
    const tree = trees.get(f.tree);
    return {
      ...this.focusBrief(id, done),
      desc: (this.name(id + '_desc') || '').slice(0, 300),
      tree: f.tree, tree_countries: tree ? tree.tags : undefined,
      file: f.file, line: f.line,
      days: f.cost ? f.cost * 7 : null,
      prerequisites_all_of: f.prereq.map((g) => ({ any_of: g.map((x) => this.focusBrief(x, done)) })),
      mutually_exclusive: f.mutex.map((x) => this.focusBrief(x, done)),
      unlocks: (children.get(id) || []).map((x) => this.focusBrief(x, done)),
      available: pdx.compact(f.available, 1500),
      bypass: pdx.compact(f.bypass, 600),
      completion_reward: pdx.compact(f.reward || f.selectEffect, 1800),
      progress_known: !!done,
    };
  }

  // 现在可以点的国策：在玩家的国策树里，前置都满足、没完成、没被互斥锁死、也不是正在点的
  nextFocuses(treeId, done, currentId, limit = 14) {
    const { focuses, trees } = this.focusIndex();
    const tree = trees.get(treeId);
    const inTree = (f) => f.tree === treeId || (tree && tree.shared.includes(f.id));
    const out = [];
    for (const f of focuses.values()) {
      if (!inTree(f) || done.has(f.id) || f.id === currentId) continue;
      if (!f.prereq.every((g) => g.some((x) => done.has(x)))) continue;
      if (f.mutex.some((m) => done.has(m) || m === currentId)) continue;
      const nm = this.name(f.id);
      out.push({ id: f.id, name: nm && !nm.includes('[') ? nm : f.id, days: f.cost ? f.cost * 7 : null, mutex: f.mutex.map((m) => this.name(m) || m), available: f.available ? pdx.compact(f.available, 100) : '' });
    }
    return out.slice(0, limit);
  }

  // 从根到目标的整条前置链（拓扑排序），带互斥和“是否已锁死”
  focusPath(target) {
    const { focuses } = this.focusIndex();
    if (!focuses.has(target)) return { error: `没有国策 ${target}` };
    const done = this.completedSet();
    const order = [];
    const seen = new Set();
    const choices = [];
    // 这个国策（连同它的前置）还能不能点：自己没被已完成的互斥锁死，且每组前置至少有一个可行
    const memo = new Map();
    const feasible = (id, stack = new Set()) => {
      if (!done) return true;
      if (done.has(id)) return true;
      if (memo.has(id)) return memo.get(id);
      if (stack.has(id)) return true;
      stack.add(id);
      const f = focuses.get(id);
      const ok = !!f && !f.mutex.some((m) => done.has(m)) && f.prereq.every((g) => g.some((x) => feasible(x, stack)));
      stack.delete(id);
      memo.set(id, ok);
      return ok;
    };
    const visit = (id) => {
      if (seen.has(id)) return;
      seen.add(id);
      const f = focuses.get(id);
      if (!f) return;
      for (const group of f.prereq) {
        const pick = group.find((g) => done && done.has(g)) || group.find((g) => seen.has(g) && feasible(g))
          || group.find((g) => feasible(g)) || group[0];
        if (group.length > 1) choices.push({ for: this.focusBrief(id), any_of: group.map((g) => ({ ...this.focusBrief(g, done), feasible: done ? feasible(g) : undefined })), picked: pick });
        visit(pick);
      }
      order.push(id);
    };
    visit(target);
    const steps = order.map((id) => {
      const f = focuses.get(id);
      const locked = done ? f.mutex.filter((m) => done.has(m)) : [];
      return {
        ...this.focusBrief(id, done),
        days: f.cost ? f.cost * 7 : null,
        mutually_exclusive: f.mutex.map((m) => this.focusBrief(m)),
        locked_by_completed: locked.map((m) => this.focusBrief(m)),
        available: f.available ? pdx.compact(f.available, 400) : undefined,
      };
    });
    const remaining = steps.filter((s) => !s.completed);
    return {
      target: this.focusBrief(target, done),
      progress_known: !!done,
      note: done ? undefined : '读不到存档进度（二进制存档），completed 未知，需要问玩家点到哪了',
      steps,
      or_choices: choices,
      remaining_days: remaining.reduce((a, s) => a + (s.days || 0), 0),
      locked: steps.some((s) => s.locked_by_completed.length) ? '路线上有国策已被互斥国策锁死' : undefined,
    };
  }

  getDecision(id) {
    const d = this.decisionIndex().get(id);
    if (!d) return { error: `没有决议 ${id}。先用 search_localisation 找 id。` };
    return {
      id, name: this.name(id), desc: (this.name(id + '_desc') || '').slice(0, 300),
      category: d.category, category_name: this.name(d.category), file: d.file, line: d.line,
      script: pdx.compact(d.block, 2500),
    };
  }

  // 后台预热索引，第一次提问不用等
  warm() {
    this.files(); this.loc(); this.focusIndex(); this.decisionIndex();
  }
}

// "1936.1.1.12" 和 "俄罗斯联邦 1938.7.1.2" 比年月日
function sameDate(a, title) {
  const d = (x) => ((String(x || '').match(/(\d{3,4})\.(\d{1,2})\.(\d{1,2})/) || []).slice(1).map(Number).join('.'));
  return !!d(a) && d(a) === d(title);
}

module.exports = { GameData, isProcessRunning, DEFAULT_GAME_DIR, DEFAULT_USER_DIR };
