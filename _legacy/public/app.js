const state = {
  accounts: [],
  currentAccount: '',
  messages: [],
  selectedThread: null,        // { id, account, subject, messages, summary, ... }
  selectedMessageIndex: 0,     // for keyboard nav within thread
  selectedRowIndex: -1,        // index into state.messages for j/k nav
  selectedIds: new Set(),      // multi-select set of message ids
  agentStatus: null,
  query: 'in:inbox newer_than:30d',
  chatBusy: false,
  agentBusy: false,
  expandedMessages: new Set(), // message ids that are expanded in thread view
};

const els = {};
function bindEls() {
  const ids = [
    'health','authState','agentState','account','query','searchForm','refresh',
    'messages','listTitle','listMeta','messageAccount','subject','headers','gmailLink',
    'summarize','triage','draft','archiveMessage','markRead','markUnread','trashMessage',
    'copyDraft','sendDraft','compose','composeModal','closeCompose','composeForm',
    'composeTo','composeCc','composeSubject','composeBody','draftBox','agent','agentTitle',
    'agentEngine','agentInstructions','threadList','threadSummary','threadSummaryText',
    'resummarize','openPalette','palette','paletteInput','paletteResults','shortcutSheet',
    'openShortcuts','closeShortcuts','toast','chatScroll','chatForm','chatInput','clearChat',
    'bulkBar','bulkCount','bulkArchive','bulkRead','bulkTrash','bulkTriage','bulkClear',
  ];
  for (const id of ids) els[id] = document.getElementById(id);
}

// ---------- helpers ----------
async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
  });
  const data = await res.json();
  if (!res.ok || data.ok === false) throw new Error(data.error || `Request failed: ${res.status}`);
  return data;
}

async function streamSSE(path, body, { onChunk, onDone, onError } = {}) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    throw new Error(text || `SSE request failed: ${res.status}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let lastEvent = 'message';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split('\n\n');
    buffer = events.pop() || '';
    for (const block of events) {
      const lines = block.split('\n');
      let event = lastEvent;
      const dataLines = [];
      for (const line of lines) {
        if (line.startsWith('event: ')) event = line.slice(7).trim();
        else if (line.startsWith('data: ')) dataLines.push(line.slice(6));
      }
      lastEvent = event;
      if (!dataLines.length) continue;
      const raw = dataLines.join('\n');
      let payload = raw;
      try { payload = JSON.parse(raw); } catch {}
      if (event === 'chunk' && onChunk) onChunk(payload);
      else if (event === 'done' && onDone) onDone(payload);
      else if (event === 'error' && onError) onError(payload);
    }
  }
}

function setHealth(label) { if (els.health) els.health.textContent = label; }
function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#039;');
}
function shortFrom(value) {
  return String(value || '').replace(/<.*?>/g, '').replaceAll('"', '').trim() || value;
}
function fromInitials(value) {
  const clean = shortFrom(value || '?').trim();
  const parts = clean.split(/[\s@<>]+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}
function fromColor(value) {
  const str = String(value || '').toLowerCase();
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = (hash * 31 + str.charCodeAt(i)) | 0;
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 55%, 55%)`;
}
function formatDate(value) {
  if (!value) return '';
  const date = Number.isFinite(Number(value)) ? new Date(Number(value)) : new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  if (sameDay) return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(date);
  if (date.getFullYear() === now.getFullYear()) return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date);
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: '2-digit' }).format(date);
}
function titleCase(value) { return String(value || '').slice(0, 1).toUpperCase() + String(value || '').slice(1); }

function toast(message, kind = 'info', timeoutMs = 2800) {
  if (!els.toast) return;
  els.toast.textContent = message;
  els.toast.className = `toast toast-${kind}`;
  els.toast.hidden = false;
  clearTimeout(els.toast._timer);
  els.toast._timer = setTimeout(() => { els.toast.hidden = true; }, timeoutMs);
}

function labelForQuery(query) {
  if (query.includes('is:unread')) return 'Unread';
  if (query.includes('is:important')) return 'Important';
  if (query.includes('icloud.com')) return 'iCloud';
  if (query.includes('has:attachment')) return 'Attachments';
  if (query.includes('in:sent')) return 'Sent';
  if (query.includes('in:drafts')) return 'Drafts';
  if (query.includes('in:trash')) return 'Trash';
  if (query.includes('-in:trash')) return 'All Mail';
  return 'Inbox';
}

function frameDoc(html) {
  const dark = document.documentElement.dataset.themeApplied === 'dark';
  const bg = dark ? '#161f29' : '#ffffff';
  const fg = dark ? '#e3eaef' : '#162029';
  const link = dark ? '#7fd0e3' : '#0b7285';
  // The injected script reports body height for auto-sizing the iframe.
  return `<!doctype html><html><head><base target="_blank"><style>
    html,body{margin:0;padding:0;background:${bg};color:${fg};font-family:Inter,Arial,sans-serif;line-height:1.5}
    body{margin:16px 18px}
    img,table{max-width:100%}
    pre{white-space:pre-wrap;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
    a{color:${link}}
    blockquote{border-left:3px solid ${dark?'#2a3845':'#dce3e8'};margin:8px 0;padding:6px 12px;color:${dark?'#9fb0bd':'#63717d'}}
  </style></head><body>${html || ''}</body></html>`;
}

// ---------- accounts + agent status ----------
async function loadAgentStatus() {
  try {
    const data = await api('/api/agent/status');
    state.agentStatus = data.agents;
    const available = [data.agents.claude && 'Claude', data.agents.codex && 'Codex'].filter(Boolean);
    if (els.agentState) els.agentState.textContent = available.length ? `Agent: ${available.join(' / ')}` : 'Agent: local fallback';
  } catch (err) {
    if (els.agentState) els.agentState.textContent = 'Agent: unreachable';
  }
}

function accountLabel(account) {
  if (account.authed) return account.primary ? `${account.email} · primary` : account.email;
  return `${account.email} (needs auth)`;
}

async function loadAccounts() {
  setHealth('Checking GOG');
  const data = await api('/api/accounts');
  state.accounts = data.accounts;
  els.account.innerHTML = '';
  for (const account of state.accounts) {
    const option = document.createElement('option');
    option.value = account.email;
    option.textContent = accountLabel(account);
    option.disabled = !account.authed;
    els.account.append(option);
  }
  const primary = state.accounts.find(a => a.email === 'jakob@lab86.io' && a.authed)
    || state.accounts.find(a => a.authed)
    || state.accounts[0];
  state.currentAccount = primary?.email || '';
  els.account.value = state.currentAccount;
  const authedCount = state.accounts.filter(a => a.authed).length;
  els.authState.textContent = `${authedCount}/${state.accounts.length} accounts connected`;
  document.querySelector('.dot')?.classList.toggle('warn', authedCount === 0);
  setHealth('Ready');
}

// ---------- search + list ----------
async function search() {
  const account = els.account.value;
  const q = els.query.value.trim() || 'in:inbox newer_than:30d';
  state.query = q;
  if (!account) return;
  state.currentAccount = account;
  setHealth('Searching');
  els.listTitle.textContent = labelForQuery(q);
  els.messages.innerHTML = loadingRow('Searching Gmail through GOG');
  try {
    const data = await api(`/api/search?account=${encodeURIComponent(account)}&q=${encodeURIComponent(q)}&max=40`);
    state.messages = data.items;
    state.selectedIds.clear();
    updateBulkBar();
    renderMessages();
    els.listMeta.textContent = `${data.items.length} result(s) · ${account}`;
    setHealth('Ready');
  } catch (err) {
    els.messages.innerHTML = loadingRow(err.message, 'Search failed');
    setHealth('Search failed');
  }
}

function loadingRow(detail, title = 'Loading') {
  return `<div class="message skeleton"><span class="from">${escapeHtml(title)}</span><strong>${escapeHtml(detail)}</strong><span class="snippet"></span></div>`;
}

function renderMessages() {
  els.messages.innerHTML = '';
  if (!state.messages.length) {
    els.messages.innerHTML = loadingRow('Try a broader Gmail search query.', 'No messages');
    return;
  }
  for (let i = 0; i < state.messages.length; i++) {
    const item = state.messages[i];
    const row = document.createElement('div');
    row.className = 'message';
    row.dataset.id = item.id;
    row.dataset.index = String(i);
    if (state.selectedIds.has(item.id)) row.classList.add('selected');
    if (item.unread) row.classList.add('unread');
    const initials = fromInitials(item.from || item.account);
    const color = fromColor(item.from || item.account);
    const label = (item.labels || []).find(l => !String(l).startsWith('CATEGORY_') && l !== 'INBOX') || (item.unread ? 'Unread' : 'Mail');
    row.innerHTML = `
      <input type="checkbox" class="msgCheck" aria-label="Select" ${state.selectedIds.has(item.id) ? 'checked' : ''}>
      <div class="msgAvatar" style="background:${color}">${escapeHtml(initials)}</div>
      <div class="msgBody">
        <div class="msgTop">
          <span class="from">${escapeHtml(shortFrom(item.from || item.account))}</span>
          <span class="date">${escapeHtml(formatDate(item.date))}</span>
        </div>
        <strong class="msgSubject">${escapeHtml(item.subject)}</strong>
        <span class="snippet">${escapeHtml(item.snippet || '')}</span>
        <span class="label">${escapeHtml(label)}</span>
      </div>
    `;
    row.addEventListener('click', e => {
      if (e.target.classList?.contains('msgCheck')) return;
      state.selectedRowIndex = i;
      openThreadFromItem(item, row);
    });
    row.querySelector('.msgCheck').addEventListener('click', e => {
      e.stopPropagation();
      toggleSelection(item.id);
    });
    els.messages.append(row);
  }
}

function highlightSelectedRow() {
  document.querySelectorAll('.message.active').forEach(el => el.classList.remove('active'));
  if (state.selectedRowIndex < 0) return;
  const target = els.messages.querySelector(`.message[data-index="${state.selectedRowIndex}"]`);
  if (target) {
    target.classList.add('active');
    target.scrollIntoView({ block: 'nearest' });
  }
}

// ---------- thread ----------
async function openThreadFromItem(item, node) {
  document.querySelectorAll('.message.active').forEach(el => el.classList.remove('active'));
  node?.classList.add('active');
  setHealth('Loading thread');
  els.messageAccount.textContent = item.account;
  els.subject.textContent = item.subject || 'Loading';
  els.headers.textContent = item.from || item.account;
  els.threadList.innerHTML = `<p class="placeholder">Loading thread…</p>`;
  els.threadSummary.hidden = true;
  els.gmailLink.href = '#';
  state.expandedMessages.clear();
  try {
    const data = await api(`/api/thread?account=${encodeURIComponent(item.account)}&id=${encodeURIComponent(item.threadId || item.id)}`);
    state.selectedThread = data.thread;
    renderThread();
    loadChatHistory();
    setHealth('Ready');
    autoSummarizeIfStale();
  } catch (err) {
    els.threadList.innerHTML = `<p class="placeholder">${escapeHtml(err.message)}</p>`;
    setHealth('Thread failed');
  }
}

function renderThread() {
  const thread = state.selectedThread;
  if (!thread) return;
  els.subject.textContent = thread.subject || '(no subject)';
  els.messageAccount.textContent = thread.account;
  const first = thread.messages[0];
  const last = thread.messages[thread.messages.length - 1];
  els.headers.textContent = `${shortFrom(last?.from || first?.from || '')} · ${thread.messages.length} message${thread.messages.length === 1 ? '' : 's'} · ${formatDate(last?.date)}`;
  els.gmailLink.href = thread.gmailUrl || '#';
  if (thread.summary) {
    els.threadSummaryText.textContent = thread.summary;
    els.threadSummary.hidden = false;
  } else {
    els.threadSummary.hidden = true;
  }
  els.threadList.innerHTML = '';
  // Expand the newest message by default.
  if (last) state.expandedMessages.add(last.id);
  for (let i = 0; i < thread.messages.length; i++) {
    const m = thread.messages[i];
    const card = document.createElement('article');
    card.className = 'threadCard';
    card.dataset.id = m.id;
    const expanded = state.expandedMessages.has(m.id);
    if (expanded) card.classList.add('expanded');
    card.innerHTML = `
      <header class="threadCardHead">
        <div class="threadCardAvatar" style="background:${fromColor(m.from)}">${escapeHtml(fromInitials(m.from))}</div>
        <div class="threadCardMeta">
          <div class="threadCardFrom">${escapeHtml(shortFrom(m.from))}</div>
          <div class="threadCardTo">to ${escapeHtml(shortFrom(m.to || m.account))}</div>
        </div>
        <div class="threadCardDate">${escapeHtml(formatDate(m.date))}</div>
      </header>
      <div class="threadCardSnippet">${escapeHtml((m.snippet || (m.text || '').slice(0, 220)) || '')}</div>
      <div class="threadCardBody"><iframe class="messageFrame" sandbox="allow-popups allow-popups-to-escape-sandbox" title="Message body"></iframe></div>
    `;
    card.addEventListener('click', e => {
      if (e.target.closest('.threadCardBody')) return;
      toggleThreadCard(m.id, card);
    });
    els.threadList.append(card);
    if (expanded) loadFrameInto(card.querySelector('iframe'), m.html || `<pre>${escapeHtml(m.text || '')}</pre>`);
  }
}

function toggleThreadCard(id, card) {
  const isExpanded = state.expandedMessages.has(id);
  if (isExpanded) {
    state.expandedMessages.delete(id);
    card.classList.remove('expanded');
  } else {
    state.expandedMessages.add(id);
    card.classList.add('expanded');
    const m = state.selectedThread?.messages.find(x => x.id === id);
    if (m) loadFrameInto(card.querySelector('iframe'), m.html || `<pre>${escapeHtml(m.text || '')}</pre>`);
  }
}

function loadFrameInto(iframe, html) {
  if (!iframe || iframe.dataset.loaded === '1') return;
  iframe.dataset.loaded = '1';
  iframe.srcdoc = frameDoc(html);
}

// ---------- thread summary ----------
async function autoSummarizeIfStale() {
  const thread = state.selectedThread;
  if (!thread) return;
  const newestDate = Math.max(...thread.messages.map(m => Number(m.date) || 0), 0);
  const summaryStale = !thread.summary || (thread.summaryAt || 0) < newestDate;
  if (summaryStale) summarizeThread();
}

async function summarizeThread() {
  const thread = state.selectedThread;
  if (!thread) return;
  els.threadSummary.hidden = false;
  els.threadSummaryText.textContent = 'Summarizing thread…';
  let buf = '';
  try {
    await streamSSE('/api/thread/summarize', {
      account: thread.account,
      threadId: thread.id,
      engine: els.agentEngine.value,
    }, {
      onChunk: (p) => { buf += (p.text || ''); els.threadSummaryText.textContent = buf; },
      onDone: (p) => {
        const final = p.result || buf;
        els.threadSummaryText.textContent = final;
        if (state.selectedThread) {
          state.selectedThread.summary = final;
          state.selectedThread.summaryAt = Date.now();
        }
      },
    });
  } catch (err) {
    els.threadSummaryText.textContent = `Could not summarize: ${err.message}`;
  }
}

// ---------- chat ----------
function renderChatHistory(messages) {
  els.chatScroll.innerHTML = '';
  if (!messages.length) {
    els.chatScroll.innerHTML = '<div class="chatEmpty">Ask the AI about this thread. It can summarize, extract action items, draft replies, or reason about prior messages.</div>';
    return;
  }
  for (const m of messages) appendChatBubble(m.role, m.content);
  els.chatScroll.scrollTop = els.chatScroll.scrollHeight;
}

function appendChatBubble(role, content) {
  const div = document.createElement('div');
  div.className = `chatBubble chat-${role}`;
  div.textContent = content;
  els.chatScroll.append(div);
  els.chatScroll.scrollTop = els.chatScroll.scrollHeight;
  return div;
}

async function loadChatHistory() {
  const thread = state.selectedThread;
  const account = thread?.account || state.currentAccount;
  const threadId = thread?.id || '';
  try {
    const data = await api(`/api/thread/chat/history?account=${encodeURIComponent(account)}&threadId=${encodeURIComponent(threadId)}`);
    renderChatHistory(data.messages || []);
  } catch {
    renderChatHistory([]);
  }
}

async function sendChat() {
  const text = els.chatInput.value.trim();
  if (!text || state.chatBusy) return;
  state.chatBusy = true;
  const thread = state.selectedThread;
  const account = thread?.account || state.currentAccount;
  const threadId = thread?.id || '';
  appendChatBubble('user', text);
  els.chatInput.value = '';
  const bubble = appendChatBubble('assistant', '…');
  let buf = '';
  try {
    await streamSSE('/api/thread/chat', {
      account, threadId, message: text, engine: els.agentEngine.value,
    }, {
      onChunk: (p) => { buf += (p.text || ''); bubble.textContent = buf; els.chatScroll.scrollTop = els.chatScroll.scrollHeight; },
      onDone: (p) => { bubble.textContent = p.result || buf || '(no response)'; },
    });
  } catch (err) {
    bubble.textContent = `Error: ${err.message}`;
  } finally {
    state.chatBusy = false;
  }
}

async function clearChatHistory() {
  const thread = state.selectedThread;
  const account = thread?.account || state.currentAccount;
  const threadId = thread?.id || '';
  await api('/api/thread/chat/clear', { method: 'POST', body: JSON.stringify({ account, threadId }) });
  renderChatHistory([]);
}

// ---------- legacy agent (summarize/triage/draft) with streaming ----------
function activeMessageForAgent() {
  const thread = state.selectedThread;
  if (!thread) return null;
  const expandedIds = [...state.expandedMessages];
  const targetId = expandedIds[expandedIds.length - 1] || thread.messages[thread.messages.length - 1]?.id;
  return thread.messages.find(m => m.id === targetId) || thread.messages[thread.messages.length - 1];
}

async function runAgent(action) {
  const message = activeMessageForAgent();
  if (!message) { toast('Open a thread first', 'warn'); return; }
  switchAgentTab('actions');
  const label = action === 'draft' ? 'Drafting' : action === 'triage' ? 'Triaging' : 'Summarizing';
  els.agentTitle.textContent = label;
  els.agent.textContent = `${label} with ${els.agentEngine.value}…`;
  let buf = '';
  try {
    await streamSSE('/api/agent/stream', {
      action, engine: els.agentEngine.value,
      instructions: els.agentInstructions.value,
      message,
    }, {
      onChunk: (p) => { buf += (p.text || ''); els.agent.textContent = buf; },
      onDone: (p) => {
        const final = p.result || buf;
        els.agent.textContent = final;
        els.agentTitle.textContent = `${titleCase(action)} via ${p.engine}`;
        if (action === 'draft') {
          els.draftBox.value = final;
          switchAgentTab('draft');
        }
      },
    });
  } catch (err) {
    els.agent.textContent = err.message;
  }
}

// ---------- message actions ----------
async function runMessageAction(action) {
  const thread = state.selectedThread;
  if (!thread) return;
  const message = activeMessageForAgent();
  if (!message) return;
  const label = action === 'read' ? 'mark this message read'
    : action === 'unread' ? 'mark this message unread'
    : action === 'trash' ? 'move this message to trash'
    : 'archive this message';
  if (!confirm(`Do you want to ${label}?`)) return;
  setHealth('Updating');
  try {
    await api('/api/message/action', {
      method: 'POST',
      body: JSON.stringify({
        account: message.account || thread.account,
        messageId: message.id,
        action,
        confirmAction: true,
      }),
    });
    toast(`${titleCase(action)} complete`, 'ok');
    setHealth('Ready');
    await search();
  } catch (err) {
    toast(`Action failed: ${err.message}`, 'error');
    setHealth('Action failed');
  }
}

// ---------- compose + send ----------
function openCompose() { els.composeModal.hidden = false; els.composeTo.focus(); }
function closeCompose() { els.composeModal.hidden = true; }

async function sendCompose() {
  const account = state.currentAccount || els.account.value;
  const to = els.composeTo.value.trim();
  const subject = els.composeSubject.value.trim();
  const body = els.composeBody.value.trim();
  if (!account || !to || !subject || !body) return;
  if (!confirm(`Send this message from ${account}?`)) return;
  setHealth('Sending');
  try {
    await api('/api/compose', {
      method: 'POST',
      body: JSON.stringify({
        account, to, cc: els.composeCc.value.trim(), subject, body, confirmSend: true,
      }),
    });
    closeCompose();
    els.composeForm.reset();
    toast(`Sent to ${to}`, 'ok');
    setHealth('Ready');
  } catch (err) {
    toast(`Send failed: ${err.message}`, 'error');
    setHealth('Send failed');
  }
}

async function sendDraft() {
  const thread = state.selectedThread;
  const message = activeMessageForAgent();
  if (!thread || !message || !els.draftBox.value.trim()) return;
  if (!confirm(`Send this reply from ${message.account || thread.account}?`)) return;
  setHealth('Sending');
  try {
    await api('/api/send', {
      method: 'POST',
      body: JSON.stringify({
        account: message.account || thread.account,
        messageId: message.id,
        threadId: thread.id,
        body: els.draftBox.value,
        confirmSend: true,
      }),
    });
    toast('Reply sent', 'ok');
    setHealth('Ready');
  } catch (err) {
    toast(`Send failed: ${err.message}`, 'error');
    setHealth('Send failed');
  }
}

// ---------- multi-select ----------
function toggleSelection(id) {
  if (state.selectedIds.has(id)) state.selectedIds.delete(id);
  else state.selectedIds.add(id);
  const row = els.messages.querySelector(`.message[data-id="${id}"]`);
  if (row) {
    row.classList.toggle('selected', state.selectedIds.has(id));
    const cb = row.querySelector('.msgCheck');
    if (cb) cb.checked = state.selectedIds.has(id);
  }
  updateBulkBar();
}

function updateBulkBar() {
  const n = state.selectedIds.size;
  if (!els.bulkBar) return;
  els.bulkBar.hidden = n === 0;
  els.bulkCount.textContent = `${n} selected`;
}

function clearSelections() {
  state.selectedIds.clear();
  document.querySelectorAll('.message.selected').forEach(el => {
    el.classList.remove('selected');
    const cb = el.querySelector('.msgCheck');
    if (cb) cb.checked = false;
  });
  updateBulkBar();
}

async function bulkAction(action) {
  if (!state.selectedIds.size) return;
  const ids = [...state.selectedIds];
  const account = state.currentAccount;
  const verb = action === 'read' ? 'mark read' : action === 'trash' ? 'trash' : 'archive';
  if (!confirm(`${verb} ${ids.length} message(s)?`)) return;
  setHealth('Bulk action');
  let success = 0;
  for (const id of ids) {
    try {
      await api('/api/message/action', {
        method: 'POST',
        body: JSON.stringify({ account, messageId: id, action, confirmAction: true }),
      });
      success++;
    } catch {}
  }
  toast(`${verb}: ${success}/${ids.length}`, success === ids.length ? 'ok' : 'warn');
  clearSelections();
  await search();
}

async function bulkTriage() {
  if (!state.selectedIds.size) return;
  switchAgentTab('actions');
  els.agent.textContent = 'Triaging selected…';
  els.agentTitle.textContent = `Bulk triage (${state.selectedIds.size})`;
  const items = state.messages
    .filter(m => state.selectedIds.has(m.id))
    .map(m => ({ id: m.id, from: m.from, subject: m.subject, snippet: m.snippet }));
  let buf = '';
  try {
    await streamSSE('/api/bulk/triage', { items, engine: els.agentEngine.value }, {
      onChunk: (p) => { buf += (p.text || ''); els.agent.textContent = buf; },
      onDone: (p) => {
        renderBulkVerdicts(p.verdicts || []);
        const lines = (p.verdicts || []).map(v => {
          const m = state.messages.find(x => x.id === v.id);
          return `${v.priority}/${v.action} — ${(m?.subject || '').slice(0, 60)}\n   ${v.reason}`;
        }).join('\n\n');
        els.agent.textContent = lines || buf;
      },
    });
  } catch (err) {
    els.agent.textContent = err.message;
  }
}

function renderBulkVerdicts(verdicts) {
  for (const v of verdicts) {
    const row = els.messages.querySelector(`.message[data-id="${v.id}"]`);
    if (!row) continue;
    row.classList.remove('prio-1', 'prio-2', 'prio-3');
    row.classList.add(`prio-${v.priority}`);
    let badge = row.querySelector('.verdictBadge');
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'verdictBadge';
      row.querySelector('.msgBody').append(badge);
    }
    badge.textContent = `AI: ${v.action} · ${v.reason.slice(0, 90)}`;
  }
}

// ---------- agent pane tabs ----------
function switchAgentTab(name) {
  document.querySelectorAll('.agentTabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tabPanel').forEach(p => p.classList.toggle('active', p.dataset.tabPanel === name));
}

// ---------- theme ----------
function applyTheme(setting) {
  const root = document.documentElement;
  root.dataset.theme = setting;
  const effective = setting === 'auto'
    ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : setting;
  root.dataset.themeApplied = effective;
  document.querySelectorAll('.themeToggle button').forEach(b => b.classList.toggle('active', b.dataset.theme === setting));
  // Reload all visible iframes to repaint with new theme colors.
  for (const iframe of document.querySelectorAll('iframe.messageFrame')) {
    if (iframe.dataset.loaded === '1') {
      iframe.dataset.loaded = '0';
      const card = iframe.closest('.threadCard');
      const id = card?.dataset.id;
      const m = state.selectedThread?.messages.find(x => x.id === id);
      if (m) loadFrameInto(iframe, m.html || `<pre>${escapeHtml(m.text || '')}</pre>`);
    }
  }
}

function initTheme() {
  const saved = localStorage.getItem('lab86-mail.theme') || 'auto';
  applyTheme(saved);
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if ((document.documentElement.dataset.theme || 'auto') === 'auto') applyTheme('auto');
  });
}

// ---------- command palette ----------
const paletteState = { items: [], selected: 0 };

function openPalette() {
  els.palette.hidden = false;
  els.paletteInput.value = '';
  els.paletteInput.focus();
  buildPaletteItems('');
}

function closePalette() { els.palette.hidden = true; }

async function buildPaletteItems(query) {
  const items = [];
  // Mailboxes
  document.querySelectorAll('.mailboxes button').forEach(b => {
    items.push({ kind: 'mailbox', label: `Mailbox · ${b.textContent.trim()}`, hint: b.dataset.query, action: () => { els.query.value = b.dataset.query; search(); } });
  });
  // Accounts
  for (const a of state.accounts) {
    if (!a.authed) continue;
    items.push({ kind: 'account', label: `Switch account · ${a.email}`, hint: a.primary ? 'primary' : '', action: () => { els.account.value = a.email; state.currentAccount = a.email; search(); } });
  }
  // AI commands
  if (state.selectedThread) {
    items.push({ kind: 'ai', label: 'AI · Summarize this thread', action: () => summarizeThread() });
    items.push({ kind: 'ai', label: 'AI · Draft reply', action: () => runAgent('draft') });
    items.push({ kind: 'ai', label: 'AI · Triage this thread', action: () => runAgent('triage') });
  }
  items.push({ kind: 'ai', label: 'AI · Compose new', hint: 'opens composer', action: () => openCompose() });
  items.push({ kind: 'view', label: 'Toggle theme · Dark', action: () => { localStorage.setItem('lab86-mail.theme', 'dark'); applyTheme('dark'); } });
  items.push({ kind: 'view', label: 'Toggle theme · Light', action: () => { localStorage.setItem('lab86-mail.theme', 'light'); applyTheme('light'); } });
  items.push({ kind: 'view', label: 'Show keyboard shortcuts', action: () => { els.shortcutSheet.hidden = false; } });
  // Recent threads from server cache
  try {
    const data = await api(`/api/recent-threads?limit=80`);
    for (const t of data.threads || []) {
      items.push({
        kind: 'thread',
        label: `Thread · ${t.subject || '(no subject)'}`,
        hint: `${t.from_address || ''} · ${t.account}`,
        action: () => openThreadFromItem({ id: t.id, threadId: t.id, account: t.account, subject: t.subject, from: t.from_address, date: t.last_date, snippet: t.snippet }, null),
      });
    }
  } catch {}
  paletteState.items = filterItems(items, query);
  paletteState.selected = 0;
  renderPalette();
}

function filterItems(items, query) {
  const q = query.trim().toLowerCase();
  if (!q) return items.slice(0, 100);
  return items
    .map(item => ({ item, score: scoreItem(item, q) }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 100)
    .map(x => x.item);
}

function scoreItem(item, q) {
  const text = `${item.label} ${item.hint || ''}`.toLowerCase();
  if (text.includes(q)) return 100 + (text.startsWith(q) ? 30 : 0) - text.length / 50;
  // Subsequence match.
  let pos = 0, score = 0;
  for (const ch of q) {
    const i = text.indexOf(ch, pos);
    if (i === -1) return 0;
    score += Math.max(0, 10 - (i - pos));
    pos = i + 1;
  }
  return score;
}

function renderPalette() {
  els.paletteResults.innerHTML = '';
  paletteState.items.forEach((item, i) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'paletteRow' + (i === paletteState.selected ? ' selected' : '');
    row.innerHTML = `<span class="paletteKind paletteKind-${item.kind}">${item.kind}</span><span class="paletteLabel">${escapeHtml(item.label)}</span><span class="paletteHintText">${escapeHtml(item.hint || '')}</span>`;
    row.addEventListener('mouseenter', () => { paletteState.selected = i; updatePaletteSelection(); });
    row.addEventListener('click', () => { runPaletteSelection(i); });
    els.paletteResults.append(row);
  });
}

function updatePaletteSelection() {
  els.paletteResults.querySelectorAll('.paletteRow').forEach((r, i) => r.classList.toggle('selected', i === paletteState.selected));
  const sel = els.paletteResults.querySelector('.paletteRow.selected');
  if (sel) sel.scrollIntoView({ block: 'nearest' });
}

function runPaletteSelection(i) {
  const item = paletteState.items[i ?? paletteState.selected];
  if (!item) return;
  closePalette();
  try { item.action(); } catch (err) { toast(err.message, 'error'); }
}

// ---------- keyboard shortcuts ----------
const keyState = { sequence: '', sequenceTimer: 0 };

function inEditable(target) {
  if (!target) return false;
  const t = target.tagName;
  if (t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT') return true;
  return target.isContentEditable;
}

document.addEventListener('keydown', e => {
  // Always-on: palette and esc.
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    openPalette();
    return;
  }
  if (e.key === 'Escape') {
    if (!els.palette.hidden) { closePalette(); return; }
    if (!els.shortcutSheet.hidden) { els.shortcutSheet.hidden = true; return; }
    if (!els.composeModal.hidden) { closeCompose(); return; }
    if (inEditable(e.target)) e.target.blur();
    return;
  }
  // Palette navigation
  if (!els.palette.hidden) {
    if (e.key === 'ArrowDown') { e.preventDefault(); paletteState.selected = Math.min(paletteState.items.length - 1, paletteState.selected + 1); updatePaletteSelection(); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); paletteState.selected = Math.max(0, paletteState.selected - 1); updatePaletteSelection(); return; }
    if (e.key === 'Enter') { e.preventDefault(); runPaletteSelection(); return; }
    return;
  }
  if (inEditable(e.target)) return;
  // Sequences (g i / g u / g s)
  if (keyState.sequence === 'g') {
    keyState.sequence = '';
    const map = { i: 'in:inbox newer_than:30d', u: 'is:unread newer_than:30d', s: 'in:sent newer_than:365d', d: 'in:drafts', t: 'in:trash newer_than:365d', a: '-in:trash newer_than:365d' };
    if (map[e.key]) { e.preventDefault(); els.query.value = map[e.key]; search(); }
    return;
  }
  switch (e.key) {
    case 'j': case 'ArrowDown': e.preventDefault(); moveRowSelection(1); break;
    case 'k': case 'ArrowUp': e.preventDefault(); moveRowSelection(-1); break;
    case 'Enter': case 'o': e.preventDefault(); openSelectedRow(); break;
    case 'u': e.preventDefault(); state.selectedThread = null; els.threadList.innerHTML = '<p class="placeholder">Select a message.</p>'; els.threadSummary.hidden = true; break;
    case 'e': e.preventDefault(); runMessageAction('archive'); break;
    case '#': e.preventDefault(); runMessageAction('trash'); break;
    case 'r': e.preventDefault(); runAgent('draft'); break;
    case 'R': e.preventDefault(); openCompose(); break;
    case 'c': e.preventDefault(); openCompose(); break;
    case 's': e.preventDefault(); summarizeThread(); break;
    case 't': e.preventDefault(); runAgent('triage'); break;
    case 'x': e.preventDefault(); toggleSelectionAtCursor(); break;
    case '/': e.preventDefault(); els.query.focus(); els.query.select(); break;
    case '?': e.preventDefault(); els.shortcutSheet.hidden = false; break;
    case 'g': keyState.sequence = 'g'; setTimeout(() => { keyState.sequence = ''; }, 900); break;
  }
});

function moveRowSelection(delta) {
  if (!state.messages.length) return;
  const next = Math.max(0, Math.min(state.messages.length - 1, state.selectedRowIndex + delta));
  if (next === state.selectedRowIndex && next === 0 && delta < 0) return;
  state.selectedRowIndex = next;
  highlightSelectedRow();
}

function openSelectedRow() {
  if (state.selectedRowIndex < 0) return;
  const item = state.messages[state.selectedRowIndex];
  const node = els.messages.querySelector(`.message[data-index="${state.selectedRowIndex}"]`);
  if (item) openThreadFromItem(item, node);
}

function toggleSelectionAtCursor() {
  if (state.selectedRowIndex < 0) return;
  const item = state.messages[state.selectedRowIndex];
  if (item) toggleSelection(item.id);
}

// ---------- wiring ----------
function wireEvents() {
  els.searchForm.addEventListener('submit', e => { e.preventDefault(); search(); });
  els.refresh.addEventListener('click', search);
  els.account.addEventListener('change', search);

  els.summarize.addEventListener('click', () => runAgent('summarize').catch(err => toast(err.message, 'error')));
  els.triage.addEventListener('click', () => runAgent('triage').catch(err => toast(err.message, 'error')));
  els.draft.addEventListener('click', () => runAgent('draft').catch(err => toast(err.message, 'error')));
  els.archiveMessage.addEventListener('click', () => runMessageAction('archive'));
  els.markRead.addEventListener('click', () => runMessageAction('read'));
  els.markUnread.addEventListener('click', () => runMessageAction('unread'));
  els.trashMessage.addEventListener('click', () => runMessageAction('trash'));
  els.copyDraft.addEventListener('click', () => navigator.clipboard.writeText(els.draftBox.value || els.agent.textContent || '').then(() => toast('Copied', 'ok')));
  els.sendDraft.addEventListener('click', () => sendDraft());

  els.compose.addEventListener('click', openCompose);
  els.closeCompose.addEventListener('click', closeCompose);
  els.composeForm.addEventListener('submit', e => { e.preventDefault(); sendCompose(); });

  document.querySelectorAll('[data-query]').forEach(button => {
    button.addEventListener('click', () => {
      document.querySelectorAll('.mailboxes button').forEach(el => el.classList.remove('active'));
      if (button.closest('.mailboxes')) button.classList.add('active');
      els.query.value = button.dataset.query;
      search();
    });
  });

  // Agent pane tabs
  document.querySelectorAll('.agentTabs button').forEach(b => b.addEventListener('click', () => switchAgentTab(b.dataset.tab)));

  // Chat
  els.chatForm.addEventListener('submit', e => { e.preventDefault(); sendChat(); });
  els.chatInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
  });
  els.clearChat.addEventListener('click', clearChatHistory);

  // Theme
  document.querySelectorAll('.themeToggle button').forEach(b => {
    b.addEventListener('click', () => {
      const t = b.dataset.theme;
      localStorage.setItem('lab86-mail.theme', t);
      applyTheme(t);
    });
  });

  // Palette
  els.openPalette.addEventListener('click', openPalette);
  els.paletteInput.addEventListener('input', () => buildPaletteItems(els.paletteInput.value));
  els.palette.addEventListener('click', e => { if (e.target === els.palette) closePalette(); });

  // Shortcut sheet
  els.openShortcuts.addEventListener('click', () => { els.shortcutSheet.hidden = false; });
  els.closeShortcuts.addEventListener('click', () => { els.shortcutSheet.hidden = true; });
  els.shortcutSheet.addEventListener('click', e => { if (e.target === els.shortcutSheet) els.shortcutSheet.hidden = true; });

  // Thread summary
  els.resummarize.addEventListener('click', summarizeThread);

  // Bulk
  els.bulkArchive.addEventListener('click', () => bulkAction('archive'));
  els.bulkRead.addEventListener('click', () => bulkAction('read'));
  els.bulkTrash.addEventListener('click', () => bulkAction('trash'));
  els.bulkTriage.addEventListener('click', bulkTriage);
  els.bulkClear.addEventListener('click', clearSelections);
}

// ---------- boot ----------
bindEls();
initTheme();
wireEvents();
renderChatHistory([]);
Promise.all([loadAccounts(), loadAgentStatus()])
  .then(search)
  .catch(err => {
    setHealth('Setup needed');
    els.messages.innerHTML = loadingRow(err.message, 'Unavailable');
  });
