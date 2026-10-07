// 接力链导出：把一条链路（原始问题 → 各 Agent 的回答 → 主持人汇总）导出成 Markdown。
//
// 为什么需要：接力台的价值是"把上下文在 Agent 之间传递"，而传递的产物最终要能
// 拿出来给别人看——贴进文档、发给同事、当作复盘材料。纯函数，便于单测。

function formatTime(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('zh-CN', { hour12: false });
}

function roleLabel(message) {
  if (message.role === 'user') return message.agent === 'roundtable' ? '圆桌提问' : '我';
  return message.agent;
}

/**
 * @param {object} p
 * @param {object[]} p.chain    按「根 → 当前」顺序的消息（store.lineage 的返回）
 * @param {string}   [p.title]  文档标题
 * @param {string}   [p.conversationTitle]
 * @returns {string} Markdown 文本
 */
export function exportChainMarkdown({ chain = [], title = '接力链', conversationTitle = '' } = {}) {
  const lines = [];
  lines.push(`# ${title}`);
  lines.push('');
  if (conversationTitle) lines.push(`> 会话：${conversationTitle}`);
  lines.push(`> 节点数：${chain.length} · 导出时间：${formatTime(new Date().toISOString())}`);
  lines.push('');

  if (!chain.length) {
    lines.push('（这条链上没有消息）');
    return `${lines.join('\n')}\n`;
  }

  lines.push('## 链路一览');
  lines.push('');
  lines.push(
    chain
      .map((message, index) => {
        const arrow = index === 0 ? '' : '→ ';
        return `${arrow}**${index + 1}. ${roleLabel(message)}**${message.role === 'user' ? '（提问）' : ''}`;
      })
      .join(' '),
  );
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const message of chain) {
    const who = roleLabel(message);
    const badges = [];
    if (message.meta?.kind === 'roundtable-summary') badges.push('主持人汇总');
    if (message.meta?.contextReset) badges.push('上下文已重置');
    if (message.meta?.relayOf) badges.push(`接力自 ${message.meta.relayOf}`);
    if (message.meta?.elapsedMs) badges.push(`${message.meta.elapsedMs}ms`);
    if (message.meta?.warnings?.length) badges.push(`警告 ×${message.meta.warnings.length}`);

    lines.push(`### ${who}${badges.length ? ` · ${badges.join(' · ')}` : ''}`);
    lines.push('');
    lines.push(`<sub>${message.id} · ${formatTime(message.createdAt)}</sub>`);
    lines.push('');
    lines.push(message.text.trim());
    lines.push('');
  }

  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}
