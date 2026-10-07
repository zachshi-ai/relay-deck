// Codex 适配器
// 原生输出：`codex exec --json` 的 JSONL 事件流
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

const CANDIDATES = [
  process.env.RELAYDECK_CODEX_BIN,
  join(dirname(process.execPath), 'codex'), // 与 node 同 bin 目录（nvm 场景）
  '/usr/local/bin/codex',
  '/opt/homebrew/bin/codex',
].filter(Boolean);

export function codexCommand() {
  // 显式覆盖必须生效（哪怕路径不存在），否则配错会被静默回退掩盖
  if (process.env.RELAYDECK_CODEX_BIN) return process.env.RELAYDECK_CODEX_BIN;
  for (const candidate of CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  return 'codex';
}

export const codexAdapter = {
  id: 'codex',
  label: 'Codex',
  capabilities: { resume: true, streaming: true, tools: true },

  command: codexCommand,

  buildArgs({ sessionId, cwd, sandbox = 'read-only' } = {}) {
    // 注意（实测）：`codex exec resume` 不接受 --sandbox / -C，选项必须排在
    // 会话 id 之前，用法是 `codex exec resume [OPTIONS] [SESSION_ID] [PROMPT]`。
    if (sessionId) {
      return [
        'exec',
        'resume',
        '--json',
        '--skip-git-repo-check',
        '-c',
        `sandbox_mode="${sandbox}"`,
        sessionId,
        '-',
      ];
    }
    const args = ['exec', '--json', '--skip-git-repo-check', '--sandbox', sandbox];
    if (cwd) args.push('-C', cwd);
    args.push('-');
    return args;
  },

  parseLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return [];

    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      // Codex 的告警与错误也可能出现在 stdout/stderr，原文透传
      return [{ type: 'raw', raw: trimmed }];
    }

    switch (obj.type) {
      case 'thread.started':
        return [{ type: 'session.started', sessionId: obj.thread_id }];
      case 'turn.started':
        return [{ type: 'status', phase: 'turn_start' }];
      case 'turn.completed':
        return [
          ...(obj.usage ? [{ type: 'usage', usage: obj.usage }] : []),
          { type: 'turn.end', reason: 'completed' },
        ];
      case 'turn.failed':
        // 整轮失败，才是致命错误
        return [{ type: 'error', message: obj.error?.message ?? 'turn failed', fatal: true }];
      case 'item.completed':
      case 'item.updated': {
        const item = obj.item ?? {};
        switch (item.type) {
          case 'agent_message':
            return item.text ? [{ type: 'text', text: item.text }] : [];
          case 'reasoning':
            return item.text ? [{ type: 'thinking', text: item.text }] : [];
          case 'error':
            // 条目级 error 常常只是「开发中功能已启用」这类警告，不中止本轮。
            // 实测：这条警告曾让一次正常回答（"收到"）被误判为失败。
            return [{ type: 'error', message: item.message ?? 'item error', fatal: false }];
          default:
            return [{ type: 'raw', raw: item }];
        }
      }
      case 'error':
        return [{ type: 'error', message: obj.message ?? trimmed, fatal: true }];
      default:
        return [{ type: 'raw', raw: obj }];
    }
  },
};
