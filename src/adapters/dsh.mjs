// DeepSeek Harness 适配器
// 原生输出：`dsh --profile headless --json` 的 NDJSON 事件流
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CANDIDATES = [
  process.env.RELAYDECK_DSH_BIN,
  '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh',
  join(homedir(), '.dsh', 'bin', 'dsh'),
  '/usr/local/bin/dsh',
  '/opt/homebrew/bin/dsh',
].filter(Boolean);

export function dshCommand() {
  // 显式覆盖必须生效（哪怕路径不存在），否则配错会被静默回退掩盖
  if (process.env.RELAYDECK_DSH_BIN) return process.env.RELAYDECK_DSH_BIN;
  for (const candidate of CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  return 'dsh';
}

export const dshAdapter = {
  id: 'dsh',
  label: 'DeepSeek Harness',
  capabilities: { resume: true, streaming: true, tools: true },

  command: dshCommand,

  buildArgs({ sessionId } = {}) {
    const args = ['--profile', 'headless', '--json'];
    if (sessionId) args.push('--session-id', sessionId);
    // `-` 让任务从 stdin 读，避免 argv 长度与转义问题
    args.push('-');
    return args;
  },

  /** 一行原生输出 → 归一化事件数组 */
  parseLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return [];

    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      return [{ type: 'raw', raw: trimmed }];
    }

    switch (obj.type) {
      case 'session':
        return [{ type: 'session.started', sessionId: obj.sessionId, cwd: obj.cwd }];
      case 'thinking':
        return obj.text ? [{ type: 'thinking', text: obj.text }] : [];
      case 'text':
        return obj.text ? [{ type: 'text', text: obj.text }] : [];
      case 'final':
        return [{ type: 'final', text: obj.text ?? '' }];
      case 'status': {
        const out = [];
        if (obj.usage) out.push({ type: 'usage', usage: obj.usage });
        if (obj.phase === 'turn_end') {
          out.push({ type: 'turn.end', reason: obj.reason ?? null });
        } else if (obj.phase) {
          out.push({ type: 'status', phase: obj.phase });
        }
        return out;
      }
      case 'error':
        // dsh 的 error 事件代表本轮出现问题，按致命处理；纯警告不会走这个类型
        return [{ type: 'error', message: obj.message ?? trimmed, fatal: true }];
      default:
        // 版本变化时未知事件不丢弃
        return [{ type: 'raw', raw: obj }];
    }
  },
};
