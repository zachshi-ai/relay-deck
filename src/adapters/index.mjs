import { dshAdapter } from './dsh.mjs';
import { codexAdapter } from './codex.mjs';
import { minimaxAdapter } from './minimax.mjs';
import { kimiAdapter } from './kimi.mjs';

// ZCode 暂未注册：它的无头 CLI 需要 CLI 侧登录态（详见 docs/agent-onboarding.md）
export const ADAPTERS = [dshAdapter, codexAdapter, minimaxAdapter, kimiAdapter];

export function getAdapter(id) {
  const adapter = ADAPTERS.find((a) => a.id === id);
  if (!adapter) {
    const known = ADAPTERS.map((a) => a.id).join(', ');
    throw new Error(`未知 Agent：${id}（已注册：${known}）`);
  }
  return adapter;
}

export { dshAdapter, codexAdapter, minimaxAdapter, kimiAdapter };
