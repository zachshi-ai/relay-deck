#!/usr/bin/env node
// 交付物一致性校验：作业正文 / 证据清单 / README 里写的数字与引用，必须和仓库现状一致。
//
// 为什么需要：这种跨多轮、由脚本逐段改写的长文档最容易"漂移"——测试数、证据文件名、
// 脚本名一旦对不上，评审照着查就会当场露馅。与其靠人肉核对，不如让机器每轮查一遍。
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, '..');
const problems = [];
const notes = [];

function fail(message) {
  problems.push(message);
}
function note(message) {
  notes.push(message);
}

// —— 1. 真实测试数 ——
let actualTests = null;
try {
  const { stdout } = await run(process.execPath, ['--test'], { cwd: ROOT, timeout: 180000 });
  const match = stdout.match(/^ℹ tests (\d+)$/m);
  if (match) actualTests = Number(match[1]);
  const failures = stdout.match(/^ℹ fail (\d+)$/m);
  if (failures && Number(failures[1]) !== 0) fail(`单测有 ${failures[1]} 项失败`);
} catch (err) {
  fail(`跑单测失败：${err.message.split('\n')[0]}`);
}

// —— 2. 各文档里声明的测试数必须等于真实值 ——
const DOCS = ['README.md', '交付/1-作业正文.md', '交付/2-证据清单.md', '交付/4-提交前自检.md'];
for (const doc of DOCS) {
  const text = await readFile(path.join(ROOT, doc), 'utf8');
  const claims = new Set();
  for (const match of text.matchAll(/\*\*(\d+) 项(?:全绿|单测)?\*\*/g)) claims.add(Number(match[1]));
  for (const match of text.matchAll(/单元测试（(\d+) 项）/g)) claims.add(Number(match[1]));
  for (const match of text.matchAll(/# (\d+) 项单测/g)) claims.add(Number(match[1]));
  for (const match of text.matchAll(/(\d+) 单测/g)) claims.add(Number(match[1]));
  for (const claim of claims) {
    if (actualTests !== null && claim !== actualTests) {
      fail(`${doc} 声称 ${claim} 项测试，实际 ${actualTests} 项`);
    }
  }
  if (!claims.size) note(`${doc} 里没找到测试数声明（可选）`);
}

// —— 3. 文档里引用的证据文件必须存在 ——
const evidenceFiles = new Set(await readdir(path.join(ROOT, 'evidence')));
const referenced = new Set();
for (const doc of [...DOCS, '交付/3-复现手册.md', 'docs/hardware-stage2b.md', 'docs/agent-onboarding.md']) {
  const text = await readFile(path.join(ROOT, doc), 'utf8');
  for (const match of text.matchAll(/evidence\/([A-Za-z0-9_.\-]+\.(?:json|sse|png))/g)) {
    referenced.add(match[1]);
  }
  for (const match of text.matchAll(/\[[^\]]*\]\(\.\.\/evidence\/([A-Za-z0-9_.\-]+\.(?:json|sse|png))\)/g)) {
    referenced.add(match[1]);
  }
}
for (const file of referenced) {
  if (!evidenceFiles.has(file)) fail(`文档引用了不存在的证据文件：evidence/${file}`);
}
note(`文档引用了 ${referenced.size} 个证据文件，evidence/ 目录现有 ${evidenceFiles.size} 个`);

// —— 4. 文档里提到的脚本必须存在 ——
const scripts = new Set(await readdir(path.join(ROOT, 'scripts')));
for (const doc of [...DOCS, '交付/3-复现手册.md', 'docs/hardware-stage2b.md', 'docs/agent-onboarding.md']) {
  const text = await readFile(path.join(ROOT, doc), 'utf8');
  for (const match of text.matchAll(/scripts\/([A-Za-z0-9_.\-]+\.mjs)/g)) {
    if (!scripts.has(match[1])) fail(`${doc} 提到了不存在的脚本：scripts/${match[1]}`);
  }
}

// —— 5. 交付文档里的相对链接必须能解析 ——
for (const doc of ['交付/1-作业正文.md', '交付/2-证据清单.md', '交付/3-复现手册.md', '交付/4-提交前自检.md']) {
  const text = await readFile(path.join(ROOT, doc), 'utf8');
  const dir = path.dirname(path.join(ROOT, doc));
  for (const match of text.matchAll(/\]\((\.\.?\/[^)\s]+)\)/g)) {
    const target = path.resolve(dir, match[1]);
    if (!existsSync(target)) fail(`${doc} 里的链接指向不存在的路径：${match[1]}`);
  }
}

// —— 6. 桌面工具与源码的一致性（改了源码要记得重新编译）——
const pairs = [
  ['tools/hidtool.swift', 'tools/hidtool'],
  ['tools/hotkeyd.swift', 'tools/hotkeyd'],
];
for (const [source, binary] of pairs) {
  const sourcePath = path.join(ROOT, source);
  const binaryPath = path.join(ROOT, binary);
  if (!existsSync(sourcePath)) continue;
  if (!existsSync(binaryPath)) {
    note(`${binary} 未编译（用 swiftc -O ${source} -o ${binary}）`);
    continue;
  }
  const { stat } = await import('node:fs/promises');
  const [s, b] = await Promise.all([stat(sourcePath), stat(binaryPath)]);
  if (s.mtimeMs > b.mtimeMs) fail(`${source} 比 ${binary} 新，忘了重新编译`);
}

// —— 7. 网页版别是过期产物（发布出去就丢人了）——
const sourceDoc = path.join(ROOT, '交付', '1-作业正文.md');
const publishHtml = path.join(ROOT, '交付', '5-作业正文-网页版.html');
if (existsSync(publishHtml) && existsSync(sourceDoc)) {
  const { stat } = await import('node:fs/promises');
  const [src, html] = await Promise.all([stat(sourceDoc), stat(publishHtml)]);
  if (src.mtimeMs > html.mtimeMs) {
    fail('交付/5-作业正文-网页版.html 比作业正文旧，忘了重新生成（node scripts/build-publish-html.mjs）');
  } else {
    note('网页版与作业正文同步');
  }
}

// —— 输出 ——
console.log('=== 交付物一致性校验 ===');
if (actualTests !== null) console.log(`真实单测数：${actualTests}`);
for (const item of notes) console.log(`  · ${item}`);
if (problems.length) {
  console.log('\n发现问题：');
  for (const item of problems) console.log(`  ✖ ${item}`);
  console.log(`\n结论：${problems.length} 处不一致，必须修掉再交付。`);
  process.exitCode = 1;
} else {
  console.log('\n结论：全部一致 ✓（测试数、证据引用、脚本名、相对链接、编译产物新鲜度）');
}
