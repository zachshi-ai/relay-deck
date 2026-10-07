#!/usr/bin/env node
// 硬件就绪自检：一条命令说清"哪些已验证、哪些需要你操作"。
//
// 之所以需要它：实板这一段有三类卡点——板子没插、macOS 权限没给、固件版本不对，
// 症状都很像（"发了没反应"）。与其让使用者猜，不如把能查的都查一遍并给出明确步骤。
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, '..');
const HIDTOOL = path.join(ROOT, 'tools', 'hidtool');
const HOTKEYD = path.join(ROOT, 'tools', 'hotkeyd');
const BASE = process.env.RELAYDECK_URL ?? 'http://127.0.0.1:8787';

const ready = [];
const needYou = [];
const missing = [];

function ok(label, detail = '') {
  ready.push({ label, detail });
}
function yours(label, action) {
  needYou.push({ label, action });
}
function blocked(label, detail = '') {
  missing.push({ label, detail });
}

async function sh(command, args, timeout = 20000) {
  try {
    const { stdout, stderr } = await run(command, args, { timeout });
    return { code: 0, out: `${stdout}${stderr}` };
  } catch (err) {
    return { code: err.code ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

// 1) 工具是否编译好
if (existsSync(HIDTOOL)) ok('实板工具已编译', 'tools/hidtool');
else blocked('实板工具未编译', '先跑 swiftc -O tools/hidtool.swift -o tools/hidtool');
if (existsSync(HOTKEYD)) ok('热键守护进程已编译', 'tools/hotkeyd');
else blocked('热键守护进程未编译', '先跑 swiftc -O tools/hotkeyd.swift -o tools/hotkeyd');

// 2) 板子在不在
let boardFound = false;
if (existsSync(HIDTOOL)) {
  const list = await sh(HIDTOOL, ['list']);
  boardFound = list.code === 0 && /EasyInput/.test(list.out);
  const identity = list.out.match(/VID=(\S+)\s+PID=(\S+)/);
  if (boardFound) ok('板子已插上并被识别', identity ? `${identity[1]} / ${identity[2]}` : '');
  else blocked('没找到 EasyInput 板子', '插上 USB，确认板子电源开关是开的，且不是下载模式');
}

// 3) Feature 写通路
if (boardFound) {
  const diag = await sh(HIDTOOL, ['diagnose'], 30000);
  const setOk = /SetReport\(feature 0x12, 含 id[^)]*\)：(0x0+)\s*✓/.test(diag.out);
  if (setOk) ok('Feature 写通路可用', 'SetReport(0x12) 成功');
  else blocked('Feature 写失败', '见 ./tools/hidtool diagnose 输出');

  // 4) 回读通路：能拿到状态 JSON 才算通
  const status = await sh(HIDTOOL, ['status'], 40000);
  if (/=== 设备回传的 JSON/.test(status.out)) {
    ok('状态回读可用（输入报告能收到）', '0x13 → 0x11 通路正常');
  } else {
    yours(
      '状态回读收不到（属预期之一）',
      '若要启用：系统设置 → 隐私与安全性 → 输入监控 → 勾选你的终端，然后重开终端再跑本脚本',
    );
  }
}

// 5) 中台与桥
try {
  const res = await fetch(`${BASE}/api/state`, { signal: AbortSignal.timeout(3000) });
  const state = await res.json();
  ok('中台在运行', `${state.agents?.length ?? 0} 个 Agent`);
  if (state.bridge?.enabled) ok('中台→实板 桥已启用', '状态一变就会写进板子');
  else yours('中台→实板 桥未启用', `用 RELAYDECK_HID_BRIDGE=1 node server.mjs 启动即可`);
} catch {
  blocked('中台没在运行', 'node server.mjs（想连板子就加 RELAYDECK_HID_BRIDGE=1）');
}

// 6) 权限与肉眼确认
yours(
  '热键守护进程需要「辅助功能」权限',
  '系统设置 → 隐私与安全性 → 辅助功能 → 勾选你的终端，然后运行 ./tools/hotkeyd',
);
if (boardFound) {
  yours(
    '灯效只能肉眼确认（主机侧没有读回通路）',
    './tools/hidtool agent-sweep —— 应看到 暗蓝 → 红 → 绿 → 琥珀 → 熄灭',
  );
}

// —— 输出 ——
console.log('\n=== 已就绪 ===');
if (!ready.length) console.log('  （无）');
for (const item of ready) console.log(`  ✅ ${item.label}${item.detail ? `  — ${item.detail}` : ''}`);

console.log('\n=== 需要你操作 ===');
if (!needYou.length) console.log('  （无）');
needYou.forEach((item, index) => console.log(`  ${index + 1}. ${item.label}\n     → ${item.action}`));

console.log('\n=== 缺条件（先解决这些） ===');
if (!missing.length) console.log('  （无）');
for (const item of missing) console.log(`  ❌ ${item.label}  — ${item.detail}`);

const summary = {
  ready: ready.length,
  needYou: needYou.length,
  blocked: missing.length,
  details: { ready, needYou, missing },
};
console.log(`\n结论：已就绪 ${summary.ready} 项 · 需要你操作 ${summary.needYou} 项 · 缺条件 ${summary.blocked} 项`);
process.exitCode = missing.length ? 1 : 0;
