#!/usr/bin/env node
// 可控坏掉的假 provider —— 供 scripts/e2e-provider-failure.mjs 使用。
//
// 它会按**调用方的 argv** 判断自己在冒充哪一家 CLI，输出对应协议的格式：
//   dsh      → NDJSON（session / text / final）
//   codex    → JSONL（thread.started / item.completed / turn.completed）
//   其它     → mmx 的整体 JSON（content[].text）
// 不这么做的话，dsh 与 codex 的解析器会认不出输出，测试结论就是假的。
//
// 行为由 FAKE_MODE_FILE 的内容决定；FAKE_COUNTER_FILE 用于"只挂住一个成员"。
import fs from 'node:fs';

const mode = fs.readFileSync(process.env.FAKE_MODE_FILE, 'utf8').trim();
// 注意：process.argv[1] 是脚本路径，参数从 argv[2] 开始。
// 这里用"成员包含"判断，别用索引——索引写错会让某一家拿到别家的输出格式，
// 而症状是"解析不出正文"，很难一眼看出是 fixture 的锅。
const dshFlavor = process.argv.includes('--profile');
const codexFlavor = process.argv.includes('exec');

function emit(text) {
  if (dshFlavor) {
    console.log(JSON.stringify({ type: 'session', sessionId: 's-fake' }));
    if (text) console.log(JSON.stringify({ type: 'text', text }));
    if (text) console.log(JSON.stringify({ type: 'final', text }));
    return;
  }
  if (codexFlavor) {
    console.log(JSON.stringify({ type: 'thread.started', thread_id: 't-fake' }));
    if (text) console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } }));
    console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 5, output_tokens: 3 } }));
    return;
  }
  console.log(
    JSON.stringify({
      content: text ? [{ type: 'text', text }] : [],
      usage: { input_tokens: 5, output_tokens: 3 },
      stop_reason: 'end_turn',
      base_resp: { status_code: 0 },
    }),
  );
}

const chunks = [];
process.stdin.on('data', (chunk) => chunks.push(chunk));
process.stdin.on('end', async () => {
  const raw = Buffer.concat(chunks).toString();
  let prompt = raw;
  if (raw.trim().startsWith('[')) {
    try {
      prompt = JSON.parse(raw)
        .map((m) => m.content)
        .join('\n');
    } catch {
      /* 原样使用 */
    }
  }
  // kimi 这类把正文放 argv 的适配器：stdin 是空的，正文在最后一个参数里
  if (!prompt.trim() && process.argv.length) prompt = process.argv[process.argv.length - 1];
  const isChair = prompt.includes('## 共识');

  // 圆桌用：主持人永远正常，成员里只有一个挂住（原子地抢占名额）
  if (mode === 'hang-one') {
    if (isChair) {
      emit('一切正常');
      return;
    }
    let victim = false;
    try {
      fs.writeFileSync(process.env.FAKE_COUNTER_FILE, 'x', { flag: 'wx' });
      victim = true;
    } catch {
      victim = false;
    }
    if (victim) {
      setTimeout(() => {}, 120000);
      return;
    }
    emit('一切正常');
    return;
  }

  if (mode === 'hang') {
    setTimeout(() => {}, 120000);
    return;
  }
  if (mode === 'slow-ok') {
    await new Promise((resolve) => setTimeout(resolve, 900));
    emit('一切正常');
    return;
  }
  if (mode === 'garbage') {
    process.stdout.write('{"content":[{"type":"text","text":"这段被截断');
    return;
  }
  if (mode === 'rate-limited') {
    console.error('Error: 429 rate limited by upstream');
    return;
  }
  if (mode === 'empty') {
    emit('');
    return;
  }
  if (mode === 'crash') {
    process.exit(3);
  }
  emit('一切正常');
});
