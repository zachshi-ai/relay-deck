#!/usr/bin/env node
// RelayDeck CLI —— 阶段 1 的最小可用入口，用来在没打开网页时验证中台核心。
//
//   node bin/relay.mjs agents
//   node bin/relay.mjs ask dsh "只输出 OK"
//   node bin/relay.mjs ask codex "只输出 OK" --cwd /tmp
//   node bin/relay.mjs ask dsh "继续" --session session-xxxx
//   node bin/relay.mjs ask dsh "..." --json      # 输出归一化事件 NDJSON
import process from 'node:process';
import { ADAPTERS, getAdapter } from '../src/adapters/index.mjs';
import { runTurn, describeEvent } from '../src/core/runner.mjs';

function parseFlags(argv) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--json') flags.json = true;
    else if (token === '--session') flags.session = argv[++i];
    else if (token === '--cwd') flags.cwd = argv[++i];
    else if (token === '--timeout') flags.timeout = Number(argv[++i]);
    else rest.push(token);
  }
  return { flags, rest };
}

async function main() {
  const [command, ...argv] = process.argv.slice(2);
  const { flags, rest } = parseFlags(argv);

  if (!command || command === 'help' || command === '--help') {
    console.log(`RelayDeck CLI

  agents                            列出已注册的 Agent
  ask <agent> "<prompt>" [选项]      向某个 Agent 发一轮

选项
  --session <id>   续跑指定会话
  --cwd <dir>      子进程工作目录（默认当前目录）
  --timeout <ms>   超时（默认 180000）
  --json           输出归一化事件 NDJSON，而不是人读格式`);
    return;
  }

  if (command === 'agents') {
    for (const adapter of ADAPTERS) {
      console.log(`${adapter.id.padEnd(8)} ${adapter.label.padEnd(20)} ${adapter.command()}`);
    }
    return;
  }

  if (command !== 'ask') {
    console.error(`未知命令：${command}（可用：agents / ask）`);
    process.exitCode = 2;
    return;
  }

  const [agentId, ...promptParts] = rest;
  const prompt = promptParts.join(' ');
  if (!agentId || !prompt) {
    console.error('用法：relay ask <agent> "<prompt>"');
    process.exitCode = 2;
    return;
  }

  const adapter = getAdapter(agentId);
  const started = Date.now();

  const result = await runTurn({
    adapter,
    prompt,
    sessionId: flags.session ?? null,
    cwd: flags.cwd ?? process.cwd(),
    timeoutMs: flags.timeout ?? 180000,
    onEvent: (event) => {
      if (flags.json) console.log(JSON.stringify(event));
      else process.stderr.write(`  ${describeEvent(event)}\n`);
    },
  });

  if (!flags.json) {
    console.log('---');
    console.log(result.text || '(无输出)');
  }

  console.error(
    `[relay] agent=${result.agent} ok=${result.ok} session=${result.sessionId ?? '-'} ` +
      `elapsed=${Date.now() - started}ms exit=${result.exitCode}` +
      (result.error ? ` error=${result.error}` : ''),
  );

  if (!result.ok) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`[relay] 失败：${err.message}`);
  process.exitCode = 1;
});
