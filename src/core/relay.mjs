// 接力：把「焦点句」作为**引用上下文**交给下一个 Agent。
// 设计原则（见 charter.md）：引用，不是全量历史。
//   - 只带被选中的那一句 + 上游结论 + 原始问题
//   - 每段都有明确上限，避免 token 失控
const DEFAULT_LIMIT = 4000;

export function clip(text, limit = DEFAULT_LIMIT) {
  const value = String(text ?? '').trim();
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n…（已截断，原文共 ${value.length} 字）`;
}

/**
 * 组装接力 prompt。
 * @param {object}   p
 * @param {object?}  p.upstream  上游 Agent 的回答消息（含 id/agent/text）
 * @param {object?}  p.focus     焦点句消息（含 id/agent/text）
 * @param {string?}  p.instruction 本次要让下游做什么
 * @param {number?}  p.limit     每段上限
 */
export function buildRelayPrompt({ upstream = null, focus = null, instruction = '', limit = DEFAULT_LIMIT } = {}) {
  const blocks = [];

  if (upstream) {
    blocks.push(
      `<relay-context from="${upstream.agent}" message-id="${upstream.id}">\n${clip(upstream.text, limit)}\n</relay-context>`,
    );
  }
  if (focus && focus.id !== upstream?.id) {
    blocks.push(
      `<focus-message author="${focus.agent}" message-id="${focus.id}">\n${clip(focus.text, limit)}\n</focus-message>`,
    );
  }

  const ask = instruction.trim() || '请基于上面的内容继续，直接给出结论，不要复述原文。';
  if (blocks.length === 0) return ask;
  return `${blocks.join('\n\n')}\n\n${ask}`;
}

/**
 * 给「没有会话续跑能力」的 Agent 补一段历史上下文。
 *
 * 像 MiniMax 这种一次性调用型 Agent，自己记不住上一轮；如果不管，接力台里
 * 它就会答非所问。这里把最近几条消息压成一段有上限的历史，而不是把整库塞进去。
 */
export function buildHistoryPrompt({ messages = [], instruction = '', limit = 2000, maxTurns = 6 } = {}) {
  const ask = instruction.trim();
  const recent = messages
    .filter((m) => String(m.text ?? '').trim())
    .slice(-maxTurns * 2);
  if (!recent.length) return ask;

  // 从最新往回装，装不下就停：超限时该丢的是最老的对话，不是最新的。
  // （第一版是正序拼接后整体截断，结果把最近一轮丢掉了——这条有回归测试锁着。）
  const lines = [];
  let budget = limit;
  for (let i = recent.length - 1; i >= 0; i -= 1) {
    const message = recent[i];
    const line = `${message.role === 'user' ? '我' : message.agent}：${clip(message.text, 400)}`;
    if (lines.length && line.length + 1 > budget) break;
    lines.unshift(line);
    budget -= line.length + 1;
  }

  return `<conversation-history>\n${lines.join('\n')}\n</conversation-history>\n\n${ask}`;
}

/** 圆桌主持人 prompt：只允许三段结构化输出 */
export function buildChairPrompt({ question, answers, limit = 3000 }) {
  const parts = answers
    .map(
      (a) =>
        `<answer agent="${a.agent}" status="${a.ok ? 'ok' : 'failed'}">\n${
          a.ok ? clip(a.text, limit) : `（本轮失败：${a.error}）`
        }\n</answer>`,
    )
    .join('\n\n');

  return [
    '下面是多个 AI Agent 对同一问题的独立回答，请做汇总。',
    '',
    `<question>\n${clip(question, limit)}\n</question>`,
    '',
    parts,
    '',
    '严格按下面三段输出，每段用标题开头，不要复述原文、不要客套：',
    '## 共识',
    '（各方一致的部分，一两句说清）',
    '## 分歧',
    '（明显不一致或互相矛盾之处；若确实没有分歧，就直说没有）',
    '## 建议',
    '（如果要落地，推荐哪一个方案、为什么；给出可执行的第一步）',
  ].join('\n');
}
