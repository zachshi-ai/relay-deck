#!/usr/bin/env node
// 干净副本复现自检：从 git 导出**只含版本控制内文件**的副本，在里面从头跑一遍验收。
//
// 为什么需要：工作区里躺着的东西（本地 data/、编译产物、没提交的改动）会掩盖
// "交付物其实不自足"的问题——比如文档链到了仓库外的文件、某个脚本依赖未提交的 fixture。
// 这条检查就是把交付物当成"别人 clone 下来的样子"来验。
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, '..');
const results = [];

function record(name, passed, detail = '') {
  results.push({ name, passed, detail });
  console.log(`${passed ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const dir = await mkdtemp(path.join(tmpdir(), 'relaydeck-clone-'));
try {
  // 1) 导出：git archive 只包含被跟踪且未被 ignore 的文件
  await new Promise((resolve, reject) => {
    const git = spawn('git', ['archive', 'HEAD'], { cwd: ROOT });
    const tar = spawn('tar', ['-x', '-C', dir]);
    git.stdout.pipe(tar.stdin);
    git.on('error', reject);
    tar.on('error', reject);
    tar.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`tar 退出码 ${code}`))));
  });
  const { stdout: files } = await run('sh', ['-c', `find ${dir} -type f | wc -l`]);
  record('从 git 导出一份干净副本', Number(files.trim()) > 0, `${files.trim()} 个文件`);

  // 2) 不该带进来的东西
  const { stdout: junk } = await run('sh', [
    '-c',
    `find ${dir} -type f \\( -name hidtool -o -name hotkeyd -o -name "*.log" \\) -o -type d -name data | head -5`,
  ]);
  record('副本里没有编译产物 / 日志 / 本地数据', junk.trim() === '', junk.trim() || '干净');

  // 3) 单测
  try {
    const { stdout } = await run(process.execPath, ['--test'], { cwd: dir, timeout: 180000 });
    const tests = stdout.match(/^ℹ tests (\d+)$/m)?.[1];
    const fails = stdout.match(/^ℹ fail (\d+)$/m)?.[1];
    record('副本里单测全绿', fails === '0', `${tests} 项，失败 ${fails}`);
  } catch (err) {
    record('副本里单测全绿', false, err.message.split('\n')[0]);
  }

  // 4) 上游失败矩阵（离线，不需要外部服务）
  try {
    const { stdout } = await run(process.execPath, ['scripts/e2e-provider-failure.mjs'], {
      cwd: dir,
      timeout: 180000,
    });
    const summary = stdout.match(/结论：(\d+)\/(\d+) 项通过/);
    const [, passed, total] = summary ?? [];
    record('副本里上游失败矩阵全过', passed === total, summary?.[0] ?? '没解析到结论');
  } catch (err) {
    record('副本里上游失败矩阵全过', false, err.message.split('\n')[0]);
  }

  // 5) 交付物一致性（这一步最能暴露"文档/脚本引用到仓库外的东西"）
  try {
    const { stdout } = await run(process.execPath, ['scripts/check-delivery.mjs'], { cwd: dir, timeout: 180000 });
    const ok = /全部一致/.test(stdout);
    record('副本里交付物一致性校验通过', ok, ok ? '' : stdout.split('\n').filter((l) => l.includes('✖')).join('；'));
  } catch (err) {
    const out = `${err.stdout ?? ''}`;
    record('副本里交付物一致性校验通过', false, out.split('\n').filter((l) => l.includes('✖')).join('；') || err.message.split('\n')[0]);
  }

  // 6) 中台能被拉起来（不依赖工作区的任何遗留状态）
  try {
    const { stdout } = await run(process.execPath, ['-e', "import('./src/adapters/index.mjs').then(m => console.log('AGENTS:' + m.ADAPTERS.map(a => a.id).join(',')))"], {
      cwd: dir,
      timeout: 30000,
    });
    record('副本里适配器注册完整', /AGENTS:dsh,codex,minimax,kimi/.test(stdout), stdout.trim());
  } catch (err) {
    record('副本里适配器注册完整', false, err.message.split('\n')[0]);
  }
} finally {
  if (process.env.KEEP_TMP !== '1') await rm(dir, { recursive: true, force: true });
  else console.log(`[debug] 副本保留在：${dir}`);
}

const failed = results.filter((r) => !r.passed);
console.log(`\n结论：${results.length - failed.length}/${results.length} 项通过`);
if (failed.length) {
  console.log('失败项：');
  for (const item of failed) console.log(`  - ${item.name}：${item.detail}`);
}
process.exitCode = failed.length ? 1 : 0;
