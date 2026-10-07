#!/usr/bin/env node
// HTTP 层端到端验收：走真实中台接口，验证「跨 Agent 接力」与「会话隔离」。
//
// 设计要点：接力要让 B 靠 A 的回答拿到信息——
//   A（dsh）先被告知数字 42 并回答出来；
//   再把 A 的回答作为引用上下文接力给 B（codex），问它数字是多少。
//   B 自己的会话里从没出现过 42，答对即证明接力上下文真的传过去了。
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const BASE = process.env.RELAYDECK_URL ?? 'http://127.0.0.1:8787';

async function api(method, route, body) {
  const res = await fetch(`${BASE}${route}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${route} → HTTP ${res.status}`);
  return res.json();
}

/** 读 SSE，返回 done 载荷与事件计数 */
async function askStream(body) {
  const res = await fetch(`${BASE}/api/ask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) throw new Error(`ask → HTTP ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const counts = {};
  let done = null;
  let failure = null;

  for (;;) {
    const { value, done: finished } = await reader.read();
    if (finished) break;
    buffer += decoder.decode(value, { stream: true });
    let cut;
    while ((cut = buffer.indexOf('\n\n')) >= 0) {
      const chunk = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      let event = 'message';
      let data = '';
      for (const line of chunk.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      if (!data) continue;
      counts[event] = (counts[event] ?? 0) + 1;
      const payload = JSON.parse(data);
      if (event === 'done') done = payload;
      if (event === 'failed') failure = payload;
    }
  }
  return { done, failure, counts };
}

const checks = [];
function check(name, passed, detail) {
  checks.push({ name, passed: Boolean(passed), detail });
  console.log(`${passed ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const startedAt = new Date().toISOString();
// 默认验 dsh → codex；可传参改验别的组合，例如：node scripts/e2e-http.mjs dsh minimax
const [sourceAgent = 'dsh', targetAgent = 'codex'] = process.argv.slice(2);

// 1. 建一个干净会话
const { conversation } = await api('POST', '/api/conversations', { title: `接力验收 ${sourceAgent}→${targetAgent}` });
console.log(`会话：${conversation.id} ${conversation.title}`);

// 2. A 侧：让上游 Agent 记住并回答出 42
const turn1 = await askStream({
  agent: sourceAgent,
  prompt: '请只回复这一句：已记住 42。不要使用任何工具。',
  conversationId: conversation.id,
});
check(`第 1 轮 ${sourceAgent} 成功产出`, turn1.done?.ok, `text=${JSON.stringify(turn1.done?.text ?? '')}`);
check('第 1 轮回答里含有 42', (turn1.done?.text ?? '').includes('42'));

// 3. B 侧：把 A 的回答接力给下游 Agent，问它数字是多少
const turn2 = await askStream({
  agent: targetAgent,
  prompt: '根据上面的引用上下文回答：那个数字是多少？只回复数字本身。',
  relayOf: turn1.done?.messageId ?? null,
  conversationId: conversation.id,
});
check(`第 2 轮 ${targetAgent} 成功产出`, turn2.done?.ok, `text=${JSON.stringify(turn2.done?.text ?? '')}`);
check(`${targetAgent} 靠自己会话不可能知道的数字答对了（接力上下文生效）`, (turn2.done?.text ?? '').includes('42'));

// 3b. 若下游 Agent 没有续跑能力（如 MiniMax），再问一轮但**不给**接力上下文：
//     这时能不能答对，只取决于中台有没有把历史补上去。
const targetInfo = (await api('GET', `/api/state?conversation=${encodeURIComponent(conversation.id)}`)).agents.find(
  (a) => a.id === targetAgent,
);
let turn3 = null;
if (targetInfo && !targetInfo.capabilities?.resume) {
  turn3 = await askStream({
    agent: targetAgent,
    prompt: '这次不给你任何引用上下文：我刚才让你回答的那个数字是多少？只回复数字本身。',
    conversationId: conversation.id,
  });
  check(
    `第 3 轮 ${targetAgent} 靠中台补的历史答对（无续跑能力时的兜底）`,
    (turn3.done?.text ?? '').includes('42'),
    `text=${JSON.stringify(turn3.done?.text ?? '')}`,
  );
} else {
  check(`第 3 轮跳过：${targetAgent} 自身支持续跑，不需要历史兜底`, true);
}

// 4. 会话隔离：两个会话里上游 Agent 的 session 必须不同
const stateA = await api('GET', `/api/state?conversation=${encodeURIComponent(conversation.id)}`);
const stateDefault = await api('GET', '/api/state?conversation=c-default');
const sessionA = stateA.agentSessions[sourceAgent] ?? null;
const sessionDefault = stateDefault.agentSessions[sourceAgent] ?? null;
check(`新会话里 ${sourceAgent} 有独立 session`, Boolean(sessionA), sessionA ?? '');
check(
  `与会话 c-default 的 ${sourceAgent} session 不同（上下文不串）`,
  sessionA !== sessionDefault,
  `A=${sessionA ?? '-'} / default=${sessionDefault ?? '-'}`,
);
check('新会话消息只含本会话内容', (stateA.messages ?? []).every((m) => m.conversationId === conversation.id));

// 5. 搜索
const searchResult = await api('GET', `/api/search?q=42&conversation=${encodeURIComponent(conversation.id)}`);
check('全文搜索能命中', (searchResult.matches ?? []).length >= 1, `${searchResult.matches?.length ?? 0} 条命中`);

// 6. 接力链
const lineage = await api('GET', `/api/lineage?message=${encodeURIComponent(turn2.done?.messageId ?? '')}`);
const chainIds = (lineage.lineage ?? []).map((m) => m.id);
check(
  '接力链可从 B 的回答回溯到 A 的回答',
  chainIds.includes(turn1.done?.messageId),
  chainIds.join(' → '),
);

// 7. 用量汇总
check('用量汇总记录了 token 或耗时', Object.keys(stateA.usage ?? {}).length > 0, JSON.stringify(Object.keys(stateA.usage ?? {})));

const summary = {
  kind: 'relaydeck-http-e2e',
  ranAt: startedAt,
  base: BASE,
  sourceAgent,
  targetAgent,
  conversationId: conversation.id,
  checks,
  turn1: { ok: turn1.done?.ok, text: turn1.done?.text, messageId: turn1.done?.messageId, sessionId: turn1.done?.sessionId, events: turn1.counts },
  turn2: { ok: turn2.done?.ok, text: turn2.done?.text, messageId: turn2.done?.messageId, sessionId: turn2.done?.sessionId, relayOf: turn2.done?.relayOf, events: turn2.counts },
  turn3: turn3
    ? { note: '无续跑能力的 Agent 的历史兜底轮', ok: turn3.done?.ok, text: turn3.done?.text, messageId: turn3.done?.messageId }
    : null,
  lineage: chainIds,
  sessions: { newConversation: sessionA, defaultConversation: sessionDefault },
};

const dir = path.resolve(process.cwd(), 'evidence');
await mkdir(dir, { recursive: true });
const file = path.join(dir, `http-e2e-${startedAt.replace(/[:.]/g, '-')}.json`);
await writeFile(file, `${JSON.stringify(summary, null, 2)}\n`);

const failed = checks.filter((c) => !c.passed);
console.log(`\n证据：${file}`);
console.log(`结论：${checks.length - failed.length}/${checks.length} 项通过`);
process.exitCode = failed.length ? 1 : 0;
