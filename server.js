import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  openStore,
  upsertThreadFromSearchItem,
  upsertMessage,
  getCachedMessage,
  getCachedThreadMessages,
  setThreadSummary,
  getThreadSummary,
  listAllRecentThreads,
  appendChat,
  recentChat,
  clearChat,
  getPref,
  setPref,
} from './lib/store.js';
import { openStream } from './lib/sse.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadDotEnv(path.join(__dirname, '.env'));
loadDotEnv('/home/jjalangtry/.config/mail-os/mail-os.env');

const HOST = process.env.MAIL_OS_HOST || '127.0.0.1';
const PORT = Number(process.env.MAIL_OS_PORT || 18836);
const GOG_BIN = process.env.MAIL_OS_GOG_BIN || '/home/jjalangtry/.local/bin/lab86-gog';
const CODEX_BIN = process.env.MAIL_OS_CODEX_BIN || 'codex';
const CLAUDE_BIN = process.env.MAIL_OS_CLAUDE_BIN || 'claude';
const AGENT_ENGINE = process.env.MAIL_OS_AGENT_ENGINE || 'auto';
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const MAX_BODY = 1024 * 1024;

openStore(DATA_DIR);

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const [key, ...rest] = line.split('=');
    if (!process.env[key]) process.env[key] = rest.join('=').replace(/^"|"$/g, '');
  }
}

function json(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

function text(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
  });
  res.end(body);
}

function errorJson(res, status, message, detail) {
  json(res, status, { ok: false, error: message, detail: detail || null });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function runGog(args, options = {}) {
  return runProcess(GOG_BIN, args, options);
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || __dirname,
      env: process.env,
      timeout: options.timeoutMs || 45000,
      maxBuffer: 16 * 1024 * 1024,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', chunk => (stderr += chunk.toString('utf8')));
    child.on('error', reject);
    if (options.stdin) {
      child.stdin.end(options.stdin);
    }
    child.on('close', code => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        const err = new Error(stderr.trim() || stdout.trim() || `gog exited ${code}`);
        err.code = code;
        reject(err);
      }
    });
  });
}

async function runGogJson(args, options = {}) {
  const out = await runGog(args, options);
  if (!out) return null;
  return JSON.parse(out);
}

function configuredAccounts() {
  return String(process.env.MAIL_OS_ACCOUNTS || '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

async function accounts() {
  const configured = configuredAccounts();
  let discovered = [];
  let raw = null;
  try {
    raw = await runGogJson(['auth', 'list', '--json', '--no-input'], { timeoutMs: 15000 });
    discovered = (raw?.accounts || []).map(item => item.email).filter(Boolean);
  } catch {
    discovered = [];
  }
  const emails = [...new Set([...configured, ...discovered])];
  return emails.map(email => {
    const stored = raw?.accounts?.find(item => item.email === email);
    return {
      email,
      provider: 'gmail',
      authed: Boolean(stored),
      services: stored?.services || [],
      auth: stored?.auth || null,
      client: stored?.client || null,
      primary: email === 'jakob@lab86.io',
    };
  });
}

function coerceItems(raw) {
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw?.messages)) return raw.messages;
  if (Array.isArray(raw?.threads)) return raw.threads;
  if (Array.isArray(raw?.results)) return raw.results;
  if (Array.isArray(raw?.items)) return raw.items;
  if (Array.isArray(raw?.data)) return raw.data;
  return [];
}

function normalizeSearchItem(item, account) {
  return {
    id: item.id || item.messageId || item.message_id || item.latestMessageId || item.latest_message_id || item.threadId,
    threadId: item.threadId || item.thread_id || item.thread || item.id,
    account,
    subject: item.subject || item.Subject || '(no subject)',
    from: item.from || item.From || item.sender || '',
    to: item.to || item.To || '',
    date: item.date || item.Date || item.internalDate || item.internal_date || '',
    snippet: item.snippet || item.preview || '',
    labels: item.labels || item.labelIds || item.label_ids || [],
    unread: labelsOf(item).includes('UNREAD'),
  };
}

function labelsOf(item) {
  const value = item.labels || item.labelIds || item.label_ids || [];
  if (Array.isArray(value)) return value;
  return String(value).split(',').map(label => label.trim()).filter(Boolean);
}

function unwrapMessage(raw) {
  return raw?.message || raw?.result || raw?.data || raw;
}

function headerMap(message) {
  const headers = message?.payload?.headers || message?.headers || [];
  const map = {};
  for (const item of headers) {
    const name = item.name || item.key;
    if (name) map[name.toLowerCase()] = item.value || '';
  }
  return map;
}

function decodeBodyData(data) {
  if (!data) return '';
  return Buffer.from(String(data).replaceAll('-', '+').replaceAll('_', '/'), 'base64').toString('utf8');
}

function collectBodies(part, out = { html: '', text: '' }) {
  if (!part) return out;
  const mimeType = part.mimeType || part.mime_type || '';
  const body = part.body || {};
  const decoded = decodeBodyData(body.data);
  if (decoded && mimeType.includes('text/html')) out.html += decoded;
  if (decoded && mimeType.includes('text/plain')) out.text += decoded;
  for (const child of part.parts || []) collectBodies(child, out);
  return out;
}

function sanitizeHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, match => match.slice(0, 120000))
    .replace(/\son[a-z]+\s*=\s*(['"]).*?\1/gi, '')
    .replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, '')
    .replace(/\s(href|src)\s*=\s*(['"])\s*javascript:[\s\S]*?\2/gi, '')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
    .replace(/<object[\s\S]*?<\/object>/gi, '')
    .replace(/<embed[\s\S]*?<\/embed>/gi, '');
}

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function normalizeMessage(raw, account) {
  const message = unwrapMessage(raw) || {};
  const headers = headerMap(message);
  const bodies = collectBodies(message.payload || message);
  const textBody = message.text || message.bodyText || bodies.text || message.snippet || '';
  const htmlBody = message.html || message.bodyHtml || bodies.html || '';
  return {
    id: message.id || message.messageId || message.message_id,
    threadId: message.threadId || message.thread_id,
    account,
    subject: headers.subject || message.subject || '(no subject)',
    from: headers.from || message.from || '',
    to: headers.to || message.to || '',
    cc: headers.cc || message.cc || '',
    date: headers.date || message.date || '',
    snippet: message.snippet || '',
    labels: message.labelIds || message.labels || [],
    text: textBody,
    html: htmlBody ? sanitizeHtml(htmlBody) : `<pre>${escapeHtml(textBody)}</pre>`,
  };
}

function messageTextForAgent(message) {
  return [
    `From: ${message.from}`,
    `To: ${message.to}`,
    `Subject: ${message.subject}`,
    '',
    message.text || message.snippet || '',
  ].join('\n').slice(0, 12000);
}

function commandAvailable(command) {
  if (!command) return false;
  if (command.includes('/')) return fs.existsSync(command);
  return String(process.env.PATH || '')
    .split(path.delimiter)
    .filter(Boolean)
    .some(dir => fs.existsSync(path.join(dir, command)));
}

function availableAgentEngines() {
  return {
    preferred: AGENT_ENGINE,
    claude: commandAvailable(CLAUDE_BIN),
    codex: commandAvailable(CODEX_BIN),
    local: true,
  };
}

function buildAgentPrompt(action, message, instructions = '') {
  const task = action === 'chat'
    ? 'Answer Jakob\'s question about this mailbox or selected email. If no email context is available, answer as a general email assistant.'
    : action === 'draft'
    ? 'Write a polished reply draft Jakob can review before sending.'
    : action === 'triage'
      ? 'Triage this email and decide urgency, owner, and next action.'
      : 'Summarize this email and call out the likely next action.';
  const output = action === 'chat'
    ? 'Answer directly. Include concrete next steps when useful. Do not claim any action was performed.'
    : action === 'draft'
    ? 'Return only the reply draft body. Do not include analysis or claim it was sent.'
    : 'Return compact sections: Priority, Summary, Next action, Reply posture. Keep it under 180 words.';
  return [
    'You are Mail OS, a local email operations agent for Jakob.',
    'You can reason over the email text, but you cannot send, archive, delete, or mutate anything.',
    'Be concrete. If details are missing, say what is missing.',
    `Task: ${task}`,
    `Output format: ${output}`,
    instructions ? `Jakob's prompt: ${instructions}` : '',
    'Email:',
    messageTextForAgent(message),
  ].filter(Boolean).join('\n\n');
}

function candidateEngines(requested) {
  const normalized = requested && requested !== 'auto' ? requested : AGENT_ENGINE;
  if (normalized === 'claude') return ['claude'];
  if (normalized === 'codex') return ['codex'];
  if (normalized === 'local') return [];
  return commandAvailable(CLAUDE_BIN) ? ['claude', 'codex'] : ['codex', 'claude'];
}

async function runLocalAgent(action, message, instructions = '', requested = 'auto') {
  const prompt = buildAgentPrompt(action, message, instructions);
  return runAgentWithPrompt(prompt, requested);
}

async function runAgentWithPrompt(prompt, requested = 'auto') {
  const errors = [];
  for (const engine of candidateEngines(requested)) {
    try {
      if (engine === 'claude' && commandAvailable(CLAUDE_BIN)) {
        const args = claudeArgs();
        const result = await runProcess(CLAUDE_BIN, args, { stdin: prompt, timeoutMs: 120000 });
        if (result) return { result, engine: 'claude' };
      }
      if (engine === 'codex' && commandAvailable(CODEX_BIN)) {
        const args = codexArgs();
        const result = await runProcess(CODEX_BIN, args, { stdin: prompt, timeoutMs: 120000 });
        if (result) return { result, engine: 'codex' };
      }
    } catch (err) {
      errors.push(`${engine}: ${err.message}`);
    }
  }
  return { result: null, engine: 'local', errors };
}

function claudeArgs() {
  const args = [
    '--print',
    '--input-format', 'text',
    '--output-format', 'text',
    '--permission-mode', 'dontAsk',
    '--tools', '',
    '--no-session-persistence',
  ];
  if (process.env.MAIL_OS_CLAUDE_MODEL) args.push('--model', process.env.MAIL_OS_CLAUDE_MODEL);
  return args;
}

function codexArgs() {
  const args = [
    'exec',
    '--skip-git-repo-check',
    '--ephemeral',
    '--sandbox', 'read-only',
    '--cd', __dirname,
  ];
  if (process.env.MAIL_OS_CODEX_MODEL) args.push('--model', process.env.MAIL_OS_CODEX_MODEL);
  args.push('-');
  return args;
}

function streamAgent(prompt, requested, { onChunk, onError }) {
  const engines = candidateEngines(requested);
  let buffer = '';
  return new Promise((resolve) => {
    const tryNext = (index, errors) => {
      if (index >= engines.length) return resolve({ result: buffer.trim() || null, engine: 'local', errors });
      const engine = engines[index];
      const bin = engine === 'claude' ? CLAUDE_BIN : CODEX_BIN;
      if (!commandAvailable(bin)) return tryNext(index + 1, errors);
      const args = engine === 'claude' ? claudeArgs() : codexArgs();
      const child = spawn(bin, args, {
        cwd: __dirname,
        env: process.env,
        timeout: 180000,
        maxBuffer: 16 * 1024 * 1024,
      });
      let localBuffer = '';
      child.stdout.on('data', chunk => {
        const text = chunk.toString('utf8');
        localBuffer += text;
        buffer += text;
        try { onChunk(text, engine); } catch {}
      });
      child.stderr.on('data', () => {});
      child.on('error', err => {
        errors.push(`${engine}: ${err.message}`);
        tryNext(index + 1, errors);
      });
      child.on('close', code => {
        if (code === 0 && localBuffer.trim()) {
          resolve({ result: localBuffer.trim(), engine, errors });
        } else {
          errors.push(`${engine}: exit ${code}`);
          buffer = '';
          tryNext(index + 1, errors);
        }
      });
      child.stdin.end(prompt);
    };
    tryNext(0, []);
  });
}

async function maybeOpenAI(task, message, instructions = '') {
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL;
  if (!apiKey || !model) return null;
  const prompt = [
    'You are helping Jakob manage email. Be concise, accurate, and do not claim an email was sent.',
    `Task: ${task}`,
    instructions ? `Instructions: ${instructions}` : '',
    'Email:',
    messageTextForAgent(message),
  ].filter(Boolean).join('\n\n');
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      input: prompt,
      max_output_tokens: 700,
    }),
  });
  if (!response.ok) throw new Error(`OpenAI request failed: ${response.status}`);
  const data = await response.json();
  return data.output_text || data.output?.flatMap(item => item.content || []).map(item => item.text || '').join('\n') || null;
}

function parseBulkVerdicts(text, items) {
  const verdicts = items.map((it, i) => ({ index: i + 1, id: it.id, priority: 2, action: 'read', reason: '' }));
  if (!text) return verdicts;
  const lines = String(text).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  for (const line of lines) {
    const m = line.match(/^(\d+)\.\s*priority\s*=\s*([1-3])\s+action\s*=\s*([a-z]+)\s+reason\s*=\s*(.*)$/i);
    if (!m) continue;
    const idx = Number(m[1]) - 1;
    if (idx < 0 || idx >= verdicts.length) continue;
    verdicts[idx].priority = Number(m[2]);
    verdicts[idx].action = m[3].toLowerCase();
    verdicts[idx].reason = m[4].trim();
  }
  return verdicts;
}

function localSummary(message) {
  const textBody = (message.text || message.snippet || '').replace(/\s+/g, ' ').trim();
  const preview = textBody ? textBody.slice(0, 420) : 'No readable body text was available.';
  return `From ${message.from || 'unknown sender'} about "${message.subject}". ${preview}`;
}

function localDraft(message, instructions = '') {
  const sender = String(message.from || '').replace(/<.*?>/g, '').trim().split(/\s+/)[0] || 'there';
  const goal = instructions ? `\n\n${instructions.trim()}` : '';
  return `Hi ${sender},\n\nThanks for reaching out. I saw this and will take a closer look.${goal}\n\nBest,\nJakob`;
}

function gmailUrl(account, message) {
  const authuser = encodeURIComponent(account);
  const thread = encodeURIComponent(message.threadId || message.id || '');
  return `https://mail.google.com/mail/u/${authuser}/#all/${thread}`;
}

async function handleApi(req, res, url) {
  try {
    if (url.pathname === '/healthz') {
      const acc = await accounts();
      return json(res, 200, {
        ok: true,
        service: 'mail-os',
        accounts: acc.length,
        authed: acc.filter(item => item.authed).map(item => item.email),
        gog: fs.existsSync(GOG_BIN),
        agents: availableAgentEngines(),
      });
    }

    if (url.pathname === '/api/accounts') {
      return json(res, 200, { ok: true, accounts: await accounts() });
    }

    if (url.pathname === '/api/agent/status') {
      return json(res, 200, { ok: true, agents: availableAgentEngines() });
    }

    if (url.pathname === '/api/search') {
      const account = required(url.searchParams.get('account'), 'account');
      const query = url.searchParams.get('q') || 'in:inbox newer_than:30d';
      const max = Math.min(Number(url.searchParams.get('max') || 25), 50);
      const raw = await runGogJson(['--account', account, '--json', '--results-only', 'gmail', 'search', query, '--max', String(max), '--no-input']);
      const items = coerceItems(raw).map(item => normalizeSearchItem(item, account)).filter(item => item.id);
      for (const item of items) {
        try { upsertThreadFromSearchItem(account, item); } catch {}
      }
      return json(res, 200, { ok: true, query, account, items });
    }

    if (url.pathname === '/api/message') {
      const account = required(url.searchParams.get('account'), 'account');
      const id = required(url.searchParams.get('id'), 'id');
      const cached = getCachedMessage(account, id);
      if (cached && cached.html && Date.now() - cached.cachedAt < 30 * 60 * 1000) {
        cached.gmailUrl = gmailUrl(account, cached);
        return json(res, 200, { ok: true, message: cached, cached: true });
      }
      const raw = await runGogJson(['--account', account, '--json', 'gmail', 'get', id, '--format', 'full', '--no-input']);
      const message = normalizeMessage(raw, account);
      message.gmailUrl = gmailUrl(account, message);
      try { upsertMessage(account, message); } catch {}
      return json(res, 200, { ok: true, message });
    }

    if (url.pathname === '/api/thread') {
      const account = required(url.searchParams.get('account'), 'account');
      const id = required(url.searchParams.get('id'), 'id');
      const refresh = url.searchParams.get('refresh') === '1';
      let messages = refresh ? [] : getCachedThreadMessages(account, id);
      let summaryRow = getThreadSummary(account, id);
      if (!messages.length) {
        const raw = await runGogJson(['--account', account, '--json', 'gmail', 'thread', 'get', id, '--full', '--no-input']);
        const threadObj = raw?.thread || raw?.result || raw?.data || raw;
        const rawMessages = threadObj?.messages || [];
        messages = rawMessages.map(item => {
          const normalized = normalizeMessage(item, account);
          try { upsertMessage(account, normalized); } catch {}
          return normalized;
        });
        summaryRow = getThreadSummary(account, id);
      }
      const subject = messages[0]?.subject || '(no subject)';
      return json(res, 200, {
        ok: true,
        thread: {
          id,
          account,
          subject,
          messages,
          gmailUrl: gmailUrl(account, { threadId: id, id }),
          summary: summaryRow?.summary || null,
          summaryAt: summaryRow?.summaryAt || null,
        },
      });
    }

    if (url.pathname === '/api/agent/stream' && req.method === 'POST') {
      const body = await readBody(req);
      const action = body.action || 'summarize';
      const message = body.message || {};
      const engine = body.engine || 'auto';
      const stream = openStream(res);
      stream.send('start', { action, engine });
      const prompt = buildAgentPrompt(action, message, body.instructions || '');
      const onChunk = (text, eng) => stream.send('chunk', { text, engine: eng });
      const agent = await streamAgent(prompt, engine, { onChunk });
      let finalText = agent.result;
      if (!finalText) {
        if (action === 'draft') finalText = await maybeOpenAI('Write a reply draft.', message, body.instructions || '') || localDraft(message, body.instructions || '');
        else if (action === 'chat') finalText = await maybeOpenAI('Answer the email assistant prompt.', message, body.instructions || '') || localSummary(message);
        else finalText = await maybeOpenAI('Summarize the email and call out the likely next action.', message, body.instructions || '') || localSummary(message);
        stream.send('chunk', { text: finalText, engine: 'fallback' });
      }
      stream.send('done', { engine: agent.engine, errors: agent.errors || [], result: finalText });
      stream.close();
      return;
    }

    if (url.pathname === '/api/thread/summarize' && req.method === 'POST') {
      const body = await readBody(req);
      const account = required(body.account, 'account');
      const threadId = required(body.threadId, 'threadId');
      const engine = body.engine || 'auto';
      const messages = getCachedThreadMessages(account, threadId);
      if (!messages.length) {
        try {
          const raw = await runGogJson(['--account', account, '--json', 'gmail', 'thread', 'get', threadId, '--full', '--no-input']);
          const threadObj = raw?.thread || raw?.result || raw?.data || raw;
          for (const item of threadObj?.messages || []) {
            const normalized = normalizeMessage(item, account);
            upsertMessage(account, normalized);
          }
        } catch {}
      }
      const all = getCachedThreadMessages(account, threadId);
      const concatenated = all.map((m, i) =>
        `--- Message ${i + 1} of ${all.length} ---\nFrom: ${m.from}\nTo: ${m.to}\nDate: ${m.date}\nSubject: ${m.subject}\n\n${(m.text || m.snippet || '').slice(0, 4000)}`
      ).join('\n\n').slice(0, 24000);
      const stream = openStream(res);
      stream.send('start', { engine });
      const prompt = [
        'You are Mail OS. Summarize this email thread for Jakob.',
        'Format strictly as: 1-line headline, then sections: "Who participated", "What was decided", "Open questions", "Suggested next action".',
        'Keep total under 220 words. Be concrete.',
        '',
        'Thread:',
        concatenated,
      ].join('\n');
      const onChunk = (text, eng) => stream.send('chunk', { text, engine: eng });
      const agent = await streamAgent(prompt, engine, { onChunk });
      let finalText = agent.result;
      if (!finalText) {
        finalText = await maybeOpenAI('Summarize this email thread.', { subject: all[0]?.subject || '', text: concatenated, from: all[0]?.from || '', to: all[0]?.to || '' }, '');
        if (!finalText) finalText = `Thread with ${all.length} messages between ${[...new Set(all.map(m => m.from))].join(', ')}.`;
        stream.send('chunk', { text: finalText, engine: 'fallback' });
      }
      try { setThreadSummary(account, threadId, finalText); } catch {}
      stream.send('done', { engine: agent.engine, result: finalText, errors: agent.errors || [] });
      stream.close();
      return;
    }

    if (url.pathname === '/api/thread/chat' && req.method === 'POST') {
      const body = await readBody(req);
      const account = body.account || '';
      const threadId = body.threadId || '';
      const engine = body.engine || 'auto';
      const userMessage = required(body.message, 'message');
      const messages = threadId ? getCachedThreadMessages(account, threadId) : [];
      const history = recentChat(account, threadId, 12);
      appendChat(account, threadId, 'user', userMessage);
      const concatenated = messages.map((m, i) =>
        `--- Msg ${i + 1} ---\nFrom: ${m.from}\nSubject: ${m.subject}\n\n${(m.text || m.snippet || '').slice(0, 2500)}`
      ).join('\n\n').slice(0, 14000);
      const historyText = history.map(h => `${h.role === 'user' ? 'Jakob' : 'Assistant'}: ${h.content}`).join('\n\n').slice(0, 6000);
      const promptParts = [
        'You are Mail OS, Jakob\'s local email assistant. You can reason about the thread below but cannot send/archive/delete.',
        'Reply directly. Be concrete. If Jakob asks you to draft something, return the draft text only.',
      ];
      if (concatenated) promptParts.push('', 'Current thread:', concatenated);
      if (historyText) promptParts.push('', 'Prior conversation:', historyText);
      promptParts.push('', `Jakob: ${userMessage}`, '', 'Assistant:');
      const prompt = promptParts.join('\n');
      const stream = openStream(res);
      stream.send('start', { engine });
      let finalText = '';
      const onChunk = (text, eng) => { finalText += text; stream.send('chunk', { text, engine: eng }); };
      const agent = await streamAgent(prompt, engine, { onChunk });
      if (!agent.result) {
        const fallback = await maybeOpenAI('Answer this email-assistant question for Jakob.', { subject: messages[0]?.subject || 'Chat', text: `${historyText}\n\nQ: ${userMessage}`, from: '', to: '' }, '');
        finalText = fallback || `I don't have an answer right now. The thread has ${messages.length} message(s).`;
        stream.send('chunk', { text: finalText, engine: 'fallback' });
      } else {
        finalText = agent.result;
      }
      try { appendChat(account, threadId, 'assistant', finalText); } catch {}
      stream.send('done', { engine: agent.engine, result: finalText, errors: agent.errors || [] });
      stream.close();
      return;
    }

    if (url.pathname === '/api/thread/chat/history') {
      const account = url.searchParams.get('account') || '';
      const threadId = url.searchParams.get('threadId') || '';
      return json(res, 200, { ok: true, messages: recentChat(account, threadId, 50) });
    }

    if (url.pathname === '/api/thread/chat/clear' && req.method === 'POST') {
      const body = await readBody(req);
      clearChat(body.account || '', body.threadId || '');
      return json(res, 200, { ok: true });
    }

    if (url.pathname === '/api/bulk/triage' && req.method === 'POST') {
      const body = await readBody(req);
      const items = Array.isArray(body.items) ? body.items.slice(0, 25) : [];
      if (!items.length) return json(res, 200, { ok: true, verdicts: [] });
      const engine = body.engine || 'auto';
      const lines = items.map((it, i) => `${i + 1}. From: ${it.from || ''} | Subject: ${it.subject || '(no subject)'} | Snippet: ${(it.snippet || '').slice(0, 200)}`).join('\n');
      const prompt = [
        'You are Mail OS triaging a batch of emails for Jakob.',
        'For each numbered item return one line in the exact form:',
        '<number>. priority=<1|2|3> action=<reply|read|archive|delegate|wait> reason=<short reason>',
        'No prose before or after. Just one line per item.',
        '',
        'Items:',
        lines,
      ].join('\n');
      const stream = openStream(res);
      stream.send('start', { engine, count: items.length });
      let buffer = '';
      const onChunk = (text, eng) => { buffer += text; stream.send('chunk', { text, engine: eng }); };
      const agent = await streamAgent(prompt, engine, { onChunk });
      const final = agent.result || buffer;
      const verdicts = parseBulkVerdicts(final, items);
      stream.send('done', { engine: agent.engine, verdicts, errors: agent.errors || [] });
      stream.close();
      return;
    }

    if (url.pathname === '/api/prefs') {
      if (req.method === 'GET') {
        const key = url.searchParams.get('key');
        if (!key) throw new Error('key required');
        return json(res, 200, { ok: true, value: getPref(key, null) });
      }
      if (req.method === 'POST') {
        const body = await readBody(req);
        setPref(required(body.key, 'key'), body.value ?? '');
        return json(res, 200, { ok: true });
      }
    }

    if (url.pathname === '/api/recent-threads') {
      const limit = Math.min(Number(url.searchParams.get('limit') || 60), 200);
      return json(res, 200, { ok: true, threads: listAllRecentThreads(limit) });
    }

    if (url.pathname === '/api/agent' && req.method === 'POST') {
      const body = await readBody(req);
      const action = body.action || 'summarize';
      const message = body.message || {};
      const engine = body.engine || 'auto';
      let agent = await runLocalAgent(action, message, body.instructions || '', engine);
      let result = agent.result;
      if (action === 'draft') {
        result ||= await maybeOpenAI('Write a reply draft that Jakob can review before sending.', message, body.instructions || '');
        result ||= localDraft(message, body.instructions || '');
      } else if (action === 'chat') {
        result ||= await maybeOpenAI('Answer Jakob\'s email assistant prompt.', message, body.instructions || '');
        result ||= localSummary(message || { subject: 'Mailbox question', text: body.instructions || '' });
      } else {
        result ||= await maybeOpenAI('Summarize the email and call out likely next action.', message, body.instructions || '');
        result ||= localSummary(message);
      }
      return json(res, 200, {
        ok: true,
        action,
        result,
        engine: agent.engine,
        errors: agent.errors || [],
        ai: agent.engine !== 'local' || Boolean(process.env.OPENAI_API_KEY && process.env.OPENAI_MODEL),
      });
    }

    if (url.pathname === '/api/message/action' && req.method === 'POST') {
      const body = await readBody(req);
      if (body.confirmAction !== true) throw new Error('confirmAction is required');
      const account = required(body.account, 'account');
      const messageId = required(body.messageId, 'messageId');
      const action = required(body.action, 'action');
      const commandByAction = {
        archive: 'archive',
        read: 'mark-read',
        unread: 'unread',
        trash: 'trash',
      };
      const command = commandByAction[action];
      if (!command) throw new Error(`unsupported action: ${action}`);
      const raw = await runGogJson(['--account', account, '--json', 'gmail', command, messageId, '--no-input'], { timeoutMs: 60000 });
      return json(res, 200, { ok: true, action, result: raw || true });
    }

    if (url.pathname === '/api/send' && req.method === 'POST') {
      const body = await readBody(req);
      if (body.confirmSend !== true) throw new Error('confirmSend is required');
      const account = required(body.account, 'account');
      const messageId = required(body.messageId, 'messageId');
      const threadId = body.threadId || '';
      const bodyText = required(body.body, 'body');
      const args = [
        '--account', account,
        '--json',
        'gmail', 'send',
        '--reply-to-message-id', messageId,
        '--body', bodyText,
        '--reply-all',
        '--no-input',
      ];
      if (threadId) args.push('--thread-id', threadId);
      if (body.from) args.push('--from', body.from);
      const raw = await runGogJson(args, { timeoutMs: 60000 });
      return json(res, 200, { ok: true, sent: raw || true });
    }

    if (url.pathname === '/api/compose' && req.method === 'POST') {
      const body = await readBody(req);
      if (body.confirmSend !== true) throw new Error('confirmSend is required');
      const account = required(body.account, 'account');
      const to = required(body.to, 'to');
      const subject = required(body.subject, 'subject');
      const bodyText = required(body.body, 'body');
      const args = [
        '--account', account,
        '--json',
        'gmail', 'send',
        '--to', to,
        '--subject', subject,
        '--body', bodyText,
        '--no-input',
      ];
      if (body.cc) args.push('--cc', body.cc);
      if (body.bcc) args.push('--bcc', body.bcc);
      if (body.from) args.push('--from', body.from);
      const raw = await runGogJson(args, { timeoutMs: 60000 });
      return json(res, 200, { ok: true, sent: raw || true });
    }

    errorJson(res, 404, 'not found');
  } catch (err) {
    errorJson(res, err.message?.includes('required') ? 400 : 500, err.message, err.code ? `gog exit ${err.code}` : null);
  }
}

function required(value, name) {
  if (!value) throw new Error(`${name} required`);
  return String(value);
}

function serveStatic(req, res, url) {
  const routePath = url.pathname === '/' ? '/index.html' : url.pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, routePath));
  if (!filePath.startsWith(PUBLIC_DIR)) return text(res, 403, 'forbidden');
  fs.readFile(filePath, (err, data) => {
    if (err) return text(res, 404, 'not found');
    const ext = path.extname(filePath);
    const type = ext === '.html' ? 'text/html; charset=utf-8'
      : ext === '.css' ? 'text/css; charset=utf-8'
        : ext === '.js' ? 'text/javascript; charset=utf-8'
          : 'application/octet-stream';
    res.writeHead(200, {
      'content-type': type,
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'self'; img-src 'self' https: data:; style-src 'self' 'unsafe-inline'; frame-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'",
    });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  if (url.pathname === '/healthz' || url.pathname.startsWith('/api/')) {
    handleApi(req, res, url);
  } else {
    serveStatic(req, res, url);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`mail-os listening on http://${HOST}:${PORT}`);
});
