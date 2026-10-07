// Agent Status（板载 LED 回传）单测。
// 协议规则照抄 easy-input-maker 的 components/keyboard/include/keyboard/agent_status.h，
// 保证"我们发出去的 16 字节"就是"固件能正确解码的 16 字节"。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AGENT_STATUS_STATES,
  AGENT_STATUS_MAX_TTL_MS,
  AGENT_STATUS_REPORT_ID,
  encodeAgentStatus,
  decodeAgentStatus,
  mapRunStatusToAgentState,
  sourceHash,
  sequenceIsNewer,
  buildAgentStatusFrame,
  AGENT_STATUS_COLORS,
} from '../src/hardware/agent-status.mjs';

test('编码 ↔ 解码回环：字段一一对应', () => {
  const payload = encodeAgentStatus({
    state: AGENT_STATUS_STATES.Running,
    flags: 3,
    sequence: 42,
    ttlMs: 60000,
    sourceHash: 0xdeadbeef,
  });
  assert.equal(payload.length, 16);

  const decoded = decodeAgentStatus(payload);
  assert.deepEqual(decoded, {
    version: 1,
    state: AGENT_STATUS_STATES.Running,
    flags: 3,
    sequence: 42,
    ttlMs: 60000,
    sourceHash: 0xdeadbeef,
  });
});

test('字节序与固件一致：小端 u32，且版本/状态在固定位置', () => {
  const payload = encodeAgentStatus({
    state: AGENT_STATUS_STATES.Failed,
    flags: 0,
    sequence: 0x01020304,
    ttlMs: 0x000a0b0c, // 注意必须在上限以内，否则会被夹紧（见下一条测试）
    sourceHash: 0x11223344,
  });
  assert.equal(payload[0], 1, 'byte0 = 协议版本');
  assert.equal(payload[1], AGENT_STATUS_STATES.Failed, 'byte1 = 状态');
  assert.equal(payload[3], 0, 'byte3 保留位必须为 0');
  assert.deepEqual([...payload.slice(4, 8)], [0x04, 0x03, 0x02, 0x01], 'sequence 小端');
  assert.deepEqual([...payload.slice(8, 12)], [0x0c, 0x0b, 0x0a, 0x00], 'ttl 小端');
  assert.deepEqual([...payload.slice(12, 16)], [0x44, 0x33, 0x22, 0x11], 'sourceHash 小端');
});

test('固件规则：TTL 夹到 12 小时上限，Idle 一律归零', () => {
  const tooLong = decodeAgentStatus(
    encodeAgentStatus({ state: AGENT_STATUS_STATES.Running, ttlMs: AGENT_STATUS_MAX_TTL_MS * 10 }),
  );
  assert.equal(tooLong.ttlMs, AGENT_STATUS_MAX_TTL_MS, '超过上限必须夹紧，而不是溢出');

  const idle = decodeAgentStatus(
    encodeAgentStatus({ state: AGENT_STATUS_STATES.Idle, ttlMs: 999999 }),
  );
  assert.equal(idle.ttlMs, 0, 'Idle 等于清除状态，TTL 必须为 0');

  const negative = decodeAgentStatus(encodeAgentStatus({ state: AGENT_STATUS_STATES.Running, ttlMs: -5 }));
  assert.equal(negative.ttlMs, 0);
});

test('非法输入被拒绝，而不是发出一个固件看不懂的帧', () => {
  assert.throws(() => encodeAgentStatus({ state: 9 }), /非法的 AgentStatusState/);
  assert.throws(() => encodeAgentStatus({ state: -1 }), /非法的 AgentStatusState/);

  const wrongVersion = encodeAgentStatus({ state: AGENT_STATUS_STATES.Running });
  wrongVersion[0] = 2;
  assert.equal(decodeAgentStatus(wrongVersion), null, '版本不对必须拒绝');

  const wrongState = encodeAgentStatus({ state: AGENT_STATUS_STATES.Running });
  wrongState[1] = 9;
  assert.equal(decodeAgentStatus(wrongState), null, '状态越界必须拒绝');

  assert.equal(decodeAgentStatus(new Uint8Array(8)), null, '长度不足必须拒绝');
  assert.equal(decodeAgentStatus(null), null);
});

test('中台状态 → 板上状态：五种语义都有落点', () => {
  assert.equal(mapRunStatusToAgentState({ runStatus: 'running' }), AGENT_STATUS_STATES.Running);
  assert.equal(mapRunStatusToAgentState({ runStatus: 'error' }), AGENT_STATUS_STATES.Failed);
  assert.equal(mapRunStatusToAgentState({ runStatus: 'ok' }), AGENT_STATUS_STATES.CompletedUnread, '完成未读 = 绿灯');
  assert.equal(
    mapRunStatusToAgentState({ runStatus: 'ok', acknowledged: true }),
    AGENT_STATUS_STATES.Idle,
    '已读就熄灯',
  );
  assert.equal(mapRunStatusToAgentState({ runStatus: 'waiting' }), AGENT_STATUS_STATES.WaitingUser);
  assert.equal(mapRunStatusToAgentState({ runStatus: 'idle' }), AGENT_STATUS_STATES.Idle);
  assert.equal(mapRunStatusToAgentState({}), AGENT_STATUS_STATES.Idle);
});

test('来源哈希稳定：同会话同 Agent 恒定，不同来源不同', () => {
  const a = sourceHash('c-1::dsh');
  const b = sourceHash('c-1::dsh');
  const c = sourceHash('c-1::codex');
  assert.equal(a, b, '同样输入必须恒定（否则板子会以为是新来源）');
  assert.notEqual(a, c);
  assert.ok(a >= 0 && a <= 0xffffffff, '必须是 32 位无符号');
});

test('序号比较按 int32 回绕（与固件一致）', () => {
  assert.equal(sequenceIsNewer(2, 1), true);
  assert.equal(sequenceIsNewer(1, 2), false);
  assert.equal(sequenceIsNewer(5, 5), false, '相同序号不算更新');
  // 回绕：0xFFFFFFFF 之后是 0
  assert.equal(sequenceIsNewer(0, 0xffffffff), true);
  assert.equal(sequenceIsNewer(0xffffffff, 0), false);
});

test('成帧函数给出可直接发送的 reportId / 载荷 / 灯色', () => {
  const frame = buildAgentStatusFrame({
    runStatus: 'running',
    conversationId: 'c-abc',
    agentId: 'kimi',
    sequence: 7,
    ttlMs: 30000,
  });
  assert.equal(frame.reportId, AGENT_STATUS_REPORT_ID);
  assert.equal(frame.reportId, 0x12, '固件 report descriptor 里声明的就是 0x12');
  assert.equal(frame.payload.length, 16);
  assert.equal(frame.state, AGENT_STATUS_STATES.Running);
  assert.deepEqual(frame.color, AGENT_STATUS_COLORS[AGENT_STATUS_STATES.Running], '暗蓝 = 正在跑');
  assert.deepEqual(decodeAgentStatus(frame.payload).sourceHash, frame.sourceHash);
});
