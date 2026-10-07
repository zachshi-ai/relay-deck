// LED 状态回传：把中台状态编码成板上 5 颗 WS2812 的可读状态。
//
// 真值表（刻意的设计，不是随便点灯）：
//   LED0        链路/轮次灯：熄=无会话 · 绿=空闲 · 黄呼吸=有轮次在跑 · 红=最近一轮失败
//   LED1–4      前 4 个 Agent 的灯：熄=没跑过 · 低亮主题色=空闲 · 满亮主题色=正在跑 · 红=失败
//   焦点指示    焦点句所属 Agent 的那颗灯与白点交替（blinkPhase）
// >4 个 Agent 时用 windowStart 做窗口滑动。
//
// 为什么用这套：硬件只有 5 颗灯，要表达「谁在跑 / 谁失败 / 我在看谁」三件事，
// 必须让"位置"承载身份、"亮度"承载状态、"颜色"承载归属，否则就是一团乱。

export const AGENT_PALETTE = ['#4cc2ff', '#c792ea', '#7ee787', '#ffa657', '#f778ba'];

export const LED_ROLES = ['link', 'agent1', 'agent2', 'agent3', 'agent4'];

export const LINK_COLORS = {
  offline: [0, 0, 0],
  idle: [60, 90, 70],
  session: [0, 120, 60],
  running: [200, 150, 0],
  error: [200, 0, 0],
};

function hexToRgb(hex) {
  const value = hex.replace('#', '');
  return [parseInt(value.slice(0, 2), 16), parseInt(value.slice(2, 4), 16), parseInt(value.slice(4, 6), 16)];
}

function scale(rgb, factor) {
  return rgb.map((c) => Math.max(0, Math.min(255, Math.round(c * factor))));
}

/**
 * @param {object} p
 * @param {string[]} p.agentIds      已注册 Agent 的顺序（决定第 N 颗灯对应谁）
 * @param {object}   p.runStatus     agentId → 'idle' | 'running' | 'ok' | 'error'
 * @param {number}   p.windowStart   窗口起点，Agent 多于 4 个时滑动
 * @param {number}   p.viewIndex     当前查看的 Agent 序号
 * @param {string?}  p.focusAgentId  焦点句所属 Agent
 * @param {boolean}  p.hasSession    当前会话是否已有 Agent 会话
 * @param {number}   p.blinkPhase    0/1，由调用方翻转，用于交替效果
 */
export function computeLedState({
  agentIds = [],
  runStatus = {},
  windowStart = 0,
  viewIndex = 0,
  focusAgentId = null,
  hasSession = false,
  cancellationRequested = false,
  blinkPhase = 0,
} = {}) {
  const anyRunning = agentIds.some((id) => runStatus[id] === 'running');
  const anyError = agentIds.some((id) => runStatus[id] === 'error');

  // LED0：链路/轮次
  let link = { color: LINK_COLORS.offline, effect: 'off' };
  if (anyRunning) link = { color: LINK_COLORS.running, effect: 'pulse' };
  else if (anyError) link = { color: LINK_COLORS.error, effect: 'solid' };
  else if (hasSession) link = { color: LINK_COLORS.session, effect: 'solid' };
  else if (agentIds.length) link = { color: LINK_COLORS.idle, effect: 'dim' };

  const pixels = [
    {
      index: 0,
      role: 'link',
      agentId: null,
      color: link.color,
      effect: link.effect,
      rgb: link.color,
    },
  ];

  for (let offset = 0; offset < 4; offset += 1) {
    const slot = windowStart + offset;
    const agentId = agentIds[slot] ?? null;
    const base = agentId ? hexToRgb(AGENT_PALETTE[slot % AGENT_PALETTE.length]) : [0, 0, 0];
    const status = agentId ? (runStatus[agentId] ?? 'idle') : 'none';
    const isFocused = Boolean(agentId && agentId === focusAgentId);
    const isViewed = slot === viewIndex;

    // 「我在看谁」必须能从灯上看出来，否则这块板子在多 Agent 场景下就是瞎的。
    // 规则：被查看的那颗灯在同状态下更亮（而不是换颜色，避免和状态色打架）。
    const viewBoost = isViewed ? 1.35 : 1;

    let rgb = [0, 0, 0];
    let effect = 'off';
    if (status === 'running') {
      rgb = scale(base, 1);
      effect = 'pulse';
    } else if (status === 'error') {
      rgb = scale(LINK_COLORS.error, 1);
      effect = 'solid';
    } else if (status === 'ok') {
      rgb = scale(base, 0.65 * viewBoost);
      effect = isViewed ? 'solid-viewed' : 'solid';
    } else if (status === 'idle' && agentId) {
      rgb = scale(base, 0.18 * viewBoost);
      effect = isViewed ? 'dim-viewed' : 'dim';
    }

    if (isFocused && blinkPhase % 2 === 1) {
      // 焦点句轮流到这颗灯：闪白，和「我在看谁」区分开
      rgb = [255, 255, 255];
      effect = 'focus-blink';
    }

    pixels.push({
      index: offset + 1,
      role: LED_ROLES[offset + 1],
      agentId,
      color: agentId ? AGENT_PALETTE[slot % AGENT_PALETTE.length] : null,
      status,
      effect,
      viewed: isViewed,
      focused: isFocused,
      rgb,
    });
  }

  return {
    blinkPhase,
    anyRunning,
    anyError,
    viewIndex,
    windowStart,
    cancellationRequested,
    pixels,
  };
}

/** 转换成板子要的 WS2812 帧：5 像素、每像素 GRB、共 15 字节 */
export function toWs2812Frame(ledState) {
  const frame = new Uint8Array(15);
  ledState.pixels.forEach((pixel, index) => {
    const [r, g, b] = pixel.rgb;
    frame[index * 3 + 0] = g;
    frame[index * 3 + 1] = r;
    frame[index * 3 + 2] = b;
  });
  return frame;
}

/** 供调试与快照使用：把帧表示成每颗灯的十六进制 */
export function frameToHex(frame) {
  return [...frame].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 人话摘要，日志与硬件自检共用 */
export function describeLedState(ledState) {
  return ledState.pixels
    .map((p) => `${p.role}:${p.agentId ?? '-'}/${p.status ?? p.effect}`)
    .join(' ');
}
