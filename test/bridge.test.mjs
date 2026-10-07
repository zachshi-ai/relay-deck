// 中台 → 实板 桥的单测（注入假的 spawn，不需要插着板子）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createBoardBridge, BRIDGE_STATE_NAMES } from '../src/hardware/bridge.mjs';

function fakeSpawn() {
  const calls = [];
  const impl = (command, args) => {
    calls.push({ command, args });
    return { on: () => {} };
  };
  return { impl, calls };
}

async function tempTool() {
  const dir = await mkdtemp(path.join(tmpdir(), 'relaydeck-bridge-'));
  const tool = path.join(dir, 'hidtool');
  await writeFile(tool, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return { dir, tool };
}

test('工具不存在时桥自动禁用，不会去 spawn 不存在的路径', () => {
  const spawnImpl = fakeSpawn();
  const bridge = createBoardBridge({ toolPath: '/nonexistent/hidtool', spawnImpl: spawnImpl.impl });
  assert.equal(bridge.enabled, false);
  const result = bridge.push({ state: 1, sequence: 5, ttlMs: 1000 });
  assert.equal(result.pushed, false);
  assert.equal(spawnImpl.calls.length, 0);
});

test('状态值映射到 hidtool 的命令行名字', () => {
  assert.deepEqual(BRIDGE_STATE_NAMES, { 0: 'idle', 1: 'running', 2: 'waiting', 3: 'ok', 4: 'failed' });
});

test('状态变化时按正确参数调用工具', async () => {
  const { dir, tool } = await tempTool();
  const spawnImpl = fakeSpawn();
  try {
    const bridge = createBoardBridge({ toolPath: tool, spawnImpl: spawnImpl.impl });
    assert.equal(bridge.enabled, true);

    const running = bridge.push({ state: 1, sequence: 717641308, ttlMs: 600000 });
    assert.equal(running.pushed, true);
    assert.equal(running.stateName, 'running');
    assert.deepEqual(spawnImpl.calls[0], {
      command: tool,
      args: ['agent', 'running', '717641308', '600000'],
    });

    const failed = bridge.push({ state: 4, sequence: 717641318, ttlMs: 600000 });
    assert.equal(failed.stateName, 'failed');

    const idle = bridge.push({ state: 0, sequence: 717641328, ttlMs: 0 });
    assert.deepEqual(spawnImpl.calls[2].args, ['agent', 'idle', '717641328', '0']);
    assert.equal(spawnImpl.calls.length, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('完全相同的帧不重复下发（固件也会丢弃，省一次进程）', async () => {
  const { dir, tool } = await tempTool();
  const spawnImpl = fakeSpawn();
  try {
    const bridge = createBoardBridge({ toolPath: tool, spawnImpl: spawnImpl.impl });
    bridge.push({ state: 1, sequence: 100, ttlMs: 1000 });
    const again = bridge.push({ state: 1, sequence: 100, ttlMs: 1000 });
    assert.equal(again.pushed, false);
    assert.equal(again.reason, 'duplicate');
    assert.equal(spawnImpl.calls.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('spawn 抛异常不影响中台（桥失败要被吞掉并记录）', async () => {
  const { dir, tool } = await tempTool();
  const logs = [];
  try {
    const bridge = createBoardBridge({
      toolPath: tool,
      spawnImpl: () => {
        throw new Error('spawn 失败');
      },
      log: (...args) => logs.push(args.join(' ')),
    });
    const result = bridge.push({ state: 1, sequence: 1, ttlMs: 100 });
    assert.equal(result.pushed, false);
    assert.match(result.reason, /spawn 失败/);
    assert.ok(logs.some((line) => line.includes('bridge 异常')));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
