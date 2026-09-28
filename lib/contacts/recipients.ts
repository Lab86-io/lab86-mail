import { labelsHaveRole } from '../mail/search/folders';
import { isNoReplyLike } from '../mail/smart-categories';
import { emailFromHeader } from '../shared/format';
import { stripLoneSurrogates, truncateText } from '../shared/text';
import { splitAddressList } from './address-field';
import {
  type ContactSource,
  isConsumerMailbox,
  isWeakHeaderName,
  normalizeContactEmail,
  normalizeSearchText,
} from './model';

// Recipient search for To, Cc, and Bcc. Two indexes feed it: the correspondent
// index (people the user wrote to and heard from, built from the mail corpus)
// and the synced contacts. This module is pure: Convex runs it inside one
// query (convex/correspondents.ts), and tests run it directly. No model calls.

// ---- Frecency --------------------------------------------------------------------
//
// Each mail event adds weight * 2^(-(now - at) / halfLife). The stored value is
// the log of that sum anchored at a fixed epoch, ln(sum(weight * e^((at - epoch)
// / tau))). The decay factor is the same for every row at a given time, so the
// stored number orders rows by their current decayed score and never needs a
// rewrite as time passes. frecencyNow() turns it back into a decayed amount.

const DAY_MS = 86_400_000;
export const FRECENCY_EPOCH_MS = Date.UTC(2020, 0, 1);
export const FRECENCY_HALF_LIFE_MS = 30 * DAY_MS;
const TAU_MS = FRECENCY_HALF_LIFE_MS / Math.LN2;
// A row with no events. Finite, so Convex stores and orders it.
export const FRECENCY_FLOOR = -1_000_000;
// Mail the user sent weighs most; bulk mail almost nothing.
export const EVENT_WEIGHT = { sent: 5, received: 1, bulkReceived: 0.05 } as const;
// Demoted senders (bulk or automated, never written to) sort after every
// other row in the score index.
export const DEMOTED_SCORE_OFFSET = 10_000;

export function logAddExp(a: number, b: number): number {
  if (a <= FRECENCY_FLOOR) return b;
  if (b <= FRECENCY_FLOOR) return a;
  const high = Math.max(a, b);
  return high + Math.log(Math.exp(a - high) + Math.exp(b - high));
}

export function eventFrecency(at: number, weight: number): number {
  return Math.log(weight) + (at - FRECENCY_EPOCH_MS) / TAU_MS;
}

/** The decayed weight of all events now: about "weighted mails in the last half-life". */
export function frecencyNow(frecency: number | undefined, now: number): number {
  if (frecency === undefined || frecency <= FRECENCY_FLOOR) return 0;
  return Math.exp(frecency - (now - FRECENCY_EPOCH_MS) / TAU_MS);
}

// ---- Mail events -------------------------------------------------------------------

export interface MailAddress {
  email: string;
  name?: string;
}

/**
 * Splits a To, Cc, or From header into addresses. Commas and semicolons
 * inside quotes or angle brackets do not split ("Doe, Ann" <ann@x.io>).
 */
export function parseAddressList(value: string | null | undefined): MailAddress[] {
  const out: MailAddress[] = [];
  const seen = new Set<string>();
  for (const part of splitAddressList(value)) {
    const email = normalizeContactEmail(emailFromHeader(part));
    if (!email || seen.has(email)) continue;
    seen.add(email);
    const name = isWeakHeaderName(part) ? undefined : headerName(part);
    out.push(name ? { email, name } : { email });
  }
  return out;
}

function headerName(part: string): string | undefined {
  const name = stripLoneSurrogates(part)
    .replace(/<[^>]*>/g, '')
    .replaceAll('"', '')
    .replace(/\s+/g, ' ')
    .trim();
  return name ? truncateText(name, 200).trim() : undefined;
}

const BULK_GMAIL_CATEGORIES = ['CATEGORY_PROMOTIONS', 'CATEGORY_FORUMS', 'CATEGORY_SOCIAL'];

/** List, campaign, and automated mail: the signals the smart sort also reads. */
export function isBulkInbound(message: {
  from?: string | null;
  headers?: Record<string, unknown> | null;
  labels?: string[] | null;
}): boolean {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(message.headers || {})) {
    if (typeof value === 'string' && value.trim()) headers[key.toLowerCase()] = value.trim();
  }
  if (headers['list-unsubscribe'] || headers['list-id']) return true;
  if (headers['x-campaign-id'] || headers['x-mailer-campaign']) return true;
  if (/^(bulk|list|junk)$/i.test(headers.precedence || '')) return true;
  const auto = headers['auto-submitted'];
  if (auto && !/^no$/i.test(auto)) return true;
  if (isNoReplyLike(message.from)) return true;
  return (message.labels || []).some((label) => BULK_GMAIL_CATEGORIES.includes(label));
}

export interface CorrespondentEvent {
  email: string;
  name?: string;
  kind: 'sent' | 'received';
  at: number;
  bulk: boolean;
  accountId: string;
}

/**
 * The correspondent events of one stored message. A message from one of the
 * user's addresses is sent mail: each other To, Cc, and Bcc address gets a
 * `sent` event. Any other message gives its sender a `received` event.
 * Drafts, spam, and trash give nothing.
 */
export function correspondentEvents(
  message: {
    from?: string | null;
    to?: string | null;
    cc?: string | null;
    bcc?: string | null;
    receivedAt?: number | null;
    labels?: string[] | null;
    headers?: Record<string, unknown> | null;
  },
  accountId: string,
  self: ReadonlySet<string>,
): CorrespondentEvent[] {
  const labels = message.labels || [];
  if (labelsHaveRole(labels, 'DRAFTS') || labelsHaveRole(labels, 'SPAM') || labelsHaveRole(labels, 'TRASH')) {
    return [];
  }
  const at = Math.floor(Number(message.receivedAt) || 0);
  if (at <= 0) return [];
  const [sender] = parseAddressList(message.from);
  if (!sender) return [];
  if (self.has(sender.email)) {
    const recipients = [
      ...parseAddressList(message.to),
      ...parseAddressList(message.cc),
      ...parseAddressList(message.bcc),
    ];
    const seen = new Set<string>();
    const events: CorrespondentEvent[] = [];
    for (const recipient of recipients) {
      if (self.has(recipient.email) || seen.has(recipient.email)) continue;
      seen.add(recipient.email);
      events.push({ ...recipient, kind: 'sent', at, bulk: false, accountId });
    }
    return events;
  }
  return [{ ...sender, kind: 'received', at, bulk: isBulkInbound(message), accountId }];
}

// ---- Correspondent rows --------------------------------------------------------------

export interface CorrespondentAccountStats {
  accountId: string;
  sent: number;
  received: number;
  lastAt: number;
}

export interface CorrespondentStats {
  email: string;
  name?: string;
  sentCount: number;
  receivedCount: number;
  bulkCount: number;
  lastSentAt?: number;
  lastReceivedAt?: number;
  frecency: number;
  accounts: CorrespondentAccountStats[];
}

const MAX_ACCOUNT_STATS = 10;

/** True for a sender to demote: bulk or automated mail, and the user never wrote to it. */
export function isDemotedCorrespondent(
  row: Pick<CorrespondentStats, 'email' | 'sentCount' | 'receivedCount' | 'bulkCount'>,
) {
  if (row.sentCount > 0) return false;
  if (isNoReplyLike(row.email)) return true;
  return row.bulkCount > 0 && row.bulkCount * 2 >= row.receivedCount;
}

/** The value of the score index: frecency, with demoted senders at the end. */
export function correspondentScore(row: CorrespondentStats): number {
  return row.frecency - (isDemotedCorrespondent(row) ? DEMOTED_SCORE_OFFSET : 0);
}

export function correspondentSearchText(email: string, name?: string): string {
  return truncateText(normalizeSearchText([name, email].filter(Boolean).join(' ')), 500).trim();
}

/** Adds the events of one address to its row. The newest real name wins. */
export function applyCorrespondentEvents(
  row: CorrespondentStats | null,
  email: string,
  events: CorrespondentEvent[],
): CorrespondentStats {
  const next: CorrespondentStats = row
    ? { ...row, accounts: row.accounts.map((entry) => ({ ...entry })) }
    : { email, sentCount: 0, receivedCount: 0, bulkCount: 0, frecency: FRECENCY_FLOOR, accounts: [] };
  let nameAt = -1;
  for (const event of [...events].sort((a, b) => a.at - b.at)) {
    if (event.kind === 'sent') {
      next.sentCount += 1;
      next.lastSentAt = Math.max(next.lastSentAt || 0, event.at);
    } else {
      next.receivedCount += 1;
      if (event.bulk) next.bulkCount += 1;
      next.lastReceivedAt = Math.max(next.lastReceivedAt || 0, event.at);
    }
    const weight =
      event.kind === 'sent'
        ? EVENT_WEIGHT.sent
        : event.bulk
          ? EVENT_WEIGHT.bulkReceived
          : EVENT_WEIGHT.received;
    next.frecency = logAddExp(next.frecency, eventFrecency(event.at, weight));
    if (event.name && event.at >= nameAt) {
      next.name = event.name;
      nameAt = event.at;
    }
    let stats = next.accounts.find((entry) => entry.accountId === event.accountId);
    if (!stats) {
      stats = { accountId: event.accountId, sent: 0, received: 0, lastAt: 0 };
      next.accounts.push(stats);
    }
    if (event.kind === 'sent') stats.sent += 1;
    else stats.received += 1;
    stats.lastAt = Math.max(stats.lastAt, event.at);
  }
  next.accounts = next.accounts.sort((a, b) => b.lastAt - a.lastAt).slice(0, MAX_ACCOUNT_STATS);
  return next;
}

/** Groups the events of a batch by address. */
export function groupEventsByEmail(events: CorrespondentEvent[]): Map<string, CorrespondentEvent[]> {
  const out = new Map<string, CorrespondentEvent[]>();
  for (const event of events) {
    const list = out.get(event.email) ?? [];
    list.push(event);
    out.set(event.email, list);
  }
  return out;
}

// ---- Matching ------------------------------------------------------------------------

export interface Highlight {
  field: 'name' | 'email';
  start: number;
  length: number;
}

interface NameWord {
  text: string;
  normalized: string;
  start: number;
}

function nameWords(name: string | undefined): NameWord[] {
  const words: NameWord[] = [];
  for (const match of String(name || '').matchAll(/[\p{L}\p{N}]+/gu)) {
    const normalized = normalizeSearchText(match[0]);
    if (normalized) words.push({ text: match[0], normalized, start: match.index ?? 0 });
  }
  return words;
}

/** True when a and b differ by at most one insertion, deletion, substitution, or swap. */
export function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  let i = 0;
  while (i < la && i < lb && a[i] === b[i]) i += 1;
  if (la === lb) {
    if (a.slice(i + 1) === b.slice(i + 1)) return true;
    return a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2);
  }
  return la > lb ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}

function typoPrefixMatch(query: string, word: string): boolean {
  if (query.length < 4) return false;
  for (const length of [query.length - 1, query.length, query.length + 1]) {
    if (length <= 0 || length > word.length) continue;
    if (withinOneEdit(query, word.slice(0, length))) return true;
  }
  return false;
}

export interface MatchResult {
  // 3 strong, 2 medium, 1 weak, 0 none.
  strength: number;
  // Extra points for a full-name prefix or an exact local part.
  precision: number;
  highlights: Highlight[];
}

const NO_MATCH: MatchResult = { strength: 0, precision: 0, highlights: [] };

/**
 * How one address and name match the query. Strong: every query word starts a
 * word of the name, the local part starts with the query, or the query is the
 * initials. Medium: the domain starts with the query, or one typo in a query of
 * four or more characters. Weak: a substring.
 */
export function matchRecipient(query: string, candidate: { name?: string; email: string }): MatchResult {
  const raw = query.trim().toLowerCase();
  const normalized = normalizeSearchText(query);
  if (!raw || !normalized) return NO_MATCH;
  const email = candidate.email;
  const [local = '', domain = ''] = email.split('@');
  const words = nameWords(candidate.name);
  const tokens = normalized.split(' ');
  const fullName = words.map((word) => word.normalized).join(' ');

  // Every query word starts a different word of the name.
  const used = new Set<number>();
  const nameHighlights: Highlight[] = [];
  let allTokens = words.length > 0;
  for (const token of tokens) {
    const index = words.findIndex(
      (word, position) => !used.has(position) && word.normalized.startsWith(token),
    );
    if (index < 0) {
      allTokens = false;
      break;
    }
    used.add(index);
    nameHighlights.push({
      field: 'name',
      start: words[index].start,
      length: Math.min(words[index].text.length, token.length),
    });
  }
  if (allTokens) {
    const precision = fullName.startsWith(normalized) ? 5 : 0;
    return { strength: 3, precision, highlights: nameHighlights.slice(0, 4) };
  }
  if (!/\s/.test(raw) && email.startsWith(raw)) {
    return {
      strength: 3,
      precision: local === raw || email === raw ? 5 : 0,
      highlights: [{ field: 'email', start: 0, length: raw.length }],
    };
  }
  const compactQuery = tokens.join('');
  if (/^[\p{L}]{2,4}$/u.test(compactQuery) && words.length >= 2) {
    const initials = words.map((word) => word.normalized[0]).join('');
    const firstLast = `${words[0].normalized[0]}${words[words.length - 1].normalized[0]}`;
    if (initials === compactQuery || firstLast === compactQuery) {
      const picked = initials === compactQuery ? words : [words[0], words[words.length - 1]];
      return {
        strength: 3,
        precision: 0,
        highlights: picked
          .slice(0, 4)
          .map((word) => ({ field: 'name' as const, start: word.start, length: 1 })),
      };
    }
  }
  if (!/\s/.test(raw) && domain.startsWith(raw.replace(/^@/, ''))) {
    const needle = raw.replace(/^@/, '');
    return {
      strength: 2,
      precision: 0,
      highlights: [{ field: 'email', start: local.length + 1, length: needle.length }],
    };
  }
  if (tokens.length === 1) {
    const token = tokens[0];
    const typoWord = words.find((word) => typoPrefixMatch(token, word.normalized));
    if (typoWord) return { strength: 2, precision: 0, highlights: [] };
    if (typoPrefixMatch(token, normalizeSearchText(local).replace(/\s+/g, ''))) {
      return { strength: 2, precision: 0, highlights: [] };
    }
  }
  if (raw.length >= 3 && !/\s/.test(raw)) {
    const at = email.indexOf(raw);
    if (at >= 0)
      return { strength: 1, precision: 0, highlights: [{ field: 'email', start: at, length: raw.length }] };
    const compactName = fullName.replace(/\s+/g, '');
    if (compactName.includes(compactQuery)) return { strength: 1, precision: 0, highlights: [] };
  }
  return NO_MATCH;
}

// ---- Ranking -------------------------------------------------------------------------

export type RecipientSource = 'addressBook' | 'inbox' | 'domain' | 'mail' | 'typed';

export interface RecipientContactInput {
  id: string;
  accountId: string;
  source: ContactSource;
  name?: string;
  emails: string[];
  company?: string;
  jobTitle?: string;
  photoUrl?: string;
}

export interface RecipientSuggestion {
  email: string;
  name?: string;
  alternateEmails: string[];
  savedContact: boolean;
  directory: boolean;
  sources: RecipientSource[];
  company?: string;
  jobTitle?: string;
  photoUrl?: string;
  lastContactedAt?: number;
  sentCount: number;
  receivedCount: number;
  highlights: Highlight[];
  score: number;
}

export interface RankRecipientsInput {
  query: string;
  now: number;
  correspondents: CorrespondentStats[];
  contacts: RecipientContactInput[];
  selfEmails: string[];
  fromAccountId?: string;
  // The domains of the user's work mailboxes (never consumer mail domains).
  workDomains?: string[];
  exclude?: string[];
  limit: number;
}

interface Person {
  emails: string[];
  names: { addressBook?: string; domain?: string; inbox?: string; mail?: string };
  saved: boolean;
  directory: boolean;
  inboxContact: boolean;
  fromAccountContact: boolean;
  company?: string;
  jobTitle?: string;
  photoUrl?: string;
}

// Weights of the final score. Match strength leads, frecency can pass a
// weaker match only by a real amount of recent mail, and boosts break ties.
export const RECIPIENT_WEIGHTS = {
  match: 20,
  frecencyMax: 40,
  frecencyScale: 10,
  sentMax: 10,
  sentScale: 3,
  saved: 8,
  directory: 3,
  sameDomain: 4,
  fromAccount: 6,
  fromAccountContact: 3,
  demoted: 100,
  typedExact: 100_000,
} as const;

function personName(person: Person): string | undefined {
  return person.names.addressBook || person.names.domain || person.names.mail || person.names.inbox;
}

/**
 * Ranks recipients for one query. People come from the correspondent index and
 * from contacts; one person is one item, and a saved contact's addresses
 * collapse into it. An empty query ranks by recent mail alone.
 */
export function rankRecipients(input: RankRecipientsInput): RecipientSuggestion[] {
  const self = new Set(input.selfEmails.map((email) => email.toLowerCase()));
  const excluded = new Set((input.exclude || []).map((email) => email.trim().toLowerCase()));
  const typed = normalizeContactEmail(input.query);
  const empty = !normalizeSearchText(input.query);
  const workDomains = new Set((input.workDomains || []).map((domain) => domain.toLowerCase()));
  const W = RECIPIENT_WEIGHTS;

  const statsByEmail = new Map<string, CorrespondentStats>();
  for (const row of input.correspondents) statsByEmail.set(row.email, row);

  const people: Person[] = [];
  const personByEmail = new Map<string, Person>();
  const join = (emails: string[]): Person => {
    const linked = [...new Set(emails.map((email) => personByEmail.get(email)).filter(Boolean))] as Person[];
    const person: Person = linked[0] ?? {
      emails: [],
      names: {},
      saved: false,
      directory: false,
      inboxContact: false,
      fromAccountContact: false,
    };
    if (!linked.length) people.push(person);
    for (const other of linked.slice(1)) {
      for (const email of other.emails) if (!person.emails.includes(email)) person.emails.push(email);
      person.names = { ...other.names, ...person.names };
      person.saved ||= other.saved;
      person.directory ||= other.directory;
      person.inboxContact ||= other.inboxContact;
      person.fromAccountContact ||= other.fromAccountContact;
      person.company ??= other.company;
      person.jobTitle ??= other.jobTitle;
      person.photoUrl ??= other.photoUrl;
      people.splice(people.indexOf(other), 1);
    }
    for (const email of emails) if (!person.emails.includes(email)) person.emails.push(email);
    for (const email of person.emails) personByEmail.set(email, person);
    return person;
  };

  for (const contact of input.contacts) {
    const emails = contact.emails.map((email) => email.toLowerCase());
    if (!emails.length) continue;
    // Only saved contacts link addresses into one person. Inbox and directory
    // rows are one address each in practice.
    const person = contact.source === 'address_book' ? join(emails) : join([emails[0]]);
    if (contact.source === 'address_book') {
      person.saved = true;
      person.names.addressBook ??= contact.name;
    } else if (contact.source === 'domain') {
      person.directory = true;
      person.names.domain ??= contact.name;
    } else {
      person.inboxContact = true;
      person.names.inbox ??= contact.name;
    }
    if (input.fromAccountId && contact.accountId === input.fromAccountId) person.fromAccountContact = true;
    person.company ??= contact.company;
    person.jobTitle ??= contact.jobTitle;
    person.photoUrl ??= contact.photoUrl;
  }
  for (const row of input.correspondents) {
    const person = personByEmail.get(row.email) ?? join([row.email]);
    person.names.mail ??= row.name;
  }

  const out: RecipientSuggestion[] = [];
  for (const person of people) {
    const name = personName(person);
    const usable = person.emails.filter(
      (email) => !excluded.has(email) && (!self.has(email) || email === typed),
    );
    if (!usable.length) continue;
    // The address to show: the typed one, then the best match, then the most
    // recent mail.
    let best: { email: string; match: MatchResult; frecency: number } | undefined;
    const order = (entry: { email: string; match: MatchResult; frecency: number }) => [
      entry.email === typed ? 1 : 0,
      entry.match.strength,
      entry.frecency,
    ];
    for (const email of usable) {
      const match = empty ? NO_MATCH : matchRecipient(input.query, { name, email });
      const entry = { email, match, frecency: frecencyNow(statsByEmail.get(email)?.frecency, input.now) };
      if (!best) {
        best = entry;
        continue;
      }
      const [a, b] = [order(entry), order(best)];
      const index = a.findIndex((value, position) => value !== b[position]);
      if (index >= 0 && a[index] > b[index]) best = entry;
    }
    if (!best) continue;
    if (!empty && best.match.strength === 0 && best.email !== typed) continue;
    const stats = person.emails
      .map((email) => statsByEmail.get(email))
      .filter(Boolean) as CorrespondentStats[];
    const sentCount = stats.reduce((sum, row) => sum + row.sentCount, 0);
    const receivedCount = stats.reduce((sum, row) => sum + row.receivedCount, 0);
    const frecency = stats.reduce((sum, row) => sum + frecencyNow(row.frecency, input.now), 0);
    const demoted = !person.saved && stats.length > 0 && stats.every((row) => isDemotedCorrespondent(row));
    const automated = !person.saved && !stats.length && isNoReplyLike(best.email);
    if (empty && !frecency) continue;
    const fromAccount = Boolean(
      input.fromAccountId &&
        stats.some((row) => row.accounts.some((entry) => entry.accountId === input.fromAccountId)),
    );
    const domain = best.email.split('@')[1] || '';
    const sameDomain = workDomains.has(domain) && !isConsumerMailbox(best.email);
    const lastContactedAt = Math.max(
      0,
      ...stats.map((row) => Math.max(row.lastSentAt || 0, row.lastReceivedAt || 0)),
    );
    const score =
      (best.email === typed ? W.typedExact : 0) +
      best.match.strength * W.match +
      best.match.precision +
      Math.min(W.frecencyMax, W.frecencyScale * Math.log1p(frecency)) +
      Math.min(W.sentMax, W.sentScale * Math.log1p(sentCount)) +
      (person.saved ? W.saved : 0) +
      (person.directory ? W.directory : 0) +
      (sameDomain ? W.sameDomain : 0) +
      (fromAccount ? W.fromAccount : 0) +
      (person.fromAccountContact ? W.fromAccountContact : 0) -
      (demoted || automated ? W.demoted : 0);
    const sources: RecipientSource[] = [];
    if (person.saved) sources.push('addressBook');
    if (person.inboxContact) sources.push('inbox');
    if (person.directory) sources.push('domain');
    if (stats.length) sources.push('mail');
    out.push({
      email: best.email,
      name,
      alternateEmails: person.saved ? usable.filter((email) => email !== best.email).slice(0, 5) : [],
      savedContact: person.saved,
      directory: person.directory,
      sources,
      company: person.company,
      jobTitle: person.jobTitle,
      photoUrl: person.photoUrl,
      lastContactedAt: lastContactedAt || undefined,
      sentCount,
      receivedCount,
      highlights: best.match.highlights,
      score: Math.round(score * 100) / 100,
    });
  }

  // A complete address that no index knows still comes first, so the user can
  // pick it. The user's own address is allowed only when typed exactly.
  if (typed && !excluded.has(typed) && !out.some((item) => item.email === typed)) {
    out.push({
      email: typed,
      alternateEmails: [],
      savedContact: false,
      directory: false,
      sources: ['typed'],
      sentCount: 0,
      receivedCount: 0,
      highlights: [{ field: 'email', start: 0, length: typed.length }],
      score: W.typedExact,
    });
  }
  return out
    .sort(
      (a, b) =>
        b.score - a.score ||
        (b.lastContactedAt || 0) - (a.lastContactedAt || 0) ||
        a.email.localeCompare(b.email),
    )
    .slice(0, Math.max(1, input.limit));
}
