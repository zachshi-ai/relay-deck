#!/usr/bin/env node
// 弱网 / 上游失败矩阵验收（自包含，不碰任何硬件）。
//
// 做法：脚本自己起一个中台实例（临时端口 + 临时数据目录），把 MiniMax 适配器的
// 可执行文件指向一个"可控坏掉"的假 provider，然后逐种失败模式打真实 HTTP 请求。
// 验证三件事：①失败必须被如实报出来，不能伪装成成功；②中台不能被拖死或崩掉；
// ③失败状态要落到板级状态帧上（Failed = 红灯），这条不需要插板子也能验。
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const startedAt = new Date().toISOString();
const checks = [];

function check(name, passed, detail = '') {
  checks.push({ name, passed: Boolean(passed), detail });
  console.log(`${passed ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const dir = await mkdtemp(path.join(tmpdir(), 'relaydeck-provider-'));
const modeFile = path.join(dir, 'mode.txt');
const fakeProvider = path.join(dir, 'fake-mmx.mjs');
const port = 19000 + Math.floor(Math.random() * 2000);

// 假 provider：行为完全由 mode 文件决定
// 注意：必须带 shebang 且可执行——适配器是直接 spawn 这个文件的，
// 否则会走"无法启动"分支，整个矩阵都会得到同一个（错误的）结论。
await writeFile(
  fakeProvider,
  `#!/usr/bin/env node
import { readFileSync } from 'node:fs';
const mode = readFileSync(process.env.FAKE_MODE_FILE, 'utf8').trim();
const ok = JSON.stringify({
  content: [{ type: 'text', text: '一切正常' }],
  usage: { input_tokens: 5, output_tokens: 3 },
  stop_reason: 'end_turn',
  base_resp: { status_code: 0 },
});
const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', async () => {
  if (mode === 'hang') { setTimeout(() => {}, 120000); return; }                       // 上游挂住不回
  if (mode === 'slow-ok') { await new Promise((r) => setTimeout(r, 900)); console.log(ok); return; } // 慢但成功
  if (mode === 'garbage') { process.stdout.write('{"content":[{"type":"text","text":"这段被截断'); return; } // 输出半截
  if (mode === 'rate-limited') { console.error('Error: 429 rate limited by upstream'); return; }      // 限流
  if (mode === 'empty') { console.log(JSON.stringify({ content: [], base_resp: { status_code: 0 } })); return; } // 空回答
  if (mode === 'crash') { process.exit(3); }                                           // 直接崩
  console.log(ok);
});
`,
  { mode: 0o755 },
);

const server = spawn(process.execPath, ['server.mjs'], {
  cwd: ROOT,
  env: {
    ...process.env,
    RELAYDECK_PORT: String(port),
    RELAYDECK_DATA: dir,
    RELAYDECK_HID_BRIDGE: '0', // 明确关掉实板桥：本脚本绝不碰设备
    RELAYDECK_TIMEOUT: '2500', // 让"挂住"这一档快速进入超时分支
    RELAYDECK_MMX_BIN: fakeProvider,
    FAKE_MODE_FILE: modeFile,
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
} catch (err) {
  check(`脚本本身执行失败：${err.message}`, false);
} finally {
  server.kill('SIGTERM');
  await new Promise((resolve) => server.on('close', resolve));
  await rm(dir, { recursive: true, force: true });
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
