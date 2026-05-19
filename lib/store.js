import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS threads (
  id TEXT NOT NULL,
  account TEXT NOT NULL,
  subject TEXT,
  from_address TEXT,
  last_date INTEGER,
  snippet TEXT,
  labels_json TEXT,
  unread INTEGER DEFAULT 0,
  summary TEXT,
  summary_at INTEGER,
  cached_at INTEGER NOT NULL,
  PRIMARY KEY (id, account)
);

CREATE INDEX IF NOT EXISTS idx_threads_account_date ON threads(account, last_date DESC);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  account TEXT NOT NULL,
  subject TEXT,
  from_address TEXT,
  to_address TEXT,
  cc_address TEXT,
  internal_date INTEGER,
  snippet TEXT,
  text_body TEXT,
  html_body TEXT,
  headers_json TEXT,
  labels_json TEXT,
  cached_at INTEGER NOT NULL,
  PRIMARY KEY (id, account)
);

CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(account, thread_id, internal_date);

CREATE TABLE IF NOT EXISTS chat (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id TEXT NOT NULL,
  account TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  ts INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chat_thread ON chat(account, thread_id, id);

CREATE TABLE IF NOT EXISTS prefs (
  key TEXT PRIMARY KEY,
  value TEXT
);
`;

let db = null;

export function openStore(dataDir) {
  if (db) return db;
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'mail-os.sqlite');
  db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.exec(SCHEMA);
  return db;
}

function now() {
  return Date.now();
}

function dateToEpoch(value) {
  if (!value) return null;
  if (Number.isFinite(Number(value))) {
    const n = Number(value);
    return n < 1e12 ? n * 1000 : n;
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

export function upsertThreadFromSearchItem(account, item) {
  const stmt = db.prepare(`
    INSERT INTO threads (id, account, subject, from_address, last_date, snippet, labels_json, unread, cached_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id, account) DO UPDATE SET
      subject=excluded.subject,
      from_address=excluded.from_address,
      last_date=excluded.last_date,
      snippet=excluded.snippet,
      labels_json=excluded.labels_json,
      unread=excluded.unread,
      cached_at=excluded.cached_at
  `);
  stmt.run(
    item.threadId || item.id,
    account,
    item.subject || '',
    item.from || '',
    dateToEpoch(item.date) || 0,
    item.snippet || '',
    JSON.stringify(item.labels || []),
    item.unread ? 1 : 0,
    now(),
  );
}

export function upsertMessage(account, message) {
  const stmt = db.prepare(`
    INSERT INTO messages (id, thread_id, account, subject, from_address, to_address, cc_address, internal_date, snippet, text_body, html_body, headers_json, labels_json, cached_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id, account) DO UPDATE SET
      thread_id=excluded.thread_id,
      subject=excluded.subject,
      from_address=excluded.from_address,
      to_address=excluded.to_address,
      cc_address=excluded.cc_address,
      internal_date=excluded.internal_date,
      snippet=excluded.snippet,
      text_body=excluded.text_body,
      html_body=excluded.html_body,
      headers_json=excluded.headers_json,
      labels_json=excluded.labels_json,
      cached_at=excluded.cached_at
  `);
  stmt.run(
    message.id,
    message.threadId || message.id,
    account,
    message.subject || '',
    message.from || '',
    message.to || '',
    message.cc || '',
    dateToEpoch(message.date) || 0,
    message.snippet || '',
    message.text || '',
    message.html || '',
    JSON.stringify(message.headers || {}),
    JSON.stringify(message.labels || []),
    now(),
  );
}

export function getCachedMessage(account, id) {
  const row = db.prepare('SELECT * FROM messages WHERE id = ? AND account = ?').get(id, account);
  if (!row) return null;
  return {
    id: row.id,
    threadId: row.thread_id,
    account: row.account,
    subject: row.subject,
    from: row.from_address,
    to: row.to_address,
    cc: row.cc_address,
    date: row.internal_date,
    snippet: row.snippet,
    text: row.text_body,
    html: row.html_body,
    labels: safeJson(row.labels_json, []),
    cachedAt: row.cached_at,
  };
}

export function getCachedThreadMessages(account, threadId) {
  const rows = db.prepare('SELECT * FROM messages WHERE account = ? AND thread_id = ? ORDER BY internal_date ASC').all(account, threadId);
  return rows.map(row => ({
    id: row.id,
    threadId: row.thread_id,
    account: row.account,
    subject: row.subject,
    from: row.from_address,
    to: row.to_address,
    cc: row.cc_address,
    date: row.internal_date,
    snippet: row.snippet,
    text: row.text_body,
    html: row.html_body,
    labels: safeJson(row.labels_json, []),
  }));
}

export function setThreadSummary(account, threadId, summary) {
  db.prepare('UPDATE threads SET summary = ?, summary_at = ? WHERE id = ? AND account = ?').run(summary, now(), threadId, account);
}

export function getThreadSummary(account, threadId) {
  const row = db.prepare('SELECT summary, summary_at FROM threads WHERE id = ? AND account = ?').get(threadId, account);
  if (!row) return null;
  return { summary: row.summary, summaryAt: row.summary_at };
}

export function listRecentThreads(account, limit = 50) {
  return db.prepare('SELECT id, account, subject, from_address as from_address, last_date, snippet FROM threads WHERE account = ? ORDER BY last_date DESC LIMIT ?').all(account, limit);
}

export function listAllRecentThreads(limit = 100) {
  return db.prepare('SELECT id, account, subject, from_address as from_address, last_date, snippet FROM threads ORDER BY last_date DESC LIMIT ?').all(limit);
}

export function appendChat(account, threadId, role, content) {
  db.prepare('INSERT INTO chat (thread_id, account, role, content, ts) VALUES (?, ?, ?, ?, ?)').run(threadId || '', account || '', role, content, now());
}

export function recentChat(account, threadId, limit = 20) {
  const rows = db.prepare('SELECT role, content, ts FROM chat WHERE account = ? AND thread_id = ? ORDER BY id DESC LIMIT ?').all(account || '', threadId || '', limit);
  return rows.reverse();
}

export function clearChat(account, threadId) {
  db.prepare('DELETE FROM chat WHERE account = ? AND thread_id = ?').run(account || '', threadId || '');
}

export function getPref(key, fallback = null) {
  const row = db.prepare('SELECT value FROM prefs WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

export function setPref(key, value) {
  db.prepare('INSERT INTO prefs (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
}

function safeJson(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}
