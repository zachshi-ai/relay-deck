#!/usr/bin/env node
// 构建静态演示数据：把**真实运行录制**下来的数据整理成 demo/data.json。
//
// 为什么要有这一步：RelayDeck 本身要调本机四个 CLI，没法跑在 GitHub Pages 上。
// 所以线上演示 = 真实界面 + 真实录制数据的静态回放（页面里会明确标注是回放）。
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT_DIR = path.join(ROOT, 'demo');

const AVATARS = {
  dsh: 'DeepSeek Harness',
  codex: 'Codex',
  minimax: 'MiniMax',
  kimi: 'Kimi',
  roundtable: '圆桌提问',
};

function safeJson(text) {
  return JSON.parse(text);
}

async function readStore() {
  const raw = await readFile(path.join(ROOT, 'data', 'store.jsonl'), 'utf8');
  const records = raw
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return safeJson(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  const conversations = new Map();
  const messages = [];
  const sessions = [];

  for (const record of records) {
    if (record.kind === 'conversation') {
      conversations.set(record.conversation.id, {
        id: record.conversation.id,
        title: record.conversation.title,
        createdAt: record.conversation.createdAt,
        updatedAt: record.conversation.updatedAt,
      });
    } else if (record.kind === 'message') {
      const message = record.message;
      if (!message.conversationId) continue; // 早期无归属的记录不进演示
      messages.push(message);
    } else if (record.kind === 'agent-session') {
      sessions.push({ conversationId: record.conversationId, agent: record.agent });
    }
  }

  // 只保留有消息的会话；没标题的用首条消息生成
  const byConversation = new Map();
  for (const message of messages) {
    if (!byConversation.has(message.conversationId)) byConversation.set(message.conversationId, []);
    byConversation.get(message.conversationId).push(message);
  }

  const cleanedConversations = [...byConversation.entries()]
    .map(([id, list]) => {
      const record = conversations.get(id);
      const sorted = list.slice().sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
      const firstUser = sorted.find((m) => m.role === 'user');
      return {
        id,
        title: record?.title ?? (firstUser?.text ?? '未命名会话').slice(0, 18),
        createdAt: record?.createdAt ?? sorted[0]?.createdAt,
        messageCount: sorted.length,
        agents: [...new Set(sorted.filter((m) => m.role === 'agent').map((m) => m.agent))],
      };
    })
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));

  // 消息瘦身：只留演示要用的字段，去掉本机 session id 等
  const cleanedMessages = messages
    .slice()
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
    .map((m) => ({
      id: m.id,
      conversationId: m.conversationId,
      agent: m.agent,
      role: m.role,
      text: m.text,
      createdAt: m.createdAt,
      meta: {
        relayOf: m.meta?.relayOf ?? null,
        inReplyTo: m.meta?.inReplyTo ?? null,
        elapsedMs: m.meta?.elapsedMs ?? null,
        usage: m.meta?.usage ?? null,
        kind: m.meta?.kind ?? null,
        contextReset: Boolean(m.meta?.contextReset),
        attempts: m.meta?.attempts ?? null,
        warnings: m.meta?.warnings ?? null,
      },
    }));

  return { conversations: cleanedConversations, messages: cleanedMessages, sessions };
}

async function readRoundtable() {
  const dir = path.join(ROOT, 'evidence');
  const files = (await import('node:fs/promises')).readdir(dir);
  const names = (await files).filter((n) => /^roundtable-4agents.*\.sse$/.test(n)).sort();
  if (!names.length) return null;
  const raw = await readFile(path.join(dir, names.at(-1)), 'utf8');
  const match = raw.match(/event: done\ndata: (.*)/);
  if (!match) return null;
  const done = safeJson(match[1]);
  return {
    sourceFile: names.at(-1),
    question: done.question,
    chair: done.chair,
    answers: done.answers.map((a) => ({ agent: a.agent, ok: a.ok, text: a.text, error: a.error, elapsedMs: null })),
    summary: { ok: done.summary.ok, text: done.summary.text },
  };
}

async function readLedTimeline() {
  const dir = path.join(ROOT, 'evidence');
  const names = (await (await import('node:fs/promises')).readdir(dir))
    .filter((n) => /^board-status-.*\.json$/.test(n))
    .sort();
  if (!names.length) return null;
  const data = safeJson(await readFile(path.join(dir, names.at(-1)), 'utf8'));
  return {
    sourceFile: names.at(-1),
    states: (data.timeline ?? []).map((entry) => ({
      label: entry.label,
      stateName: entry.stateName,
      sequence: entry.sequence,
      ttlMs: entry.ttlMs,
      color: entry.color,
    })),
  };
}

const store = await readStore();
const roundtable = await readRoundtable();
const led = await readLedTimeline();

const demo = {
  generatedAt: new Date().toISOString(),
  note: '数据来自 2026-10-07 的真实运行录制（本地中台 + 四个 CLI）。线上是静态回放，不能真实调用模型。',
  agents: Object.entries(AVATARS)
    .filter(([id]) => id !== 'roundtable')
    .map(([id, label]) => ({ id, label, available: true })),
  conversations: store.conversations,
  messages: store.messages,
  roundtable,
  led,
  stats: {
    conversations: store.conversations.length,
    messages: store.messages.length,
    byAgent: store.messages.reduce((acc, m) => {
      acc[m.agent] = (acc[m.agent] ?? 0) + 1;
      return acc;
    }, {}),
  },
};

await mkdir(OUT_DIR, { recursive: true });
const file = path.join(OUT_DIR, 'data.json');
await writeFile(file, `${JSON.stringify(demo, null, 2)}\n`);

console.log('=== 演示数据已生成 ===');
console.log(`输出：demo/data.json（${(JSON.stringify(demo).length / 1024).toFixed(0)} KB）`);
console.log(`会话 ${demo.stats.conversations} 个 · 消息 ${demo.stats.messages} 条 · Agent 分布 ${JSON.stringify(demo.stats.byAgent)}`);
console.log(`圆桌录制：${roundtable ? `${roundtable.answers.length} 个 Agent 参与` : '无'}`);
console.log(`LED 时间线：${led ? `${led.states.length} 个状态` : '无'}`);
