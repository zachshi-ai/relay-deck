#!/usr/bin/env node
// 板级状态帧验收：在没有板子的情况下，验证"中台状态 → 要发给板的 16 字节"这条链路。
//
// 固件语义（来自 easy-input-maker，已核对）：
//   - 一次只显示一个状态，后到的覆盖先到的
//   - render_agent_status() 把这一种颜色铺成 5 颗灯的径向渐变（中亮 → 50% → 25%）
//   - 完全相同的帧会被丢弃（state/flags/sequence/ttl/source 全同）
//
// 所以这里要验的是：聚合是否正确、sequence 是否只在变化时递增、TTL/Idle 规则是否符合固件。
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { decodeAgentStatus, AGENT_STATUS_STATES, AGENT_STATUS_NAMES } from '../src/hardware/agent-status.mjs';

const BASE = process.env.RELAYDECK_URL ?? 'http://127.0.0.1:8787';
const startedAt = new Date().toISOString();
const checks = [];
const timeline = [];

function check(name, passed, detail = '') {
  checks.push({ name, passed: Boolean(passed), detail });
  console.log(`${passed ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function api(method, route, body) {
  const res = await fetch(`${BASE}${route}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

async function board() {
  const led = await api('GET', '/api/hardware/led');
  return led.board;
}

function record(label, board) {
  const decoded = decodeAgentStatus(Uint8Array.from(board.payload));
  timeline.push({
    at: new Date().toISOString(),
    label,
    state: board.state,
    stateName: board.stateName,
    sequence: board.sequence,
    ttlMs: board.ttlMs,
    color: board.color,
    payloadValid: Boolean(decoded),
    payload: board.payload,
  });
  return decoded;
}

// —— 1. 基线：用户没在等任何东西时必须是 Idle 且 TTL 为 0 ——
const baseline = await board();
check('基线状态是 Idle', baseline.stateName === 'Idle', baseline.stateName);
check('Idle 时 TTL 必须为 0（等于清状态）', baseline.ttlMs === 0, `ttl=${baseline.ttlMs}`);
check('载荷能被固件规则解码', Boolean(record('baseline', baseline)), 'decode ok');
check('reportId 是固件声明的 0x12', baseline.reportId === 0x12, `reportId=${baseline.reportId}`);

// —— 2. 硬件通路按下 S3（第 3 个 Agent，MiniMax，最快）：应当立刻进入 Running ——
// 用 S3 是为了让验收脚本跑得快；按键语义与 S1 完全一样。
const accepted = await api('POST', '/api/hardware', { source: 'key', id: 'S3', gesture: 'press' });
check('硬件接力被接受', accepted.accepted === true, accepted.agent ?? accepted.reason ?? '');

// 关键：**响应体里那一帧**就必须是 Running。
// 否则桥接层照这帧点灯，会漏掉"正在跑"（这是一次真实修复：之前状态是异步才置上的）。
const responseBoard = accepted.led?.board;
record('response-frame', responseBoard);
check(
  '响应体里的板级帧已是 Running（不能等异步置位）',
  responseBoard?.stateName === 'Running',
  responseBoard?.stateName ?? '缺失',
);
check(
  'Running 的 TTL 不为 0（否则板子会当成清状态）',
  responseBoard?.ttlMs > 0,
  `ttl=${responseBoard?.ttlMs}`,
);
check(
  '状态变化时 sequence 递增（固件用它去重）',
  responseBoard?.sequence > baseline.sequence,
  `${baseline.sequence} → ${responseBoard?.sequence}`,
);

// —— 3. 等这一轮跑完：应当变成"完成未读"（绿灯） ——
let finished = null;
for (let i = 0; i < 90; i += 1) {
  await new Promise((r) => setTimeout(r, 1000));
  const frame = await board();
  if (frame.stateName !== 'Running') {
    finished = frame;
    break;
  }
}
check('轮次结束后不再是 Running', finished !== null && finished.stateName !== 'Running', finished?.stateName ?? '超时仍是 Running');
if (finished) {
  record('after-turn', finished);
  check(
    '有结果未读 → CompletedUnread（绿灯）',
    finished.stateName === 'CompletedUnread',
    `${finished.stateName} color=${JSON.stringify(finished.color)}`,
  );
}

// —— 4. 用户动一下焦点：视为已读，应当回到 Idle ——
await api('POST', '/api/focus', { messageId: null });
const afterAck = await board();
record('after-ack', afterAck);
check('用户动过之后回到 Idle（灯灭）', afterAck.stateName === 'Idle', afterAck.stateName);

// —— 5. 帧结构自检：16 字节、可解码、来源哈希稳定 ——
const again = await board();
check('重复读取不改变 sequence（状态没变不该刷号）', again.sequence === afterAck.sequence, `${afterAck.sequence} vs ${again.sequence}`);
check('来源哈希稳定', again.sourceHash === afterAck.sourceHash, `${afterAck.sourceHash}`);

const summary = {
  kind: 'relaydeck-board-status-e2e',
  ranAt: startedAt,
  base: BASE,
  checks,
  timeline,
  states: AGENT_STATUS_NAMES,
  enumValues: AGENT_STATUS_STATES,
};

const dir = path.resolve(process.cwd(), 'evidence');
await mkdir(dir, { recursive: true });
const file = path.join(dir, `board-status-${startedAt.replace(/[:.]/g, '-')}.json`);
await writeFile(file, `${JSON.stringify(summary, null, 2)}\n`);

const failed = checks.filter((c) => !c.passed);
console.log(`\n证据：${file}`);
console.log(`结论：${checks.length - failed.length}/${checks.length} 项通过`);
process.exitCode = failed.length ? 1 : 0;
