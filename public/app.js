const state = {
  accounts: [],
  currentAccount: '',
  messages: [],
  selected: null,
  agentStatus: null,
};

const els = {
  health: document.querySelector('#health'),
  aiChatForm: document.querySelector('#aiChatForm'),
  aiChatInput: document.querySelector('#aiChatInput'),
  authState: document.querySelector('#authState'),
  agentState: document.querySelector('#agentState'),
  account: document.querySelector('#account'),
  query: document.querySelector('#query'),
  searchForm: document.querySelector('#searchForm'),
  refresh: document.querySelector('#refresh'),
  messages: document.querySelector('#messages'),
  listTitle: document.querySelector('#listTitle'),
  listMeta: document.querySelector('#listMeta'),
  messageAccount: document.querySelector('#messageAccount'),
  subject: document.querySelector('#subject'),
  headers: document.querySelector('#headers'),
  gmailLink: document.querySelector('#gmailLink'),
  summarize: document.querySelector('#summarize'),
  triage: document.querySelector('#triage'),
  draft: document.querySelector('#draft'),
  archiveMessage: document.querySelector('#archiveMessage'),
  markRead: document.querySelector('#markRead'),
  markUnread: document.querySelector('#markUnread'),
  trashMessage: document.querySelector('#trashMessage'),
  copyDraft: document.querySelector('#copyDraft'),
  sendDraft: document.querySelector('#sendDraft'),
  compose: document.querySelector('#compose'),
  composeModal: document.querySelector('#composeModal'),
  closeCompose: document.querySelector('#closeCompose'),
  composeForm: document.querySelector('#composeForm'),
  composeTo: document.querySelector('#composeTo'),
  composeCc: document.querySelector('#composeCc'),
  composeSubject: document.querySelector('#composeSubject'),
  composeBody: document.querySelector('#composeBody'),
  draftBox: document.querySelector('#draftBox'),
  agent: document.querySelector('#agent'),
  agentTitle: document.querySelector('#agentTitle'),
  agentEngine: document.querySelector('#agentEngine'),
  agentInstructions: document.querySelector('#agentInstructions'),
  mailFrame: document.querySelector('#mailFrame'),
};

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const data = await res.json();
  if (!res.ok || data.ok === false) throw new Error(data.error || `Request failed: ${res.status}`);
  return data;
}

function setHealth(label) {
  els.health.textContent = label;
}

async function loadAgentStatus() {
  const data = await api('/api/agent/status');
  state.agentStatus = data.agents;
  const available = [
    data.agents.claude ? 'Claude' : null,
    data.agents.codex ? 'Codex' : null,
  ].filter(Boolean);
  els.agentState.textContent = available.length ? `Agent: ${available.join(' / ')}` : 'Agent: local fallback';
}

function accountLabel(account) {
  if (account.authed) return account.primary ? `${account.email} primary` : account.email;
  return `${account.email} needs auth`;
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
  const primary = state.accounts.find(item => item.email === 'jakob@lab86.io' && item.authed)
    || state.accounts.find(item => item.authed)
    || state.accounts[0];
  state.currentAccount = primary?.email || '';
  els.account.value = state.currentAccount;
  const authedCount = state.accounts.filter(item => item.authed).length;
  els.authState.textContent = `${authedCount}/${state.accounts.length} accounts connected`;
  document.querySelector('.dot')?.classList.toggle('warn', authedCount === 0);
  setHealth('Ready');
}

async function search() {
  const account = els.account.value;
  const q = els.query.value.trim() || 'in:inbox newer_than:30d';
  if (!account) return;
  state.currentAccount = account;
  setHealth('Searching');
  els.listTitle.textContent = labelForQuery(q);
  els.messages.innerHTML = loadingRow('Searching Gmail through GOG');
  try {
    const data = await api(`/api/search?account=${encodeURIComponent(account)}&q=${encodeURIComponent(q)}&max=30`);
    state.messages = data.items;
    renderMessages();
    els.listMeta.textContent = `${data.items.length} result(s) from ${account}`;
    setHealth('Ready');
  } catch (err) {
    els.messages.innerHTML = loadingRow(err.message, 'Search failed');
    setHealth('Search failed');
  }
}

function renderMessages() {
  els.messages.innerHTML = '';
  if (!state.messages.length) {
    els.messages.innerHTML = loadingRow('Try a broader Gmail search query.', 'No messages');
    return;
  }
  for (const item of state.messages) {
    const button = document.createElement('button');
    button.className = 'message';
    button.dataset.id = item.id;
    const label = item.unread ? 'Unread' : (item.labels || []).find(label => !String(label).startsWith('CATEGORY_')) || 'Mail';
    button.innerHTML = `
      <span class="from">${escapeHtml(shortFrom(item.from || item.account))}</span>
      <span class="date">${escapeHtml(formatDate(item.date))}</span>
      <strong>${escapeHtml(item.subject)}</strong>
      <span class="snippet">${escapeHtml(item.snippet || '')}</span>
      <span class="label">${escapeHtml(label)}</span>
    `;
    button.addEventListener('click', () => openMessage(item, button));
    els.messages.append(button);
  }
}

async function openMessage(item, node) {
  document.querySelectorAll('.message.active').forEach(el => el.classList.remove('active'));
  node?.classList.add('active');
  setHealth('Loading');
  els.messageAccount.textContent = item.account;
  els.subject.textContent = item.subject || 'Loading';
  els.headers.textContent = item.from || item.account;
  els.agent.textContent = 'Ready for this message.';
  els.agentTitle.textContent = 'Ready';
  els.draftBox.value = '';
  els.mailFrame.srcdoc = frameDoc('<p>Loading...</p>');
  try {
    const data = await api(`/api/message?account=${encodeURIComponent(item.account)}&id=${encodeURIComponent(item.id)}`);
    state.selected = data.message;
    els.messageAccount.textContent = state.selected.account;
    els.subject.textContent = state.selected.subject;
    els.headers.textContent = `${state.selected.from} -> ${state.selected.to || state.selected.account} | ${formatDate(state.selected.date)}`;
    els.gmailLink.href = state.selected.gmailUrl;
    els.mailFrame.srcdoc = frameDoc(state.selected.html);
    setHealth('Ready');
  } catch (err) {
    els.agent.textContent = err.message;
    setHealth('Message failed');
  }
}

async function runAgent(action) {
  if (!state.selected) return;
  const label = action === 'draft' ? 'Drafting' : action === 'triage' ? 'Triaging' : 'Summarizing';
  els.agentTitle.textContent = label;
  els.agent.textContent = `${label} with ${els.agentEngine.value}...`;
  const data = await api('/api/agent', {
    method: 'POST',
    body: JSON.stringify({
      action,
      engine: els.agentEngine.value,
      instructions: els.agentInstructions.value,
      message: state.selected,
    }),
  });
  els.agentTitle.textContent = `${titleCase(action)} via ${data.engine}`;
  const suffix = data.errors?.length ? `\n\nFallback notes:\n${data.errors.join('\n')}` : '';
  els.agent.textContent = data.result + suffix;
  if (action === 'draft') els.draftBox.value = data.result;
}

async function runTopChat() {
  const prompt = els.aiChatInput.value.trim();
  if (!prompt) return;
  els.agentTitle.textContent = 'AI chat';
  els.agent.textContent = `Thinking with ${els.agentEngine.value}...`;
  const data = await api('/api/agent', {
    method: 'POST',
    body: JSON.stringify({
      action: 'chat',
      engine: els.agentEngine.value,
      instructions: prompt,
      message: state.selected || {
        from: state.currentAccount,
        to: state.currentAccount,
        subject: `Mailbox query: ${els.query.value}`,
        text: `Current account: ${state.currentAccount}\nCurrent Gmail query: ${els.query.value}\nVisible subjects:\n${state.messages.slice(0, 12).map(item => `- ${item.subject}`).join('\n')}`,
      },
    }),
  });
  els.agentTitle.textContent = `AI chat via ${data.engine}`;
  els.agent.textContent = data.result;
}

async function runMessageAction(action) {
  if (!state.selected) return;
  const label = action === 'read' ? 'mark this message read'
    : action === 'unread' ? 'mark this message unread'
      : action === 'trash' ? 'move this message to trash'
        : 'archive this message';
  if (!confirm(`Do you want to ${label}?`)) return;
  setHealth('Updating');
  await api('/api/message/action', {
    method: 'POST',
    body: JSON.stringify({
      account: state.selected.account || state.currentAccount,
      messageId: state.selected.id,
      action,
      confirmAction: true,
    }),
  });
  els.agentTitle.textContent = 'Message updated';
  els.agent.textContent = `${titleCase(action)} completed.`;
  setHealth('Ready');
  await search();
}

function openCompose() {
  els.composeModal.hidden = false;
  els.composeTo.focus();
}

function closeCompose() {
  els.composeModal.hidden = true;
}

async function sendCompose() {
  const account = state.currentAccount || els.account.value;
  const to = els.composeTo.value.trim();
  const subject = els.composeSubject.value.trim();
  const body = els.composeBody.value.trim();
  if (!account || !to || !subject || !body) return;
  if (!confirm(`Send this message from ${account}?`)) return;
  setHealth('Sending');
  await api('/api/compose', {
    method: 'POST',
    body: JSON.stringify({
      account,
      to,
      cc: els.composeCc.value.trim(),
      subject,
      body,
      confirmSend: true,
    }),
  });
  closeCompose();
  els.composeForm.reset();
  els.agentTitle.textContent = 'Sent';
  els.agent.textContent = `Message sent to ${to}.`;
  setHealth('Ready');
}

async function sendDraft() {
  if (!state.selected || !els.draftBox.value.trim()) return;
  const ok = confirm(`Send this reply from ${state.selected.account || state.currentAccount}?`);
  if (!ok) return;
  setHealth('Sending');
  await api('/api/send', {
    method: 'POST',
    body: JSON.stringify({
      account: state.selected.account || state.currentAccount,
      messageId: state.selected.id,
      threadId: state.selected.threadId,
      body: els.draftBox.value,
      confirmSend: true,
    }),
  });
  els.agentTitle.textContent = 'Sent';
  els.agent.textContent = 'Reply sent.';
  setHealth('Ready');
}

function frameDoc(html) {
  return `<!doctype html><html><head><base target="_blank"><style>
    body{font-family:Arial,sans-serif;margin:22px;color:#162029;line-height:1.5}
    img{max-width:100%;height:auto}
    table{max-width:100%}
    pre{white-space:pre-wrap;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
    a{color:#0b7285}
  </style></head><body>${html || ''}</body></html>`;
}

function loadingRow(detail, title = 'Loading') {
  return `<div class="message"><span class="from">${escapeHtml(title)}</span><strong>${escapeHtml(detail)}</strong><span class="snippet"></span></div>`;
}

function labelForQuery(query) {
  if (query.includes('is:unread')) return 'Unread';
  if (query.includes('is:important')) return 'Important';
  if (query.includes('icloud.com')) return 'iCloud';
  if (query.includes('has:attachment')) return 'Attachments';
  return 'Inbox';
}

function shortFrom(value) {
  return String(value || '').replace(/<.*?>/g, '').replaceAll('"', '').trim() || value;
}

function formatDate(value) {
  if (!value) return '';
  const date = Number.isFinite(Number(value)) ? new Date(Number(value)) : new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date);
}

function titleCase(value) {
  return String(value || '').slice(0, 1).toUpperCase() + String(value || '').slice(1);
}

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

els.searchForm.addEventListener('submit', event => {
  event.preventDefault();
  search();
});
els.aiChatForm.addEventListener('submit', event => {
  event.preventDefault();
  runTopChat().catch(err => (els.agent.textContent = err.message));
});
els.refresh.addEventListener('click', search);
els.account.addEventListener('change', search);
els.summarize.addEventListener('click', () => runAgent('summarize').catch(err => (els.agent.textContent = err.message)));
els.triage.addEventListener('click', () => runAgent('triage').catch(err => (els.agent.textContent = err.message)));
els.draft.addEventListener('click', () => runAgent('draft').catch(err => (els.agent.textContent = err.message)));
els.archiveMessage.addEventListener('click', () => runMessageAction('archive').catch(err => (els.agent.textContent = err.message)));
els.markRead.addEventListener('click', () => runMessageAction('read').catch(err => (els.agent.textContent = err.message)));
els.markUnread.addEventListener('click', () => runMessageAction('unread').catch(err => (els.agent.textContent = err.message)));
els.trashMessage.addEventListener('click', () => runMessageAction('trash').catch(err => (els.agent.textContent = err.message)));
els.copyDraft.addEventListener('click', () => navigator.clipboard.writeText(els.draftBox.value || els.agent.textContent || ''));
els.sendDraft.addEventListener('click', () => sendDraft().catch(err => {
  els.agent.textContent = err.message;
  setHealth('Send failed');
}));
els.compose.addEventListener('click', openCompose);
els.closeCompose.addEventListener('click', closeCompose);
els.composeForm.addEventListener('submit', event => {
  event.preventDefault();
  sendCompose().catch(err => {
    els.agent.textContent = err.message;
    setHealth('Send failed');
  });
});
document.querySelectorAll('[data-query]').forEach(button => {
  button.addEventListener('click', () => {
    document.querySelectorAll('.mailboxes button').forEach(el => el.classList.remove('active'));
    if (button.closest('.mailboxes')) button.classList.add('active');
    els.query.value = button.dataset.query;
    search();
  });
});

Promise.all([loadAccounts(), loadAgentStatus()])
  .then(search)
  .catch(err => {
    setHealth('Setup needed');
    els.messages.innerHTML = loadingRow(err.message, 'Unavailable');
  });
