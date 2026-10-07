// 解析器单测：fixtures 全部是**真实抓取**的原生输出行（不是编造的）
// 来源：2026-10-07 本机实测 `dsh --profile headless --json` 与 `codex exec --json`
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { dshAdapter } from '../src/adapters/dsh.mjs';
import { codexAdapter } from '../src/adapters/codex.mjs';

const DSH_REAL_LINES = [
  '{"type":"session","sessionId":"session-16759da8-02d4-42a8-94a1-2522cdc82c81","cwd":"/Users/zach/Documents/ChatGPT/Easyinput_homework"}',
  '{"type":"status","phase":"turn_start","turn":1}',
  '{"type":"status","phase":"step_start","turn":1,"step":1}',
  '{"type":"thinking","text":""}',
  '{"type":"text","text":"OK"}',
  '{"type":"status","phase":"step_end","turn":1,"step":1,"usage":{"inputTokens":8553,"outputTokens":2,"cacheReadTokens":0,"cacheWriteTokens":0,"totalTokens":8555}}',
  '{"type":"status","phase":"turn_end","turn":1,"reason":{"kind":"completed"}}',
  '{"type":"final","text":"OK"}',
];

const CODEX_REAL_LINES = [
  '{"type":"thread.started","thread_id":"01a1168a-78a9-76c1-be03-0b0d3b31fb48"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Under-development features enabled: chronicle."}}',
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"OK"}}',
  '{"type":"turn.completed","usage":{"input_tokens":23456,"cached_input_tokens":13184,"cache_write_input_tokens":0,"output_tokens":5,"reasoning_output_tokens":0}}',
];

function parseAll(adapter, lines) {
  return lines.flatMap((line) => adapter.parseLine(line));
}

test('dsh：真实事件流解析出 session / usage / final', () => {
  const events = parseAll(dshAdapter, DSH_REAL_LINES);
  const byType = (t) => events.filter((e) => e.type === t);

  assert.equal(byType('session.started')[0].sessionId, 'session-16759da8-02d4-42a8-94a1-2522cdc82c81');
  assert.equal(byType('text')[0].text, 'OK');
  assert.equal(byType('final')[0].text, 'OK');
  assert.equal(byType('usage')[0].usage.totalTokens, 8555);
  assert.equal(byType('turn.end')[0].reason.kind, 'completed');
  // 空 thinking 不产生噪声事件
  assert.equal(byType('thinking').length, 0);
});

test('codex：真实事件流解析出 thread_id / agent_message / usage', () => {
  const events = parseAll(codexAdapter, CODEX_REAL_LINES);
  const byType = (t) => events.filter((e) => e.type === t);

  assert.equal(byType('session.started')[0].sessionId, '01a1168a-78a9-76c1-be03-0b0d3b31fb48');
  assert.equal(byType('text')[0].text, 'OK');
  assert.equal(byType('usage')[0].usage.output_tokens, 5);
  assert.equal(byType('turn.end')[0].reason, 'completed');
});

test('codex：条目级 error 标为非致命，turn.failed 标为致命', () => {
  const itemError = codexAdapter.parseLine(
    '{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Under-development features enabled: chronicle."}}',
  );
  assert.equal(itemError[0].type, 'error');
  assert.equal(itemError[0].fatal, false);

  const turnFailed = codexAdapter.parseLine('{"type":"turn.failed","error":{"message":"模型超载"}}');
  assert.equal(turnFailed[0].type, 'error');
  assert.equal(turnFailed[0].fatal, true);

  // dsh 的 error 事件按致命处理
  const dshError = dshAdapter.parseLine('{"type":"error","message":"模型不可用"}');
  assert.equal(dshError[0].fatal, true);
});

test('未知事件类型不丢弃，归一为 raw（版本变化可诊断）', () => {
  const events = dshAdapter.parseLine('{"type":"brand_new_thing","payload":1}');
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'raw');
  assert.equal(events[0].raw.type, 'brand_new_thing');
});

test('非 JSON 行不丢，原样透传为 raw', () => {
  const events = codexAdapter.parseLine('Not inside a trusted directory and --skip-git-repo-check was not specified.');
  assert.equal(events[0].type, 'raw');
});

test('参数构造：续跑时带上会话标识，prompt 一律走 stdin', () => {
  assert.deepEqual(dshAdapter.buildArgs({ sessionId: 'session-abc' }), [
    '--profile',
    'headless',
    '--json',
    '--session-id',
    'session-abc',
    '-',
  ]);
  assert.deepEqual(dshAdapter.buildArgs({}), ['--profile', 'headless', '--json', '-']);

  const fresh = codexAdapter.buildArgs({ cwd: '/tmp' });
  assert.deepEqual(fresh, ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'read-only', '-C', '/tmp', '-']);

  // 续跑必须走 resume 子命令：选项在会话 id 之前，且不带 --sandbox / -C
  const resumed = codexAdapter.buildArgs({ sessionId: 'thread-1', cwd: '/tmp' });
  assert.deepEqual(resumed.slice(0, 2), ['exec', 'resume']);
  assert.ok(resumed.includes('thread-1'));
  assert.ok(resumed.includes('--skip-git-repo-check'));
  assert.ok(!resumed.includes('--sandbox'), 'resume 子命令不接受 --sandbox');
  assert.ok(!resumed.includes('-C'), 'resume 子命令不接受 -C');
  assert.ok(resumed.indexOf('thread-1') < resumed.length - 1, '会话 id 之后只跟 prompt 占位');
  assert.equal(resumed.at(-1), '-');
});
