// 中台启动冒烟测试。
//
// 存在的理由：单测只覆盖 src/ 下的模块，**不会发现 server.mjs 自己的语法错误、
// 缺失的命名导入、端口绑定失败**。这些必须靠"真的把它拉起来"才能发现。
// （2026-10-07 就发生过一次：批量脚本替换导入行没匹配上，服务直接起不来，
//   而当时 87 项单测全绿。）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');

function startServer(port, dataDir) {
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: ROOT,
    env: { ...process.env, RELAYDECK_PORT: String(port), RELAYDECK_DATA: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  return {
    child,
    get output() {
      return { stdout, stderr };
    },
    /** 等启动日志出现，或者进程提前退出 */
    waitForStart(timeoutMs = 15000) {
      return new Promise((resolve) => {
        const deadline = Date.now() + timeoutMs;
        const tick = () => {
          if (stdout.includes('中台已启动')) return resolve('started');
          if (child.exitCode !== null) return resolve('exited');
          if (Date.now() > deadline) return resolve('timeout');
          setTimeout(tick, 100);
        };
        tick();
      });
    },
  };
}

test('中台能被拉起来：没有语法错误、命名导入齐全、端口可绑定', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'relaydeck-smoke-'));
  const port = 18000 + Math.floor(Math.random() * 2000);
  const server = startServer(port, dataDir);
  try {
    const state = await server.waitForStart();
    assert.equal(state, 'started', `服务没能启动。stdout=${server.output.stdout} stderr=${server.output.stderr}`);
    assert.equal(server.child.exitCode, null, '启动后不应该立刻退出');

    // 真的能回答请求
    const res = await fetch(`http://127.0.0.1:${port}/api/state`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.agents) && body.agents.length >= 2, '至少要注册两个 Agent');
    assert.ok(body.led?.board, '板级状态帧必须存在');
    assert.ok(body.led.board.sequence > 1_000_000, '板级序号应从纪元起算，而不是从 0');

    // 静态页面也要能出来
    const page = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /RelayDeck/);
  } finally {
    server.child.kill('SIGTERM');
    await new Promise((resolve) => server.child.on('close', resolve));
    await rm(dataDir, { recursive: true, force: true });
  }
});
