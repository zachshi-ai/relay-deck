// 硬件输入 → 中台命令 的映射层（纯逻辑，可单测）。
//
// 存在的理由：物理输入有两条通路，语义必须只有一套。
//   1. HID 通路（阶段 2a）：板子模拟键盘发组合键，靠全局监听接住，零固件改动；
//   2. 结构化通路（阶段 2b）：板子通过 BLE/Host Action 直接发 {action}，不看前台焦点。
// 两条路都先过这里，再落到同一组中台命令上。

/** 默认硬件手势映射：按键 = 发送（接力），旋钮 = 查看（不发送） */
export const DEFAULT_HARDWARE_KEYMAP = {
  keys: {
    S1: { press: { type: 'relay', slot: 0 } },
    S2: { press: { type: 'relay', slot: 1 } },
    S3: { press: { type: 'relay', slot: 2 } },
    S4: { press: { type: 'relay', slot: 3 } },
    S5: { press: { type: 'relay', slot: 4 } },
    S6: { press: { type: 'focus.clear' } },
    S7: { press: { type: 'focus.copy' } },
    S8: { press: { type: 'roundtable' } },
  },
  encoder: {
    rotate: { type: 'focus.move' },
    press: { type: 'view.cycle' },
    longPress: { type: 'config.enter' },
  },
};

/** 板子用 HID 组合键当控制通道时，约定这一组组合键（macOS 上默认不占用） */
export const DEFAULT_HID_KEYMAP = {
  'alt+meta+digit1': { type: 'relay', slot: 0 },
  'alt+meta+digit2': { type: 'relay', slot: 1 },
  'alt+meta+digit3': { type: 'relay', slot: 2 },
  'alt+meta+digit4': { type: 'relay', slot: 3 },
  'alt+meta+digit5': { type: 'relay', slot: 4 },
  'alt+meta+arrowleft': { type: 'focus.move', delta: -1 },
  'alt+meta+arrowright': { type: 'focus.move', delta: 1 },
  'alt+meta+keyc': { type: 'focus.copy' },
  'alt+meta+keyb': { type: 'roundtable' },
  'alt+meta+escape': { type: 'focus.clear' },
};

const MODIFIER_ORDER = ['ctrl', 'alt', 'shift', 'meta'];

/** 组合键归一化：忽略大小写与修饰键顺序，'Cmd+Alt+1' 与 'alt+meta+digit1' 等价 */
export function normalizeCombo(combo) {
  const parts = String(combo ?? '')
    .split('+')
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  const modifiers = [];
  const keys = [];
  for (const part of parts) {
    const alias = { cmd: 'meta', command: 'meta', option: 'alt', control: 'ctrl', opt: 'alt' }[part] ?? part;
    if (MODIFIER_ORDER.includes(alias)) modifiers.push(alias);
    else keys.push(normalizeKeyName(alias));
  }
  modifiers.sort((a, b) => MODIFIER_ORDER.indexOf(a) - MODIFIER_ORDER.indexOf(b));
  // 与键盘事件命名（KeyboardEvent.code）对齐：'1'→'digit1'、'c'→'keyc'
  const normalizedKeys = keys.map((k) => {
    if (/^[1-9]$/.test(k)) return `digit${k}`;
    if (/^[a-z]$/.test(k)) return `key${k}`;
    return k;
  });
  return [...modifiers, ...normalizedKeys].join('+');
}

function normalizeKeyName(key) {
  const named = { left: 'arrowleft', right: 'arrowright', up: 'arrowup', down: 'arrowdown', esc: 'escape' };
  return named[key] ?? key;
}

function withSlotBounds(command, agentCount) {
  if (command.type === 'relay' && command.slot >= agentCount) {
    return {
      type: 'error',
      code: 'slot-out-of-range',
      message: `按下的是第 ${command.slot + 1} 个接力位，但当前只接了 ${agentCount} 个 Agent`,
    };
  }
  return command;
}

/**
 * 解析物理硬件事件。
 * @param {{source:'key'|'encoder', id?:string, gesture?:string, delta?:number, phase?:number}} event
 */
export function resolveHardwareEvent(event, { keymap = DEFAULT_HARDWARE_KEYMAP, agentCount = 0, blinkPhase = 0 } = {}) {
  if (!event || typeof event !== 'object') return null;

  if (event.source === 'key') {
    const binding = keymap.keys?.[event.id]?.[event.gesture ?? 'press'];
    return binding ? withSlotBounds({ ...binding }, agentCount) : null;
  }

  if (event.source === 'encoder') {
    if (event.gesture === 'rotate') {
      const binding = keymap.encoder?.rotate;
      if (!binding) return null;
      const delta = Number(event.delta ?? 0);
      if (!delta) return null;
      return { ...binding, delta: Math.sign(delta) * Math.abs(delta) };
    }
    const binding = keymap.encoder?.[event.gesture];
    return binding ? { ...binding } : null;
  }

  return null;
}

/** 解析 HID 组合键（全局监听通路） */
export function resolveHidCombo(combo, { keymap = DEFAULT_HID_KEYMAP, agentCount = 0 } = {}) {
  const binding = keymap[normalizeCombo(combo)];
  return binding ? withSlotBounds({ ...binding }, agentCount) : null;
}

/** 命令 → 人话（日志与界面提示共用） */
export function describeCommand(command) {
  if (!command) return '无动作';
  switch (command.type) {
    case 'relay':
      return `接力给第 ${command.slot + 1} 个 Agent`;
    case 'focus.move':
      return command.delta > 0 ? '焦点下一句' : '焦点上一句';
    case 'focus.copy':
      return '复制焦点句';
    case 'focus.clear':
      return '清空焦点';
    case 'view.cycle':
      return '切换查看的 Agent';
    case 'roundtable':
      return '拉群并汇总';
    case 'config.enter':
      return '进入配置模式（长按）';
    case 'noop':
      return command.note ? `预留：${command.note}` : '预留按键';
    case 'error':
      return `无效动作：${command.message}`;
    default:
      return `未知命令 ${command.type}`;
  }
}
