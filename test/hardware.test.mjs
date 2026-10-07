// 硬件协议层单测：手势映射、边界、组合键归一化、LED 真值表与 WS2812 帧
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveHardwareEvent,
  resolveHidCombo,
  normalizeCombo,
  describeCommand,
  DEFAULT_HARDWARE_KEYMAP,
} from '../src/hardware/keymap.mjs';
import { computeLedState, toWs2812Frame, frameToHex, AGENT_PALETTE } from '../src/hardware/led.mjs';

test('按键 = 发送：S1–S5 映射到 5 个接力位', () => {
  for (let slot = 0; slot < 5; slot += 1) {
    const command = resolveHardwareEvent({ source: 'key', id: `S${slot + 1}`, gesture: 'press' }, { agentCount: 5 });
    assert.deepEqual(command, { type: 'relay', slot });
  }
});

test('旋钮 = 查看：旋转只移动焦点，不发送', () => {
  const forward = resolveHardwareEvent({ source: 'encoder', gesture: 'rotate', delta: 3 }, { agentCount: 2 });
  assert.deepEqual(forward, { type: 'focus.move', delta: 3 });
  assert.equal(forward.type === 'relay', false, '旋钮绝不能触发发送');

  const backward = resolveHardwareEvent({ source: 'encoder', gesture: 'rotate', delta: -2 }, { agentCount: 2 });
  assert.deepEqual(backward, { type: 'focus.move', delta: -2 });

  // 静止（delta=0）不应产生动作
  assert.equal(resolveHardwareEvent({ source: 'encoder', gesture: 'rotate', delta: 0 }, { agentCount: 2 }), null);
});

test('旋钮短按 = 切换查看，长按 = 配置模式', () => {
  assert.deepEqual(resolveHardwareEvent({ source: 'encoder', gesture: 'press' }, { agentCount: 2 }), {
    type: 'view.cycle',
  });
  assert.deepEqual(resolveHardwareEvent({ source: 'encoder', gesture: 'longPress' }, { agentCount: 2 }), {
    type: 'config.enter',
  });
});

test('越界保护：接力位超过已接入的 Agent 数时给出明确错误而不是静默失败', () => {
  const command = resolveHardwareEvent({ source: 'key', id: 'S5', gesture: 'press' }, { agentCount: 2 });
  assert.equal(command.type, 'error');
  assert.equal(command.code, 'slot-out-of-range');
  assert.match(command.message, /第 5 个接力位/);
  assert.match(command.message, /2 个 Agent/);
  assert.match(describeCommand(command), /无效动作/);
});

test('S7 复制、S8 拉群、S6 清空焦点', () => {
  const press = (id) => resolveHardwareEvent({ source: 'key', id, gesture: 'press' }, { agentCount: 2 });
  assert.equal(press('S6').type, 'focus.clear');
  assert.equal(press('S7').type, 'focus.copy');
  assert.equal(press('S8').type, 'roundtable');
});

test('未绑定的硬件输入不产生动作（而不是抛异常）', () => {
  assert.equal(resolveHardwareEvent({ source: 'key', id: 'S99', gesture: 'press' }, { agentCount: 2 }), null);
  assert.equal(resolveHardwareEvent({ source: 'key', id: 'S1', gesture: 'doublePress' }, { agentCount: 2 }), null);
  assert.equal(resolveHardwareEvent(null, { agentCount: 2 }), null);
  assert.equal(resolveHardwareEvent({ source: 'unknown' }, { agentCount: 2 }), null);
});

test('组合键归一化：修饰键顺序与别名都不影响命中', () => {
  assert.equal(normalizeCombo('meta+alt+1'), 'alt+meta+digit1');
  assert.equal(normalizeCombo('Cmd+Option+Digit1'), 'alt+meta+digit1');
  assert.equal(normalizeCombo('ALT+META+KeyC'), 'alt+meta+keyc');

  const a = resolveHidCombo('Cmd+Option+1', { agentCount: 3 });
  const b = resolveHidCombo('alt+meta+digit1', { agentCount: 3 });
  assert.deepEqual(a, { type: 'relay', slot: 0 });
  assert.deepEqual(a, b);
});

test('HID 通路的方向键与动作键', () => {
  assert.deepEqual(resolveHidCombo('alt+meta+left', { agentCount: 2 }), { type: 'focus.move', delta: -1 });
  assert.deepEqual(resolveHidCombo('alt+meta+right', { agentCount: 2 }), { type: 'focus.move', delta: 1 });
  assert.equal(resolveHidCombo('alt+meta+c', { agentCount: 2 }).type, 'focus.copy');
  assert.equal(resolveHidCombo('alt+meta+b', { agentCount: 2 }).type, 'roundtable');
  // 不该误接普通按键
  assert.equal(resolveHidCombo('meta+1', { agentCount: 2 }), null);
  assert.equal(resolveHidCombo('alt+meta+keyz', { agentCount: 2 }), null);
});

test('LED：固定 5 颗，LED0 承载链路/轮次状态', () => {
  const idle = computeLedState({ agentIds: ['dsh', 'codex'], hasSession: false });
  assert.equal(idle.pixels.length, 5);
  assert.equal(idle.pixels[0].role, 'link');
  assert.equal(idle.pixels[0].effect, 'dim');

  const running = computeLedState({ agentIds: ['dsh', 'codex'], runStatus: { dsh: 'running' }, hasSession: true });
  assert.equal(running.pixels[0].effect, 'pulse', '有轮次在跑 → 黄呼吸');

  const failed = computeLedState({ agentIds: ['dsh', 'codex'], runStatus: { dsh: 'error' }, hasSession: true });
  assert.equal(failed.pixels[0].effect, 'solid');
  assert.deepEqual(failed.pixels[0].rgb, [200, 0, 0], '最近一轮失败 → 红灯');
});

test('LED：Agent 灯按身份分配位置，颜色来自固定调色板', () => {
  const state = computeLedState({
    agentIds: ['dsh', 'codex'],
    runStatus: { dsh: 'ok', codex: 'running' },
  });
  assert.equal(state.pixels[1].agentId, 'dsh');
  assert.equal(state.pixels[2].agentId, 'codex');
  assert.equal(state.pixels[3].agentId, null, '没有第 3 个 Agent 时该位置熄灭');
  assert.deepEqual(state.pixels[3].rgb, [0, 0, 0]);
  assert.equal(state.pixels[1].status, 'ok');
  assert.equal(state.pixels[2].effect, 'pulse');

  // 亮度承载状态：正在跑 > 最近成功 > 空闲
  const [r1] = state.pixels[1].rgb;
  const running = computeLedState({ agentIds: ['dsh'], runStatus: { dsh: 'running' } }).pixels[1].rgb[0];
  const idle = computeLedState({ agentIds: ['dsh'], runStatus: { dsh: 'idle' } }).pixels[1].rgb[0];
  assert.ok(running > r1 && r1 > idle, `亮度应递减：running=${running} ok=${r1} idle=${idle}`);
  assert.equal(AGENT_PALETTE[0], '#4cc2ff');
});

test('LED：焦点归属用交替闪白表达，且与状态色区分', () => {
  const base = { agentIds: ['dsh', 'codex'], runStatus: { dsh: 'ok' }, focusAgentId: 'dsh' };
  const phase0 = computeLedState({ ...base, blinkPhase: 0 });
  const phase1 = computeLedState({ ...base, blinkPhase: 1 });
  assert.equal(phase0.pixels[1].focused, true);
  assert.notDeepEqual(phase0.pixels[1].rgb, phase1.pixels[1].rgb, '两个相位颜色不同才是"闪"');
  assert.deepEqual(phase1.pixels[1].rgb, [255, 255, 255]);
  assert.equal(phase1.pixels[1].effect, 'focus-blink');
  assert.equal(phase0.pixels[2].focused, false, '非焦点 Agent 不受影响');
});

test('LED：Agent 多于 4 个时窗口滑动，viewIndex 记录当前查看', () => {
  const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
  const first = computeLedState({ agentIds: ids, windowStart: 0, viewIndex: 5 });
  assert.deepEqual(first.pixels.slice(1).map((p) => p.agentId), ['a', 'b', 'c', 'd']);
  assert.equal(first.pixels.slice(1).every((p) => p.viewed === false), true);

  const second = computeLedState({ agentIds: ids, windowStart: 4, viewIndex: 5 });
  assert.deepEqual(second.pixels.slice(1).map((p) => p.agentId), ['e', 'f', null, null]);
  assert.equal(second.pixels[2].viewed, true, 'viewIndex=5 对应窗口内第 2 颗');
});

test('LED：被查看的 Agent 更亮——「我在看谁」必须能从灯上看出来', () => {
  const brightness = (pixel) => pixel.rgb.reduce((sum, c) => sum + c, 0);
  const idleStatus = { dsh: 'idle', codex: 'idle' };

  const viewFirst = computeLedState({ agentIds: ['dsh', 'codex'], runStatus: idleStatus, viewIndex: 0 });
  const viewSecond = computeLedState({ agentIds: ['dsh', 'codex'], runStatus: idleStatus, viewIndex: 1 });

  assert.ok(
    brightness(viewFirst.pixels[1]) > brightness(viewSecond.pixels[1]),
    '看 dsh 时 dsh 的灯应比看 codex 时更亮',
  );
  assert.ok(
    brightness(viewSecond.pixels[2]) > brightness(viewFirst.pixels[2]),
    '看 codex 时 codex 的灯应比看 dsh 时更亮',
  );
  assert.equal(viewFirst.pixels[1].effect, 'dim-viewed');
  assert.equal(viewFirst.pixels[2].effect, 'dim');
  // 窗口与查看位不同步时，被查看的 Agent 可能不在灯阵上——此时不应有任何灯被标记 viewed
  const offWindow = computeLedState({ agentIds: ['a', 'b', 'c', 'd', 'e', 'f'], windowStart: 0, viewIndex: 5 });
  assert.equal(offWindow.pixels.slice(1).some((p) => p.viewed), false);
});

test('WS2812 帧：15 字节 GRB 顺序，与板子协议一致', () => {
  const state = computeLedState({ agentIds: ['dsh'] });
  state.pixels[0].rgb = [10, 20, 30]; // 人为设定，便于验证字节序
  const frame = toWs2812Frame(state);
  assert.equal(frame.length, 15);
  assert.deepEqual([...frame.slice(0, 3)], [20, 10, 30], 'GRB：先绿后红再蓝');
  assert.equal(frameToHex(frame).length, 30);
});
