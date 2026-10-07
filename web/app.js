// RelayDeck 网页端：零依赖，原生 DOM + fetch 流式读取 SSE。
// 键盘语义（与 charter.md 的约定一致）：
//   1–5  接力给第 N 个 Agent（发送）
//   ↑/↓ 或 j/k  移动焦点句（只看，不发送）
//   c    复制焦点句
//   b    拉群（焦点句作为引用上下文）
//   /    搜索；Enter 跳到下一个命中；n 下一个命中
//   Esc  清空焦点 / 退出搜索
const els = {
  conn: document.getElementById('conn'),
  focusPill: document.getElementById('focusPill'),
  convList: document.getElementById('convList'),
  newConvBtn: document.getElementById('newConvBtn'),
  agentList: document.getElementById('agentList'),
  usageBox: document.getElementById('usageBox'),
  ledBox: document.getElementById('ledBox'),
  streamTitle: document.getElementById('streamTitle'),
  messages: document.getElementById('messages'),
  searchInput: document.getElementById('searchInput'),
  searchInfo: document.getElementById('searchInfo'),
  composer: document.getElementById('composer'),
  sendBtn: document.getElementById('sendBtn'),
  relayBtn: document.getElementById('relayBtn'),
  live: document.getElementById('live'),
  liveTitle: document.getElementById('liveTitle'),
  liveText: document.getElementById('liveText'),
  liveClose: document.getElementById('liveClose'),
  cancelBtn: document.getElementById('cancelBtn'),
  rtQuestion: document.getElementById('rtQuestion'),
  rtChair: document.getElementById('rtChair'),
  rtAgents: document.getElementById('rtAgents'),
  rtConcurrency: document.getElementById('rtConcurrency'),
  rtRun: document.getElementById('rtRun'),
  rtResult: document.getElementById('rtResult'),
};

const state = {
  agents: [],
  conversations: [],
  conversationId: null,
  messages: [],
  agentSessions: {},
  usage: {},
  chair: 'dsh',
  focusMessageId: null,
};
const search = { query: '', matches: [], index: -1, scope: 'conversation' };
// 允许用 ?conversation=<id> 直接打开某个会话（可分享、也方便截图与排查）
const initialConversation = new URLSearchParams(location.search).get('conversation');
if (initialConversation) state.conversationId = initialConversation;
let currentAgent = null; // null = 全部
let focusId = null;
const running = new Set();
const AGENT_COLORS = ['#4cc2ff', '#c792ea', '#7ee787', '#ffa657', '#f778ba'];

// —— 数据 ——

async function loadState() {
  const query = state.conversationId ? `?conversation=${encodeURIComponent(state.conversationId)}` : '';
  const res = await fetch(`/api/state${query}`);
  if (!res.ok) throw new Error(`state ${res.status}`);
  const data = await res.json();
  Object.assign(state, data);
  if (currentAgent && !state.agents.some((a) => a.id === currentAgent)) currentAgent = null;
  focusId = state.focusMessageId ?? null;
  els.conn.textContent = `已连接 · ${state.agents.length} 个 Agent`;
  els.conn.className = 'pill pill-ok';
  render();
}

async function switchConversation(id) {
  state.conversationId = id;
  search.matches = [];
  search.index = -1;
  focusId = null;
  await fetch('/api/focus', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messageId: null, conversationId: id }),
  });
  await loadState();
}

async function newConversation() {
  const title = prompt('新会话名称', `会话 ${state.conversations.length + 1}`);
  if (title === null) return;
  const res = await fetch('/api/conversations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  });
  const data = await res.json();
  await switchConversation(data.conversation.id);
}

async function renameConversation(conversation) {
  const title = prompt('重命名会话', conversation.title);
  if (title === null) return;
  await fetch('/api/conversations', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: conversation.id, title }),
  });
  await loadState();
}

// —— 渲染 ——

function agentColor(id) {
  const index = state.agents.findIndex((a) => a.id === id);
  return AGENT_COLORS[(index < 0 ? 0 : index) % AGENT_COLORS.length];
}

function visibleMessages() {
  return currentAgent ? state.messages.filter((m) => m.agent === currentAgent) : state.messages.slice();
}

function shortId(id) {
  if (!id) return '—';
  return id.length > 18 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}

function render() {
  renderConversations();
  renderAgents();
  renderUsage();
  renderLed();
  renderMessages();
  renderRoundtableControls();
  renderFocusPill();
  renderSearchInfo();
}

/** 把板上 5 颗 WS2812 的期望状态画出来：没接板子也能看到软硬件协同的那一半 */
function renderLed() {
  const led = state.led;
  if (!led) {
    els.ledBox.innerHTML = '<p class="hint">暂无 LED 状态</p>';
    return;
  }
  const dots = led.pixels
    .map(
      (pixel) =>
        `<span class="led-dot${pixel.viewed ? ' viewed' : ''}" style="background:rgb(${pixel.rgb.join(',')})" title="${
          pixel.role
        } ${pixel.agentId ?? ''} ${pixel.status ?? pixel.effect}"></span>`,
    )
    .join('');
  els.ledBox.innerHTML = `<div class="led-dots">${dots}</div><div class="led-meta">${led.summary ?? ''}</div>`;
}

function renderConversations() {
  els.convList.innerHTML = '';
  for (const conversation of state.conversations) {
    const item = document.createElement('div');
    item.className = `conv-item${conversation.id === state.conversationId ? ' active' : ''}`;
    item.innerHTML = `<span class="conv-title"></span><span class="conv-meta">${conversation.messageCount}</span>`;
    item.querySelector('.conv-title').textContent = conversation.title;
    item.title = '单击切换 · 双击重命名';
    item.onclick = () => switchConversation(conversation.id);
    item.ondblclick = (event) => {
      event.stopPropagation();
      renameConversation(conversation);
    };
    els.convList.appendChild(item);
  }
}

function renderFocusPill() {
  const msg = state.messages.find((m) => m.id === focusId);
  els.focusPill.textContent = msg ? `焦点：${msg.agent} · ${msg.text.slice(0, 16)}…` : '焦点：无';
}

function renderUsage() {
  const entries = Object.entries(state.usage ?? {});
  if (!entries.length) {
    els.usageBox.innerHTML = '<p class="hint">本会话还没有用量数据</p>';
    return;
  }
  els.usageBox.innerHTML = entries
    .map(([agent, u]) => {
      const tokens = u.tokensKnown ? `${u.tokens.toLocaleString()} tok` : 'token 未知';
      const ms = u.avgMs ? `平均 ${(u.avgMs / 1000).toFixed(1)}s` : '耗时未知';
      return `<div class="usage-row"><span style="color:${agentColor(agent)}">${agent}</span><span>${u.turns} 轮 · ${tokens} · ${ms}</span></div>`;
    })
    .join('');
}

function renderAgents() {
  els.agentList.innerHTML = '';
  const all = document.createElement('div');
  all.className = `agent-card${currentAgent === null ? ' active' : ''}`;
  all.innerHTML = `<span class="dot dot-idle"></span><div><div class="name">全部消息</div><div class="meta">${state.messages.length} 条</div></div><span class="key">0</span>`;
  all.onclick = () => {
    currentAgent = null;
    render();
  };
  els.agentList.appendChild(all);

  state.agents.forEach((agent, index) => {
    const card = document.createElement('div');
    const isRunning = running.has(agent.id);
    const last = state.messages.filter((m) => m.agent === agent.id && m.role === 'agent').at(-1);
    const dotClass = isRunning ? 'dot-running' : last ? 'dot-ok' : 'dot-idle';
    card.className = `agent-card${currentAgent === agent.id ? ' active' : ''}`;
    card.innerHTML = `
      <span class="dot ${dotClass}"></span>
      <div>
        <div class="name" style="color:${agentColor(agent.id)}">${agent.label}</div>
        <div class="meta">session ${shortId(agent.sessionId)}</div>
        <div class="meta">${agent.capabilities?.resume ? '可续跑' : '不可续跑'} · ${
          last?.meta?.elapsedMs ? `${last.meta.elapsedMs}ms` : '未计时'
        }</div>
      </div>
      <span class="key">${index + 1}</span>`;
    card.onclick = () => {
      currentAgent = agent.id;
      render();
    };
    els.agentList.appendChild(card);
  });
}

/** 本地回溯接力链：沿 relayOf / inReplyTo 向上走，带环保护 */
function localLineage(message, maxDepth = 12) {
  const byId = new Map(state.messages.map((m) => [m.id, m]));
  const chain = [];
  const seen = new Set();
  let current = message;
  while (current && !seen.has(current.id) && chain.length < maxDepth) {
    chain.push(current);
    seen.add(current.id);
    const nextId = current.meta?.relayOf ?? current.meta?.inReplyTo ?? null;
    current = nextId ? byId.get(nextId) : null;
  }
  return chain.reverse();
}

function renderMessages() {
  const conversation = state.conversations.find((c) => c.id === state.conversationId);
  els.streamTitle.textContent = `消息流 · ${conversation?.title ?? '—'}${currentAgent ? ` · ${currentAgent}` : ' · 全部'}`;
  els.messages.innerHTML = '';
  const list = visibleMessages();
  if (!list.length) {
    els.messages.innerHTML =
      '<p class="hint">本会话还没有消息。在下面输入一句话发给当前 Agent；选中某条回答后按 1–5 可以接力给别人。</p>';
    return;
  }
  for (const msg of list) {
    const el = document.createElement('div');
    el.className = `msg ${msg.role === 'user' ? 'user' : 'agent'}${msg.id === focusId ? ' focused' : ''}`;
    el.dataset.id = msg.id;

    const badges = [];
    if (msg.id === focusId) badges.push('焦点');
    if (msg.meta?.kind === 'roundtable-summary') badges.push('主持人汇总');
    // 续跑线失效被重置过：必须显式告诉用户"这个 Agent 失忆了"
    if (msg.meta?.contextReset) badges.push('上下文已重置');
    if (msg.meta?.elapsedMs) badges.push(`${msg.meta.elapsedMs}ms`);
    if (msg.meta?.warnings?.length) badges.push(`警告 ${msg.meta.warnings.length}`);

    const head = document.createElement('div');
    head.className = 'msg-head';
    head.innerHTML = `
      <span class="who" style="color:${agentColor(msg.agent)}">${msg.agent}</span>
      <span>${msg.role === 'user' ? '我' : 'Agent'}</span>
      <span>${new Date(msg.createdAt).toLocaleTimeString()}</span>
      <span class="badge">${msg.id}</span>
      ${badges.map((b) => `<span class="badge">${b}</span>`).join('')}`;
    el.appendChild(head);

    // 接力链面包屑：一眼看出这句话是从哪儿接过来的
    const chain = localLineage(msg);
    if (chain.length > 1) {
      const crumbs = document.createElement('div');
      crumbs.className = 'lineage';
      crumbs.append(document.createTextNode('接力链：'));
      chain.forEach((node, index) => {
        const chip = document.createElement('button');
        chip.className = `crumb${node.id === msg.id ? ' current' : ''}`;
        chip.textContent = `${node.agent}:${node.id.slice(-4)}`;
        chip.title = node.text.slice(0, 160);
        chip.onclick = (event) => {
          event.stopPropagation();
          setFocus(node.id);
        };
        crumbs.appendChild(chip);
        if (index < chain.length - 1) crumbs.append(document.createTextNode('→'));
      });
      el.appendChild(crumbs);
    }

    const pre = document.createElement('pre');
    pre.textContent = msg.text;
    el.appendChild(pre);

    el.onclick = () => setFocus(msg.id === focusId ? null : msg.id);
    els.messages.appendChild(el);
  }

  const focused = els.messages.querySelector('.msg.focused');
  focused?.scrollIntoView({ block: 'nearest' });
}

function renderRoundtableControls() {
  if (els.rtChair.options.length) return;
  state.agents.forEach((a) => {
    els.rtChair.add(new Option(a.label, a.id));
    const label = document.createElement('label');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = true;
    box.value = a.id;
    label.append(box, document.createTextNode(a.label));
    els.rtAgents.appendChild(label);
  });
  els.rtChair.value = state.chair ?? state.agents[0]?.id ?? '';
}

function renderSearchInfo() {
  if (!search.query) {
    els.searchInfo.textContent = search.scope === 'conversation' ? '范围：本会话' : '范围：全部会话';
    return;
  }
  const position = search.index >= 0 ? `${search.index + 1}/${search.matches.length}` : `0/${search.matches.length}`;
  els.searchInfo.textContent = `${position} 命中 · ${search.scope === 'conversation' ? '本会话' : '全部会话'}`;
}

// —— 交互 ——

function setFocus(id) {
  focusId = id;
  fetch('/api/focus', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messageId: id, conversationId: state.conversationId }),
  }).catch(() => {});
  render();
}

function moveFocus(delta) {
  const list = visibleMessages();
  if (!list.length) return;
  const index = list.findIndex((m) => m.id === focusId);
  const next = index < 0 ? (delta > 0 ? 0 : list.length - 1) : Math.min(list.length - 1, Math.max(0, index + delta));
  setFocus(list[next].id);
}

async function copyFocus() {
  const msg = state.messages.find((m) => m.id === focusId);
  if (!msg) return;
  try {
    await navigator.clipboard.writeText(msg.text);
    els.focusPill.textContent = `已复制 ${msg.id}`;
  } catch {
    els.focusPill.textContent = '复制失败（请手动选择）';
  }
}

let searchTimer = null;
function onSearchInput() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, 220);
}

async function runSearch() {
  search.query = els.searchInput.value.trim();
  search.index = -1;
  if (!search.query) {
    search.matches = [];
    renderSearchInfo();
    return;
  }
  const scopeParam = search.scope === 'conversation' ? state.conversationId : '';
  const res = await fetch(`/api/search?q=${encodeURIComponent(search.query)}&conversation=${encodeURIComponent(scopeParam)}`);
  const data = await res.json();
  search.matches = data.matches ?? [];
  renderSearchInfo();
  if (search.matches.length) jumpToNextMatch();
}

function jumpToNextMatch() {
  if (!search.matches.length) return;
  search.index = (search.index + 1) % search.matches.length;
  const match = search.matches[search.index];
  // 命中可能在别的会话，先切过去再设焦点
  if (match.conversationId && match.conversationId !== state.conversationId) {
    switchConversation(match.conversationId).then(() => setFocus(match.id));
  } else {
    setFocus(match.id);
  }
  renderSearchInfo();
}

async function toggleScope() {
  search.scope = search.scope === 'conversation' ? 'all' : 'conversation';
  await runSearch();
}

async function sse(url, body, handlers) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let cut;
    while ((cut = buffer.indexOf('\n\n')) >= 0) {
      const chunk = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      let event = 'message';
      let data = '';
      for (const line of chunk.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      if (!data) continue;
      try {
        handlers[event]?.(JSON.parse(data));
      } catch {
        // 忽略解析失败的块
      }
    }
  }
}

function showLive(title) {
  els.live.classList.remove('hidden');
  els.liveTitle.textContent = title;
  els.liveText.textContent = '';
}

async function ask({ agent, prompt, relayOf = null }) {
  running.add(agent);
  render();
  showLive(`${agent} 正在回答${relayOf ? `（接力自 ${relayOf}）` : ''}`);
  let streamed = '';
  try {
    await sse('/api/ask', { agent, prompt, relayOf, conversationId: state.conversationId }, {
      turn: (event) => {
        if (event.type === 'text') {
          streamed += event.text;
          els.liveText.textContent = streamed;
        } else if (event.type === 'thinking' && event.text) {
          els.liveText.textContent = `（思考）${event.text}\n\n${streamed}`;
        } else if (event.type === 'error') {
          els.liveText.textContent += `\n[${event.fatal === false ? '警告' : '错误'}] ${event.message}`;
        }
      },
      done: async (result) => {
        els.liveText.textContent = result.ok ? result.text : `失败：${result.error}`;
        if (result.messageId) focusId = result.messageId;
        await loadState();
      },
      failed: (result) => {
        els.liveText.textContent = `中台错误：${result.error}`;
      },
    });
  } catch (err) {
    els.liveText.textContent = `请求失败：${err.message}`;
  } finally {
    running.delete(agent);
    render();
  }
}

async function runRoundtable() {
  const question = els.rtQuestion.value.trim();
  if (!question) {
    els.rtQuestion.focus();
    return;
  }
  const agents = [...els.rtAgents.querySelectorAll('input:checked')].map((i) => i.value);
  const chair = els.rtChair.value;
  const concurrency = Number(els.rtConcurrency.value) || 3;
  if (!agents.length) return;

  agents.forEach((a) => running.add(a));
  running.add(chair);
  render();
  els.rtResult.innerHTML = '<p class="hint">并行广播中…</p>';
  const collected = new Map();

  try {
    await sse('/api/roundtable', { question, agents, chair, concurrency, relayOf: focusId, conversationId: state.conversationId }, {
      phase: (phase) => {
        if (phase.phase === 'fanout.answer') {
          collected.set(phase.agent, { agent: phase.agent, ok: phase.ok });
          els.rtResult.innerHTML = [...collected.values()]
            .map((a) => `<div class="rt-answer"><h4>${a.agent} ${a.ok ? '✓' : '✗'}</h4></div>`)
            .join('');
        }
        if (phase.phase === 'chair.start') els.rtResult.innerHTML += '<p class="hint">主持人正在汇总…</p>';
      },
      done: async (result) => {
        els.rtResult.innerHTML = '';
        for (const answer of result.answers) {
          const div = document.createElement('div');
          div.className = 'rt-answer';
          div.innerHTML = `<h4>${answer.agent} ${answer.ok ? '✓' : '✗ ' + (answer.error ?? '')}</h4><pre></pre>`;
          div.querySelector('pre').textContent = answer.text || '（无输出）';
          els.rtResult.appendChild(div);
        }
        const summary = document.createElement('div');
        summary.className = 'rt-summary';
        summary.innerHTML = `<h4>主持人 ${result.chair} 的汇总</h4><pre></pre>`;
        summary.querySelector('pre').textContent = result.summary.ok ? result.summary.text : `汇总失败：${result.summary.error}`;
        els.rtResult.appendChild(summary);
        await loadState();
      },
      failed: (result) => {
        els.rtResult.innerHTML = `<p class="hint">圆桌失败：${result.error}</p>`;
      },
    });
  } catch (err) {
    els.rtResult.innerHTML = `<p class="hint">圆桌失败：${err.message}</p>`;
  } finally {
    agents.forEach((a) => running.delete(a));
    running.delete(chair);
    render();
  }
}

// —— 事件绑定 ——
els.newConvBtn.onclick = newConversation;
els.sendBtn.onclick = () => {
  const prompt = els.composer.value.trim();
  if (!prompt) return;
  const target = currentAgent ?? state.agents[0]?.id;
  if (!target) return;
  ask({ agent: target, prompt, relayOf: focusId });
  els.composer.value = '';
};
els.relayBtn.onclick = () => els.composer.focus();
els.composer.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    els.sendBtn.click();
  }
});
els.searchInput.addEventListener('input', onSearchInput);
els.searchInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    jumpToNextMatch();
  } else if (event.key === 'Escape') {
    els.searchInput.value = '';
    search.query = '';
    search.matches = [];
    search.index = -1;
    renderSearchInfo();
    els.searchInput.blur();
  }
});
els.searchInfo.onclick = toggleScope;
els.searchInfo.title = '单击切换搜索范围（本会话 / 全部会话）';
els.liveClose.onclick = () => els.live.classList.add('hidden');
els.rtRun.onclick = runRoundtable;
els.cancelBtn.onclick = async () => {
  await fetch('/api/cancel', { method: 'POST' });
  els.focusPill.textContent = '已发送终止信号';
};

document.addEventListener('keydown', (event) => {
  const tag = document.activeElement?.tagName;
  const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
  if (typing) return;
  if (event.metaKey || event.ctrlKey || event.altKey) return;

  const order = state.agents.map((a) => a.id);
  if (/^[1-9]$/.test(event.key)) {
    const target = order[Number(event.key) - 1];
    if (!target) return;
    event.preventDefault();
    const prompt = els.composer.value.trim() || '请基于上面的内容继续，直接给结论，不要复述原文。';
    ask({ agent: target, prompt, relayOf: focusId });
    return;
  }
  switch (event.key) {
    case 'ArrowDown':
    case 'j':
      event.preventDefault();
      moveFocus(1);
      break;
    case 'ArrowUp':
    case 'k':
      event.preventDefault();
      moveFocus(-1);
      break;
    case 'c':
      event.preventDefault();
      copyFocus();
      break;
    case 'b':
      event.preventDefault();
      runRoundtable();
      break;
    case 'n':
      if (search.matches.length) {
        event.preventDefault();
        jumpToNextMatch();
      }
      break;
    case '/':
      event.preventDefault();
      els.searchInput.focus();
      break;
    case 'Escape':
      setFocus(null);
      break;
    default:
      break;
  }
});

loadState().catch((err) => {
  els.conn.textContent = `连接失败：${err.message}`;
  els.conn.className = 'pill pill-err';
});
setInterval(() => loadState().catch(() => {}), 10000);
