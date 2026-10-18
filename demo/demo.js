// RelayDeck 在线演示（静态回放）
//
// 说明：线上不能真跑中台（它要调本机四个 CLI），所以这里用**真实运行录制**的数据
// 在浏览器里把界面跑起来：会话切换、焦点句导航、复制、接力链回溯、搜索、
// 四方圆桌回放、板级 LED 状态回放。
const AGENT_COLORS = {
  dsh: '#4cc2ff',
  codex: '#c792ea',
  minimax: '#7ee787',
  kimi: '#ffa657',
  roundtable: '#8b98a8',
};

const els = {
  convList: document.getElementById('convList'),
  agentList: document.getElementById('agentList'),
  ledBox: document.getElementById('ledBox'),
  messages: document.getElementById('messages'),
  streamTitle: document.getElementById('streamTitle'),
  search: document.getElementById('search'),
  searchInfo: document.getElementById('searchInfo'),
  rtQuestion: document.getElementById('rtQuestion'),
  rtRun: document.getElementById('rtRun'),
  rtResult: document.getElementById('rtResult'),
  dataInfo: document.getElementById('dataInfo'),
};

let demo = null;
let currentConversation = null;
let currentAgent = null;
let focusId = null;
let keyword = '';
let ledTimer = null;

/**
 * 最小 markdown 渲染：先转义 HTML，再处理 **加粗**、`行内代码`、行首 ## 小标题。
 * 只为让录制的模型输出（常带 markdown 记号）读起来不别扭——不引入任何依赖。
 */
function mdLite(text) {
  const escaped = String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return escaped
    .split('\n')
    .map((line) => {
      const heading = line.match(/^#{1,4}\s+(.*)$/);
      const body = heading ? `<strong>${heading[1]}</strong>` : line;
      return body
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/`([^`]+)`/g, '<code>$1</code>');
    })
    .join('\n');
}

const byId = (id) => demo.messages.find((m) => m.id === id) ?? null;
const colorOf = (agent) => AGENT_COLORS[agent] ?? '#8b98a8';

function messagesOf(conversationId) {
  return demo.messages.filter((m) => m.conversationId === conversationId);
}

/** 沿 relayOf / inReplyTo 回溯成链（带环保护） */
function lineageOf(message, pool) {
  const map = new Map(pool.map((m) => [m.id, m]));
  const chain = [];
  const seen = new Set();
  let current = message;
  while (current && !seen.has(current.id) && chain.length < 12) {
    chain.push(current);
    seen.add(current.id);
    const nextId = current.meta?.relayOf ?? current.meta?.inReplyTo ?? null;
    current = nextId ? map.get(nextId) : null;
  }
  return chain.reverse();
}

function shortTime(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('zh-CN', { hour12: false });
}

function render() {
  renderConversations();
  renderAgents();
  renderMessages();
  renderLed();
}

function renderConversations() {
  els.convList.innerHTML = '';
  for (const conversation of demo.conversations) {
    const item = document.createElement('div');
    item.className = `conv-item${conversation.id === currentConversation ? ' active' : ''}`;
    const title = document.createElement('span');
    title.className = 'conv-title';
    title.textContent = conversation.title;
    const meta = document.createElement('span');
    meta.className = 'conv-meta';
    meta.textContent = conversation.messageCount;
    item.append(title, meta);
    item.onclick = () => {
      currentConversation = conversation.id;
      focusId = null;
      keyword = '';
      els.search.value = '';
      els.searchInfo.textContent = '';
      render();
    };
    els.convList.appendChild(item);
  }
}

function renderAgents() {
  els.agentList.innerHTML = '';
  const all = document.createElement('div');
  all.className = `agent-card${currentAgent === null ? ' active' : ''}`;
  all.innerHTML = `<span class="dot dot-idle"></span><div><div class="name">全部消息</div><div class="meta">本会话</div></div>`;
  all.onclick = () => {
    currentAgent = null;
    render();
  };
  els.agentList.appendChild(all);

  const pool = messagesOf(currentConversation);
  demo.agents.forEach((agent, index) => {
    const mine = pool.filter((m) => m.agent === agent.id);
    const card = document.createElement('div');
    card.className = `agent-card${currentAgent === agent.id ? ' active' : ''}`;
    card.innerHTML = `
      <span class="dot ${mine.length ? 'dot-ok' : 'dot-idle'}"></span>
      <div>
        <div class="name" style="color:${colorOf(agent.id)}">${agent.label}</div>
        <div class="meta">本会话 ${mine.length} 条</div>
      </div>
      <span class="key">${index + 1}</span>`;
    card.onclick = () => {
      currentAgent = agent.id;
      render();
    };
    els.agentList.appendChild(card);
  });
}

function renderSearchInfo() {
  if (!keyword) {
    els.searchInfo.textContent = '范围：本会话';
    return;
  }
  const hits = visibleMessages().filter((m) => m.text.toLowerCase().includes(keyword)).length;
  els.searchInfo.textContent = `${hits} 条命中`;
}

function visibleMessages() {
  const pool = messagesOf(currentConversation);
  return currentAgent ? pool.filter((m) => m.agent === currentAgent) : pool;
}

function renderMessages() {
  const conversation = demo.conversations.find((c) => c.id === currentConversation);
  els.streamTitle.textContent = `消息流 · ${conversation?.title ?? '—'}`;
  els.messages.innerHTML = '';

  const all = visibleMessages();
  const list = keyword ? all.filter((m) => m.text.toLowerCase().includes(keyword)) : all;
  if (!list.length) {
    els.messages.innerHTML = '<p class="hint">没有匹配的消息</p>';
    renderSearchInfo();
    return;
  }

  for (const message of list) {
    const el = document.createElement('div');
    el.className = `msg ${message.role === 'user' ? 'user' : 'agent'}${message.id === focusId ? ' focused' : ''}`;

    const badges = [];
    if (message.id === focusId) badges.push('焦点');
    if (message.meta?.kind === 'roundtable-summary') badges.push('主持人汇总');
    if (message.meta?.contextReset) badges.push('上下文已重置');
    if (message.meta?.elapsedMs) badges.push(`${message.meta.elapsedMs}ms`);
    if (message.meta?.warnings?.length) badges.push(`警告 ${message.meta.warnings.length}`);

    const head = document.createElement('div');
    head.className = 'msg-head';
    head.innerHTML = `
      <span class="who" style="color:${colorOf(message.agent)}">${message.agent}</span>
      <span>${message.role === 'user' ? '我' : 'Agent'}</span>
      <span>${shortTime(message.createdAt)}</span>
      <span class="badge">${message.id}</span>
      ${badges.map((b) => `<span class="badge">${b}</span>`).join('')}`;
    el.appendChild(head);

    const chain = lineageOf(message, all);
    if (chain.length > 1) {
      const crumbs = document.createElement('div');
      crumbs.className = 'lineage';
      crumbs.append(document.createTextNode('接力链：'));
      chain.forEach((node, index) => {
        const chip = document.createElement('button');
        chip.className = `crumb${node.id === message.id ? ' current' : ''}`;
        chip.textContent = `${node.agent}:${node.id.slice(-4)}`;
        chip.onclick = (event) => {
          event.stopPropagation();
          focusId = node.id;
          renderMessages();
        };
        crumbs.appendChild(chip);
        if (index < chain.length - 1) crumbs.append(document.createTextNode('→'));
      });
      el.appendChild(crumbs);
    }

    const pre = document.createElement('pre');
    pre.innerHTML = mdLite(message.text);
    el.appendChild(pre);
    el.onclick = () => {
      focusId = focusId === message.id ? null : message.id;
      renderMessages();
    };
    els.messages.appendChild(el);
  }

  els.messages.querySelector('.msg.focused')?.scrollIntoView({ block: 'nearest' });
  renderSearchInfo();
}

// —— 板级 LED 回放：按固件语义把一种状态铺成 5 颗灯的径向渐变 ——
function renderLedDots(state) {
  const color = state?.color ?? [0, 0, 0];
  const scaled = (factor) => color.map((c) => Math.round(c * factor));
  const pixels = [
    scaled(0.25),
    scaled(0.5),
    color,
    scaled(0.5),
    scaled(0.25),
  ];
  return pixels
    .map(
      (rgb, index) =>
        `<span class="led-dot${index === 2 ? ' viewed' : ''}" style="background:rgb(${rgb.join(',')})" title="${state?.stateName ?? 'Idle'}"></span>`,
    )
    .join('');
}

function renderLed(step = 0) {
  const states = demo.led?.states ?? [];
  if (!states.length) {
    els.ledBox.innerHTML = '<p class="hint">无 LED 录制</p>';
    return;
  }
  const state = states[step % states.length];
  els.ledBox.innerHTML = `
    <div class="led-dots">${renderLedDots(state)}</div>
    <div class="led-meta">板子会显示：<b>${state.stateName}</b> · seq ${state.sequence} · ttl ${state.ttlMs}ms</div>`;
}

function startLedReplay() {
  if (ledTimer) clearInterval(ledTimer);
  const states = demo.led?.states ?? [];
  if (states.length < 2) return;
  let step = 0;
  ledTimer = setInterval(() => {
    step = (step + 1) % states.length;
    renderLed(step);
  }, 1800);
}

// —— 圆桌回放 ——
function replayRoundtable() {
  const rt = demo.roundtable;
  if (!rt) {
    els.rtResult.innerHTML = '<p class="hint">没有录制的圆桌数据</p>';
    return;
  }
  els.rtResult.innerHTML = '';
  els.rtRun.disabled = true;
  els.rtRun.textContent = '回放中…';

  const answers = rt.answers.slice();
  let index = 0;

  const step = () => {
    if (index >= answers.length) {
      const summary = document.createElement('div');
      summary.className = 'rt-summary';
      summary.innerHTML = `<h4>主持人 ${rt.chair} 的汇总</h4><pre></pre>`;
      summary.querySelector('pre').innerHTML = rt.summary.ok ? mdLite(rt.summary.text) : '汇总失败';
      els.rtResult.appendChild(summary);
      els.rtRun.disabled = false;
      els.rtRun.textContent = '▶ 再回放一次';
      return;
    }
    const answer = answers[index];
    const div = document.createElement('div');
    div.className = 'rt-answer';
    div.innerHTML = `<h4><span style="color:${colorOf(answer.agent)}">${answer.agent}</span> ${answer.ok ? '✓' : '✗'}</h4><pre></pre>`;
    div.querySelector('pre').innerHTML = mdLite(answer.text || answer.error || '');
    els.rtResult.appendChild(div);
    els.rtResult.scrollTop = els.rtResult.scrollHeight;
    index += 1;
    setTimeout(step, 450);
  };
  step();
}

// —— 启动 ——
async function boot() {
  try {
    const res = await fetch('demo/data.json', { cache: 'no-cache' });
    demo = await res.json();
  } catch (err) {
    els.dataInfo.textContent = `数据载入失败：${err.message}`;
    els.dataInfo.className = 'pill pill-err';
    return;
  }

  els.dataInfo.textContent = `真实录制 · ${demo.stats.messages} 条消息`;
  els.dataInfo.className = 'pill pill-ok';

  // 默认挑消息最多的会话（内容最丰富的那一个）
  const richest = demo.conversations.slice().sort((a, b) => b.messageCount - a.messageCount)[0];
  currentConversation = richest?.id ?? demo.conversations[0]?.id ?? null;

  els.rtQuestion.textContent = demo.roundtable?.question ?? '（无录制）';
  els.search.addEventListener('input', () => {
    keyword = els.search.value.trim().toLowerCase();
    renderMessages();
  });
  els.rtRun.addEventListener('click', replayRoundtable);

  document.addEventListener('keydown', (event) => {
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const list = keyword ? visibleMessages().filter((m) => m.text.toLowerCase().includes(keyword)) : visibleMessages();
    const currentIndex = list.findIndex((m) => m.id === focusId);
    if (event.key === 'ArrowDown' || event.key === 'j') {
      event.preventDefault();
      focusId = list[Math.min(list.length - 1, currentIndex + 1)]?.id ?? null;
      renderMessages();
    } else if (event.key === 'ArrowUp' || event.key === 'k') {
      event.preventDefault();
      focusId = list[Math.max(0, currentIndex - 1)]?.id ?? null;
      renderMessages();
    } else if (event.key === 'c') {
      const message = byId(focusId);
      if (message) navigator.clipboard.writeText(message.text).then(() => {
        els.searchInfo.textContent = `已复制 ${message.id}`;
      });
    } else if (event.key === 'Escape') {
      focusId = null;
      renderMessages();
    }
  });

  render();
  startLedReplay();
}

boot();
