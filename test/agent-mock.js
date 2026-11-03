// 用本地假 OpenAI 服务器测 agent 的工具循环（Responses 和 Chat 两种）、转写、朗读的请求格式
const assert = require('assert');
const http = require('http');
const { Agent } = require('../lib/agent');
const { GameData } = require('../lib/gamedata');

const seen = [];
const server = http.createServer((req, res) => {
  let body = [];
  req.on('data', (c) => body.push(c));
  req.on('end', () => {
    body = Buffer.concat(body);
    seen.push({ url: req.url, auth: req.headers.authorization, ctype: req.headers['content-type'] });
    const json = (o) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
    if (req.url === '/v1/responses') {
      const b = JSON.parse(body);
      assert(b.tools.length >= 7 && b.instructions.includes('参谋电报机'));
      assert(!b.previous_response_id && b.store === false, '不该依赖 previous_response_id');
      const out = Array.isArray(b.input) && b.input.find((x) => x.type === 'function_call_output');
      if (!out) return json({ id: 'r1', output: [{ type: 'reasoning', id: 'rs_1', summary: [] }, { type: 'function_call', id: 'fc_1', name: 'get_focus', call_id: 'c1', arguments: '{"id":"SOV_romanov_reconstruction"}' }] });
      const fc = b.input.find((x) => x.type === 'function_call');
      assert(fc && !fc.id && fc.call_id === 'c1' && !b.input.some((x) => x.type === 'reasoning'), '回传的 function_call 不该带 id / reasoning');
      assert(out.output.includes('罗曼诺夫王朝复辟'), '工具结果没传回去');
      return json({ id: 'r2', usage: { input_tokens: 1200, output_tokens: 80 }, output: [{ type: 'message', content: [{ type: 'output_text', text: '能走。\n1. 罗曼诺夫王朝复辟\n【播报】能走，先点重开缙绅会议。' }] }] });
    }
    if (req.url === '/v1/chat/completions') {
      const b = JSON.parse(body);
      const last = b.messages[b.messages.length - 1];
      if (last.role === 'user') return json({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'focus_path', arguments: '{"target":"SOV_romanov_reconstruction"}' } }] } }] });
      assert(last.role === 'tool' && last.content.includes('重开缙绅会议'));
      return json({ choices: [{ message: { role: 'assistant', content: '路线如下。【播报】一共十六步。' } }] });
    }
    if (req.url === '/v1/audio/transcriptions') {
      assert(seen[seen.length - 1].ctype.startsWith('multipart/form-data; boundary='));
      assert(body.includes('gpt-transcribe') && body.includes('filename="speech.webm"'));
      return json({ text: '我要变成俄罗斯帝国' });
    }
    if (req.url === '/v1/audio/speech') {
      const b = JSON.parse(body);
      assert(b.voice && b.instructions && b.input);
      res.setHeader('content-type', 'audio/mpeg');
      return res.end(Buffer.from([0xff, 0xfb, 1, 2]));
    }
    if (req.url === '/v1/models') return json({ data: [{ id: 'gpt-6-sol' }, { id: '[m1]claude-sonnet-5' }, { id: 'gpt-4o-mini-tts' }] });
    res.statusCode = 404; res.end('{"error":"nope"}');
  });
});

server.listen(0, async () => {
  const cfg = { ...require('../lib/config').DEFAULTS, sttEngine: 'openai', apiKey: 'sk-test', baseURL: `http://127.0.0.1:${server.address().port}/v1` };
  const agent = new Agent({ config: cfg, gamedata: new GameData(), fetchImpl: fetch, getRunning: () => false });
  const events = [];
  try {
    let r = await agent.ask('我要变成俄罗斯帝国', (e) => events.push(e));
    assert.strictEqual(r.speech, '能走，先点重开缙绅会议。');
    assert(!r.text.includes('【播报】') && events[0].name === 'get_focus');
    assert.strictEqual(agent.history.length, 4, '对话记录应为 用户/调用/结果/回答');
    assert.deepStrictEqual(r.usage, { calls: 2, input: 1200, output: 80 }, '用量统计不对');
    assert.deepStrictEqual(await agent.listModels(), ['[m1]claude-sonnet-5', 'gpt-4o-mini-tts', 'gpt-6-sol']);
    cfg.apiStyle = 'chat'; agent.reset();
    r = await agent.ask('怎么走');
    assert.strictEqual(r.speech, '一共十六步。');
    assert.strictEqual(await agent.transcribe(Buffer.from('fakeaudio'.repeat(100)), 'audio/webm'), '我要变成俄罗斯帝国');
    assert.strictEqual((await agent.speak('测试')).length, 4);
    assert(seen.every((s) => s.auth === 'Bearer sk-test'));
    cfg.apiKey = '';
    await assert.rejects(agent.ask('x'), /API Key/);
    console.log('agent mock OK（Responses + Chat + 转写 + 朗读）');
  } catch (e) { console.error(e); process.exitCode = 1; }
  server.close();
});
