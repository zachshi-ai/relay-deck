// 会话与消息存储：内存索引 + JSONL 追加落盘（零依赖）
//
// 关键设计：**会话隔离**。
// Agent 的续跑 session 按「会话 × Agent」隔离，否则你换一个话题，
// 上游的上下文会被带进来（这是多会话场景下最容易出错的一处）。
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const DEFAULT_CONVERSATION_ID = 'c-default';

/** 两家 Agent 的 usage 字段不同，这里统一折算成 token 数 */
export function usageTokens(usage) {
  if (!usage || typeof usage !== 'object') return null;
  if (typeof usage.totalTokens === 'number') return usage.totalTokens;
  const input = usage.input_tokens ?? usage.inputTokens;
  const output = usage.output_tokens ?? usage.outputTokens;
  if (typeof input === 'number' || typeof output === 'number') return (input ?? 0) + (output ?? 0);
  return null;
}

function sessionKey(conversationId, agent) {
  return `${conversationId}::${agent}`;
}

export class Store {
  #file;
  #messages = [];
  #conversations = new Map();
  #agentSessions = new Map();

  constructor({ dataDir = process.env.RELAYDECK_DATA ?? path.resolve(process.cwd(), 'data') } = {}) {
    this.dataDir = dataDir;
    this.#file = path.join(dataDir, 'store.jsonl');
    this.#conversations.set(DEFAULT_CONVERSATION_ID, {
      id: DEFAULT_CONVERSATION_ID,
      title: '默认会话',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }

  async load() {
    try {
      const raw = await readFile(this.#file, 'utf8');
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          this.#apply(JSON.parse(line));
        } catch {
          // 损坏行跳过，不影响其余数据
        }
      }
    } catch {
      // 首次运行没有文件
    }
    return this;
  }

  #apply(record) {
    if (record.kind === 'conversation') {
      this.#conversations.set(record.conversation.id, record.conversation);
      return;
    }
    if (record.kind === 'message') {
      // 兼容旧数据：没有 conversationId 的消息归入默认会话
      const message = { conversationId: DEFAULT_CONVERSATION_ID, ...record.message };
      this.#messages.push(message);
      this.#touch(message.conversationId, message.createdAt);
      return;
    }
    if (record.kind === 'agent-session') {
      const conversationId = record.conversationId ?? DEFAULT_CONVERSATION_ID;
      const key = sessionKey(conversationId, record.agent);
      // sessionId 为 null 是墓碑记录：表示这条续跑线已被清掉，重载时不能再复活
      if (record.sessionId) this.#agentSessions.set(key, record.sessionId);
      else this.#agentSessions.delete(key);
    }
  }

  /** 重新从磁盘加载（消息 / 会话 / 续跑线）。用于手工修数据后恢复，或验证落盘一致性。 */
  async reload() {
    this.#messages = [];
    this.#agentSessions.clear();
    const keep = new Map(this.#conversations);
    this.#conversations = new Map();
    this.#conversations.set(DEFAULT_CONVERSATION_ID, {
      id: DEFAULT_CONVERSATION_ID,
      title: '默认会话',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await this.load();
    // 内存里刚创建的会话在文件里可能还没有记录，补回来
    for (const [id, conversation] of keep) {
      if (!this.#conversations.has(id)) this.#conversations.set(id, conversation);
    }
    return this;
  }

  async #persist(record) {
    await mkdir(this.dataDir, { recursive: true });
    await appendFile(this.#file, `${JSON.stringify(record)}\n`);
  }

  #touch(conversationId, at = new Date().toISOString()) {
    const conversation = this.#conversations.get(conversationId);
    if (!conversation) return;
    conversation.updatedAt = at;
  }

  // —— 会话 ——

  ensureConversation(id) {
    if (!id) return DEFAULT_CONVERSATION_ID;
    if (!this.#conversations.has(id)) {
      this.#conversations.set(id, {
        id,
        title: '未命名会话',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }
    return id;
  }

  async createConversation(title = '新会话') {
    const id = `c-${randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    const conversation = { id, title: title.trim() || '新会话', createdAt: now, updatedAt: now };
    this.#conversations.set(id, conversation);
    await this.#persist({ kind: 'conversation', conversation });
    return conversation;
  }

  async renameConversation(id, title) {
    const conversation = this.#conversations.get(id);
    if (!conversation) return null;
    conversation.title = String(title ?? '').trim() || conversation.title;
    await this.#persist({ kind: 'conversation', conversation });
    return conversation;
  }

  getConversation(id) {
    return this.#conversations.get(id) ?? null;
  }

  listConversations() {
    return [...this.#conversations.values()]
      .map((c) => ({
        ...c,
        messageCount: this.#messages.filter((m) => m.conversationId === c.id).length,
        lastMessageAt: this.#messages.filter((m) => m.conversationId === c.id).at(-1)?.createdAt ?? null,
      }))
      .sort((a, b) => (b.lastMessageAt ?? b.createdAt).localeCompare(a.lastMessageAt ?? a.createdAt));
  }

  latestConversationId() {
    return this.listConversations()[0]?.id ?? DEFAULT_CONVERSATION_ID;
  }

  // —— 消息 ——

  async addMessage({ conversationId = DEFAULT_CONVERSATION_ID, agent, role, text, sessionId = null, meta = null }) {
    this.ensureConversation(conversationId);
    const message = {
      id: `m-${randomUUID().slice(0, 8)}`,
      conversationId,
      agent,
      role, // 'user' | 'agent'
      text,
      sessionId,
      meta,
      createdAt: new Date().toISOString(),
    };
    this.#messages.push(message);
    this.#touch(conversationId, message.createdAt);
    await this.#persist({ kind: 'message', message });
    return message;
  }

  getMessage(id) {
    return this.#messages.find((m) => m.id === id) ?? null;
  }

  listMessages({ conversationId = null, agent = null, limit = 300 } = {}) {
    let list = this.#messages.slice();
    if (conversationId) list = list.filter((m) => m.conversationId === conversationId);
    if (agent) list = list.filter((m) => m.agent === agent);
    return list.slice(-limit);
  }

  /** 全文搜索（大小写不敏感），可按会话限定 */
  searchMessages({ q, conversationId = null, limit = 50 }) {
    const needle = String(q ?? '').trim().toLowerCase();
    if (!needle) return [];
    let list = this.#messages.slice();
    if (conversationId) list = list.filter((m) => m.conversationId === conversationId);
    return list
      .filter((m) => m.text.toLowerCase().includes(needle))
      .slice(-limit)
      .reverse();
  }

  lastAgentMessage(conversationId, agent) {
    for (let i = this.#messages.length - 1; i >= 0; i -= 1) {
      const m = this.#messages[i];
      if (m.conversationId === conversationId && m.agent === agent && m.role === 'agent') return m;
    }
    return null;
  }

  /**
   * 接力链：从这条消息沿 meta.relayOf / meta.inReplyTo 一路回溯到根。
   * 返回从最早到当前的顺序，带环保护。
   */
  lineage(messageId, maxDepth = 20) {
    const chain = [];
    const seen = new Set();
    let current = this.getMessage(messageId);
    while (current && !seen.has(current.id) && chain.length < maxDepth) {
      chain.push(current);
      seen.add(current.id);
      const nextId = current.meta?.relayOf ?? current.meta?.inReplyTo ?? null;
      current = nextId ? this.getMessage(nextId) : null;
    }
    return chain.reverse();
  }

  // —— Agent 会话（按会话隔离）——

  getAgentSession(conversationId, agent) {
    return this.#agentSessions.get(sessionKey(conversationId, agent)) ?? null;
  }

  /**
   * 清掉一条续跑线（写墓碑，重载后不会复活）。
   * 场景：上游会话已失效，继续带着它只会让这个会话永久失败。
   */
  async clearAgentSession(conversationId, agent) {
    const key = sessionKey(conversationId, agent);
    if (!this.#agentSessions.has(key)) return false;
    this.#agentSessions.delete(key);
    await this.#persist({ kind: 'agent-session', conversationId, agent, sessionId: null });
    return true;
  }

  async setAgentSession(conversationId, agent, sessionId) {
    if (!sessionId) return;
    const key = sessionKey(conversationId, agent);
    if (this.#agentSessions.get(key) === sessionId) return;
    this.#agentSessions.set(key, sessionId);
    await this.#persist({ kind: 'agent-session', conversationId, agent, sessionId });
  }

  /** 用量汇总：每轮 token 与耗时 */
  usageSummary(conversationId) {
    const summary = {};
    for (const message of this.#messages) {
      if (message.conversationId !== conversationId || message.role !== 'agent') continue;
      const entry = (summary[message.agent] ??= { turns: 0, tokens: 0, tokensKnown: 0, totalMs: 0, msKnown: 0 });
      entry.turns += 1;
      const tokens = usageTokens(message.meta?.usage);
      if (tokens !== null) {
        entry.tokens += tokens;
        entry.tokensKnown += 1;
      }
      const ms = message.meta?.elapsedMs;
      if (typeof ms === 'number') {
        entry.totalMs += ms;
        entry.msKnown += 1;
      }
    }
    for (const entry of Object.values(summary)) {
      entry.avgMs = entry.msKnown ? Math.round(entry.totalMs / entry.msKnown) : null;
    }
    return summary;
  }

  snapshot({ conversationId = null } = {}) {
    const id = conversationId ?? this.latestConversationId();
    const messages = this.listMessages({ conversationId: id });
    return {
      conversationId: id,
      conversations: this.listConversations(),
      messages,
      agentSessions: Object.fromEntries(
        [...this.#agentSessions.entries()]
          .filter(([key]) => key.startsWith(`${id}::`))
          .map(([key, value]) => [key.split('::')[1], value]),
      ),
      usage: this.usageSummary(id),
    };
  }
}
