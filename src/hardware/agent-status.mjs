// 板载 LED 状态回传：复用固件**已经存在**的 Agent Status 协议 v1，而不是自己造一套。
//
// 事实来源（easy-input-maker 仓库）：
//   - 协议定义：components/keyboard/include/keyboard/agent_status.h
//     16 字节：version(1) | state(1) | flags(1) | reserved(1) | sequence(u32 LE)
//              | ttl_ms(u32 LE) | source_hash(u32 LE)
//   - USB HID：report ID 已声明为 0x12（main/platform/usb_hid.cpp 的 report descriptor）
//   - BLE：存在 agent status 写入句柄（main/platform/ble_hid.cpp 的 s_agent_status_write_handle）
//   - 状态 → 灯色：main/platform/led_strip_status.cpp 的 agent_status_color()
//
// 也就是说：**灯效通道不需要改固件**，主机侧只要按这个格式发 16 字节即可。
// 这里的编码规则与固件解码端保持一致（含 TTL 上限与 Idle 归零），
// 保证"我们发出去的"就是"固件理解的"。

export const AGENT_STATUS_REPORT_ID = 0x12;
export const AGENT_STATUS_PROTOCOL_VERSION = 1;
export const AGENT_STATUS_PAYLOAD_LEN = 16;
export const AGENT_STATUS_MAX_TTL_MS = 12 * 60 * 60 * 1000; // 固件上限 12 小时

/** 与固件 AgentStatusState 一一对应（数值必须一致） */
export const AGENT_STATUS_STATES = {
  Idle: 0,
  Running: 1,
  WaitingUser: 2,
  CompletedUnread: 3,
  Failed: 4,
};

/** 固件侧 agent_status_color() 的配色，供界面/文档对照 */
export const AGENT_STATUS_COLORS = {
  0: [0, 0, 0], // Idle：熄灭
  1: [0, 0, 28], // Running：暗蓝
  2: [30, 12, 0], // WaitingUser：琥珀
  3: [0, 24, 5], // CompletedUnread：绿
  4: [30, 0, 8], // Failed：红
};

/** 状态名，便于日志与界面显示 */
export const AGENT_STATUS_NAMES = Object.freeze(
  Object.fromEntries(Object.entries(AGENT_STATUS_STATES).map(([name, value]) => [value, name])),
);

function writeU32Le(view, offset, value) {
  const v = Number(value) >>> 0;
  view[offset + 0] = v & 0xff;
  view[offset + 1] = (v >>> 8) & 0xff;
  view[offset + 2] = (v >>> 16) & 0xff;
  view[offset + 3] = (v >>> 24) & 0xff;
}

function readU32Le(view, offset) {
  return (
    (view[offset] | (view[offset + 1] << 8) | (view[offset + 2] << 16) | (view[offset + 3] << 24)) >>> 0
  );
}

/**
 * @param {object} p
 * @param {number} p.state       AGENT_STATUS_STATES 里的值
 * @param {number} [p.flags]
 * @param {number} [p.sequence]
 * @param {number} [p.ttlMs]     存活时间；会被夹到固件上限，且 Idle 时按固件规则归零
 * @param {number} [p.sourceHash] 来源标识（例如会话 id 的哈希），让板子能区分不同来源
 * @returns {Uint8Array} 16 字节载荷
 */
export function encodeAgentStatus({ state, flags = 0, sequence = 0, ttlMs = 0, sourceHash = 0 } = {}) {
  if (!Number.isInteger(state) || state < 0 || state > AGENT_STATUS_STATES.Failed) {
    throw new Error(`非法的 AgentStatusState：${state}`);
  }
  const bytes = new Uint8Array(AGENT_STATUS_PAYLOAD_LEN);
  bytes[0] = AGENT_STATUS_PROTOCOL_VERSION;
  bytes[1] = state;
  bytes[2] = flags & 0xff;
  bytes[3] = 0; // reserved
  writeU32Le(bytes, 4, sequence);
  // 与固件解码端一致：TTL 上限夹紧；Idle 归零（等于"清除状态"）
  const clamped = Math.min(Math.max(Number(ttlMs) || 0, 0), AGENT_STATUS_MAX_TTL_MS);
  writeU32Le(bytes, 8, state === AGENT_STATUS_STATES.Idle ? 0 : clamped);
  writeU32Le(bytes, 12, sourceHash);
  return bytes;
}

/** 按固件规则解码（非法输入返回 null），用于回环测试与诊断 */
export function decodeAgentStatus(bytes) {
  if (!bytes || bytes.length < AGENT_STATUS_PAYLOAD_LEN) return null;
  if (bytes[0] !== AGENT_STATUS_PROTOCOL_VERSION) return null;
  if (bytes[1] > AGENT_STATUS_STATES.Failed) return null;
  const state = bytes[1];
  let ttlMs = readU32Le(bytes, 8);
  if (ttlMs > AGENT_STATUS_MAX_TTL_MS) ttlMs = AGENT_STATUS_MAX_TTL_MS;
  if (state === AGENT_STATUS_STATES.Idle) ttlMs = 0;
  return {
    version: bytes[0],
    state,
    flags: bytes[2],
    sequence: readU32Le(bytes, 4),
    ttlMs,
    sourceHash: readU32Le(bytes, 12),
  };
}

/**
 * 中台的轮次状态 → 板上状态。
 * @param {object} p
 * @param {string} p.runStatus  'idle' | 'running' | 'ok' | 'error' | 'waiting'
 * @param {boolean} [p.acknowledged] 结果是否已被用户看到；未看到时用 CompletedUnread（绿灯等你）
 */
export function mapRunStatusToAgentState({ runStatus = 'idle', acknowledged = false } = {}) {
  switch (runStatus) {
    case 'running':
      return AGENT_STATUS_STATES.Running;
    case 'error':
      return AGENT_STATUS_STATES.Failed;
    case 'ok':
      return acknowledged ? AGENT_STATUS_STATES.Idle : AGENT_STATUS_STATES.CompletedUnread;
    case 'waiting':
      return AGENT_STATUS_STATES.WaitingUser;
    default:
      return AGENT_STATUS_STATES.Idle;
  }
}

/**
 * 聚合：板子的 Agent Status **一次只显示一个状态**（后到的覆盖先到的，
 * 且以径向渐变铺满 5 颗灯）。所以主机侧必须先决定"现在最该让用户看到哪一件事"。
 *
 * 优先级：在跑 > 失败 > 有结果未读 > 在等用户 > 空闲。
 * 理由：跑着的不能被打断；失败最需要被看到；结果未读次之；空闲说明一切正常。
 *
 * @param {object} p
 * @param {string[]|Record<string,string>} p.runStatuses 各 Agent 的轮次状态
 */
export function aggregateAgentStatus({ runStatuses = [], acknowledged = false } = {}) {
  const statuses = Array.isArray(runStatuses) ? runStatuses : Object.values(runStatuses);
  if (statuses.includes('running')) return AGENT_STATUS_STATES.Running;
  if (statuses.includes('error')) return AGENT_STATUS_STATES.Failed;
  if (!acknowledged && statuses.includes('ok')) return AGENT_STATUS_STATES.CompletedUnread;
  if (statuses.includes('waiting')) return AGENT_STATUS_STATES.WaitingUser;
  return AGENT_STATUS_STATES.Idle;
}

/** 稳定的 32 位来源哈希（FNV-1a）：同一个会话/Agent 永远得到同一个值 */
export function sourceHash(text) {
  let hash = 0x811c9dc5;
  const value = String(text ?? '');
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** 序号比较：与固件的 agent_status_sequence_is_newer 语义一致（按 int32 回绕比较） */
export function sequenceIsNewer(candidate, baseline) {
  return candidate !== baseline && ((candidate - baseline) | 0) > 0;
}

/**
 * 起始序号：从"当前时间秒数"起算，而不是从 0 起算。
 *
 * 准确语义（重读过固件的 take_pending_agent_status —— 它是**消费型**的）：
 *   - 只有 USB 一路有帧挂起时，`!pending` 成立 → **一定生效，与序号无关**；
 *   - 只有当 BLE 与 USB 在**同一轮循环里都挂着待处理帧**时，才比较序号，
 *     此时 `agent_status_sequence_is_newer(usb.seq, ble.seq)` 为假的那一帧被丢弃。
 *
 * 也就是说竞争窗口很窄，但确实存在。桌面 App 的序号从 0 起算，中台若也从 0 起算，
 * 就有概率在这个窄窗口里输掉、那一帧被静默丢弃（现象：灯偶尔不跟着中台走）。
 * 从纪元起步可以让中台**天生赢下这个比较**，代价只是序号大一些。
 */
export function epochSequence(now = Date.now()) {
  return Math.floor(now / 1000) & 0x3fff_ffff;
}

/**
 * 生成"要发给板子的一帧"：把 LED 真值表与 board 状态合起来，方便主机侧直接发。
 * @returns {{reportId:number, payload:Uint8Array, state:number, sequence:number, sourceHash:number, color:number[]}}
 */
export function buildAgentStatusFrame({ runStatus, conversationId = '', agentId = '', sequence = 0, ttlMs = 60000 } = {}) {
  const state = mapRunStatusToAgentState({ runStatus });
  const hash = sourceHash(`${conversationId}::${agentId}`);
  const payload = encodeAgentStatus({ state, sequence, ttlMs, sourceHash: hash });
  return {
    reportId: AGENT_STATUS_REPORT_ID,
    payload,
    state,
    stateName: AGENT_STATUS_NAMES[state],
    sequence,
    sourceHash: hash,
    color: AGENT_STATUS_COLORS[state],
  };
}

/**
 * 板级聚合帧：这是阶段 2b **真正要发给板子**的东西。
 *
 * 与 buildAgentStatusFrame 的区别：那个是"某个 Agent 的状态"，这个是把所有 Agent
 * 收敛成一件最该被看到的事——因为板子一次只渲染一个状态。
 *
 * 注意固件会丢弃**完全相同**的帧（state/flags/sequence/ttl/source 全同），
 * 所以只在状态变化时递增 sequence 即可；不变时重复发送等于刷新 TTL，是安全的。
 */
export function buildBoardStatus({
  runStatuses = [],
  acknowledged = false,
  conversationId = '',
  sequence = epochSequence(),
  ttlMs = 10 * 60 * 1000,
} = {}) {
  const state = aggregateAgentStatus({ runStatuses, acknowledged });
  const hash = sourceHash(`relaydeck:${conversationId}`);
  const payload = encodeAgentStatus({ state, sequence, ttlMs, sourceHash: hash });
  return {
    reportId: AGENT_STATUS_REPORT_ID,
    payload: [...payload],
    state,
    stateName: AGENT_STATUS_NAMES[state],
    color: AGENT_STATUS_COLORS[state],
    sequence,
    ttlMs: state === AGENT_STATUS_STATES.Idle ? 0 : ttlMs,
    sourceHash: hash,
  };
}
