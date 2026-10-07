#!/usr/bin/env node
// 生成"单文件、自包含"的网页版作业正文（发布用）。
//
// 解决发布时的两个坑：
//   1. 飞书/多数平台不会自动上传正文里嵌的截图 → 这里把图片内联成 data: URI；
//   2. 指向 evidence/ 与 docs/ 的相对链接在文档平台里会 404 → 这里改写成文件名的行内代码，
//      至少不会出现"看起来能点、点进去 404"的死链。
//
// 依赖：pandoc（仅**构建时**需要，项目本身仍是零依赖）。
import { execFile } from 'node:child_process';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, '..');
const SOURCE = path.join(ROOT, '交付', '1-作业正文.md');
const OUTPUT = path.join(ROOT, '交付', '5-作业正文-网页版.html');

const STYLE = `
  :root { color-scheme: light dark; }
  body { max-width: 900px; margin: 0 auto; padding: 32px 20px 80px;
         font: 16px/1.75 -apple-system, "PingFang SC", "Helvetica Neue", Arial, sans-serif; }
  h1 { font-size: 26px; border-bottom: 2px solid #d0d7de; padding-bottom: 8px; }
  h2 { font-size: 21px; margin-top: 40px; border-bottom: 1px solid #e3e6ea; padding-bottom: 6px; }
  h3 { font-size: 17px; margin-top: 28px; }
  table { border-collapse: collapse; width: 100%; margin: 16px 0; font-size: 14px; display: block; overflow-x: auto; }
  th, td { border: 1px solid #d0d7de; padding: 6px 10px; text-align: left; vertical-align: top; }
  th { background: #f6f8fa; }
  blockquote { margin: 16px 0; padding: 4px 16px; border-left: 4px solid #d0d7de; color: #57606a; }
  code { background: #f6f8fa; padding: 1px 5px; border-radius: 4px; font-size: 90%; }
  pre { background: #f6f8fa; padding: 12px; border-radius: 8px; overflow-x: auto; }
  pre code { background: none; padding: 0; }
  img { max-width: 100%; border: 1px solid #d0d7de; border-radius: 8px; }
  hr { margin: 36px 0; border: 0; border-top: 1px solid #e3e6ea; }
  @media (prefers-color-scheme: dark) {
    body { background: #0d1117; color: #e6edf3; }
    h1, h2 { border-color: #30363d; }
    th, td { border-color: #30363d; }
    th { background: #161b22; }
    code, pre { background: #161b22; }
    blockquote { border-color: #30363d; color: #8b949e; }
    img { border-color: #30363d; }
  }
`;

function checkPandoc() {
  return run('pandoc', ['--version']).then(
    () => true,
    () => false,
  );
}

const hasPandoc = await checkPandoc();
if (!hasPandoc) {
  console.error(
    '需要 pandoc 才能生成网页版（仅构建时依赖，安装：brew install pandoc）。\n' +
      '不想装也没关系：交付/1-作业正文.md 本身就是最终交付物。',
  );
  process.exit(2);
}

if (!(await stat(SOURCE).then(() => true, () => false))) {
  console.error(`找不到源文件：${SOURCE}`);
  process.exit(2);
}

// 1) pandoc：gfm → html5，单文件，内联资源
// 注意：pandoc 解析图片的相对路径是按**工作目录**，不是按源文件所在目录。
// 这里把工作目录设成源文件所在目录，否则 '../evidence/xxx.png' 会解析到仓库外 → 内联失败。
await run('pandoc', [
  '--from=gfm',
  '--to=html5',
  '--standalone',
  '--embed-resources',
  '--metadata',
  'title=RelayDeck 接力台 · 第8课毕业大作业',
  '--metadata',
  'lang=zh-CN',
  SOURCE,
  '-o',
  OUTPUT,
], { cwd: path.dirname(SOURCE) });

// 2) 后处理：把仍指向仓库外/仓库内相对路径的链接改成行内代码，避免"点了 404"
let html = await readFile(OUTPUT, 'utf8');
const rewritten = new Set();
html = html.replace(/<a href="(\.\.?\/[^"]+)"[^>]*>([^<]*)<\/a>/g, (_match, href, label) => {
  const name = path.basename(href) || href;
  rewritten.add(`${label} → ${name}`);
  return `<code>${label}</code>`;
});
// 3) 插入可读性样式
html = html.replace('</head>', `<style>${STYLE}</style>\n</head>`);
await writeFile(OUTPUT, html);

// —— 自检：生成物必须满足"单文件可发布"的几条硬性质 ——
const checks = [];
const finalHtml = await readFile(OUTPUT, 'utf8');
checks.push(['内联了图片（data:image）', /src="data:image\//.test(finalHtml)]);
checks.push(['没有残留的图片相对路径', !/<img[^>]+src="\.\.?\//.test(finalHtml)]);
checks.push(['没有残留的仓库内相对链接', !/href="\.\.?\//.test(finalHtml)]);
checks.push(['表格正常渲染', (finalHtml.match(/<table>/g) ?? []).length >= 8]);
checks.push(['带上了样式', /<style>/.test(finalHtml)]);
checks.push(['文件确实变大了（说明资源被内联）', finalHtml.length > (await readFile(SOURCE, 'utf8')).length]);

const size = (await stat(OUTPUT)).size;
console.log('=== 生成单文件网页版 ===');
console.log(`源文件：交付/1-作业正文.md`);
console.log(`输出：  交付/5-作业正文-网页版.html（${(size / 1024).toFixed(0)} KB）`);
if (rewritten.size) console.log(`改写成行内代码的相对链接：${rewritten.size} 处`);
for (const [name, ok] of checks) console.log(`${ok ? '✔' : '✖'} ${name}`);

const failed = checks.filter(([, ok]) => !ok);
process.exitCode = failed.length ? 1 : 0;
