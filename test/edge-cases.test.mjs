// 覆盖率补漏：这些分支之前没被测到——都是真实路径（参数校验、回调抛异常、
// 描述表、适配器解析的边角），不补上的话它们只会在线上第一次被人踩到。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { Store, DEFAULT_CONVERSATION_ID } from '../src/core/store.mjs';
import { runTurn, describeEvent } from '../src/core/runner.mjs';
import { runRoundtable } from '../src/core/roundtable.mjs';
import { createBoardBridge } from '../src/hardware/bridge.mjs';
import { describeLedState, computeLedState } from '../src/hardware/led.mjs';
import { describeCommand } from '../src/hardware/keymap.mjs';
import { codexAdapter } from '../src/adapters/codex.mjs';
import { dshAdapter } from '../src/adapters/dsh.mjs';

// —— store：会话增删改查的边角 ——

test('store：ensureConversation 会给未知会话建档；renameConversation 的三种情形', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'relaydeck-edge-'));
  try {
    const store = await new Store({ dataDir: dir }).load();

    // 未知 id → 建档（而不是崩或返回 undefined）
    const id = store.ensureConversation('c-brand-new');
    assert.equal(id, 'c-brand-new');
    assert.equal(store.getConversation(id).title, '未命名会话');
    assert.equal(store.ensureConversation(null), DEFAULT_CONVERSATION_ID, '空 id 回落到默认会话');

    // 正常改名
    const renamed = await store.renameConversation(id, '  新名字  ');
    assert.equal(renamed.title, '新名字', '两端空白要去掉');

    // 空标题不改（不能把标题清成空串）
    const kept = await store.renameConversation(id, '   ');
    assert.equal(kept.title, '新名字');

    // 不存在的会话返回 null，不抛
    assert.equal(await store.renameConversation('c-nope', 'x'), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('store：lastAgentMessage 只认本会话的 Agent 回答', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'relaydeck-edge-'));
  try {
    const store = await new Store({ dataDir: dir }).load();
    const a = (await store.createConversation('A')).id;
    const b = (await store.createConversation('B')).id;

    assert.equal(store.lastAgentMessage(a, 'dsh'), null, '没有任何消息时返回 null');

    await store.addMessage({ conversationId: a, agent: 'dsh', role: 'user', text: '提问' });
    assert.equal(store.lastAgentMessage(a, 'dsh'), null, '只有 user 消息时不算');

    await store.addMessage({ conversationId: b, agent: 'dsh', role: 'agent', text: '别的会话的回答' });
    assert.equal(store.lastAgentMessage(a, 'dsh'), null, '不能跨会话取');

    await store.addMessage({ conversationId: a, agent: 'dsh', role: 'agent', text: '本会话的回答一' });
    const second = await store.addMessage({ conversationId: a, agent: 'dsh', role: 'agent', text: '本会话的回答二' });
    assert.equal(store.lastAgentMessage(a, 'dsh').id, second.id, '要取最新一条');
    assert.equal(store.lastAgentMessage(a, 'codex'), null, '没有该 Agent 的回答时返回 null');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// —— runner：参数校验与回调异常 ——

test('runner：空 prompt 直接拒绝（调用方错误不应变成一次子进程）', async () => {
  const adapter = {
    id: 'x',
    command: () => process.execPath,
    buildArgs: () => ['-e', ''],
    parseLine: () => [],
  };
  await assert.rejects(() => runTurn({ adapter, prompt: '' }), /需要非空 prompt/);
  await assert.rejects(() => runTurn({ prompt: 'hi' }), /需要 adapter/);
});

test('runner：onEvent 回调抛异常不能影响这一轮', async () => {
  const adapter = {
    id: 'x',
    command: () => process.execPath,
    buildArgs: () => ['-e', 'console.log(JSON.stringify({type:"final",text:"照常返回"}))'],
    parseLine: (line) => [JSON.parse(line)],
  };
  const result = await runTurn({
    adapter,
    prompt: 'hi',
    timeoutMs: 10000,
    onEvent: () => {
      throw new Error('回调炸了');
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.text, '照常返回');
});

test('runner：describeEvent 覆盖每一种事件类型（CLI 与日志都靠它）', () => {
  const samples = [
    { type: 'session.started', sessionId: 's-1' },
    { type: 'thinking', text: '想一下' },
    { type: 'text', text: '正文' },
    { type: 'usage', usage: { totalTokens: 1 } },
    { type: 'error', message: '出错了' },
    { type: 'final', text: '最终' },
    { type: 'turn.end', reason: { kind: 'completed' } },
    { type: 'status', phase: 'step_start' },
    { type: 'raw', raw: { anything: true } },
    { type: '某种新类型', payload: 1 },
  ];
  for (const event of samples) {
    const line = describeEvent(event);
    assert.equal(typeof line, 'string');
    assert.ok(line.length > 0, `${event.type} 应有可读描述`);
  }
  assert.match(describeEvent({ type: 'error', message: '出错了' }), /ERROR/);

  // 字段缺失 / 结构意外时必须降级显示，而不是抛（CLI 正在打印事件流时崩溃最难受）
  assert.doesNotThrow(() => describeEvent({ type: 'thinking' }));
  assert.doesNotThrow(() => describeEvent({ type: 'text' }));
  assert.doesNotThrow(() => describeEvent({ type: 'final' }));
  assert.doesNotThrow(() => describeEvent({ type: 'unknown-without-raw' }));
  assert.doesNotThrow(() => describeEvent({}));
  assert.doesNotThrow(() => describeEvent(null));
  assert.doesNotThrow(() => describeEvent('不是对象'));
  assert.match(describeEvent({ type: 'unknown-without-raw', payload: 1 }), /unknown-without-raw/);
  const circular = { type: 'raw' };
  circular.raw = circular;
  assert.doesNotThrow(() => describeEvent(circular), '循环引用也不能抛');
});

// —— roundtable：超时回调自身抛异常也不能影响返回 ——

test('roundtable：onMemberTimeout 抛异常时仍然正常返回超时结果', async () => {
  const { answers } = await runRoundtable({
    agents: ['dsh'],
    chair: 'dsh',
    question: 'q',
    memberTimeoutMs: 100,
    onMemberTimeout: () => {
      throw new Error('通知上层时炸了');
    },
    askAgent: async () => new Promise(() => {}),
  });
  assert.equal(answers[0].timedOut, true);
  assert.match(answers[0].error, /超时/);
});

// —— bridge / led / keymap：描述与去重 ——

test('bridge：lastSignature 记录最后一次真正下发的帧', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'relaydeck-edge-'));
  const tool = path.join(dir, 'hidtool');
  const { writeFile } = await import('node:fs/promises');
  await writeFile(tool, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  try {
    const bridge = createBoardBridge({ toolPath: tool, spawnImpl: () => ({ on: () => {} }) });
    assert.equal(bridge.lastSignature, null);
    bridge.push({ state: 1, sequence: 5, ttlMs: 1000 });
    assert.equal(bridge.lastSignature, 'running:5');
    bridge.push({ state: 1, sequence: 5, ttlMs: 1000 }); // 重复不下发，签名也不变
    assert.equal(bridge.lastSignature, 'running:5');
    bridge.push({ state: 4, sequence: 6, ttlMs: 1000 });
    assert.equal(bridge.lastSignature, 'failed:6');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('led：describeLedState 给出可读摘要（日志与硬件自检共用）', () => {
  const led = computeLedState({
    agentIds: ['dsh', 'codex'],
    runStatus: { dsh: 'running', codex: 'error' },
    focusAgentId: 'codex',
  });
  const text = describeLedState(led);
  assert.match(text, /link:-/);
  assert.match(text, /agent1:dsh\/running/);
  assert.match(text, /agent2:codex\/error/);
});

test('keymap：describeCommand 覆盖所有命令类型', () => {
  const cases = [
    [{ type: 'relay', slot: 0 }, /接力给第 1 个 Agent/],
    [{ type: 'focus.move', delta: 1 }, /下一句/],
    [{ type: 'focus.move', delta: -1 }, /上一句/],
    [{ type: 'focus.copy' }, /复制焦点句/],
    [{ type: 'focus.clear' }, /清空焦点/],
    [{ type: 'view.cycle' }, /切换查看/],
    [{ type: 'roundtable' }, /拉群/],
    [{ type: 'config.enter' }, /配置模式/],
    [{ type: 'noop' }, /预留按键/],
    [{ type: 'noop', note: '给未来留的' }, /预留：给未来留的/],
    [{ type: 'error', message: '越界了' }, /无效动作：越界了/],
    [{ type: '未来新命令' }, /未知命令/],
    [null, /无动作/],
  ];
  for (const [command, pattern] of cases) {
    assert.match(describeCommand(command), pattern, `命令 ${JSON.stringify(command)} 的描述不对`);
  }
});

// —— 适配器解析的边角 ——

test('codex：各类事件的解析分支都被覆盖', () => {
  // 整轮失败 → 致命
  const failed = codexAdapter.parseLine('{"type":"turn.failed","error":{"message":"模型超载"}}');
  assert.equal(failed[0].fatal, true);
  // 条目级 error → 非致命
  const itemError = codexAdapter.parseLine('{"type":"item.completed","item":{"type":"error","message":"警告而已"}}');
  assert.equal(itemError[0].fatal, false);
  // reasoning → thinking
  assert.equal(codexAdapter.parseLine('{"type":"item.completed","item":{"type":"reasoning","text":"推理"}}')[0].type, 'thinking');
  // 未知条目类型 / 未知顶层类型 → raw，不丢
  assert.equal(codexAdapter.parseLine('{"type":"item.completed","item":{"type":"mystery"}}')[0].type, 'raw');
  assert.equal(codexAdapter.parseLine('{"type":"brand_new"}')[0].type, 'raw');
  // 顶层 error → 致命
  assert.equal(codexAdapter.parseLine('{"type":"error","message":"坏了"}')[0].fatal, true);
  // 空行
  assert.deepEqual(codexAdapter.parseLine('   '), []);
});

test('dsh：error 事件按致命处理，未知类型保留为 raw', () => {
  assert.equal(dshAdapter.parseLine('{"type":"error","message":"模型不可用"}')[0].fatal, true);
  assert.equal(dshAdapter.parseLine('{"type":"全新事件","x":1}')[0].type, 'raw');
  assert.deepEqual(dshAdapter.parseLine(''), []);
});
