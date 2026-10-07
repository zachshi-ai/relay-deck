// 存储层单测：会话隔离、搜索、接力链、用量折算
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Store, usageTokens, DEFAULT_CONVERSATION_ID } from '../src/core/store.mjs';

async function freshStore() {
  const dir = await mkdtemp(path.join(tmpdir(), 'relaydeck-store-'));
  const store = await new Store({ dataDir: dir }).load();
  return { store, dir };
}

test('usage 折算：两家字段不同，都能折算成 token 数', () => {
  assert.equal(usageTokens({ totalTokens: 8555 }), 8555); // dsh 形态
  assert.equal(usageTokens({ input_tokens: 23456, output_tokens: 5 }), 23461); // codex 形态
  assert.equal(usageTokens(null), null);
  assert.equal(usageTokens({}), null);
});

test('会话隔离：同一个 Agent 在两个会话里各有一条独立 session 线', async () => {
  const { store, dir } = await freshStore();
  try {
    const a = (await store.createConversation('项目 A')).id;
    const b = (await store.createConversation('项目 B')).id;

    await store.setAgentSession(a, 'dsh', 'session-A');
    await store.setAgentSession(b, 'dsh', 'session-B');

    assert.equal(store.getAgentSession(a, 'dsh'), 'session-A');
    assert.equal(store.getAgentSession(b, 'dsh'), 'session-B');
    assert.equal(store.snapshot({ conversationId: a }).agentSessions.dsh, 'session-A');
    assert.equal(store.snapshot({ conversationId: b }).agentSessions.dsh, 'session-B');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('消息按会话隔离，快照只返回本会话内容', async () => {
  const { store, dir } = await freshStore();
  try {
    const a = (await store.createConversation('A')).id;
    const b = (await store.createConversation('B')).id;
    await store.addMessage({ conversationId: a, agent: 'dsh', role: 'user', text: '苹果香蕉' });
    await store.addMessage({ conversationId: b, agent: 'dsh', role: 'user', text: '香蕉牛奶' });

    assert.equal(store.snapshot({ conversationId: a }).messages.length, 1);
    assert.equal(store.snapshot({ conversationId: b }).messages.length, 1);
    assert.equal(store.snapshot({ conversationId: a }).messages[0].text, '苹果香蕉');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('搜索：大小写不敏感、限定会话、最新优先', async () => {
  const { store, dir } = await freshStore();
  try {
    const a = (await store.createConversation('A')).id;
    const b = (await store.createConversation('B')).id;
    await store.addMessage({ conversationId: a, agent: 'dsh', role: 'user', text: '关于 OTA 的设计' });
    await store.addMessage({ conversationId: a, agent: 'codex', role: 'agent', text: 'ota 要预留双分区' });
    await store.addMessage({ conversationId: b, agent: 'dsh', role: 'user', text: 'OTA 是别的会话' });

    const inA = store.searchMessages({ q: 'ota', conversationId: a });
    assert.equal(inA.length, 2);
    assert.match(inA[0].text, /双分区/, '最新命中的排在前面');
    assert.equal(store.searchMessages({ q: 'OTA' }).length, 3, '全库搜索不区分大小写');
    assert.deepEqual(store.searchMessages({ q: '' }), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('接力链：沿 relayOf 回溯成链，且有环保护', async () => {
  const { store, dir } = await freshStore();
  try {
    const c = (await store.createConversation('链')).id;
    const q = await store.addMessage({ conversationId: c, agent: 'dsh', role: 'user', text: '问题' });
    const a1 = await store.addMessage({
      conversationId: c,
      agent: 'dsh',
      role: 'agent',
      text: 'A 的回答',
      meta: { inReplyTo: q.id },
    });
    const a2 = await store.addMessage({
      conversationId: c,
      agent: 'codex',
      role: 'agent',
      text: 'B 接着 A',
      meta: { relayOf: a1.id },
    });

    const chain = store.lineage(a2.id);
    assert.deepEqual(
      chain.map((m) => m.id),
      [q.id, a1.id, a2.id],
      '从根到当前按顺序返回',
    );

    // 人为制造环：a1.relayOf → a2，链应能安全终止
    a1.meta.relayOf = a2.id;
    const safe = store.lineage(a2.id);
    assert.ok(safe.length <= 20);
    assert.equal(new Set(safe.map((m) => m.id)).size, safe.length, '链上不应出现重复节点');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('用量汇总：按 Agent 累加 token 与平均耗时', async () => {
  const { store, dir } = await freshStore();
  try {
    const c = (await store.createConversation('用量')).id;
    await store.addMessage({
      conversationId: c,
      agent: 'dsh',
      role: 'agent',
      text: 'x',
      meta: { usage: { totalTokens: 100 }, elapsedMs: 1000 },
    });
    await store.addMessage({
      conversationId: c,
      agent: 'dsh',
      role: 'agent',
      text: 'y',
      meta: { usage: { totalTokens: 300 }, elapsedMs: 3000 },
    });
    await store.addMessage({
      conversationId: c,
      agent: 'codex',
      role: 'agent',
      text: 'z',
      meta: { usage: { input_tokens: 10, output_tokens: 5 } },
    });

    const usage = store.usageSummary(c);
    assert.equal(usage.dsh.turns, 2);
    assert.equal(usage.dsh.tokens, 400);
    assert.equal(usage.dsh.avgMs, 2000);
    assert.equal(usage.codex.tokens, 15);
    assert.equal(usage.codex.avgMs, null, '没有耗时数据时不编造');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('落盘后可重新加载，且旧数据（无会话字段）自动归入默认会话', async () => {
  const { store, dir } = await freshStore();
  try {
    const c = (await store.createConversation('持久化')).id;
    await store.addMessage({ conversationId: c, agent: 'dsh', role: 'user', text: '会被持久化' });
    await store.setAgentSession(c, 'dsh', 'session-xyz');

    const reloaded = await new Store({ dataDir: dir }).load();
    assert.equal(reloaded.snapshot({ conversationId: c }).messages[0].text, '会被持久化');
    assert.equal(reloaded.getAgentSession(c, 'dsh'), 'session-xyz');
    assert.ok(reloaded.getConversation(DEFAULT_CONVERSATION_ID), '默认会话始终存在');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
