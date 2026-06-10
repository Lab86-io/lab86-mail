import type { SearchAst, SearchClause, SearchProvider, SearchUnsupportedClause } from './ast';

export interface CorpusMessageDocument {
  accountId: string;
  provider: SearchProvider;
  providerMessageId: string;
  providerThreadId: string;
  subject: string;
  from: string;
  to: string;
  cc?: string;
  bcc?: string;
  receivedAt: number;
  snippet: string;
  textBody?: string;
  searchText: string;
  labels: string[];
  unread?: boolean;
  starred?: boolean;
  attachments?: unknown[];
  updatedAt?: number;
}

export interface LocalSearchPlan {
  query: string;
  dropped: SearchUnsupportedClause[];
}

export function compileAstToLocalCorpusQuery(ast: SearchAst): LocalSearchPlan {
  const terms: string[] = [];
  const dropped: SearchUnsupportedClause[] = [];
  for (const clause of ast.clauses) collectLocalSearchTerm(clause, terms, dropped);
  return { query: terms.join(' ').trim(), dropped };
}

export function filterCorpusMessagesByAst(messages: CorpusMessageDocument[], ast: SearchAst) {
  if (!ast.clauses.length) return messages;
  return messages.filter((message) => ast.clauses.every((clause) => matchesClause(message, clause)));
}

export function corpusMessagesToThreads(messages: CorpusMessageDocument[], accountId: string) {
  const byThread = new Map<string, CorpusMessageDocument[]>();
  for (const message of messages) {
    const group = byThread.get(message.providerThreadId) || [];
    group.push(message);
    byThread.set(message.providerThreadId, group);
  }
  return [...byThread.values()]
    .map((threadMessages) => {
      const sorted = [...threadMessages].sort((a, b) => b.receivedAt - a.receivedAt);
      const latest = sorted[0];
      const labels = [...new Set(threadMessages.flatMap((message) => message.labels || []))];
      return {
        _id: latest.providerThreadId,
        account: accountId,
        subject: latest.subject || '(no subject)',
        fromAddress: latest.from || '',
        lastDate: latest.receivedAt,
        snippet: latest.snippet || latest.textBody?.slice(0, 240) || '',
        labels,
        unread: threadMessages.some((message) => Boolean(message.unread) || hasLabel(message, 'UNREAD')),
        starred: threadMessages.some((message) => Boolean(message.starred) || hasLabel(message, 'STARRED')),
        cachedAt: latest.updatedAt || Date.now(),
      };
    })
    .sort((a, b) => Number(b.lastDate || 0) - Number(a.lastDate || 0));
}

function collectLocalSearchTerm(clause: SearchClause, terms: string[], dropped: SearchUnsupportedClause[]) {
  if (clause.negated) return;
  switch (clause.type) {
    case 'text':
    case 'from':
    case 'to':
    case 'subject':
      terms.push(clause.value);
      return;
    case 'or':
      return;
    case 'folder':
    case 'unread':
    case 'starred':
    case 'important':
    case 'attachment':
    case 'after':
    case 'before':
      return;
    default:
      dropped.push({ clause, reason: 'local search does not understand this clause' });
  }
}

function matchesClause(message: CorpusMessageDocument, clause: SearchClause): boolean {
  const matched = matchesPositiveClause(message, clause);
  return clause.negated ? !matched : matched;
}

function matchesPositiveClause(message: CorpusMessageDocument, clause: SearchClause): boolean {
  switch (clause.type) {
    case 'folder':
      return hasSystemLabel(message, clause.value);
    case 'unread':
      return (Boolean(message.unread) || hasLabel(message, 'UNREAD')) === clause.value;
    case 'starred':
      return (Boolean(message.starred) || hasLabel(message, 'STARRED')) === clause.value;
    case 'important':
      return hasAnyLabel(message, ['IMPORTANT', 'Important', 'FLAGGED', 'Flagged']) === clause.value;
    case 'attachment':
      return Boolean(message.attachments?.length) === clause.value;
    case 'from':
      return includesFolded(message.from, clause.value);
    case 'to':
      return includesFolded([message.to, message.cc, message.bcc].filter(Boolean).join(' '), clause.value);
    case 'subject':
      return includesFolded(message.subject, clause.value);
    case 'after':
      return message.receivedAt >= startOfDay(clause.value);
    case 'before':
      return message.receivedAt <= endOfDay(clause.value);
    case 'text':
      return includesAllTerms(message.searchText, clause.value);
    case 'or':
      return clause.clauses.some((child) => matchesClause(message, child));
  }
}

function hasLabel(message: CorpusMessageDocument, label: string) {
  const expected = normalizeLabel(label);
  return (message.labels || []).some((item) => normalizeLabel(item) === expected);
}

function hasAnyLabel(message: CorpusMessageDocument, labels: readonly string[]) {
  return labels.some((label) => hasLabel(message, label));
}

function hasSystemLabel(message: CorpusMessageDocument, folder: string) {
  const normalized = normalizeFolder(folder);
  if (normalized === 'ALL') {
    return (
      !hasAnyLabel(message, SYSTEM_LABEL_ALIASES.TRASH) && !hasAnyLabel(message, SYSTEM_LABEL_ALIASES.SPAM)
    );
  }
  const aliases = SYSTEM_LABEL_ALIASES[normalized as keyof typeof SYSTEM_LABEL_ALIASES] || [normalized];
  return hasAnyLabel(message, aliases);
}

function includesFolded(value: string | undefined, needle: string) {
  return String(value || '')
    .toLowerCase()
    .includes(needle.toLowerCase());
}

function includesAllTerms(value: string | undefined, query: string) {
  const folded = String(value || '').toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((term) => folded.includes(term));
}

function normalizeFolder(value: string) {
  const lower = value.toLowerCase();
  if (lower === 'sent') return 'SENT';
  if (lower === 'draft' || lower === 'drafts') return 'DRAFTS';
  if (lower === 'trash') return 'TRASH';
  if (lower === 'spam') return 'SPAM';
  if (lower === 'inbox') return 'INBOX';
  if (lower === 'archive' || lower === 'archived') return 'ARCHIVE';
  if (lower === 'all' || lower === 'allmail' || lower === 'all_mail') return 'ALL';
  return value;
}

const SYSTEM_LABEL_ALIASES = {
  INBOX: ['INBOX', 'Inbox', '\\Inbox'],
  SENT: ['SENT', 'Sent', 'Sent Items', 'Sent Mail', '\\Sent'],
  DRAFTS: ['DRAFT', 'DRAFTS', 'Draft', 'Drafts', '\\Drafts'],
  TRASH: ['TRASH', 'Trash', 'Deleted Items', 'DeletedItems', '\\Trash'],
  SPAM: ['SPAM', 'Spam', 'Junk', 'Junk Email', 'JunkEmail', '\\Junk'],
  ARCHIVE: ['ARCHIVE', 'Archive', 'Archived', 'All Mail', '\\Archive'],
} as const;

function normalizeLabel(value: string) {
  return String(value || '')
    .replace(/^\\/, '')
    .replace(/[\s_-]+/g, '')
    .toLowerCase();
}

function startOfDay(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return Number.NEGATIVE_INFINITY;
  date.setUTCHours(0, 0, 0, 0);
  return date.valueOf();
}

function endOfDay(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return Number.POSITIVE_INFINITY;
  date.setUTCHours(23, 59, 59, 999);
  return date.valueOf();
}
