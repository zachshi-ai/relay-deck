#!/usr/bin/env node
// 精确取消验收：证明"取消某一轮"只影响那一轮，且被如实标记为 cancelled（不是失败、不是超时）。
//
// 覆盖：
//   1. 能按 agent 取消正在跑的那一轮
//   2. 取消后该轮返回 cancelled=true / error=已取消，而不是伪装成模型失败
//   3. 取消不影响其他 Agent（并发场景）
//   4. 取消不会触发"续跑线自愈重试"（那等于无视用户的取消）
//   5. 取消按钮对应的 agent 状态回到 idle，而不是报红
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const BASE = process.env.RELAYDECK_URL ?? 'http://127.0.0.1:8787';
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
  return res.json();
}

/** 发起一轮但不等待：返回一个 promise，稍后可取 done 载荷 */
function startAsk(body) {
  const promise = (async () => {
    const res = await fetch(`${BASE}/api/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
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
  })();
  return promise;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** 等某个 Agent 出现在 runs 列表里（说明子进程已经起来了） */
async function waitForRun(agent, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await api('GET', '/api/state');
    const run = (state.runs ?? []).find((r) => r.agentId === agent);
    if (run) return run;
    await wait(300);
  }
  return null;
}

const convo = await api('POST', '/api/conversations', { title: `取消验收 ${startedAt.slice(11, 19)}` });
const conversationId = convo.conversation.id;
console.log(`会话：${conversationId}`);

// —— 1. 起两轮：一个要被取消（kimi，慢），一个不该受影响（minimax，快） ——
const victim = startAsk({ agent: 'kimi', prompt: '请详细写一篇 800 字的技术散文。', conversationId });
const bystander = startAsk({ agent: 'minimax', prompt: '只回复两个字：收到', conversationId });

const run = await waitForRun('kimi');
check('能看到正在跑的轮次（runs 列表里有 runId）', Boolean(run?.runId), run?.runId ?? '未出现');

const cancelResult = await api('POST', '/api/cancel', { agent: 'kimi' });
check('按 agent 精确取消命中 1 条', cancelResult.killed === 1, `killed=${cancelResult.killed} ${JSON.stringify(cancelResult.cancelled ?? [])}`);

const victimDone = await victim;
check('被取消的那轮如实标记 cancelled', victimDone?.cancelled === true, `cancelled=${victimDone?.cancelled} error=${victimDone?.error}`);
check('错误信息是"已取消"，不是伪装成模型失败', victimDone?.error === '已取消', victimDone?.error ?? '');
check('被取消的那轮没有产出正式回答', victimDone?.ok === false, `ok=${victimDone?.ok} text=${JSON.stringify((victimDone?.text ?? '').slice(0, 30))}`);

const bystanderDone = await bystander;
check('同时进行的另一轮不受影响', bystanderDone?.ok === true && bystanderDone?.cancelled !== true, `ok=${bystanderDone?.ok} text=${JSON.stringify(bystanderDone?.text ?? '')}`);

// —— 2. 取消不能触发自愈重试 ——
const stateAfter = await api('GET', `/api/state?conversation=${encodeURIComponent(conversationId)}`);
const kimiMessages = (stateAfter.messages ?? []).filter((m) => m.agent === 'kimi');
const kimiUserMessages = kimiMessages.filter((m) => m.role === 'user');
check(
  '取消没有造成重复调用（用户的指令只入库一次，没有自愈重试的第二轮）',
  kimiUserMessages.length === 1,
  `kimi 的 user 消息数=${kimiUserMessages.length}`,
);
const kimiRuns = (stateAfter.runs ?? []).filter((r) => r.agentId === 'kimi');
check('取消后 runs 列表里不再有 kimi', kimiRuns.length === 0, JSON.stringify(kimiRuns));

const kimiStatus = (stateAfter.agents ?? []).find((a) => a.id === 'kimi')?.runStatus;
check('取消后该 Agent 的状态回到 idle（不是 error）', kimiStatus === 'idle', `runStatus=${kimiStatus}`);

// —— 3. 全部取消（兼容旧行为） ——
const all = await api('POST', '/api/cancel', {});
check('不带参数仍可"终止全部"（向后兼容）', typeof all.killed === 'number', `killed=${all.killed}`);

const summary = {
  kind: 'relaydeck-cancel-e2e',
  ranAt: startedAt,
  base: BASE,
  conversationId,
  checks,
  victim: { cancelled: victimDone?.cancelled, error: victimDone?.error, ok: victimDone?.ok, runId: victimDone?.runId },
  bystander: { ok: bystanderDone?.ok, text: bystanderDone?.text, cancelled: bystanderDone?.cancelled },
  cancelResponse: cancelResult,
};

const dir = path.resolve(process.cwd(), 'evidence');
await mkdir(dir, { recursive: true });
const file = path.join(dir, `cancel-${startedAt.replace(/[:.]/g, '-')}.json`);
await writeFile(file, `${JSON.stringify(summary, null, 2)}\n`);

const failed = checks.filter((c) => !c.passed);
console.log(`\n证据：${file}`);
console.log(`结论：${checks.length - failed.length}/${checks.length} 项通过`);
process.exitCode = failed.length ? 1 : 0;
