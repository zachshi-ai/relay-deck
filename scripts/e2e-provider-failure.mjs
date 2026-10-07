#!/usr/bin/env node
// 弱网 / 上游失败矩阵验收（自包含，不碰任何硬件）。
//
// 做法：脚本自己起一个中台实例（临时端口 + 临时数据目录），把 MiniMax 适配器的
// 可执行文件指向一个"可控坏掉"的假 provider，然后逐种失败模式打真实 HTTP 请求。
// 验证三件事：①失败必须被如实报出来，不能伪装成成功；②中台不能被拖死或崩掉；
// ③失败状态要落到板级状态帧上（Failed = 红灯），这条不需要插板子也能验。
import { chmod, copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const FIXTURE_PROVIDER = path.join(ROOT, 'scripts', 'fixtures', 'fake-provider.mjs');
const startedAt = new Date().toISOString();
const checks = [];

function check(name, passed, detail = '') {
  checks.push({ name, passed: Boolean(passed), detail });
  console.log(`${passed ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const dir = await mkdtemp(path.join(tmpdir(), 'relaydeck-provider-'));
const modeFile = path.join(dir, 'mode.txt');
const counterFile = path.join(dir, 'victim-taken');
const fakeProvider = path.join(dir, 'fake-mmx.mjs');
const port = 19000 + Math.floor(Math.random() * 2000);

// 假 provider 是仓库里的真实文件（scripts/fixtures/fake-provider.mjs），
// 这里只负责拷进临时目录并加执行位——
// 之前用字符串模板"生成代码"，被 JS 模板字符串的转义坑了两次（写出真换行 → 语法错误）。
await copyFile(FIXTURE_PROVIDER, fakeProvider);
await chmod(fakeProvider, 0o755);

const server = spawn(process.execPath, ['server.mjs'], {
  cwd: ROOT,
  env: {
    ...process.env,
    RELAYDECK_PORT: String(port),
    RELAYDECK_DATA: dir,
    RELAYDECK_HID_BRIDGE: '0', // 明确关掉实板桥：本脚本绝不碰设备
    RELAYDECK_TIMEOUT: '2500', // 让"挂住"这一档快速进入超时分支
    RELAYDECK_MMX_BIN: fakeProvider,
    RELAYDECK_DSH_BIN: fakeProvider,
    RELAYDECK_CODEX_BIN: fakeProvider,
    RELAYDECK_CHAIR: 'dsh',
    RELAYDECK_MEMBER_TIMEOUT_MS: '800',
    FAKE_MODE_FILE: modeFile,
    FAKE_COUNTER_FILE: counterFile,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let serverLog = '';
server.stdout.on('data', (c) => {
  serverLog += c.toString();
});
server.stderr.on('data', (c) => {
  serverLog += c.toString();
});

const BASE = `http://127.0.0.1:${port}`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForServer(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/state`);
      if (res.ok) return true;
    } catch {
      /* 还没起来 */
    }
    await wait(150);
  }
  return false;
}

async function ask(prompt = '你好') {
  const res = await fetch(`${BASE}/api/ask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent: 'minimax', prompt }),
  });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let done = null;
  for (;;) {
    const { value, done: finished } = await reader.read();
    if (finished) break;
    buffer += decoder.decode(value, { stream: true });
    let cut;
    while ((cut = buffer.indexOf('\n\n')) >= 0) {
      const chunk = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      let event = 'message';
      let data = '';
      for (const line of chunk.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      if (event === 'done' && data) done = JSON.parse(data);
    }
  }
  return done;
}

async function board() {
  const res = await fetch(`${BASE}/api/hardware/led`);
  const led = await res.json();
  return led.board;
}

const results = [];
try {
  const up = await waitForServer();
  check('临时中台能起来（假 provider 已就位）', up);
  if (!up) throw new Error(`中台没起来：${serverLog}`);

  const cases = [
    { mode: 'hang', name: '上游挂住不回', expectError: /超时/, expectBoard: 'Failed' },
    { mode: 'garbage', name: '上游输出被截断', expectError: /没有产出任何文本|解析/, expectBoard: 'Failed' },
    { mode: 'rate-limited', name: '上游限流（429）', expectError: /429/, expectBoard: 'Failed' },
    { mode: 'empty', name: '上游返回空回答', expectError: /没有产出任何文本|无/, expectBoard: 'Failed' },
    { mode: 'crash', name: '上游进程直接退出', expectError: /没有产出任何文本|退出/, expectBoard: 'Failed' },
  ];

  for (const item of cases) {
    await writeFile(modeFile, `${item.mode}\n`);
    const started = Date.now();
    const done = await ask();
    const elapsed = Date.now() - started;

    check(
      `${item.name} → 如实判失败（ok=false）`,
      done?.ok === false,
      `ok=${done?.ok} error=${(done?.error ?? '').slice(0, 60)}`,
    );
    check(
      `${item.name} → 错误信息能指认原因`,
      item.expectError.test(done?.error ?? ''),
      (done?.error ?? '').slice(0, 80),
    );

    const frame = await board();
    check(
      `${item.name} → 板级状态帧为 ${item.expectBoard}（红灯）`,
      frame?.stateName === item.expectBoard,
      `实际 ${frame?.stateName}`,
    );

    results.push({ mode: item.mode, ok: done?.ok, error: done?.error, elapsedMs: elapsed, boardState: frame?.stateName });
  }

  // 关键：一连串失败之后，中台必须还活着并能正常工作
  await writeFile(modeFile, 'slow-ok\n');
  const recovered = await ask('再来一次');
  check('连续失败之后，正常请求仍能成功（中台没被拖死）', recovered?.ok === true, `text=${JSON.stringify(recovered?.text ?? '')}`);
  const frameAfter = await board();
  check(
    '恢复成功后板级状态帧变为 CompletedUnread（绿灯）',
    frameAfter?.stateName === 'CompletedUnread',
    `实际 ${frameAfter?.stateName}`,
  );
  results.push({ mode: 'slow-ok', ok: recovered?.ok, text: recovered?.text, boardState: frameAfter?.stateName });

  check('上游很慢但最终成功 → 不误判为失败', recovered?.ok === true);

  // —— 圆桌：三个成员全离线，其中一个故意挂住 ——
  // 没有成员超时的话这一轮会一直等到轮次总超时（180s）；有了它应当在 1s 量级结束。
  await writeFile(modeFile, 'hang-one\n');
  await rm(counterFile, { force: true });

  const started = Date.now();
  const roundtableRes = await fetch(`${BASE}/api/roundtable`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question: '纯离线圆桌测试', agents: ['dsh', 'codex', 'minimax'], chair: 'dsh' }),
  });
  const reader = roundtableRes.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let roundDone = null;
  const phases = [];
  for (;;) {
    const { value, done: finished } = await reader.read();
    if (finished) break;
    buffer += decoder.decode(value, { stream: true });
    let cut;
    while ((cut = buffer.indexOf('\n\n')) >= 0) {
      const chunk = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      let event = 'message';
      let data = '';
      for (const line of chunk.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      if (!data) continue;
      const payload = JSON.parse(data);
      if (event === 'phase') phases.push(payload);
      if (event === 'done') roundDone = payload;
    }
  }
  const roundElapsed = Date.now() - started;

  const timedOutMembers = (roundDone?.answers ?? []).filter((a) => a.timedOut);
  check(
    '圆桌：挂住的成员被判超时并跳过',
    timedOutMembers.length === 1,
    `超时=${timedOutMembers.map((a) => a.agent).join(',') || '无'}｜各自结果=${JSON.stringify((roundDone?.answers ?? []).map((a) => [a.agent, a.ok, a.error]))}`,
  );
  check(
    '圆桌：其他成员不受影响，照常有回答',
    (roundDone?.answers ?? []).filter((a) => a.ok).length >= 2,
    `成功 ${(roundDone?.answers ?? []).filter((a) => a.ok).length}/${(roundDone?.answers ?? []).length}`,
  );
  check('圆桌：主持人照常汇总', roundDone?.summary?.ok === true);
  check(
    '圆桌：整轮在秒级结束，而不是等满总超时',
    roundElapsed < 15000,
    `实际 ${roundElapsed}ms`,
  );
  check(
    '圆桌：SSE 里能看到成员超时（timedOut 标记随 phase 推出）',
    phases.some((phase) => phase.timedOut === true),
    JSON.stringify(phases.filter((p) => p.phase === 'fanout.answer')),
  );
  results.push({
    roundtable: {
      elapsedMs: roundElapsed,
      answers: (roundDone?.answers ?? []).map((a) => ({ agent: a.agent, ok: a.ok, timedOut: Boolean(a.timedOut), error: a.error })),
      summaryOk: roundDone?.summary?.ok,
    },
  });
} catch (err) {
  check(`脚本本身执行失败：${err.message}`, false);
} finally {
  server.kill('SIGTERM');
  await new Promise((resolve) => server.on('close', resolve));
  if (process.env.KEEP_TMP !== '1') {
    await rm(dir, { recursive: true, force: true });
  } else {
    console.log(`[debug] 临时目录保留在：${dir}`);
  }
}

const summary = {
  kind: 'relaydeck-provider-failure-e2e',
  ranAt: startedAt,
  note: '本脚本自身起中台与假 provider，不接触任何实体设备（RELAYDECK_HID_BRIDGE=0）',
  checks,
  results,
};

const evidenceDir = path.resolve(ROOT, 'evidence');
await writeFile(
  path.join(evidenceDir, `provider-failure-${startedAt.replace(/[:.]/g, '-')}.json`),
  `${JSON.stringify(summary, null, 2)}\n`,
);

const failed = checks.filter((c) => !c.passed);
console.log(`\n结论：${checks.length - failed.length}/${checks.length} 项通过`);
process.exitCode = failed.length ? 1 : 0;
