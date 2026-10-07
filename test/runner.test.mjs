// 执行器契约测：用真实子进程验证「退出码不可信」这条核心约定
import { test } from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';

import { runTurn } from '../src/core/runner.mjs';

/** 用 `node -e` 造一个可控的假 Agent，避免测试依赖网络与真实模型 */
function fakeAdapter(code, { id = 'fake' } = {}) {
  return {
    id,
    label: 'Fake',
    capabilities: { resume: true, streaming: true, tools: false },
    command: () => process.execPath,
    buildArgs: () => ['-e', code],
    parseLine: (line) => {
      const trimmed = line.trim();
      if (!trimmed) return [];
      try {
        return [JSON.parse(trimmed)];
      } catch {
        return [{ type: 'raw', raw: trimmed }];
      }
    },
  };
}

test('退出码 0 但没有任何输出 → 判失败（实测两个 CLI 都这样）', async () => {
  const adapter = fakeAdapter('process.exit(0)');
  const result = await runTurn({ adapter, prompt: 'hi', timeoutMs: 10000 });
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 0);
  assert.match(result.error, /没有产出任何文本/);
});

test('退出码 0、有 stderr、无文本 → 失败原因取 stderr（复刻 codex 拒绝执行那次）', async () => {
  const adapter = fakeAdapter(
    'console.error("Not inside a trusted directory and --skip-git-repo-check was not specified."); process.exit(0)',
  );
  const result = await runTurn({ adapter, prompt: 'hi', timeoutMs: 10000 });
  assert.equal(result.ok, false);
  assert.match(result.error, /trusted directory/);
});

test('prompt 确实通过 stdin 送达，并捕获 session 与文本', async () => {
  const code = `
    const chunks = [];
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => {
      console.log(JSON.stringify({ type: 'session.started', sessionId: 's-1' }));
      console.log(JSON.stringify({ type: 'text', text: 'ECHO:' + Buffer.concat(chunks).toString().trim() }));
      console.log(JSON.stringify({ type: 'final', text: 'ECHO:' + Buffer.concat(chunks).toString().trim() }));
    });
  `;
  const result = await runTurn({ adapter: fakeAdapter(code), prompt: '你好 world', timeoutMs: 10000 });
  assert.equal(result.ok, true);
  assert.equal(result.sessionId, 's-1');
  assert.equal(result.text, 'ECHO:你好 world');
});

test('致命 error 事件即判失败，即使有正常文本', async () => {
  const code = `
    console.log(JSON.stringify({ type: 'text', text: '部分输出' }));
    console.log(JSON.stringify({ type: 'error', message: '模型调用失败', fatal: true }));
    process.exit(0);
  `;
  const result = await runTurn({ adapter: fakeAdapter(code), prompt: 'hi', timeoutMs: 10000 });
  assert.equal(result.ok, false);
  assert.equal(result.error, '模型调用失败');
});

test('非致命 error（警告）不判失败，但要如实记录 warnings', async () => {
  // 复刻真实场景：Codex 先抛 "Under-development features enabled: chronicle"，
  // 随后正常回答。若不区分 fatal，一次正确回答会被误判成失败。
  const code = `
    console.log(JSON.stringify({ type: 'error', message: 'Under-development features enabled: chronicle.', fatal: false }));
    console.log(JSON.stringify({ type: 'text', text: '收到' }));
    process.exit(0);
  `;
  const result = await runTurn({ adapter: fakeAdapter(code), prompt: 'hi', timeoutMs: 10000 });
  assert.equal(result.ok, true);
  assert.equal(result.text, '收到');
  assert.equal(result.error, null);
  assert.deepEqual(result.warnings, ['Under-development features enabled: chronicle.']);
});

test('只有警告、没有文本 → 仍然判失败', async () => {
  const code = `
    console.log(JSON.stringify({ type: 'error', message: '只是个警告', fatal: false }));
    process.exit(0);
  `;
  const result = await runTurn({ adapter: fakeAdapter(code), prompt: 'hi', timeoutMs: 10000 });
  assert.equal(result.ok, false);
  assert.match(result.error, /没有产出任何文本/);
});

test('二进制不存在 → 判失败、给出"无法启动"，且不会挂住', async () => {
  const adapter = fakeAdapter('console.log("不会被执行")', { id: 'missing-bin' });
  adapter.command = () => '/nonexistent/path/definitely-not-here';

  const started = Date.now();
  const result = await runTurn({ adapter, prompt: 'hi', timeoutMs: 10000 });
  assert.equal(result.ok, false);
  assert.match(result.error, /无法启动/);
  assert.ok(Date.now() - started < 5000, 'spawn 失败必须立刻返回，不能等到超时');
});

test('取消：abort 后立刻终止子进程并标记 cancelled（与超时区分开）', async () => {
  const adapter = fakeAdapter('setTimeout(() => {}, 60000)');
  const controller = new AbortController();
  const started = Date.now();
  const pending = runTurn({
    adapter,
    prompt: 'hi',
    timeoutMs: 60000,
    killGraceMs: 200,
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 150);
  const result = await pending;

  assert.equal(result.ok, false);
  assert.equal(result.cancelled, true);
  assert.equal(result.timedOut, false, '取消不能被记成超时');
  assert.equal(result.error, '已取消');
  assert.ok(Date.now() - started < 10000, '取消后必须很快返回');
});

test('取消先于执行：已经 abort 的信号不会把子进程跑完', async () => {
  const adapter = fakeAdapter('setTimeout(() => { console.log("不该输出"); }, 30000)');
  const controller = new AbortController();
  controller.abort();
  const result = await runTurn({
    adapter,
    prompt: 'hi',
    timeoutMs: 30000,
    killGraceMs: 200,
    signal: controller.signal,
  });
  assert.equal(result.cancelled, true);
  assert.equal(result.text, '');
});

test('超时会被强制终止，并如实标记 timedOut', async () => {
  const adapter = fakeAdapter('setTimeout(() => {}, 60000)');
  const started = Date.now();
  const result = await runTurn({ adapter, prompt: 'hi', timeoutMs: 400, killGraceMs: 200 });
  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);
  assert.match(result.error, /超时/);
  assert.ok(Date.now() - started < 10000, '超时后不应长时间挂住');
});
