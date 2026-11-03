// 看画面工具：截图要作为下一条 user 消息附上，回合结束后从历史里拿掉；上报国家要回调
const assert = require('assert');
const http = require('http');
const { Agent } = require('../lib/agent');
const { GameData } = require('../lib/gamedata');

let round = 0;
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const b = JSON.parse(body);
    const json = (o) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
    round++;
    if (round === 1) return json({ output: [{ type: 'function_call', name: 'look_at_screen', call_id: 'a', arguments: '{}' }] });
    if (round === 2) {
      const img = b.input.find((x) => x.role === 'user' && Array.isArray(x.content) && x.content.some((c) => c.type === 'input_image'));
      assert(img && img.content[1].image_url === 'data:image/jpeg;base64,QUJD', '截图没附上');
      return json({ output: [{ type: 'function_call', name: 'report_player_country', call_id: 'b', arguments: '{"tag":"ger"}' }] });
    }
    return json({ output: [{ type: 'message', content: [{ type: 'output_text', text: '你在玩德国。【播报】德国，收到。' }] }] });
  });
});
server.listen(0, async () => {
  const gd = new GameData();
  let reported = null;
  const cfg = { ...require('../lib/config').DEFAULTS, apiKey: 'k', baseURL: `http://127.0.0.1:${server.address().port}/v1` };
  const a = new Agent({ config: cfg, gamedata: gd, fetchImpl: fetch, captureScreen: async () => 'data:image/jpeg;base64,QUJD', onCountry: (ov) => { reported = ov; } });
  try {
    const r = await a.ask('我现在在玩哪国？');
    assert.strictEqual(r.speech, '德国，收到。');
    assert(reported && reported.tag === 'GER' && reported.ideology === 'fascism', '国家没上报/意识形态没补全');
    assert(!JSON.stringify(a.history).includes('QUJD'), '回合结束后截图还留在历史里');
    const st = await gd.gameState(true);
    assert.strictEqual(st.screen_country.country, '德意志国');
    console.log('vision mock OK（看画面 + 上报国家）');
  } catch (e) { console.error(e); process.exitCode = 1; }
  server.close();
});
