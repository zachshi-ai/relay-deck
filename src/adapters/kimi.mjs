// Kimi 适配器（走 Kimi 桌面版内置的 daimon runner）
//
// 两个特殊点：
//   1. 它是常驻型 runner：正文必须走 --prompt（argv），stdin 是它的控制命令通道；
//   2. 日志与回答**都在 stdout**：需要按日志前缀过滤，只留回答文本。
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const BUNDLE_DIR = '/Applications/Kimi.app/Contents/Resources/resources/daimon-bundle';

const CANDIDATES = [process.env.RELAYDECK_KIMI_BIN, join(BUNDLE_DIR, 'bin', 'kimi-daimon')].filter(Boolean);

export function kimiCommand() {
  // 显式覆盖必须生效（哪怕路径不存在），否则配错会被静默回退掩盖
  if (process.env.RELAYDECK_KIMI_BIN) return process.env.RELAYDECK_KIMI_BIN;
  for (const candidate of CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  return 'kimi-daimon';
}

/** 桌面版与 CLI 共用的一套 daimon 配置（含凭据），必须显式指过去 */
export function kimiConfigPath() {
  return (
    process.env.RELAYDECK_KIMI_CONFIG ??
    join(homedir(), 'Library', 'Application Support', 'kimi-desktop', 'daimon-share', 'daimon', 'config.json')
  );
}

const LOG_LINE = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s+(TRACE|DEBUG|INFO|WARN|ERROR|FATAL)\s/;

/** 从「日志 + 回答混在 stdout」里挑出回答 */
export function parseKimiOutput(stdout) {
  const lines = String(stdout ?? '').split('\n');
  const kept = [];
  const logs = [];
  for (const line of lines) {
    if (LOG_LINE.test(line)) logs.push(line);
    else kept.push(line);
  }

  const reply = kept.join('\n').trim();
  if (!reply) {
    const errorLog = logs.find((line) => /\s(ERROR|FATAL)\s/.test(line)) ?? logs.at(-1) ?? '';
    return [
      {
        type: 'error',
        message: errorLog ? errorLog.replace(LOG_LINE, '').slice(0, 300) : 'kimi 没有产出回答文本',
        fatal: true,
      },
    ];
  }

  return [
    { type: 'text', text: reply },
    { type: 'final', text: reply },
    { type: 'turn.end', reason: 'completed' },
  ];
}

export const kimiAdapter = {
  id: 'kimi',
  label: 'Kimi',
  // daimon 支持 --session <conversation-key>，但输出里拿不到稳定的会话键，
  // 因此这里声明不支持续跑，由中台补历史（与 minimax 同一条兜底路径）。
  capabilities: { resume: false, streaming: false, tools: true },

  promptChannel: 'argv',
  command: kimiCommand,
  env: () => ({ DAIMON_CONFIG_PATH: kimiConfigPath() }),

  buildArgs({ prompt }) {
    return ['--node', process.execPath, '--prompt', prompt];
  },

  parseOutput(stdout) {
    return parseKimiOutput(stdout);
  },
};
