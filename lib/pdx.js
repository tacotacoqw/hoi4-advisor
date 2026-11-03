// Paradox 脚本（Clausewitz 格式）的小型解析工具：只解析一层，子块保留原文，按需再解析。

// 返回每个字符偏移对应行号的查询函数（1 起）
function lineIndexer(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return (offset) => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid; else hi = mid - 1;
    }
    return lo + 1;
  };
}

// 从 text[openIdx] === '{' 开始，返回匹配的 '}' 下标；忽略注释和引号里的括号
function matchBrace(text, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    const c = text[i];
    if (c === '#') { const nl = text.indexOf('\n', i); if (nl < 0) return -1; i = nl; continue; }
    if (c === '"') { const q = text.indexOf('"', i + 1); if (q < 0) return -1; i = q; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

const OPS = ['<=', '>=', '!=', '==', '=', '<', '>'];
const isSpace = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '﻿';
const isDelim = (c) => isSpace(c) || c === '=' || c === '{' || c === '}' || c === '#' || c === '<' || c === '>' || c === '!';

// 解析 text[from, to) 这一层的条目：[{ key, op, value | block, offset, blockOffset }]
// 列表形式（{ A B C }）的条目只有 value
function entries(text, from = 0, to = text.length) {
  const out = [];
  let i = from;
  const skip = () => {
    while (i < to) {
      const c = text[i];
      if (isSpace(c)) i++;
      else if (c === '#') { const nl = text.indexOf('\n', i); i = nl < 0 || nl > to ? to : nl + 1; }
      else break;
    }
  };
  const readToken = () => {
    if (text[i] === '"') {
      const q = text.indexOf('"', i + 1);
      const end = q < 0 || q >= to ? to : q;
      const tok = text.slice(i + 1, end);
      i = end + 1;
      return tok;
    }
    const s = i;
    while (i < to && !isDelim(text[i])) i++;
    return text.slice(s, i);
  };
  while (true) {
    skip();
    if (i >= to) break;
    const offset = i;
    if (text[i] === '}') { i++; continue; }
    if (text[i] === '{') {
      // 匿名块（比如 { a b } 列表里的子块）
      const close = matchBrace(text, i);
      const end = close < 0 ? to : close;
      out.push({ key: null, op: null, block: text.slice(i + 1, end), blockOffset: i + 1, offset });
      i = end + 1;
      continue;
    }
    const key = readToken();
    if (!key && i === offset) { i++; continue; }
    skip();
    const op = OPS.find((o) => text.startsWith(o, i));
    if (!op) { out.push({ key: null, op: null, value: key, offset }); continue; }
    i += op.length;
    skip();
    if (text[i] === '{') {
      const close = matchBrace(text, i);
      const end = close < 0 ? to : close;
      out.push({ key, op, block: text.slice(i + 1, end), blockOffset: i + 1, offset });
      i = end + 1;
    } else {
      out.push({ key, op, value: readToken(), offset });
    }
  }
  return out;
}

// 取某一层里第一个 key 的值
const get = (list, key) => {
  const e = list.find((x) => x.key === key);
  return e ? (e.block !== undefined ? e.block : e.value) : undefined;
};
const getAll = (list, key) => list.filter((x) => x.key === key);

// 压缩块文本：去注释、压空白，方便塞给模型
function compact(block, max = 1200) {
  if (!block) return '';
  const s = block.replace(/#[^\n]*/g, '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) + ' …(截断)' : s;
}

module.exports = { lineIndexer, matchBrace, entries, get, getAll, compact };
