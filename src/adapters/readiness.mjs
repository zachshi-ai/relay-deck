// 适配器就绪自检：启动时就说清"哪几家真能用"。
//
// 为什么需要：某家 CLI 没装好 / 路径配错时，现在只有在真正发请求的那一刻才炸，
// 而且错误藏在一次失败的轮次里。启动时先查一遍，对使用者友好得多。
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

/** 在 PATH 上找命令（找不到返回空串） */
export function whichCommand(command, { exec = execFileSync } = {}) {
  try {
    return String(exec('which', [command], { encoding: 'utf8' })).trim();
  } catch {
    return '';
  }
}

/**
 * @param {Array} adapters
 * @param {object} deps 便于测试注入
 * @returns {Array<{id,label,command,available,note}>}
 */
export function inspectAdapters(adapters, { exists = existsSync, which = whichCommand } = {}) {
  return adapters.map((adapter) => {
    const command = adapter.command();
    const isAbsolute = command.startsWith('/');
    const available = isAbsolute ? exists(command) : Boolean(which(command));
    let note = null;
    if (!available) {
      note = isAbsolute ? `找不到文件：${command}` : `PATH 上没有 ${command}`;
    }
    return { id: adapter.id, label: adapter.label, command, available, note };
  });
}

/** 一行摘要，供启动日志与 /api/state 使用 */
export function readinessSummary(reports) {
  const missing = reports.filter((r) => !r.available);
  return {
    ready: reports.length - missing.length,
    total: reports.length,
    missing: missing.map((r) => ({ id: r.id, note: r.note })),
  };
}

/** 启动日志用的多行表格 */
export function formatReadiness(reports) {
  return reports
    .map((r) => `  ${r.available ? '✓' : '✗'} ${r.id.padEnd(8)} ${r.command}${r.note ? `  ← ${r.note}` : ''}`)
    .join('\n');
}
