// 中台核心逻辑单测：接力 prompt 的引用边界、圆桌的并发与失败降级
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildRelayPrompt, buildChairPrompt, buildHistoryPrompt, clip } from '../src/core/relay.mjs';
import { mapWithConcurrency, runRoundtable } from '../src/core/roundtable.mjs';

test('接力只引用焦点句与上游结论，不携带全量历史', () => {
  const prompt = buildRelayPrompt({
    upstream: { id: 'm-1', agent: 'dsh', text: '上游结论：用 B 方案。' },
    focus: { id: 'm-2', agent: 'codex', text: '焦点句：但 B 方案的迁移成本高。' },
    instruction: '请判断到底用哪个方案。',
  });

  assert.match(prompt, /<relay-context from="dsh" message-id="m-1">/);
  assert.match(prompt, /<focus-message author="codex" message-id="m-2">/);
  assert.match(prompt, /请判断到底用哪个方案。$/);
  // 没有出现任何"整段历史"的痕迹
  assert.equal(prompt.includes('全量'), false);
});

test('上游与焦点是同一句时不重复注入', () => {
  const same = { id: 'm-9', agent: 'dsh', text: '同一句话' };
  const prompt = buildRelayPrompt({ upstream: same, focus: same, instruction: '继续' });
  assert.equal(prompt.match(/同一句话/g).length, 1);
});

test('超长上下文被截断且明示（token 不会失控）', () => {
  const cliped = clip('x'.repeat(100), 20);
  assert.ok(cliped.startsWith('x'.repeat(20)));
  assert.match(cliped, /已截断，原文共 100 字/);

  const prompt = buildRelayPrompt({ upstream: { id: 'm-1', agent: 'dsh', text: 'y'.repeat(9999) }, limit: 50 });
  assert.ok(prompt.length < 400, '注入正文必须受 limit 约束');
});

test('主持人 prompt 必须要求三段结构化输出，并如实标注失败方', () => {
  const prompt = buildChairPrompt({
    question: '选 A 还是 B？',
    answers: [
      { agent: 'dsh', ok: true, text: '选 A' },
      { agent: 'codex', ok: false, error: '超时' },
    ],
  });
  assert.match(prompt, /## 共识/);
  assert.match(prompt, /## 分歧/);
  assert.match(prompt, /## 建议/);
  assert.match(prompt, /status="failed"/);
  assert.match(prompt, /本轮失败：超时/);
});

test('受控并发保持输入顺序，且并发上限被遵守', async () => {
  let running = 0;
  let peak = 0;
  const results = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => {
    running += 1;
    peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, 20));
    running -= 1;
    return n * 10;
  });
  assert.deepEqual(results, [10, 20, 30, 40, 50]);
  assert.ok(peak <= 2, `并发峰值应为 2，实际 ${peak}`);
});

test('历史补全：给没有续跑能力的 Agent 提供有上限的上下文', () => {
  const messages = [
    { agent: 'dsh', role: 'user', text: '我在做接力台' },
    { agent: 'dsh', role: 'agent', text: '好的，你在做多 Agent 中台' },
    { agent: 'codex', role: 'agent', text: '建议先做会话隔离' },
  ];
  const prompt = buildHistoryPrompt({ messages, instruction: '那下一步做什么？' });

  assert.match(prompt, /<conversation-history>/);
  assert.match(prompt, /我：我在做接力台/);
  assert.match(prompt, /dsh：好的/);
  assert.match(prompt, /codex：建议先做会话隔离/);
  assert.ok(prompt.trim().endsWith('那下一步做什么？'), '问题必须在最后，别被历史淹没');
});

test('历史补全：没有历史时退化为原始问题；有上限不会爆', () => {
  assert.equal(buildHistoryPrompt({ messages: [], instruction: '直接回答' }), '直接回答');
  assert.equal(buildHistoryPrompt({ messages: [{ role: 'user', text: '   ' }], instruction: '直接回答' }), '直接回答');

  const many = Array.from({ length: 40 }, (_, i) => ({ agent: 'dsh', role: 'agent', text: `第${i}条 ${'x'.repeat(500)}` }));
  const prompt = buildHistoryPrompt({ messages: many, instruction: '总结', limit: 500, maxTurns: 6 });
  assert.ok(prompt.length < 1500, `历史上限应生效，实际 ${prompt.length}`);
  assert.ok(prompt.includes('第39条'), '保留的是最近的内容');
  assert.ok(!prompt.includes('第0条'), '久远内容应被丢弃');
});

test('圆桌按「阶段」标注调用：主持人同时是参与者时也不会被混淆', async () => {
  // 回归用例：曾按「身份」去重，导致既是参与者又是主持人的 Agent 丢掉参与者那一轮
  const calls = [];
  await runRoundtable({
    agents: ['dsh', 'codex'],
    chair: 'dsh',
    question: 'q',
    askAgent: async (agent, prompt, options = {}) => {
      calls.push({ agent, stage: options.stage, hasChairPrompt: prompt.includes('## 共识') });
      return { agent, ok: true, text: 'x' };
    },
  });

  const fanout = calls.filter((c) => c.stage === 'fanout');
  const chair = calls.filter((c) => c.stage === 'chair');
  assert.equal(fanout.length, 2, '两个参与者都应各有一次 fanout 轮');
  assert.deepEqual(fanout.map((c) => c.agent).sort(), ['codex', 'dsh']);
  assert.equal(chair.length, 1);
  assert.equal(chair[0].agent, 'dsh');
  assert.equal(chair[0].hasChairPrompt, true, '只有主持人轮才收到汇总 prompt');
});

test('圆桌：先并行各自回答，再由主持人汇总；失败的成员不阻断整轮', async () => {
  const seen = [];
  const phases = [];
  const { answers, summary, chairPrompt } = await runRoundtable({
    agents: ['dsh', 'codex', 'minimax'],
    question: '这块板还能做什么？',
    chair: 'dsh',
    concurrency: 2,
    onPhase: (p) => phases.push(p),
    askAgent: async (agent, prompt) => {
      seen.push({ agent, prompt });
      if (agent === 'codex') return { agent, ok: false, text: '', error: '模型不可用' };
      if (prompt.includes('## 共识')) return { agent, ok: true, text: '## 共识\n都认为可行', sessionId: 's-chair' };
      return { agent, ok: true, text: `${agent} 的回答`, sessionId: `s-${agent}` };
    },
  });

  assert.equal(answers.length, 3);
  assert.equal(answers.filter((a) => a.ok).length, 2);
  assert.equal(summary.ok, true);
  // 主持人看到的 prompt 里必须含三方原文与失败标注
  assert.match(chairPrompt, /dsh 的回答/);
  assert.match(chairPrompt, /本轮失败：模型不可用/);
  // 每个参与者只收到问题本身，不收到别人的答案
  for (const call of seen.filter((c) => !c.prompt.includes('## 共识'))) {
    assert.equal(call.prompt, '这块板还能做什么？');
  }
  assert.ok(phases.some((p) => p.phase === 'chair.start'));
});
