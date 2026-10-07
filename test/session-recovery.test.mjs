// 续跑线自愈单测：坏 session 不能把会话永久卡死
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runTurnWithRecovery } from '../src/core/session-recovery.mjs';

test('首轮成功：不重试、不算重置', async () => {
  const calls = [];
  const out = await runTurnWithRecovery({
    sessionId: 'session-good',
    runOnce: async ({ sessionId, attempt }) => {
      calls.push({ sessionId, attempt });
      return { ok: true, text: '好' };
    },
  });
  assert.equal(out.result.ok, true);
  assert.equal(out.contextReset, false);
  assert.equal(out.attempts, 1);
  assert.deepEqual(calls, [{ sessionId: 'session-good', attempt: 1 }]);
});

test('坏 session：丢掉旧线重跑一次并标记 contextReset', async () => {
  const calls = [];
  const out = await runTurnWithRecovery({
    sessionId: 'session-dead',
    runOnce: async ({ sessionId, attempt }) => {
      calls.push({ sessionId, attempt });
      if (sessionId) return { ok: false, text: '', error: 'session "session-dead" does not exist' };
      return { ok: true, text: '重跑成功' };
    },
  });

  assert.equal(out.result.ok, true);
  assert.equal(out.result.text, '重跑成功');
  assert.equal(out.contextReset, true, '重置必须被如实上报');
  assert.equal(out.previousSession, 'session-dead');
  assert.equal(out.attempts, 2);
  assert.deepEqual(calls, [
    { sessionId: 'session-dead', attempt: 1 },
    { sessionId: null, attempt: 2 },
  ]);
});

test('本来就没有续跑线：失败也不重试（省一次调用）', async () => {
  let calls = 0;
  const out = await runTurnWithRecovery({
    sessionId: null,
    runOnce: async () => {
      calls += 1;
      return { ok: false, text: '', error: '模型不可用' };
    },
  });
  assert.equal(out.result.ok, false);
  assert.equal(out.contextReset, false);
  assert.equal(calls, 1);
});

test('超时不重试：不能让用户白等两倍时间', async () => {
  let calls = 0;
  const out = await runTurnWithRecovery({
    sessionId: 'session-good',
    runOnce: async () => {
      calls += 1;
      return { ok: false, text: '', error: '超时（1200ms）后已终止', timedOut: true };
    },
  });
  assert.equal(out.contextReset, false);
  assert.equal(calls, 1);
  assert.equal(out.result.timedOut, true);
});

test('重跑仍然失败：不声称自愈，并保留第一次的错误用于诊断', async () => {
  const out = await runTurnWithRecovery({
    sessionId: 'session-dead',
    runOnce: async ({ sessionId }) => ({
      ok: false,
      text: '',
      error: sessionId ? 'session 不存在' : '网络不可达',
    }),
  });
  assert.equal(out.result.ok, false);
  assert.equal(out.contextReset, false, '没成功就不能算重置成功');
  assert.equal(out.result.error, '网络不可达');
  assert.equal(out.firstError, 'session 不存在');
  assert.equal(out.attempts, 2);
});
