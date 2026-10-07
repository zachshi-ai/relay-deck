#!/usr/bin/env node
// 硬件模拟器：没有板子也能驱动中台，用来验证「硬件命令 → 中台动作 → LED 状态」整条链路。
//
//   node bin/simulate.mjs led                     查看当前 LED 真值表与 WS2812 帧
//   node bin/simulate.mjs key S7 [--copy]         模拟按一下 S7（复制焦点句，--copy 真的写入剪贴板）
//   node bin/simulate.mjs key S1                  模拟按一下 S1（接力给第 1 个 Agent，会真的调用模型）
//   node bin/simulate.mjs encoder rotate 3        旋钮右转 3 格（移动焦点）
//   node bin/simulate.mjs encoder press           旋钮短按（切换查看的 Agent）
//   node bin/simulate.mjs encoder longPress       旋钮长按（配置模式）
//   node bin/simulate.mjs hid alt+meta+2          模拟 HID 组合键通路
//   node bin/simulate.mjs demo                    跑一遍非模型的完整序列
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const BASE = process.env.RELAYDECK_URL ?? 'http://127.0.0.1:8787';

async function post(body) {
  const res = await fetch(`${BASE}/api/hardware`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function getLed() {
  const res = await fetch(`${BASE}/api/hardware/led`);
  return res.json();
}

function renderLed(led) {
  const dots = led.pixels
    .map((p) => {
      const who = p.agentId ?? (p.role === 'link' ? 'link' : '--');
      return `${p.index}:${who.padEnd(5)} ${String(p.status ?? p.effect).padEnd(11)} rgb(${p.rgb.join(',')})`;
    })
    .join('\n   ');
  return `   ${dots}\n   帧(GRB hex): ${led.frameHex}`;
}

function renderResult(result) {
  const lines = [`动作：${result.action ?? '无'}（${result.accepted ? '已执行' : `未执行：${result.reason}`}）`];
  if (result.agent) lines.push(`目标 Agent：${result.agent}`);
  if (result.position) lines.push(`焦点位置：${result.position.index + 1}/${result.position.total}`);
  if (result.viewAgent) lines.push(`当前查看：${result.viewAgent}`);
  if (result.copy) lines.push(`复制内容：${result.copy.chars} 字，来自 ${result.copy.agent} ${result.copy.messageId}`);
  if (result.question) lines.push(`圆桌问题：${result.question.slice(0, 40)}…`);
  return lines.join('\n');
}

const [kind, arg1, arg2] = process.argv.slice(2);
const wantCopy = process.argv.includes('--copy');

async function copyToClipboard(text) {
  const result = spawnSync('pbcopy', { input: text });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`pbcopy 退出码 ${result.status}`);
  return `已写入剪贴板（pbcopy，${text.length} 字）`;
}

async function perform(body) {
  const result = await post(body);
  console.log(renderResult(result));
  if (wantCopy && result.copy) console.log(await copyToClipboard(result.copy.text));
  console.log('LED：');
  console.log(renderLed(result.led));
  return result;
}

switch (kind) {
  case 'led': {
    console.log(renderLed(await getLed()));
    break;
  }
  case 'key': {
    if (!arg1) throw new Error('用法：simulate.mjs key S1..S8');
    await perform({ source: 'key', id: arg1.toUpperCase(), gesture: 'press' });
    break;
  }
  case 'encoder': {
    if (arg1 === 'rotate') await perform({ source: 'encoder', gesture: 'rotate', delta: Number(arg2 ?? 1) });
    else if (arg1 === 'press' || arg1 === 'longPress') await perform({ source: 'encoder', gesture: arg1 });
    else throw new Error('用法：simulate.mjs encoder rotate <delta> | press | longPress');
    break;
  }
  case 'hid': {
    if (!arg1) throw new Error('用法：simulate.mjs hid alt+meta+1');
    await perform({ source: 'hid', combo: arg1 });
    break;
  }
  case 'demo': {
    const steps = [
      ['旋钮右转一格', { source: 'encoder', gesture: 'rotate', delta: 1 }],
      ['旋钮右转两格', { source: 'encoder', gesture: 'rotate', delta: 2 }],
      ['旋钮按一下（切换查看）', { source: 'encoder', gesture: 'press' }],
      ['按 S7（复制焦点句）', { source: 'key', id: 'S7', gesture: 'press' }],
      ['按 S6（清空焦点）', { source: 'key', id: 'S6', gesture: 'press' }],
      ['按 S5（接力位越界，应有明确拒绝）', { source: 'key', id: 'S5', gesture: 'press' }],
      ['HID：alt+meta+right', { source: 'hid', combo: 'alt+meta+right' }],
    ];
    for (const [title, body] of steps) {
      console.log(`\n— ${title} —`);
      await perform(body);
    }
    break;
  }
  default:
    console.log(`硬件模拟器

  node bin/simulate.mjs led
  node bin/simulate.mjs key S7 [--copy]
  node bin/simulate.mjs key S1
  node bin/simulate.mjs encoder rotate 3 | press | longPress
  node bin/simulate.mjs hid alt+meta+2
  node bin/simulate.mjs demo`);
}
