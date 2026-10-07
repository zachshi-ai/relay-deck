// 健壮性测试：上游输出被截断/夹带垃圾、适配器自己抛异常时，中台必须"失败得清楚"，
// 而不是崩掉、挂住、或把半截内容当成完整回答。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';

import { runTurn } from '../src/core/runner.mjs';
import { parseMmxOutput } from '../src/adapters/minimax.mjs';
import { codexAdapter } from '../src/adapters/codex.mjs';
import { dshAdapter } from '../src/adapters/dsh.mjs';

/** 用 node -e 造一个"输出可任意构造"的假 Agent */
function scriptedAdapter(code, overrides = {}) {
  return {
    id: 'scripted',
    label: 'Scripted',
    capabilities: { resume: false, streaming: false, tools: false },
    command: () => process.execPath,
    buildArgs: () => ['-e', code],
    ...overrides,
  };
}

test('整体输出被截断（JSON 不完整）→ 明确失败，而不是拿半截当回答', () => {
  const truncated = '{"content":[{"type":"text","text":"这是一段被截断的回';
  const events = parseMmxOutput(truncated);
  // 解析不出结构 → 归为 raw，不产生任何正文
  assert.equal(events.some((e) => e.type === 'text'), false, '不能把半截 JSON 当正文');
});

test('MiniMax 返回结构完整但正文为空 → 也判失败', () => {
  const events = parseMmxOutput(JSON.stringify({ content: [], base_resp: { status_code: 0 } }));
  assert.equal(events.some((e) => e.type === 'text'), false);
  assert.equal(events.some((e) => e.type === 'turn.end'), true, '仍然要标记轮次结束');
});

test('Codex 尾部有半截 JSON 行 → 已收到的正文不受影响（容错而非全盘失败）', () => {
  const lines = [
    '{"type":"thread.started","thread_id":"t-1"}',
    '{"type":"item.completed","item":{"type":"agent_message","text":"完整回答"}}',
    '{"type":"turn.comp', // 被切断的最后一行
  ];
  const events = lines.flatMap((line) => codexAdapter.parseLine(line));
  const text = events.filter((e) => e.type === 'text').map((e) => e.text).join('');
  assert.equal(text, '完整回答');
  assert.ok(events.some((e) => e.type === 'raw'), '残缺行应作为 raw 保留下来，便于排查');
});

test('dsh 事件里夹带非 JSON 脏行 → 不丢，归一为 raw', () => {
  const events = dshAdapter.parseLine('=== 这不是 JSON ===');
  assert.deepEqual(events, [{ type: 'raw', raw: '=== 这不是 JSON ===' }]);
});

test('适配器的 parseLine 抛异常不能带崩中台：跳过错行、继续处理后续行', async () => {
  const adapter = scriptedAdapter(
    `const w=(o)=>console.log(JSON.stringify(o));
     w({type:'session.started',sessionId:'s-1'});
     w({type:'text',text:'前半段 '});
     w({type:'text',text:'后半段'});
     w({type:'final',text:'前半段 后半段'});`,
    {
      // 故意让解析器在遇到第二行时抛异常
      parseLine: (() => {
        let calls = 0;
        return (line) => {
          calls += 1;
          if (calls === 2) throw new Error('解析器 bug');
          return [JSON.parse(line)];
        };
      })(),
    },
  );

  const result = await runTurn({ adapter, prompt: 'x', timeoutMs: 10000 });
  assert.equal(result.ok, true, '一行解析失败不应导致整轮失败');
  assert.equal(result.text, '前半段 后半段');
  assert.ok(
    result.warnings.some((w) => w.includes('适配器解析失败')),
    `应记录警告，实际 warnings=${JSON.stringify(result.warnings)}`,
  );
});

test('适配器的 parseOutput 抛异常 → 明确失败并说明原因，而不是崩掉', async () => {
  const adapter = scriptedAdapter('console.log("随便什么")', {
    parseOutput: () => {
      throw new Error('整体解析炸了');
    },
  });
  const result = await runTurn({ adapter, prompt: 'x', timeoutMs: 10000 });
  assert.equal(result.ok, false);
  assert.match(result.error, /适配器整体解析失败/);
  assert.match(result.error, /整体解析炸了/);
});

test('stderr 过长会被截断，不会把内存撑爆', async () => {
  const adapter = scriptedAdapter(
    `for (let i=0;i<20000;i++) console.error('这一行是垃圾日志 '.repeat(5));
     console.log(JSON.stringify({type:'final',text:'还是给出答案'}));`,
    { parseOutput: undefined, parseLine: (line) => [JSON.parse(line)] },
  );
  const result = await runTurn({ adapter, prompt: 'x', timeoutMs: 30000 });
  assert.equal(result.text, '还是给出答案');
  assert.ok(result.stderr.length <= 20000, `stderr 应被截到 20000 以内，实际 ${result.stderr.length}`);
});

test('上游只吐日志、不吐正文 → 失败信息里带出上游原文片段，便于排查', async () => {
  const adapter = scriptedAdapter('console.error("Error: 上游拒绝了这次请求（429）")', {
    parseOutput: (stdout) => (stdout.trim() ? [{ type: 'raw', raw: stdout }] : [{ type: 'error', message: '无输出', fatal: true }]),
  });
  const result = await runTurn({ adapter, prompt: 'x', timeoutMs: 10000 });
  assert.equal(result.ok, false);
  assert.match(result.error, /429|无输出/);
});
