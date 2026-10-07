// 按 Agent 串行化队列单测：同 Agent 串行、跨 Agent 并行、失败不断链
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createAgentQueue } from '../src/core/queue.mjs';

const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('同一个 Agent 的轮次严格串行，不会并发跑两个子进程', async () => {
  const queue = createAgentQueue();
  let running = 0;
  let peak = 0;
  const order = [];

  const tasks = ['a', 'b', 'c'].map((tag) =>
    queue.run('kimi', async () => {
      running += 1;
      peak = Math.max(peak, running);
      order.push(`start-${tag}`);
      await tick(15);
      order.push(`end-${tag}`);
      running -= 1;
      return tag;
    }),
  );

  const results = await Promise.all(tasks);
  assert.deepEqual(results, ['a', 'b', 'c']);
  assert.equal(peak, 1, `同 Agent 并发峰值应为 1，实际 ${peak}`);
  assert.deepEqual(order, ['start-a', 'end-a', 'start-b', 'end-b', 'start-c', 'end-c']);
});

test('不同 Agent 之间仍然并行（圆桌依赖这一点）', async () => {
  const queue = createAgentQueue();
  let running = 0;
  let peak = 0;

  const run = (agent) =>
    queue.run(agent, async () => {
      running += 1;
      peak = Math.max(peak, running);
      await tick(20);
      running -= 1;
      return agent;
    });

  await Promise.all([run('dsh'), run('codex'), run('minimax')]);
  assert.equal(peak, 3, `跨 Agent 应并行，实际峰值 ${peak}`);
});

test('前一轮失败不会把队列挂死', async () => {
  const queue = createAgentQueue();
  await assert.rejects(() => queue.run('dsh', async () => {
    throw new Error('第一轮失败');
  }));

  const second = await queue.run('dsh', async () => '第二轮正常');
  assert.equal(second, '第二轮正常');
  assert.deepEqual(queue.pending(), ['dsh']);
});
