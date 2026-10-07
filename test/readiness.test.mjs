// 适配器就绪自检单测（注入假 exists/which，不依赖本机装了什么）
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { inspectAdapters, readinessSummary, formatReadiness, whichCommand } from '../src/adapters/readiness.mjs';

const adapters = [
  { id: 'a', label: 'A', command: () => '/opt/tools/a' },
  { id: 'b', label: 'B', command: () => 'b-cli' },
  { id: 'c', label: 'C', command: () => '/missing/c' },
];

test('绝对路径看文件是否存在，非绝对路径查 PATH', () => {
  const reports = inspectAdapters(adapters, {
    exists: (p) => p === '/opt/tools/a',
    which: (cmd) => (cmd === 'b-cli' ? '/usr/local/bin/b-cli' : ''),
  });

  assert.deepEqual(
    reports.map((r) => [r.id, r.available]),
    [
      ['a', true],
      ['b', true],
      ['c', false],
    ],
  );
  assert.equal(reports[0].note, null);
  assert.match(reports[2].note, /找不到文件：\/missing\/c/);
});

test('PATH 上没有对应命令时给出明确说明', () => {
  const reports = inspectAdapters([adapters[1]], { exists: () => true, which: () => '' });
  assert.equal(reports[0].available, false);
  assert.match(reports[0].note, /PATH 上没有 b-cli/);
});

test('摘要统计可用数量与缺失清单', () => {
  const reports = inspectAdapters(adapters, {
    exists: (p) => p === '/opt/tools/a',
    which: () => '',
  });
  const summary = readinessSummary(reports);
  assert.equal(summary.ready, 1);
  assert.equal(summary.total, 3);
  assert.deepEqual(summary.missing.map((m) => m.id), ['b', 'c']);
});

test('启动日志表格把可用/不可用与原因都打出来', () => {
  const text = formatReadiness(
    inspectAdapters(adapters, { exists: (p) => p === '/opt/tools/a', which: (c) => (c === 'b-cli' ? '/x/b' : '') }),
  );
  assert.match(text, /✓ a\s+\/opt\/tools\/a/);
  assert.match(text, /✓ b\s+b-cli/);
  assert.match(text, /✗ c\s+\/missing\/c\s+← 找不到文件/);
});

test('whichCommand 找不到命令时返回空串而不是抛异常', () => {
  assert.equal(whichCommand('definitely-not-a-real-command-xyz'), '');
  assert.equal(
    whichCommand('whatever', {
      exec: () => {
        throw new Error('boom');
      },
    }),
    '',
  );
  assert.equal(whichCommand('node'), whichCommand('node')); // 真实存在的命令应能找到
  assert.ok(whichCommand('node').length > 0);
});
