// 中台 → 实板 的桥：状态变化时调用 tools/hidtool 把 Agent Status 帧写进板子。
//
// 为什么单独一层：编帧是纯逻辑（可单测），真正"发出去"要 spawn 一个原生工具，
// 而原生工具只在有板子时可用。把这两件事分开，测试就不需要插着板子跑。
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

/** 固件状态值 → hidtool 的命令行名字 */
export const BRIDGE_STATE_NAMES = {
  0: 'idle',
  1: 'running',
  2: 'waiting',
  3: 'ok',
  4: 'failed',
};

/**
 * @param {object} p
 * @param {string?} p.toolPath  hidtool 可执行文件；不存在则桥自动禁用
 * @param {boolean} p.enabled   开关（默认由 toolPath 是否存在决定）
 * @param {Function} p.spawnImpl 便于测试注入
 * @param {Function} p.log
 */
export function createBoardBridge({ toolPath = null, enabled = null, spawnImpl = spawn, log = () => {} } = {}) {
  const available = Boolean(toolPath && existsSync(toolPath));
  const active = enabled === null ? available : Boolean(enabled) && available;

  let lastPushed = null;

  return {
    enabled: active,
    reason: active ? 'ok' : toolPath ? `找不到 ${toolPath}` : '未配置工具路径',

    /** @returns {{pushed:boolean, stateName?:string, reason?:string}} */
    push(board) {
      if (!active) return { pushed: false, reason: this.reason };
      const stateName = BRIDGE_STATE_NAMES[board.state] ?? 'idle';
      const signature = `${stateName}:${board.sequence}`;
      if (signature === lastPushed) return { pushed: false, reason: 'duplicate' };

      try {
        const child = spawnImpl(
          toolPath,
          ['agent', stateName, String(board.sequence ?? 0), String(board.ttlMs ?? 0)],
          { stdio: 'ignore' },
        );
        child.on?.('error', (err) => log('bridge 调用失败', err.message));
        lastPushed = signature;
        log('bridge →', stateName, `seq=${board.sequence}`);
        return { pushed: true, stateName };
      } catch (err) {
        log('bridge 异常', err.message);
        return { pushed: false, reason: err.message };
      }
    },

    get lastSignature() {
      return lastPushed;
    },
  };
}
