// 续跑线自愈：上游会话失效时，不要让整个会话永久失败。
//
// 真实场景：DeepSeek Harness 的 session 被删/过期、Codex 的 thread 失效、
// 换机器后数据文件里的 session 已经不存在。此时继续带着旧 session 发请求，
// 每一轮都会失败，而且没有任何机制会去清理它——用户看到的是"这个会话坏了"。
//
// 规则（刻意保守）：
//   - 只有"用了续跑线并且失败"才重试；
//   - 超时不重试（超时重试会让用户等两倍时间，且根因通常不是会话失效）；
//   - 重试只做一次，且**不带**续跑线（新开一条）；
//   - 重试成功才算自愈，并如实上报 contextReset，让用户知道上下文被重置了。
export async function runTurnWithRecovery({ sessionId = null, runOnce }) {
  const first = await runOnce({ sessionId, attempt: 1 });

  // 用户主动取消不算"续跑线坏了"：重试等于无视用户的取消指令
  const canRetry = Boolean(sessionId) && !first.ok && !first.timedOut && !first.cancelled;
  if (!canRetry) {
    return { result: first, contextReset: false, previousSession: null, attempts: 1 };
  }

  const second = await runOnce({ sessionId: null, attempt: 2 });
  if (!second.ok) {
    // 不带续跑线仍然失败 → 不是会话线的问题，保留原始错误（更有诊断价值）
    return { result: second, contextReset: false, previousSession: null, attempts: 2, firstError: first.error };
  }

  return { result: second, contextReset: true, previousSession: sessionId, attempts: 2, firstError: first.error };
}
