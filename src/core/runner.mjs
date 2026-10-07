// 轮次执行器：把「一次问答」跑成一个统一的、可观测的事件流。
// 核心约定（见 docs/adapter-contract.md）：
//   1. prompt 走 stdin，并立即关闭；
//   2. 不以退出码判成败（实测失败时退出码仍为 0）；
//   3. 出现 error 事件、或整轮无文本产出，即判失败；
//   4. 超时先用 SIGTERM，宽限后再 SIGKILL，不留僵尸进程。
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const STDERR_CAP = 20000;

/** 取 stderr 里最后一条有内容的行，用来做错误摘要（截断，避免把整段日志塞进界面） */
function lastMeaningfulLine(stderr) {
  const lines = String(stderr ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const last = lines.at(-1) ?? '';
  return last.length > 200 ? `${last.slice(0, 200)}…` : last;
}

export async function runTurn({
  adapter,
  prompt,
  sessionId = null,
  cwd = process.cwd(),
  timeoutMs = 180000,
  killGraceMs = 5000,
  onEvent = () => {},
  onChild = () => {},
  signal = null,
  env = process.env,
} = {}) {
  if (!adapter) throw new Error('runTurn 需要 adapter');
  if (typeof prompt !== 'string' || prompt.length === 0) {
    throw new Error('runTurn 需要非空 prompt');
  }

  // prompt 的传递通道有三种，由适配器声明：
  //   stdin（默认）  直接写 stdin
  //   stdin-json     用 stdinPayload 包成 JSON（例如 mmx 要 messages 数组）
  //   argv           必须进命令行参数（例如 kimi 的 stdin 是控制命令通道，不能塞正文）
  const promptChannel = adapter.promptChannel ?? 'stdin';
  const args = adapter.buildArgs({ sessionId, cwd, prompt });
  const childEnv = { ...env, ...(adapter.env ? adapter.env() : null) };
  const child = spawn(adapter.command(), args, {
    cwd,
    env: childEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  onChild(child);

  const events = [];
  const warnings = [];
  let streamedText = '';
  let finalText = null;
  let resolvedSessionId = sessionId;
  let errorMessage = null;
  let lastUsage = null;
  let stderr = '';
  let timedOut = false;
  let cancelled = false;
  let spawnError = null;
  let graceTimer = null;

  const emit = (event) => {
    const full = { agent: adapter.id, ...event };
    events.push(full);
    if (full.type === 'text') streamedText += full.text;
    if (full.type === 'final') finalText = full.text;
    if (full.type === 'usage') lastUsage = full.usage;
    if (full.type === 'session.started' && full.sessionId) resolvedSessionId = full.sessionId;
    if (full.type === 'error') {
      // fatal === false 的条目级错误只是警告，不判失败（实测 Codex 的
      // "Under-development features enabled" 就属于这一类）
      if (full.fatal === false) warnings.push(full.message);
      else if (!errorMessage) errorMessage = full.message;
    }
    try {
      onEvent(full);
    } catch {
      // 回调异常不能影响轮次执行
    }
  };

  // 两种解析模式：
  //   parseLine   —— 行分隔的流式输出（dsh 的 NDJSON、codex 的 JSONL），能边跑边推
  //   parseOutput —— 整体输出（mmx 的 pretty-printed JSON 一个对象跨多行），跑完再解析
  const wholeOutput = typeof adapter.parseOutput === 'function';
  let stdoutBuffer = '';
  let rl = null;

  if (wholeOutput) {
    child.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk.toString();
    });
  } else {
    rl = createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      // 适配器解析抛异常不能把中台带崩：事件回调里抛出会变成未捕获异常。
      // 单行解析失败只记一条警告，继续处理后面的行（上游输出偶尔会夹带残缺行）。
      try {
        for (const event of adapter.parseLine(line)) emit(event);
      } catch (err) {
        emit({ type: 'raw', raw: line, parseError: err.message });
        emit({ type: 'error', message: `适配器解析失败（已跳过该行）：${err.message}`, fatal: false });
      }
    });
  }

  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
    if (stderr.length > STDERR_CAP) stderr = stderr.slice(-STDERR_CAP);
  });

  child.on('error', (err) => {
    spawnError = err;
  });

  const timeoutTimer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGTERM');
    graceTimer = setTimeout(() => child.kill('SIGKILL'), killGraceMs);
    graceTimer.unref?.();
  }, timeoutMs);
  timeoutTimer.unref?.();

  // 取消：与超时走同一套"先 SIGTERM、宽限后 SIGKILL"，但标记不同——
  // "用户取消"和"跑太久"是两件必须分清的事，否则日志会把它们混为一谈。
  const onAbort = () => {
    if (cancelled || child.exitCode !== null) return;
    cancelled = true;
    child.kill('SIGTERM');
    graceTimer = setTimeout(() => child.kill('SIGKILL'), killGraceMs);
    graceTimer.unref?.();
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  // stdin 必须显式关闭：Codex 在有 stdin 时会继续等待输入。
  // prompt 走 argv 的适配器（kimi）不能往 stdin 写正文——那是它的控制命令通道。
  child.stdin.on('error', () => {});
  if (promptChannel === 'argv') child.stdin.end();
  else child.stdin.end(adapter.stdinPayload ? adapter.stdinPayload(prompt) : prompt);

  // spawn 失败（例如二进制路径不存在）时 Node 只保证发 'error'，'close' 未必会来；
  // 所以两个事件谁先到就以谁为准，避免整个轮次挂死。
  const exitCode = await new Promise((resolve) => {
    let settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      resolve(code);
    };
    child.on('close', (code) => finish(code));
    child.on('error', () => finish(null));
  });

  clearTimeout(timeoutTimer);
  if (graceTimer) clearTimeout(graceTimer);
  if (signal) signal.removeEventListener('abort', onAbort);
  rl?.close();

  // 进程根本没起来（二进制不存在等）时没有输出可解析，直接进入失败分支，
  // 否则适配器的"空输出"错误会把真正的启动错误盖掉。
  if (wholeOutput && !spawnError) {
    // 整体解析同样要防：适配器自己的 bug 不能变成中台的崩溃
    try {
      for (const event of adapter.parseOutput(stdoutBuffer)) emit(event);
    } catch (err) {
      emit({
        type: 'error',
        message: `适配器整体解析失败：${err.message}（可能是上游输出被截断）`,
        fatal: true,
      });
    }
  }

  const text = (finalText ?? streamedText).trim();
  const ok = !timedOut && !cancelled && !spawnError && !errorMessage && text.length > 0;

  // 错误信息按"谁更接近根因"排序：取消 > 启动失败 > 超时 > 适配器报错 > 无输出
  if (cancelled) errorMessage = '已取消';
  else if (spawnError) errorMessage = `无法启动 ${adapter.command()}：${spawnError.message}`;
  else if (timedOut) errorMessage = `超时（${timeoutMs}ms）后已终止`;
  else if (!ok) {
    const stderrTail = lastMeaningfulLine(stderr);
    const exitNote = typeof exitCode === 'number' && exitCode !== 0 ? `上游退出码 ${exitCode}` : '';
    // 适配器给的"没有任何输出"这类**泛化**信息会把真正的原因盖住：
    // 上游往往把 429 / 鉴权失败写在 stderr 里，退出码也带着信息。
    // 这里把一手线索补上去，否则排错只能靠猜。
    const generic = !errorMessage || /没有任何输出|没有产出任何文本|无输出/.test(errorMessage);
    if (generic && (stderrTail || exitNote)) {
      const parts = [errorMessage ?? '没有任何输出'];
      if (exitNote) parts.push(exitNote);
      if (stderrTail) parts.push(`上游 stderr：${stderrTail}`);
      errorMessage = parts.join('｜');
    } else if (!errorMessage) {
      errorMessage = stderrTail || '没有产出任何文本';
    }
  }

  return {
    ok,
    agent: adapter.id,
    sessionId: resolvedSessionId,
    text,
    usage: lastUsage,
    error: ok ? null : errorMessage,
    warnings,
    stderr: stderr.trim(),
    timedOut,
    cancelled,
    exitCode,
    args,
    events,
  };
}

/** 人类可读的一行摘要，供 CLI 与日志使用 */
export function describeEvent(event) {
  switch (event.type) {
    case 'session.started':
      return `session  ${event.sessionId}`;
    case 'thinking':
      return `think    ${event.text.slice(0, 60)}`;
    case 'text':
      return `text     ${event.text.slice(0, 120)}`;
    case 'usage':
      return `usage    ${JSON.stringify(event.usage)}`;
    case 'error':
      return `ERROR    ${event.message}`;
    case 'final':
      return `final    ${event.text.slice(0, 120)}`;
    case 'turn.end':
      return `end      ${JSON.stringify(event.reason)}`;
    case 'status':
      return `status   ${event.phase}`;
    default:
      return `raw      ${JSON.stringify(event.raw).slice(0, 120)}`;
  }
}
