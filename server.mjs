#!/usr/bin/env node
// RelayDeck 中台服务：零第三方依赖。
//   GET  /                    网页
//   GET  /api/state           当前状态（Agent / 会话 / 消息 / 焦点）
//   POST /api/ask             { agent, prompt?, relayOf? }        → SSE 事件流
//   POST /api/roundtable      { question, agents?, chair }        → SSE 事件流
//   POST /api/focus           { messageId }                       → 设置焦点句
//   POST /api/cancel          终止当前所有在跑的子进程
//   POST /api/hardware        { source, id?, gesture?, combo?, delta? } → 硬件命令入口
//   GET  /api/hardware/led    → 当前 LED 真值表 + WS2812 帧
//   GET  /api/export?message= → 把一条接力链导出成 Markdown
//
// 隐私：日志只打元数据（agent / 长度 / 耗时），不打印 prompt 与回答正文。
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ADAPTERS, getAdapter } from './src/adapters/index.mjs';
import { runTurn } from './src/core/runner.mjs';
import { Store } from './src/core/store.mjs';
import { buildRelayPrompt, buildHistoryPrompt, clip } from './src/core/relay.mjs';
import { runRoundtable } from './src/core/roundtable.mjs';
import { createAgentQueue } from './src/core/queue.mjs';
import { runTurnWithRecovery } from './src/core/session-recovery.mjs';
import { exportChainMarkdown } from './src/core/export.mjs';
import { resolveHardwareEvent, resolveHidCombo, describeCommand } from './src/hardware/keymap.mjs';
import { computeLedState, toWs2812Frame, frameToHex, describeLedState } from './src/hardware/led.mjs';
import { buildBoardStatus, aggregateAgentStatus, AGENT_STATUS_NAMES, epochSequence } from './src/hardware/agent-status.mjs';
import { createBoardBridge } from './src/hardware/bridge.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.join(HERE, 'web');
const PORT = Number(process.env.RELAYDECK_PORT ?? 8787);
const DEFAULT_CHAIR = process.env.RELAYDECK_CHAIR ?? 'dsh';
const TURN_TIMEOUT_MS = Number(process.env.RELAYDECK_TIMEOUT ?? 180000);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

const store = await new Store().load();
const agentQueue = createAgentQueue();

// 运行注册表：每一轮都有 runId + AbortController，支持"单条精确取消"；
// 之前只能"终止全部"，一个慢轮次会把整台中台拖住。
const activeRuns = new Map(); // runId → { runId, agentId, conversationId, startedAt, controller, child }
let runCounter = 0;

function registerRun({ agentId, conversationId }) {
  const runId = `run-${(runCounter += 1)}`;
  const entry = {
    runId,
    agentId,
    conversationId,
    startedAt: Date.now(),
    controller: new AbortController(),
    child: null,
  };
  activeRuns.set(runId, entry);
  return entry;
}

function finishRun(runId) {
  activeRuns.delete(runId);
}

/** 取消：给 runId 就精确取消；给 agent 就取消该 Agent 当前那一轮；都不给则全部 */
function cancelRuns({ runId = null, agent = null, all = false } = {}) {
  const killed = [];
  for (const entry of activeRuns.values()) {
    const matches = all || (runId && entry.runId === runId) || (agent && entry.agentId === agent);
    if (!matches) continue;
    entry.controller.abort();
    killed.push({ runId: entry.runId, agentId: entry.agentId });
  }
  return killed;
}

function activeRunList() {
  return [...activeRuns.values()].map((entry) => ({
    runId: entry.runId,
    agentId: entry.agentId,
    conversationId: entry.conversationId,
    elapsedMs: Date.now() - entry.startedAt,
  }));
}

let focusMessageId = null;
// 硬件侧状态：谁在跑、当前在看第几个 Agent、当前会话
const runStatus = new Map(); // agentId → 'idle' | 'running' | 'ok' | 'error'
let viewIndex = 0;
let activeConversationId = store.latestConversationId();
// 板级状态帧：sequence 只在状态变化时递增；用户动过手就视为"已读"。
// 从纪元起步（而不是 0）：固件会拿它和 BLE 侧序号比较，小的会被丢弃。
let boardStatusSequence = epochSequence();
let boardStatusState = null;
let boardAcknowledged = true;

// 中台 → 实板 的桥：RELAYDECK_HID_BRIDGE=1 时启用（默认关闭，
// 免得没板子的机器上每次状态变化都去 spawn 一个不存在的工具）
const boardBridge = createBoardBridge({
  toolPath: process.env.RELAYDECK_HID_TOOL ?? path.join(HERE, 'tools', 'hidtool'),
  enabled: process.env.RELAYDECK_HID_BRIDGE === '1',
  log,
});

function setRunStatus(agentId, status) {
  runStatus.set(agentId, status);
}

/** 当前会话的全部消息（硬件侧没有"只看某个 Agent"的概念） */
function conversationMessages(conversationId = activeConversationId) {
  return store.listMessages({ conversationId });
}

/** LED 快照：真值表见 src/hardware/led.mjs；board 是阶段 2b 真正要发给板子的聚合帧 */
function ledSnapshot() {
  const state = computeLedState({
    agentIds: ADAPTERS.map((a) => a.id),
    runStatus: Object.fromEntries(runStatus),
    viewIndex,
    focusAgentId: focusMessageId ? (store.getMessage(focusMessageId)?.agent ?? null) : null,
    hasSession: ADAPTERS.some((a) => store.getAgentSession(activeConversationId, a.id)),
    blinkPhase: Math.floor(Date.now() / 500) % 2,
  });
  const frame = toWs2812Frame(state);

  // 板子一次只渲染一个状态，所以这里把各 Agent 的状态收敛成"最该被看到的一件事"。
  // sequence 只在状态变化时递增（固件会丢弃完全相同的帧，重复发送等于刷新 TTL）。
  const runStatuses = ADAPTERS.map((a) => runStatus.get(a.id) ?? 'idle');
  const boardState = aggregateAgentStatus({ runStatuses, acknowledged: boardAcknowledged });
  let changed = false;
  if (boardState !== boardStatusState) {
    boardStatusState = boardState;
    boardStatusSequence += 1;
    changed = true;
    log('led', `板级状态 → ${AGENT_STATUS_NAMES[boardState]}（seq=${boardStatusSequence}）`);
  }
  const board = buildBoardStatus({
    runStatuses,
    acknowledged: boardAcknowledged,
    conversationId: activeConversationId,
    sequence: boardStatusSequence,
  });
  // 真的把帧写到板子上（仅在 --bridge 打开且有板子时）
  if (changed && boardBridge.enabled) boardBridge.push(board);

  return {
    ...state,
    frame: [...frame],
    frameHex: frameToHex(frame),
    summary: describeLedState(state),
    board,
  };
}

function log(...args) {
  console.log(`[relaydeck ${new Date().toISOString().slice(11, 19)}]`, ...args);
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw new Error('请求体过大');
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('请求体不是合法 JSON');
  }
}

function openSse(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
  res.write(': relaydeck stream\n\n');
  let closed = false;
  res.on('close', () => {
    closed = true;
  });
  return {
    send(event, data) {
      if (closed) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    end() {
      if (!closed) res.end();
    },
  };
}

function statePayload(conversationId = null) {
  const snapshot = store.snapshot({ conversationId });
  return {
    agents: ADAPTERS.map((a) => ({
      id: a.id,
      label: a.label,
      command: a.command(),
      capabilities: a.capabilities,
      // 会话隔离：同一个人在不同会话里的续跑上下文互不影响
      sessionId: store.getAgentSession(snapshot.conversationId, a.id),
      lastMessageAt: store.lastAgentMessage(snapshot.conversationId, a.id)?.createdAt ?? null,
      runStatus: runStatus.get(a.id) ?? 'idle',
    })),
    focusMessageId,
    chair: DEFAULT_CHAIR,
    viewIndex,
    runs: activeRunList(),
    bridge: { enabled: boardBridge.enabled, reason: boardBridge.reason },
    led: ledSnapshot(),
    ...snapshot,
  };
}

/** 执行一轮并把结果写进存储；返回结构化结果 */
async function askOnce({
  agentId,
  instruction,
  relayOf,
  conversationId,
  onEvent,
  onChild,
  persistUser = true,
  persistAgent = true,
}) {
  const adapter = getAdapter(agentId);
  activeConversationId = conversationId;
  // 必须在任何 await 之前同步置位：硬件通路是"按下即走"，
  // 调用方紧接着就读 LED，晚一个微任务板子上就看不到 Running。
  setRunStatus(agentId, 'running');
  const focus = relayOf ? store.getMessage(relayOf) : null;
  const upstream = focus
    ? focus.role === 'agent'
      ? focus
      : store.lastAgentMessage(conversationId, focus.agent)
    : null;
  let effectivePrompt = focus ? buildRelayPrompt({ upstream, focus, instruction }) : instruction;
  // 没有续跑能力的 Agent（如 MiniMax）记不住上一轮，由中台补一段有上限的历史
  if (!focus && !adapter.capabilities.resume) {
    effectivePrompt = buildHistoryPrompt({
      messages: store.listMessages({ conversationId, limit: 12 }),
      instruction: effectivePrompt,
    });
  }

  let userMessage = null;
  if (persistUser) {
    userMessage = await store.addMessage({
      conversationId,
      agent: agentId,
      role: 'user',
      text: instruction,
      meta: {
        relayOf: focus?.id ?? null,
        upstreamId: upstream?.id ?? null,
        promptPreview: clip(effectivePrompt, 400),
      },
    });
  }

  const started = Date.now();
  const existingSession = store.getAgentSession(conversationId, agentId);
  // 每一轮登记一个 runId + AbortController，这样"取消"能精确到某一条轮次
  const run = registerRun({ agentId, conversationId });
  let recovery;
  try {
    // 同一个 Agent 串行（kimi 的 runner.lock 拒绝并发；连按两下也不该起两个进程）；
    // 续跑线失效时自动丢掉旧线重跑一次，避免整个会话被一条坏 session 永久卡死。
    recovery = await runTurnWithRecovery({
      sessionId: existingSession,
      runOnce: ({ sessionId }) =>
        agentQueue.run(agentId, () =>
          runTurn({
            adapter,
            prompt: effectivePrompt,
            sessionId,
            timeoutMs: TURN_TIMEOUT_MS,
            signal: run.controller.signal,
            onEvent,
            onChild: (child) => {
              run.child = child;
              onChild?.(child);
            },
          }),
        ),
    });
  } finally {
    finishRun(run.runId);
  }
  const result = recovery.result;
  // 硬件侧的 LED 靠这个状态点灯，成败都要如实落到灯上。
  // 用户主动取消不算失败：灯回到空闲，而不是报红。
  setRunStatus(agentId, result.cancelled ? 'idle' : result.ok ? 'ok' : 'error');
  // 有新结果但用户还没看：板子上应该亮"完成未读"（绿灯）
  if (result.ok) boardAcknowledged = false;

  if (recovery.contextReset) {
    log('session', agentId, `续跑线失效，已重置上下文重跑（旧线 ${String(recovery.previousSession).slice(0, 20)}…）`);
    await store.clearAgentSession(conversationId, agentId);
  }
  if (result.sessionId) await store.setAgentSession(conversationId, agentId, result.sessionId);

  let agentMessage = null;
  if (result.ok && persistAgent) {
    agentMessage = await store.addMessage({
      conversationId,
      agent: agentId,
      role: 'agent',
      text: result.text,
      sessionId: result.sessionId,
      meta: {
        inReplyTo: userMessage?.id ?? null,
        relayOf: focus?.id ?? null,
        warnings: result.warnings,
        usage: result.usage,
        elapsedMs: Date.now() - started,
        // 上下文被重置过就如实记下来：用户需要知道这个 Agent 失忆了
        contextReset: recovery.contextReset,
        previousSession: recovery.previousSession ? String(recovery.previousSession).slice(0, 24) : null,
        attempts: recovery.attempts,
        firstError: recovery.contextReset ? (recovery.firstError ?? null) : null,
      },
    });
  }

  return {
    ...result,
    userMessage,
    agentMessage,
    effectivePrompt,
    focus,
    upstream,
    contextReset: recovery.contextReset,
    previousSession: recovery.previousSession,
    attempts: recovery.attempts,
    runId: run.runId,
    cancelled: result.cancelled === true,
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const route = `${req.method} ${url.pathname}`;

  try {
    if (route === 'GET /api/state') {
      return json(res, 200, statePayload(url.searchParams.get('conversation')));
    }

    if (route === 'GET /api/search') {
      const conversationId = url.searchParams.get('conversation') ?? store.latestConversationId();
      const query = url.searchParams.get('q') ?? '';
      return json(res, 200, {
        query,
        conversationId,
        matches: store.searchMessages({ q: query, conversationId }),
      });
    }

    if (route === 'GET /api/lineage') {
      const messageId = url.searchParams.get('message');
      return json(res, 200, { lineage: messageId ? store.lineage(messageId) : [] });
    }

    // 把一条接力链导出成 Markdown，直接下载/复制给别人
    if (route === 'GET /api/export') {
      const messageId = url.searchParams.get('message') ?? focusMessageId;
      const message = messageId ? store.getMessage(messageId) : null;
      if (!message) return json(res, 404, { error: '没有可导出的焦点消息' });
      const chain = store.lineage(message.id);
      const markdown = exportChainMarkdown({
        chain,
        title: `接力链 · ${message.id}`,
        conversationTitle: store.getConversation(message.conversationId)?.title ?? '',
      });
      res.writeHead(200, {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Disposition': `attachment; filename="relay-${message.id}.md"`,
      });
      res.end(markdown);
      return undefined;
    }

    if (route === 'POST /api/conversations') {
      const body = await readBody(req);
      const conversation = await store.createConversation(body.title);
      return json(res, 200, { conversation, state: statePayload(conversation.id) });
    }

    // 改名或归档（软归档，不删数据）
    if (route === 'PATCH /api/conversations') {
      const body = await readBody(req);
      const id = String(body.id ?? '');
      const conversation =
        typeof body.archived === 'boolean'
          ? await store.setConversationArchived(id, body.archived)
          : await store.renameConversation(id, body.title);
      if (!conversation) return json(res, 404, { error: '找不到会话' });

      // 归档掉的正是当前会话时，自动切到下一个可用的
      let viewId = conversation.id;
      if (conversation.archivedAt && activeConversationId === id) {
        activeConversationId = store.latestConversationId();
        viewId = activeConversationId;
      }
      log('conversation', body.archived === true ? 'archived' : body.archived === false ? 'restored' : 'renamed', id);
      return json(res, 200, { conversation, state: statePayload(viewId) });
    }

    if (route === 'POST /api/focus') {
      const body = await readBody(req);
      focusMessageId = body.messageId ? String(body.messageId) : null;
      if (focusMessageId && !store.getMessage(focusMessageId)) {
        focusMessageId = null;
        return json(res, 404, { error: '找不到该消息' });
      }
      // 用户在动焦点 = 他看到了结果，板子上的"未读绿灯"可以熄了
      boardAcknowledged = true;
      return json(res, 200, statePayload(body.conversationId));
    }

    // 精确取消：{ runId } 取消某一条；{ agent } 取消该 Agent 当前轮；都不给则全部取消
    if (route === 'POST /api/cancel') {
      const body = await readBody(req).catch(() => ({}));
      const all = body.all === true || (!body.runId && !body.agent);
      const killed = cancelRuns({ runId: body.runId ?? null, agent: body.agent ?? null, all });
      log('cancel', all ? 'all' : (body.runId ?? body.agent), `→ ${killed.length} 条`);
      return json(res, 200, { killed: killed.length, cancelled: killed, runs: activeRunList() });
    }

    // 手工修过 data/store.jsonl 之后不必重启进程：重新从磁盘加载一次
    if (route === 'POST /api/admin/reload') {
      await store.reload();
      log('admin', '已重新从磁盘加载数据');
      return json(res, 200, { reloaded: true, state: statePayload(store.latestConversationId()) });
    }

    if (route === 'GET /api/hardware/led') {
      return json(res, 200, ledSnapshot());
    }

    // 硬件命令入口：板子（或全局热键守护进程 / 模拟器）只需要打这一个接口。
    // 请求：{ source:'key'|'encoder'|'hid', id?, gesture?, delta?, combo?, prompt?, question? }
    if (route === 'POST /api/hardware') {
      const body = await readBody(req);
      const agentIds = ADAPTERS.map((a) => a.id);
      const command =
        body.source === 'hid'
          ? resolveHidCombo(body.combo, { agentCount: agentIds.length })
          : resolveHardwareEvent(
              { source: body.source, id: body.id, gesture: body.gesture, delta: body.delta },
              { agentCount: agentIds.length },
            );

      if (!command) {
        return json(res, 200, { accepted: false, reason: '未绑定的硬件输入', command: null, led: ledSnapshot() });
      }
      if (command.type === 'error') {
        log('hardware', 'rejected', command.code);
        return json(res, 200, { accepted: false, reason: command.message, command, led: ledSnapshot() });
      }

      const conversationId = store.ensureConversation(body.conversationId ?? activeConversationId);
      const messages = conversationMessages(conversationId);
      const result = { accepted: true, command, action: describeCommand(command), conversationId };

      switch (command.type) {
        case 'relay': {
          const target = agentIds[command.slot];
          const instruction =
            (body.prompt && String(body.prompt).trim()) ||
            '请基于引用上下文继续，直接给结论，不要复述原文。';
          result.agent = target;
          // 硬件通路是"按下即走"，不阻塞等待。但**必须在返回之前**把状态标成 running：
          // 否则返回体里那帧 LED 还是 Idle，桥接层照它点灯就会漏掉"正在跑"。
          setRunStatus(target, 'running');
          askOnce({
            agentId: target,
            instruction,
            relayOf: focusMessageId,
            conversationId,
          })
            .then((turn) => {
              log('hardware', `relay→${target}`, 'ok=' + turn.ok, 'chars=' + turn.text.length);
              if (turn.agentMessage) focusMessageId = turn.agentMessage.id;
            })
            .catch((err) => {
              log('hardware', `relay→${target}`, 'failed', err.message);
              setRunStatus(target, 'error');
            });
          break;
        }
        case 'focus.move': {
          if (!messages.length) {
            result.accepted = false;
            result.reason = '当前会话还没有消息';
            break;
          }
          const index = messages.findIndex((m) => m.id === focusMessageId);
          const next =
            index < 0
              ? command.delta > 0
                ? 0
                : messages.length - 1
              : Math.min(messages.length - 1, Math.max(0, index + command.delta));
          focusMessageId = messages[next].id;
          result.focusMessageId = focusMessageId;
          result.position = { index: next, total: messages.length };
          break;
        }
        case 'focus.copy': {
          const message = focusMessageId ? store.getMessage(focusMessageId) : null;
          if (!message) {
            result.accepted = false;
            result.reason = '没有焦点句可复制';
            break;
          }
          // 复制动作由调用方完成（守护进程走 pbcopy），中台只交出内容与元数据
          result.copy = { messageId: message.id, agent: message.agent, text: message.text, chars: message.text.length };
          break;
        }
        case 'focus.clear': {
          focusMessageId = null;
          break;
        }
        case 'view.cycle': {
          viewIndex = (viewIndex + 1) % Math.max(1, agentIds.length);
          result.viewIndex = viewIndex;
          result.viewAgent = agentIds[viewIndex];
          break;
        }
        case 'roundtable': {
          const question =
            (body.question && String(body.question).trim()) ||
            [...messages].reverse().find((m) => m.role === 'user')?.text ||
            null;
          if (!question) {
            result.accepted = false;
            result.reason = '当前会话里没有可用的问题';
            break;
          }
          result.question = question;
          runRoundtable({
            agents: agentIds,
            chair: DEFAULT_CHAIR,
            question,
            onPhase: () => {},
            askAgent: async (agentId, prompt, { stage = 'fanout' } = {}) => {
              const turn = await askOnce({
                agentId,
                instruction: prompt,
                relayOf: null,
                conversationId,
                persistUser: false,
                persistAgent: stage !== 'chair',
              });
              return { agent: turn.agent, ok: turn.ok, text: turn.text, error: turn.error, sessionId: turn.sessionId };
            },
          })
            .then(({ summary }) => log('hardware', 'roundtable done', 'chairOk=' + summary.ok))
            .catch((err) => log('hardware', 'roundtable failed', err.message));
          break;
        }
        default:
          result.accepted = false;
          result.reason = `${command.type} 在硬件通路上暂无实现`;
      }

      log('hardware', body.source ?? '?', body.id ?? body.combo ?? body.gesture ?? '?', '→', result.action, result.accepted ? 'ok' : `skip(${result.reason})`);
      return json(res, 200, { ...result, led: ledSnapshot() });
    }

    if (route === 'POST /api/ask') {
      const body = await readBody(req);
      if (!body.agent) return json(res, 400, { error: '缺少 agent' });
      if (!body.prompt || !String(body.prompt).trim()) return json(res, 400, { error: '缺少 prompt' });

      const sse = openSse(res);
      const childRef = { child: null };
      const conversationId = store.ensureConversation(body.conversationId ?? store.latestConversationId());
      // 用户主动发起 = 他看到了之前的结果
      boardAcknowledged = true;
      try {
        const result = await askOnce({
          agentId: String(body.agent),
          instruction: String(body.prompt).trim(),
          relayOf: body.relayOf ?? focusMessageId,
          conversationId,
          onEvent: (event) => sse.send('turn', event),
          onChild: (child) => {
            childRef.child = child;
          },
        });
        log('ask', result.agent, 'ok=' + result.ok, 'chars=' + result.text.length, 'ms=' + (result.agentMessage?.meta?.elapsedMs ?? '-'));
        sse.send('done', {
          ok: result.ok,
          agent: result.agent,
          text: result.text,
          error: result.error,
          warnings: result.warnings,
          sessionId: result.sessionId,
          usage: result.usage,
          userId: result.userMessage?.id ?? null,
          messageId: result.agentMessage?.id ?? null,
          relayOf: result.focus?.id ?? null,
          contextReset: result.contextReset,
          attempts: result.attempts,
          runId: result.runId,
          cancelled: result.cancelled,
          state: statePayload(conversationId),
        });
      } catch (err) {
        // 哪怕在 spawn 之前就抛了，也不能让板子停在"正在跑"
        setRunStatus(String(body.agent), 'error');
        sse.send('failed', { error: err.message });
      } finally {
        sse.end();
      }
      return undefined;
    }

    if (route === 'POST /api/roundtable') {
      const body = await readBody(req);
      const question = String(body.question ?? '').trim();
      if (!question) return json(res, 400, { error: '缺少 question' });
      const chair = String(body.chair ?? DEFAULT_CHAIR);
      const agents = (Array.isArray(body.agents) && body.agents.length ? body.agents : ADAPTERS.map((a) => a.id)).map(String);
      for (const id of agents) getAdapter(id);
      if (!agents.includes(chair)) getAdapter(chair);

      const sse = openSse(res);
      const conversationId = store.ensureConversation(body.conversationId ?? store.latestConversationId());
      try {
        const focus = body.relayOf ? store.getMessage(body.relayOf) : focusMessageId ? store.getMessage(focusMessageId) : null;
        const upstream = focus
          ? focus.role === 'agent'
            ? focus
            : store.lastAgentMessage(conversationId, focus.agent)
          : null;
        const snapshot = focus ? buildRelayPrompt({ upstream, focus, instruction: question }) : question;

        await store.addMessage({
          conversationId,
          agent: 'roundtable',
          role: 'user',
          text: question,
          meta: { agents, chair, relayOf: focus?.id ?? null, promptPreview: clip(snapshot, 400) },
        });

        const { answers, summary } = await runRoundtable({
          agents,
          chair,
          question: snapshot,
          concurrency: Number(body.concurrency ?? 3),
          onPhase: (phase) => sse.send('phase', phase),
          askAgent: async (agentId, prompt, { stage = 'fanout' } = {}) => {
            const result = await askOnce({
              agentId,
              instruction: prompt,
              relayOf: null,
              conversationId,
              onEvent: (event) => sse.send('turn', event),
              persistUser: false,
              // 主持人那一轮由外层显式存成 roundtable-summary；参与者轮照常入库。
              // 注意：chair 本身也可能在 fan-out 里，所以只能按 stage 区分，不能按身份。
              persistAgent: stage !== 'chair',
            });
            return {
              agent: result.agent,
              ok: result.ok,
              text: result.text,
              error: result.error,
              sessionId: result.sessionId,
              messageId: result.agentMessage?.id ?? null,
            };
          },
        });

        const summaryMessage = summary.ok
          ? await store.addMessage({
              conversationId,
              agent: chair,
              role: 'agent',
              text: summary.text,
              sessionId: summary.sessionId,
              meta: { kind: 'roundtable-summary', question, participants: agents },
            })
          : null;

        log('roundtable', `agents=${agents.length}`, `ok=${answers.filter((a) => a.ok).length}`, 'chair=' + chair);
        sse.send('done', {
          question,
          chair,
          answers,
          summary: { ok: summary.ok, text: summary.text, error: summary.error, messageId: summaryMessage?.id ?? null },
          state: statePayload(conversationId),
        });
      } catch (err) {
        sse.send('failed', { error: err.message });
      } finally {
        sse.end();
      }
      return undefined;
    }

    // 静态资源
    if (req.method === 'GET') {
      const relative = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
      const target = path.join(WEB_DIR, relative);
      if (!target.startsWith(WEB_DIR)) return json(res, 403, { error: '越界路径' });
      try {
        const info = await stat(target);
        if (!info.isFile()) throw new Error('not a file');
        const body = await readFile(target);
        res.writeHead(200, { 'Content-Type': MIME[path.extname(target)] ?? 'application/octet-stream' });
        res.end(body);
        return undefined;
      } catch {
        return json(res, 404, { error: '未找到' });
      }
    }

    return json(res, 404, { error: `未实现的路由 ${route}` });
  } catch (err) {
    return json(res, 500, { error: err.message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  log(`中台已启动 http://127.0.0.1:${PORT}`);
  log(`已注册 Agent：${ADAPTERS.map((a) => a.id).join(', ')}（主持人默认 ${DEFAULT_CHAIR}）`);
});
