// 不联网的冒烟测试：直接读本机游戏文件，验证工具函数能找对东西
const assert = require('assert');
const { GameData } = require('../lib/gamedata');
const gd = new GameData();
const t0 = Date.now();
gd.warm();
const { focuses, trees } = gd.focusIndex();
console.log(`索引：${gd.files().size} 文件，${gd.loc().size} 条本地化，${focuses.size} 个国策，${trees.size} 棵树，${gd.decisionIndex().size} 个决议，${Date.now() - t0}ms`);
assert(focuses.size > 1000, '国策太少');

const loc = gd.searchLocalisation('俄罗斯帝国');
console.log('搜「俄罗斯帝国」:', loc.total, loc.results.slice(0, 4).map((r) => `${r.key}=${r.text}[${r.kind}]`));
assert(loc.results.some((r) => r.key === 'SOV_fascism'));

const rom = gd.searchLocalisation('罗曼诺夫王朝复辟');
const romFocus = rom.results.find((r) => r.kind.startsWith('focus('));
console.log('罗曼诺夫王朝复辟 →', romFocus && romFocus.key);
assert(romFocus, '没找到罗曼诺夫王朝复辟国策');

const f = gd.getFocus(romFocus.key);
console.log('get_focus:', f.name, f.file + ':' + f.line, '前置', JSON.stringify(f.prerequisites_all_of.map((g) => g.any_of.map((x) => x.name))), '互斥', f.mutually_exclusive.map((x) => x.name));
const p = gd.focusPath(romFocus.key);
console.log('路线', p.steps.length, '步，', p.remaining_days, '天：', p.steps.map((s) => s.name).join(' → '));
assert(p.steps.length >= 3 && p.steps[p.steps.length - 1].id === romFocus.key);

const s = gd.searchScripts('SOV_romanov_reconstruction', 'common/');
console.log('search_scripts:', s.total, s.results.slice(0, 3));
assert(s.total > 0);
const rf = gd.readFile(f.file, f.line, f.line + 5);
assert(rf.content.includes('id'), 'read_file 内容不对');

const decKey = [...gd.decisionIndex().keys()].find((k) => k.startsWith('SOV_'));
console.log('get_decision:', gd.getDecision(decKey).name);

gd.gameState(false).then((st) => {
  console.log('game_state:', JSON.stringify(st, null, 1).slice(0, 900));
  assert(st.latest_save && st.latest_save.player_tag, '读不到存档 tag');
  console.log('smoke OK');
});

// Codex 审出来的两个逻辑：存档结构认不出要当“未知”；OR 前置要挑没被锁死的那支
{
  const g = new GameData();
  g.latestSave = () => ({ path: __filename, mtime: 1, tag: 'SOV', format: 'text' });
  g.parseTextSave = () => ({ completed_focus: [], country_found: false, focus_found: false });
  assert.strictEqual(g.completedSet(), null, '没找到国家块却当成已知进度');
  g.completedSet = () => new Set(['X']);
  g.name = () => null;
  g.focusIndex = () => ({ focuses: new Map([
    ['T', { prereq: [['A', 'B']], mutex: [], cost: 1 }],
    ['A', { prereq: [], mutex: ['X'], cost: 1 }],
    ['B', { prereq: [], mutex: [], cost: 1 }],
  ]) });
  const fp = g.focusPath('T');
  assert(!fp.locked && fp.steps.map((x) => x.id).join() === 'B,T', 'OR 分支没避开被锁死的 A：' + JSON.stringify(fp.steps.map((x) => x.id)));
  console.log('逻辑修复 OK');
}

// 文本存档：只认 countries={ 下一层的国家块；国策进度、执政党、交战状态
{
  const fs = require('fs'), os = require('os'), path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hoi4save-'));
  fs.mkdirSync(path.join(dir, 'save games'));
  fs.writeFileSync(path.join(dir, 'save games', 'autosave.hoi4'), [
    'HOI4txt', 'player="GER"', 'ideology=fascism', 'date="1939.9.2.12"',
    'countries={',
    '\tPOL={', '\t\tdiplomacy={', '\t\t\tGER={', '\t\t\t\twar_relation={', '\t\t\t\t\tfirst="GER"', '\t\t\t\t\tsecond="POL"', '\t\t\t\t\tstart_date="1939.9.1.12"', '\t\t\t\t}', '\t\t\t}', '\t\t}', '\t}',
    '\tGER={', '\t\tpolitics={', '\t\t\truling_party=fascism', '\t\t}', '\t\tstability=0.65',
    '\t\tfocus={', '\t\t\tcompleted="GER_rhineland"', '\t\t\tcompleted="GER_anschluss"', '\t\t\tcurrent="GER_danzig_or_war"', '\t\t\tprogress=12.000', '\t\t}', '\t}',
    '}', '',
  ].join('\n'));
  const g = new GameData({ userDir: dir });
  g.gameState(false).then((st) => {
    assert.strictEqual(st.latest_save.player_tag, 'GER');
    assert.deepStrictEqual(st.player.completed_focus.map((f) => f.id), ['GER_rhineland', 'GER_anschluss'], '国策进度没读对');
    assert.strictEqual(st.player.current_focus.id, 'GER_danzig_or_war');
    assert.strictEqual(st.player.ruling_party, 'fascism');
    assert.strictEqual(st.at_war, true, '没认出交战');
    assert.strictEqual(st.enemies[0].tag, 'POL');
    console.log('文本存档 OK（国策进度 + 交战状态）');
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

// 存档里还是和平，存档之后日志里宣战 → 立刻算交战（不用等下个月自动存档）
{
  const fs = require('fs'), os = require('os'), path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hoi4war-'));
  fs.mkdirSync(path.join(dir, 'save games'));
  fs.mkdirSync(path.join(dir, 'logs'));
  const save = path.join(dir, 'save games', 'autosave.hoi4');
  fs.writeFileSync(save, ['HOI4txt', 'player="GER"', 'ideology=fascism', 'countries={', '\tGER={', '\t\tfocus={', '\t\t\tcompleted="GER_rhineland"', '\t\t}', '\t}', '}', ''].join('\n'));
  const old = new Date(Date.now() - 3600 * 1000);
  fs.utimesSync(save, old, old);
  const hhmmss = new Date().toTimeString().slice(0, 8);
  fs.writeFileSync(path.join(dir, 'logs', 'game.log'), `[${hhmmss}][1939.09.01.12][effectbase.cpp:1783]: 德意志国 is declaring war on 波兰\n`);
  const g = new GameData({ userDir: dir });
  g.gameState(true).then((st) => {
    assert.strictEqual(st.at_war, true, '存档之后的宣战没算上');
    assert.strictEqual(st.enemies[0].name, '波兰');
    console.log('日志宣战 OK（存档之后宣战立刻算交战）');
    fs.rmSync(dir, { recursive: true, force: true });
  });
}
