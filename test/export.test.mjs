// 接力链导出单测
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { exportChainMarkdown } from '../src/core/export.mjs';

const chain = [
  {
    id: 'm-1',
    agent: 'dsh',
    role: 'user',
    text: '帮我把这段逻辑整理成方案。',
    createdAt: '2026-10-07T14:00:00.000Z',
  },
  {
    id: 'm-2',
    agent: 'dsh',
    role: 'agent',
    text: '方案 A：先做会话隔离。',
    meta: { elapsedMs: 2500, usage: { totalTokens: 100 } },
    createdAt: '2026-10-07T14:00:03.000Z',
  },
  {
    id: 'm-3',
    agent: 'codex',
    role: 'agent',
    text: '方案 B：先做取消与超时。',
    meta: { relayOf: 'm-2', elapsedMs: 9000, warnings: ['chronicle'] },
    createdAt: '2026-10-07T14:00:12.000Z',
  },
];

test('导出含标题、链路一览与逐条正文', () => {
  const md = exportChainMarkdown({ chain, title: '方案讨论', conversationTitle: '接力台开发' });

  assert.match(md, /^# 方案讨论/);
  assert.match(md, /> 会话：接力台开发/);
  assert.match(md, /> 节点数：3/);
  assert.match(md, /## 链路一览/);
  assert.ok(md.includes('**1. 我**（提问）'), '第一条是提问');
  assert.ok(md.includes('→ **2. dsh**'));
  assert.ok(md.includes('→ **3. codex**'));
  assert.ok(/链路一览\n\n\*\*1\. 我\*\*（提问） → \*\*2\. dsh\*\* → \*\*3\. codex\*\*/.test(md), '链路一览必须是一行，别拆成多行');
  assert.match(md, /方案 A：先做会话隔离。/);
  assert.match(md, /方案 B：先做取消与超时。/);
});

test('元信息被如实带出：耗时、接力来源、警告、上下文重置', () => {
  const md = exportChainMarkdown({
    chain: [
      { id: 'm-9', agent: 'kimi', role: 'agent', text: '回答', meta: { elapsedMs: 5100, warnings: ['w1', 'w2'], contextReset: true, relayOf: 'm-8' }, createdAt: '2026-10-07T14:00:00.000Z' },
    ],
  });
  assert.match(md, /5100ms/);
  assert.match(md, /接力自 m-8/);
  assert.match(md, /警告 ×2/);
  assert.match(md, /上下文已重置/);
  assert.match(md, /m-9/);
});

test('空链不崩，且给出明确说明', () => {
  const md = exportChainMarkdown({ chain: [] });
  assert.match(md, /（这条链上没有消息）/);
});

test('圆桌提问的角色名与普通提问区分开', () => {
  const md = exportChainMarkdown({
    chain: [{ id: 'm-1', agent: 'roundtable', role: 'user', text: '大家怎么看？', createdAt: '2026-10-07T14:00:00.000Z' }],
  });
  assert.match(md, /圆桌提问/);
});

test('时间缺失或非法时不抛异常', () => {
  const md = exportChainMarkdown({
    chain: [{ id: 'm-x', agent: 'dsh', role: 'agent', text: '无时间', createdAt: '不是时间' }],
  });
  assert.match(md, /无时间/);
});
