#!/usr/bin/env node
// 续跑线失效自愈的端到端验收。
//
// 脚本自己制造故障：先正常跑一轮拿到真实续跑线，然后把数据文件里这条线改成
// 一个不存在的 session（模拟会话过期/被删/换机器），热加载让它生效，
// 再发一轮——中台应当丢掉坏线重跑一次并如实上报 contextReset。
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const BASE = process.env.RELAYDECK_URL ?? 'http://127.0.0.1:8787';
const AGENT = process.env.RELAYDECK_RECOVERY_AGENT ?? 'dsh';
const DATA_FILE = path.resolve(
  process.env.RELAYDECK_DATA ?? path.resolve(process.cwd(), 'data'),
  'store.jsonl',
);
const BOGUS = `session-nonexistent-${Date.now()}`;
const startedAt = new Date().toISOString();
const checks = [];

function check(name, passed, detail = '') {
  checks.push({ name, passed: Boolean(passed), detail });
  console.log(`${passed ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function api(method, route, body) {
  const res = await fetch(`${BASE}${route}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  try {
    return { status: res.status, json: JSON.parse(text) };
  } catch {
    return { status: res.status, json: null, text };
  }
}

async function ask(prompt, conversationId) {
  const res = await fetch(`${BASE}/api/ask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent: AGENT, prompt, conversationId }),
  });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let done = null;
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
      if (event === 'done' && data) done = JSON.parse(data);
    }
  }
  return done;
}

// 1. 建会话并正常跑一轮，拿到真实续跑线
const created = await api('POST', '/api/conversations', { title: `自愈验收 ${startedAt.slice(11, 19)}` });
const conversationId = created.json.conversation.id;
const first = await ask('只回复两个字：收到', conversationId);
check('第 1 轮正常产出并建立续跑线', Boolean(first?.ok) && Boolean(first?.sessionId), `session=${first?.sessionId ?? '-'}`);
const realSession = first?.sessionId ?? null;

// 2. 制造故障：把这条线改成一个不存在的 session
await appendFile(
  DATA_FILE,
  `${JSON.stringify({ kind: 'agent-session', conversationId, agent: AGENT, sessionId: BOGUS })}\n`,
);
const reloaded = await api('POST', '/api/admin/reload');
const bogusInState = reloaded.json?.state?.agentSessions?.[AGENT];
check('故障已注入（热加载后内存里是坏 session）', bogusInState === BOGUS, bogusInState ?? '-');

// 3. 关键一步：带坏 session 的一轮应当自愈
const second = await ask('只回复两个字：收到（第二轮的正文不要和上一轮相同）', conversationId);
check('坏 session 下仍然成功产出（自愈生效）', Boolean(second?.ok), `text=${JSON.stringify(second?.text ?? '')} error=${second?.error ?? '-'}`);
check('如实上报 contextReset（用户必须知道上下文被重置）', second?.contextReset === true, `contextReset=${second?.contextReset}`);
check('重试用了一次且只有一次重试', second?.attempts === 2, `attempts=${second?.attempts}`);

// 4. 收尾：坏线应被替换成新线，且下一轮不再重置
const state = await api('GET', `/api/state?conversation=${encodeURIComponent(conversationId)}`);
const sessionNow = state.json?.agentSessions?.[AGENT] ?? null;
check('坏续跑线已被替换成新线', Boolean(sessionNow) && sessionNow !== BOGUS, `now=${String(sessionNow).slice(0, 24)}…`);

const third = await ask('只回复两个字：收到', conversationId);
check('后续轮次恢复正常（不会再重置）', Boolean(third?.ok) && third?.contextReset === false, `contextReset=${third?.contextReset} attempts=${third?.attempts}`);

const summary = {
  kind: 'relaydeck-session-recovery-e2e',
  ranAt: startedAt,
  base: BASE,
  agent: AGENT,
  conversationId,
  bogusSession: BOGUS,
  realSession,
  sessionAfterRecovery: sessionNow,
  checks,
  turns: {
    first: { ok: first?.ok, sessionId: first?.sessionId },
    afterPoison: { ok: second?.ok, text: second?.text, contextReset: second?.contextReset, attempts: second?.attempts },
    afterRecovery: { ok: third?.ok, contextReset: third?.contextReset, attempts: third?.attempts },
  },
};

const dir = path.resolve(process.cwd(), 'evidence');
await mkdir(dir, { recursive: true });
const file = path.join(dir, `session-recovery-${startedAt.replace(/[:.]/g, '-')}.json`);
await writeFile(file, `${JSON.stringify(summary, null, 2)}\n`);

const failed = checks.filter((c) => !c.passed);
console.log(`\n证据：${file}`);
console.log(`结论：${checks.length - failed.length}/${checks.length} 项通过`);
process.exitCode = failed.length ? 1 : 0;
