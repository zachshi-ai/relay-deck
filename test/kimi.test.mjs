// Kimi 适配器单测。fixture 是 2026-10-07 本机实测抓取的真实输出（日志与回答混在 stdout）。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { kimiAdapter, parseKimiOutput, kimiConfigPath } from '../src/adapters/kimi.mjs';
import { runTurn } from '../src/core/runner.mjs';

const REAL_SUCCESS = `2026-10-07T13:56:08.767Z INFO standalone-runtime daemon lock acquired path=/Users/zach/.kimi/daimon/agents/main/runner.lock generation=foreground:28405 pid=28405
2026-10-07T13:56:08.772Z INFO standalone-runtime startup begin defaultWorkDir=/Users/zach/Documents/kimi/workspace sessionNamespace=daimon
2026-10-07T13:56:08.778Z INFO standalone-runtime startup model current=k2d8-preview thinkingLevel=high
2026-10-07T13:56:08.977Z INFO standalone-runtime startup kimi-code kernel ready
2026-10-07T13:56:08.139Z INFO standalone-runtime stdin commands: "health", "stop", "cancel <jobId>", "help"
收到
2026-10-07T13:56:01.039Z INFO standalone-runtime active Kimi turns shutdown cancel skipped active=0
2026-10-07T13:56:01.049Z INFO standalone-runtime daemon lock released path=/Users/zach/.kimi/daimon/agents/main/runner.lock
`;

const REAL_FAILURE = `2026-10-07T13:56:08.767Z INFO standalone-runtime daemon lock acquired path=/Users/zach/.kimi/daimon/agents/main/runner.lock
2026-10-07T13:56:09.100Z ERROR standalone-runtime model request failed status=401 unauthorized
2026-10-07T13:56:09.200Z INFO standalone-runtime shutdown complete status=stopped
`;

test('Kimi：日志与回答混在 stdout 时，只取回答', () => {
  const events = parseKimiOutput(REAL_SUCCESS);
  assert.equal(events[0].type, 'text');
  assert.equal(events[0].text, '收到');
  assert.equal(events.find((e) => e.type === 'final').text, '收到');
  assert.equal(events.find((e) => e.type === 'turn.end').reason, 'completed');
  assert.equal(events.some((e) => e.type === 'error'), false);
});

test('Kimi：多行回答不会被日志过滤吃掉', () => {
  const mixed = `2026-10-07T13:56:08.767Z INFO standalone-runtime startup begin
第一行回答
第二行回答
2026-10-07T13:56:09.000Z INFO standalone-runtime shutdown begin
`;
  const events = parseKimiOutput(mixed);
  assert.equal(events[0].text, '第一行回答\n第二行回答');
});

test('Kimi：只有日志没有回答时判失败，并尽量带出 ERROR 日志', () => {
  const events = parseKimiOutput(REAL_FAILURE);
  assert.equal(events[0].type, 'error');
  assert.equal(events[0].fatal, true);
  assert.match(events[0].message, /401 unauthorized/);
});

test('Kimi：完全没有输出也不静默通过', () => {
  const events = parseKimiOutput('');
  assert.equal(events[0].type, 'error');
  assert.equal(events[0].fatal, true);
});

test('Kimi：正文走 argv，stdin 只用于关闭（不能塞正文）', () => {
  assert.equal(kimiAdapter.promptChannel, 'argv');
  const args = kimiAdapter.buildArgs({ prompt: '你好' });
  assert.deepEqual(args, ['--node', process.execPath, '--prompt', '你好']);
  assert.equal(kimiAdapter.stdinPayload, undefined);
  // 桌面版共享配置必须显式传入，否则 daimon 找不到适配器配置
  assert.match(kimiAdapter.env().DAIMON_CONFIG_PATH, /kimi-desktop\/daimon-share\/daimon\/config\.json$/);
  assert.equal(kimiConfigPath(), kimiAdapter.env().DAIMON_CONFIG_PATH);
});

test('执行器：prompt 走 argv 时，正文出现在命令参数里而不是 stdin', async () => {
  const adapter = {
    id: 'fake-argv',
    label: 'FakeArgv',
    capabilities: { resume: false, streaming: false, tools: false },
    promptChannel: 'argv',
    command: () => process.execPath,
    buildArgs: ({ prompt }) => ['-e', 'console.log("ARGV:" + process.argv[1])', '--', prompt],
    parseOutput: (stdout) => [{ type: 'text', text: stdout.trim() }, { type: 'final', text: stdout.trim() }],
  };
  const result = await runTurn({ adapter, prompt: '来自 argv 的正文', timeoutMs: 10000 });
  assert.equal(result.ok, true);
  assert.equal(result.text, 'ARGV:来自 argv 的正文');
});

test('执行器：适配器自带环境变量会合并进子进程', async () => {
  const adapter = {
    id: 'fake-env',
    label: 'FakeEnv',
    capabilities: { resume: false, streaming: false, tools: false },
    command: () => process.execPath,
    env: () => ({ RELAYDECK_TEST_MARK: 'injected-42' }),
    buildArgs: () => ['-e', 'console.log(process.env.RELAYDECK_TEST_MARK ?? "missing")'],
    parseOutput: (stdout) => [{ type: 'final', text: stdout.trim() }],
  };
  const result = await runTurn({ adapter, prompt: 'x', timeoutMs: 10000 });
  assert.equal(result.text, 'injected-42');
});
