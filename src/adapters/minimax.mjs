// MiniMax 适配器（走 mmx CLI 的 Messages API）
//
// 与另两个适配器的两个关键差异：
//   1. 输出是**整体**的多行 pretty-printed JSON → 用 parseOutput 而不是 parseLine；
//   2. 没有会话续跑能力（capabilities.resume = false）→ 中台会改用「历史片段」补上下文。
//
// prompt 通过 stdin 送一个 messages 数组，避免 argv 长度与转义问题：
//   [{"role":"user","content":"..."}]
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const CANDIDATES = [
  process.env.RELAYDECK_MMX_BIN,
  join(dirname(process.execPath), 'mmx'),
  join(homedir(), '.nvm', 'versions', 'node', process.version, 'bin', 'mmx'),
  '/usr/local/bin/mmx',
  '/opt/homebrew/bin/mmx',
].filter(Boolean);

export function mmxCommand() {
  // 显式覆盖必须生效（哪怕路径不存在）：否则配错了会悄悄回退到 PATH 上的另一个版本，
  // 排查起来毫无线索。
  if (process.env.RELAYDECK_MMX_BIN) return process.env.RELAYDECK_MMX_BIN;
  for (const candidate of CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  return 'mmx';
}

/** 把 mmx 的 Anthropic 风格响应转成中台事件 */
export function parseMmxOutput(stdout) {
  const text = String(stdout ?? '').trim();
  if (!text) return [{ type: 'error', message: 'mmx 没有任何输出', fatal: true }];

  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    // CLI 出错时打印的是人类可读文本（例如 "Error: s is not iterable"）
    const firstLine = text.split('\n').find((line) => line.trim()) ?? text;
    const isError = /^error[:\s]/i.test(firstLine) || /error/i.test(firstLine);
    return [{ type: isError ? 'error' : 'raw', message: firstLine, raw: text, fatal: isError }];
  }

  const events = [];
  const status = payload.base_resp?.status_code;
  if (typeof status === 'number' && status !== 0) {
    return [
      {
        type: 'error',
        message: `MiniMax 返回错误 ${status}：${payload.base_resp?.status_msg ?? '未知原因'}`,
        fatal: true,
      },
    ];
  }

  const body = Array.isArray(payload.content) ? payload.content : [];
  const reply = body
    .filter((part) => part?.type === 'text')
    .map((part) => part.text ?? '')
    .join('');

  if (reply) events.push({ type: 'text', text: reply });
  if (payload.usage) events.push({ type: 'usage', usage: payload.usage });
  events.push({ type: 'turn.end', reason: payload.stop_reason ?? 'completed' });
  if (reply) events.push({ type: 'final', text: reply });
  return events;
}

export const minimaxAdapter = {
  id: 'minimax',
  label: 'MiniMax',
  capabilities: { resume: false, streaming: false, tools: false },

  command: mmxCommand,

  buildArgs() {
    const args = ['text', 'chat', '--messages-file', '-', '--output', 'json', '--non-interactive'];
    const model = process.env.RELAYDECK_MMX_MODEL;
    if (model) args.splice(2, 0, '--model', model);
    return args;
  },

  stdinPayload(prompt) {
    return JSON.stringify([{ role: 'user', content: prompt }]);
  },

  parseOutput(stdout) {
    return parseMmxOutput(stdout);
  },
};
