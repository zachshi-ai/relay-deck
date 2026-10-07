#!/usr/bin/env node
// 真实端到端验收：证明「会话续跑 + 接力」在两个真 Agent 上都成立。
//
//   第 1 轮：让它记住一个数字
//   第 2 轮：续跑同一会话问「刚才那个数字是多少」——答对即证明接力链路可用
//
// 结果落盘到 evidence/e2e-<时间戳>.json，作为可复查的证据（不是"我试过了"）。
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { getAdapter } from '../src/adapters/index.mjs';
import { runTurn } from '../src/core/runner.mjs';

const SECRET_NUMBER = '42';
const FIRST_PROMPT = `记住这个数字：${SECRET_NUMBER}。现在只回复两个字：收到。不要使用任何工具，不要读写任何文件。`;
const SECOND_PROMPT = '我刚才让你记住的数字是多少？只回复那个数字本身，不要解释。不要使用任何工具。';
const TIMEOUT_MS = 150000;

async function relayCheck(agentId) {
  const adapter = getAdapter(agentId);
  const steps = [];

  const first = await runTurn({
    adapter,
    prompt: FIRST_PROMPT,
    timeoutMs: TIMEOUT_MS,
    onEvent: (e) => process.stderr.write(`  [${agentId}/1] ${e.type}\n`),
  });
  steps.push({ step: 'turn1', ok: first.ok, sessionId: first.sessionId, text: first.text, error: first.error });

  if (!first.ok || !first.sessionId) {
    return { agent: agentId, ok: false, reason: '第一轮未产出可用会话', steps };
  }

  const second = await runTurn({
    adapter,
    prompt: SECOND_PROMPT,
    sessionId: first.sessionId,
    timeoutMs: TIMEOUT_MS,
    onEvent: (e) => process.stderr.write(`  [${agentId}/2] ${e.type}\n`),
  });
  steps.push({ step: 'turn2', ok: second.ok, sessionId: second.sessionId, text: second.text, error: second.error });

  const recalled = second.ok && second.text.includes(SECRET_NUMBER);
  return {
    agent: agentId,
    ok: first.ok && second.ok && recalled,
    recalled,
    sessionId: first.sessionId,
    steps,
  };
}

const results = [];
for (const agentId of process.argv.slice(2).length ? process.argv.slice(2) : ['dsh', 'codex']) {
  try {
    results.push(await relayCheck(agentId));
  } catch (err) {
    results.push({ agent: agentId, ok: false, reason: err.message, steps: [] });
  }
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const dir = path.resolve(process.cwd(), 'evidence');
await mkdir(dir, { recursive: true });
const file = path.join(dir, `e2e-${stamp}.json`);
await writeFile(
  file,
  `${JSON.stringify(
    {
      kind: 'relay-e2e',
      ranAt: new Date().toISOString(),
      node: process.version,
      platform: `${process.platform} ${process.arch}`,
      secretNumber: SECRET_NUMBER,
      results,
    },
    null,
    2,
  )}\n`,
);

console.log(JSON.stringify({ evidence: file, results }, null, 2));
process.exitCode = results.every((r) => r.ok) ? 0 : 1;
