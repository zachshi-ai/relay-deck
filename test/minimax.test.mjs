// MiniMax 适配器单测。fixture 是 2026-10-07 本机实测抓取的真实响应（含多行 pretty JSON）。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { minimaxAdapter, parseMmxOutput } from '../src/adapters/minimax.mjs';
import { runTurn } from '../src/core/runner.mjs';

// 真实抓取的输出形态：一个 JSON 对象，跨多行
const REAL_SUCCESS = `{
  "id": "071581b83b6108e62047467db255bc3c",
  "type": "message",
  "role": "assistant",
  "model": "MiniMax-M3",
  "content": [
    {
      "text": "收到",
      "type": "text"
    }
  ],
  "usage": {
    "input_tokens": 40,
    "output_tokens": 2,
    "cache_creation_input_tokens": 0,
    "cache_read_input_tokens": 128,
    "service_tier": "standard"
  },
  "stop_reason": "end_turn",
  "base_resp": {
    "status_code": 0,
    "status_msg": ""
  }
}
`;

test('MiniMax：多行 pretty JSON 能被整体解析出文本与用量', () => {
  const events = parseMmxOutput(REAL_SUCCESS);
  const byType = (t) => events.filter((e) => e.type === t);

  assert.equal(byType('text')[0].text, '收到');
  assert.equal(byType('final')[0].text, '收到');
  assert.equal(byType('usage')[0].usage.output_tokens, 2);
  assert.equal(byType('turn.end')[0].reason, 'end_turn');
  assert.equal(byType('error').length, 0);
});

test('MiniMax：多段 text 内容会被拼起来（不丢内容）', () => {
  const payload = JSON.stringify({
    content: [
      { type: 'text', text: '前半段 ' },
      { type: 'thinking', text: '这段不应出现在正文里' },
      { type: 'text', text: '后半段' },
    ],
    stop_reason: 'end_turn',
    base_resp: { status_code: 0 },
  });
  const events = parseMmxOutput(payload);
  assert.equal(events.find((e) => e.type === 'final').text, '前半段 后半段');
});

test('MiniMax：CLI 文本错误被判为致命错误（实测踩到过 "Error: s is not iterable"）', () => {
  const events = parseMmxOutput('Error: s is not iterable\n');
  assert.equal(events[0].type, 'error');
  assert.equal(events[0].fatal, true);
  assert.match(events[0].message, /s is not iterable/);
});

test('MiniMax：base_resp 非 0 视为业务错误，且带上原始原因', () => {
  const events = parseMmxOutput(
    JSON.stringify({ content: [], base_resp: { status_code: 1004, status_msg: 'invalid api key' } }),
  );
  assert.equal(events[0].type, 'error');
  assert.match(events[0].message, /1004/);
  assert.match(events[0].message, /invalid api key/);
});

test('MiniMax：空输出不静默通过', () => {
  const events = parseMmxOutput('   \n');
  assert.equal(events[0].type, 'error');
  assert.equal(events[0].fatal, true);
});

test('MiniMax：参数与 stdin 载荷符合 CLI 契约', () => {
  const args = minimaxAdapter.buildArgs();
  assert.deepEqual(args, ['text', 'chat', '--messages-file', '-', '--output', 'json', '--non-interactive']);
  const payload = JSON.parse(minimaxAdapter.stdinPayload('你好'));
  assert.deepEqual(payload, [{ role: 'user', content: '你好' }]);
  assert.equal(minimaxAdapter.capabilities.resume, false, '必须声明不支持续跑，中台才会补历史');
});

test('执行器：整体输出型适配器（parseOutput）也能跑完一轮', async () => {
  const adapter = {
    id: 'fake-whole',
    label: 'FakeWhole',
    capabilities: { resume: false, streaming: false, tools: false },
    command: () => process.execPath,
    buildArgs: () => ['-e', 'process.stdout.write(process.argv[1] ? "" : \'\')', '--', 'x'],
    stdinPayload: (prompt) => `收到：${prompt}`,
    parseOutput: (stdout) => [
      { type: 'text', text: `WHOLE:${stdout.trim()}` },
      { type: 'final', text: `WHOLE:${stdout.trim()}` },
    ],
  };
  // 这个假适配器把 stdin 原样回显到 stdout（整体输出、无行分隔）
  adapter.buildArgs = () => [
    '-e',
    'const c=[];process.stdin.on("data",d=>c.push(d));process.stdin.on("end",()=>process.stdout.write(Buffer.concat(c).toString()))',
  ];

  const result = await runTurn({ adapter, prompt: '你好', timeoutMs: 10000 });
  assert.equal(result.ok, true);
  assert.equal(result.text, 'WHOLE:收到：你好');
  assert.equal(result.events.some((e) => e.type === 'session.started'), false);
});
