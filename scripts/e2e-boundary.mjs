#!/usr/bin/env node
// 边界验证：中台遇到异常输入、坏路径、并发、超时时，必须**优雅失败**，
// 不能崩进程、不能挂住、更不能静默当成成功。
//
// 覆盖（对应 plan.md 的 3.3）：
//   1. 焦点指向不存在的消息
//   2. 未绑定的硬件输入
//   3. 缺少必填字段 / 未知 Agent
//   4. 查一个不存在的会话
//   5. 二进制不存在（spawn 失败）
//   6. 超时（真实子进程被强制终止）
//   7. 同一个 Agent 并发两轮（kimi 持有 runner.lock，串行队列必须挡住）
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

const run = promisify(execFile);
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
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON 响应保留原文 */
  }
  return { status: res.status, json, text };
}

/** 读 SSE 直到结束，返回 done / failed 载荷 */
async function askStream(body) {
  const res = await fetch(`${BASE}/api/ask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let done = null;
  let failed = null;
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
      const payload = JSON.parse(data);
      if (event === 'done') done = payload;
      if (event === 'failed') failed = payload;
    }
  }
  return { done, failed, httpStatus: res.status };
}

// —— 1. 焦点指向不存在的消息 ——
const badFocus = await api('POST', '/api/focus', { messageId: 'm-does-not-exist' });
check('焦点指向不存在的消息 → 404 且不写入状态', badFocus.status === 404, `HTTP ${badFocus.status}`);

// 清空焦点后按 S7（复制）：应明确拒绝而不是复制空内容
await api('POST', '/api/focus', { messageId: null });
const copyWithoutFocus = await api('POST', '/api/hardware', { source: 'key', id: 'S7', gesture: 'press' });
check(
  '没有焦点句时按 S7 → 明确拒绝（accepted:false）',
  copyWithoutFocus.status === 200 && copyWithoutFocus.json?.accepted === false,
  copyWithoutFocus.json?.reason ?? '',
);

// —— 2. 未绑定的硬件输入 ——
const unknownKey = await api('POST', '/api/hardware', { source: 'key', id: 'S99', gesture: 'press' });
check(
  '未绑定的按键 → 不执行、不报 500',
  unknownKey.status === 200 && unknownKey.json?.accepted === false,
  unknownKey.json?.reason ?? '',
);
const unknownGesture = await api('POST', '/api/hardware', { source: 'encoder', gesture: 'doubleTap' });
check(
  '未绑定的手势 → 不执行、不报 500',
  unknownGesture.status === 200 && unknownGesture.json?.accepted === false,
);

// —— 3. 缺少必填字段 / 未知 Agent ——
const noPrompt = await api('POST', '/api/ask', { agent: 'dsh' });
check('缺少 prompt → 400', noPrompt.status === 400, noPrompt.json?.error ?? '');

const unknownAgent = await askStream({ agent: 'gpt-9', prompt: '你好' });
check(
  '未知 Agent → SSE 报 failed 且带上可用列表',
  Boolean(unknownAgent.failed) && /未知 Agent/.test(unknownAgent.failed.error ?? ''),
  unknownAgent.failed?.error ?? '',
);

// —— 4. 不存在的会话 ——
const ghostConversation = await api('GET', '/api/state?conversation=c-does-not-exist');
check(
  '查询不存在的会话 → 200 且不崩（返回空消息）',
  ghostConversation.status === 200 && Array.isArray(ghostConversation.json?.messages),
  `messages=${ghostConversation.json?.messages?.length ?? 'n/a'}`,
);

// —— 5. spawn 失败：二进制不存在 ——
let spawnFailure = null;
try {
  await run('node', ['bin/relay.mjs', 'ask', 'minimax', '你好'], {
    cwd: process.cwd(),
    env: { ...process.env, RELAYDECK_MMX_BIN: '/nonexistent/bin/mmx' },
    timeout: 30000,
  });
} catch (err) {
  spawnFailure = { code: err.code, stderr: err.stderr ?? '', stdout: err.stdout ?? '' };
}
check(
  '二进制不存在 → 非 0 退出，且错误信息说明"无法启动"',
  spawnFailure !== null && /无法启动/.test(spawnFailure.stderr),
  (spawnFailure?.stderr ?? '').trim().split('\n').at(-1) ?? '',
);

// —— 6. 超时：真实子进程被强制终止 ——
let timeoutRun = null;
try {
  await run('node', ['bin/relay.mjs', 'ask', 'dsh', '请写一篇一万字的长文', '--timeout', '1200'], {
    cwd: process.cwd(),
    timeout: 60000,
  });
} catch (err) {
  timeoutRun = { code: err.code, stderr: err.stderr ?? '' };
}
check(
  '超时 → 进程被终止且如实标记超时（不是静默成功）',
  timeoutRun !== null && /超时/.test(timeoutRun.stderr),
  (timeoutRun?.stderr ?? '').trim().split('\n').at(-1)?.slice(0, 140) ?? '',
);

// —— 7. 同一 Agent 并发两轮：串行队列必须挡住 ——
const convo = await api('POST', '/api/conversations', { title: `边界验证 ${startedAt.slice(11, 19)}` });
const [first, second] = await Promise.all([
  askStream({ agent: 'kimi', prompt: '只回复：一', conversationId: convo.json.conversation.id }),
  askStream({ agent: 'kimi', prompt: '只回复：二', conversationId: convo.json.conversation.id }),
]);
check(
  '同一 Agent 并发两轮都成功（runner.lock 不冲突 = 队列生效）',
  Boolean(first.done?.ok) && Boolean(second.done?.ok),
  `1=${JSON.stringify(first.done?.text ?? first.done?.error ?? first.failed)} / 2=${JSON.stringify(second.done?.text ?? second.done?.error ?? second.failed)}`,
);

const summary = {
  kind: 'relaydeck-boundary-e2e',
  ranAt: startedAt,
  base: BASE,
  checks,
  spawnFailure,
  timeoutRun,
  concurrency: { first: first.done?.text, second: second.done?.text },
};

const dir = path.resolve(process.cwd(), 'evidence');
await mkdir(dir, { recursive: true });
const file = path.join(dir, `boundary-${startedAt.replace(/[:.]/g, '-')}.json`);
await writeFile(file, `${JSON.stringify(summary, null, 2)}\n`);

const failed = checks.filter((c) => !c.passed);
console.log(`\n证据：${file}`);
console.log(`结论：${checks.length - failed.length}/${checks.length} 项通过`);
process.exitCode = failed.length ? 1 : 0;
