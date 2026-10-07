// 圆桌：同一上下文快照并行 fan-out 给多个 Agent，再由主持人汇总。
// 关键点：
//   1. 所有 Agent 收到的是**同一份**上下文快照（可复现）；
//   2. 并发受控（默认 3），避免把本机打爆；
//   3. 单个 Agent 失败不影响整轮，失败会被如实写进主持人 prompt；
//   4. **单个成员挂住不能拖住整轮**：到点判超时、跳过，并回调上层去掐掉它。
import { buildChairPrompt } from './relay.mjs';

/** 受控并发映射：保持输入顺序返回结果 */
export async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const size = Math.max(1, Math.min(limit, items.length));
  const runners = Array.from({ length: size }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * 给一个"成员轮"套上超时。
 * 超时后**不会**等底层 promise 结束（它可能还要跑很久）：
 * 直接返回失败结果，并通过 onTimeout 通知上层去取消那一轮。
 */
export function withTimeout(promise, timeoutMs, { agent, stage, onTimeout = () => {} } = {}) {
  if (!timeoutMs || timeoutMs <= 0) return promise;

  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      try {
        onTimeout({ agent, stage });
      } catch {
        // 通知失败不能影响轮次返回
      }
      resolve({
        agent,
        ok: false,
        text: '',
        error: `${stage === 'chair' ? '主持人' : '成员'}超时（${Math.round(timeoutMs / 1000)}s）已跳过`,
        timedOut: true,
      });
    }, timeoutMs);
    timer.unref?.();
  });

  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * @param {object}   p
 * @param {string[]} p.agents      参与圆桌的 Agent（顺序即展示顺序）
 * @param {string}   p.question    本轮问题（所有人一致）
 * @param {string}   p.chair       主持人 Agent
 * @param {Function} p.askAgent    (agent, prompt, {stage}) => Promise<{ok,agent,text,error}>
 * @param {Function} p.onPhase     阶段回调，用于 SSE 推进度
 * @param {number}   p.concurrency 并发上限
 * @param {number}   p.memberTimeoutMs 单个成员的超时（0 = 不限）
 * @param {Function} p.onMemberTimeout 成员超时回调（上层据此取消那一轮）
 */
export async function runRoundtable({
  agents,
  question,
  chair,
  askAgent,
  onPhase = () => {},
  concurrency = 3,
  memberTimeoutMs = 0,
  onMemberTimeout = () => {},
}) {
  const participants = agents.filter((a) => a !== chair).length ? agents : agents;

  onPhase({ phase: 'fanout.start', agents: participants });
  const answers = await mapWithConcurrency(participants, concurrency, async (agent) => {
    // stage 让上层能区分「参与者轮」与「主持人轮」——主持人可能同时是参与者
    const result = await withTimeout(askAgent(agent, question, { stage: 'fanout' }), memberTimeoutMs, {
      agent,
      stage: 'fanout',
      onTimeout: onMemberTimeout,
    });
    onPhase({ phase: 'fanout.answer', agent, ok: result.ok, chars: result.text?.length ?? 0, timedOut: result.timedOut });
    return result;
  });
  onPhase({ phase: 'fanout.done', ok: answers.filter((a) => a.ok).length, total: answers.length });

  const chairPrompt = buildChairPrompt({ question, answers });
  onPhase({ phase: 'chair.start', chair });
  const summary = await withTimeout(askAgent(chair, chairPrompt, { stage: 'chair' }), memberTimeoutMs, {
    agent: chair,
    stage: 'chair',
    onTimeout: onMemberTimeout,
  });
  onPhase({ phase: 'chair.done', ok: summary.ok, timedOut: summary.timedOut });

  return { answers, summary, chairPrompt };
}
