// 按 Agent 串行化：同一个 Agent 同时只能有一轮在跑。
//
// 为什么必须有：kimi 的 daimon runner 会被 runner.lock 拒绝第二次并发；
// 任何 Agent 被连按两下也都会并发起两个子进程，浪费额度还可能写坏会话状态。
// 不同 Agent 之间仍然并行（圆桌要靠这一点）。
export function createAgentQueue() {
  const chains = new Map();

  return {
    /** @param {string} agentId @param {() => Promise<any>} task */
    run(agentId, task) {
      const previous = chains.get(agentId) ?? Promise.resolve();
      // 前一轮失败也要继续排队，不能把整条链挂死
      const current = previous.then(task, task);
      chains.set(
        agentId,
        current.then(
          () => {},
          () => {},
        ),
      );
      return current;
    },

    /** 供测试与诊断：当前有排队的 Agent */
    pending() {
      return [...chains.keys()];
    },

    idle(agentId) {
      return chains.get(agentId) ?? Promise.resolve();
    },
  };
}
