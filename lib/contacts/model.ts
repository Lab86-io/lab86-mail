import { emailFromHeader } from '../shared/format';
import { stripLoneSurrogates, truncateText } from '../shared/text';

// Contacts come from the Nylas v3 Contacts API. Each mailbox has up to three
// sources: `address_book` (saved contacts), `inbox` (people the user wrote to;
// "Other contacts" on Google), and `domain` (the work directory). This module
// holds the pure rules: which sources a mailbox can read, how a provider
// contact becomes a small stored row, and how rows rank for a lookup. Convex
// code and the Next.js sync both import it, so it must stay free of Node APIs.

export const CONTACT_SOURCES = ['address_book', 'inbox', 'domain'] as const;
export type ContactSource = (typeof CONTACT_SOURCES)[number];

export type ContactProvider = 'google' | 'microsoft' | 'icloud' | 'imap';

// Lookup order: saved contacts, then people the user wrote to, then the work
// directory.
export const CONTACT_SOURCE_WEIGHT: Record<ContactSource, number> = {
  address_book: 3,
  inbox: 2,
  domain: 1,
};

// Sources whose names a person or an administrator wrote. An `inbox` name is
// a guess from mail headers, so it never replaces a header name.
export const NAMED_CONTACT_SOURCES: ReadonlySet<string> = new Set<ContactSource>(['address_book', 'domain']);

// A mailbox gets one full pass a day. The hourly cron checks each mailbox, so
// 20 hours keeps the pass daily without drift past 24 hours.
export const CONTACT_FULL_SYNC_INTERVAL_MS = 20 * 60 * 60_000;
// Contacts of a mailbox that needs a reconnect stay this long, then go.
export const DEAD_ACCOUNT_CONTACT_RETENTION_MS = 30 * 24 * 60 * 60_000;

export function isContactSource(value: unknown): value is ContactSource {
  return typeof value === 'string' && (CONTACT_SOURCES as readonly string[]).includes(value);
}

export interface ContactEmail {
  email: string;
  type?: string;
}

export interface ContactPhone {
  number: string;
  type?: string;
}

// The stored shape of one contact. No raw provider payload is kept.
export interface ContactInput {
  providerContactId: string;
  source: ContactSource;
  displayName?: string;
  givenName?: string;
  familyName?: string;
  nickname?: string;
  emails: ContactEmail[];
  phones?: ContactPhone[];
  company?: string;
  jobTitle?: string;
  photoUrl?: string;
  groups?: string[];
  searchText: string;
  contentHash: string;
}

const MAX_EMAILS = 20;
const MAX_PHONES = 10;
const MAX_GROUPS = 20;
const MAX_NAME = 200;
const MAX_SEARCH_TEXT = 1_000;
const MAX_PHOTO_URL = 2_048;
const EMAIL_PATTERN = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;

// ---- Scopes ----------------------------------------------------------------

const GOOGLE_SCOPE = 'https://www.googleapis.com/auth/';

// The scope that each source needs. Google's full `contacts` scope also reads
// saved contacts. Microsoft reads the People API for `inbox` and `domain`.
const GOOGLE_SOURCE_SCOPES: Record<ContactSource, string[]> = {
  address_book: [`${GOOGLE_SCOPE}contacts.readonly`, `${GOOGLE_SCOPE}contacts`],
  inbox: [`${GOOGLE_SCOPE}contacts.other.readonly`],
  domain: [`${GOOGLE_SCOPE}directory.readonly`],
};
const MICROSOFT_SOURCE_SCOPES: Record<ContactSource, string[]> = {
  address_book: ['contacts.read', 'contacts.readwrite', 'contacts.read.shared', 'contacts.readwrite.shared'],
  inbox: ['people.read', 'people.read.all'],
  domain: ['people.read', 'people.read.all'],
};

// The scope to ask for, shown when a source needs a reconnect.
export const CONTACT_SCOPE_FOR_SOURCE: Record<'google' | 'microsoft', Record<ContactSource, string>> = {
  google: {
    address_book: `${GOOGLE_SCOPE}contacts.readonly`,
    inbox: `${GOOGLE_SCOPE}contacts.other.readonly`,
    domain: `${GOOGLE_SCOPE}directory.readonly`,
  },
  microsoft: { address_book: 'Contacts.Read', inbox: 'People.Read', domain: 'People.Read' },
};

// Consumer mailboxes have no work directory.
const CONSUMER_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'msn.com',
  'passport.com',
]);

export function isConsumerMailbox(email: string | null | undefined): boolean {
  const domain = String(email || '')
    .trim()
    .toLowerCase()
    .split('@')[1];
  return Boolean(domain && CONSUMER_DOMAINS.has(domain));
}

/**
 * What the stored grant scopes say about one source. `unknown` means the list
 * cannot prove a gap (no scopes stored, or a Microsoft `.default` request), so
 * the sync asks the provider and learns from its answer.
 */
export type ContactScopeState = 'granted' | 'missing' | 'unknown' | 'unsupported';

function microsoftScopeName(scope: string) {
  const trimmed = scope.trim().toLowerCase();
  const slash = trimmed.lastIndexOf('/');
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

export function contactScopeState(
  account: { provider: ContactProvider; scopes?: string[] | null; email?: string | null },
  source: ContactSource,
): ContactScopeState {
  const { provider } = account;
  // iCloud reads the address book over CardDAV with the app password. Other
  // IMAP mailboxes (Yahoo, for example) can do the same; the provider says.
  if (provider === 'icloud') return source === 'address_book' ? 'granted' : 'unsupported';
  if (provider === 'imap') return source === 'address_book' ? 'unknown' : 'unsupported';
  if (source === 'domain' && isConsumerMailbox(account.email)) return 'unsupported';
  const scopes = (account.scopes || []).map((scope) => scope.trim()).filter(Boolean);
  if (!scopes.length) return 'unknown';
  if (provider === 'google') {
    return scopes.some((scope) => GOOGLE_SOURCE_SCOPES[source].includes(scope)) ? 'granted' : 'missing';
  }
  const names = scopes.map(microsoftScopeName);
  if (names.some((name) => MICROSOFT_SOURCE_SCOPES[source].includes(name))) return 'granted';
  // `.default` asks for every permission of the app registration, so the list
  // alone does not prove that the permission is absent.
  if (names.includes('.default')) return 'unknown';
  return 'missing';
}

export interface ContactSourcePlanEntry {
  source: ContactSource;
  scope: ContactScopeState;
}

/** The sources to read for one mailbox, in sync order: saved contacts first. */
export function contactSourcePlan(account: {
  provider: ContactProvider;
  scopes?: string[] | null;
  email?: string | null;
}): ContactSourcePlanEntry[] {
  return CONTACT_SOURCES.map((source) => ({ source, scope: contactScopeState(account, source) }));
}

// ---- Normalization ------------------------------------------------------------

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function clean(value: unknown, max = MAX_NAME): string | undefined {
  const text = str(value);
  if (!text) return undefined;
  const collapsed = stripLoneSurrogates(text).replace(/\s+/g, ' ').trim();
  return collapsed ? truncateText(collapsed, max).trim() : undefined;
}

export function normalizeContactEmail(value: unknown): string | null {
  const text = str(value);
  if (!text) return null;
  const email = text.trim().toLowerCase();
  if (email.length > 320 || !EMAIL_PATTERN.test(email)) return null;
  return email;
}

/** Lowercase words without accents or punctuation, for search text and matching. */
export function normalizeSearchText(value: string | null | undefined): string {
  return stripLoneSurrogates(String(value || ''))
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function buildContactSearchText(input: {
  displayName?: string;
  givenName?: string;
  familyName?: string;
  nickname?: string;
  company?: string;
  emails: ContactEmail[];
}): string {
  const text = normalizeSearchText(
    [
      input.displayName,
      input.givenName,
      input.familyName,
      input.nickname,
      input.company,
      ...input.emails.map((item) => item.email),
    ]
      .filter(Boolean)
      .join(' '),
  );
  return truncateText(text, MAX_SEARCH_TEXT).trim();
}

/** A 64-bit string hash (cyrb53). It detects changed rows; it is not security. */
export function stableHash(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `${(h2 >>> 0).toString(16).padStart(8, '0')}${(h1 >>> 0).toString(16).padStart(8, '0')}`;
}

function photoUrl(value: unknown): string | undefined {
  const text = str(value)?.trim();
  if (!text || text.length > MAX_PHOTO_URL) return undefined;
  return /^https?:\/\//i.test(text) ? text : undefined;
}

/**
 * One provider contact as a small stored row, or null when it has no usable
 * email address (a mail product cannot use a phone-only card). Accepts SDK
 * objects (camelCase) and webhook objects (snake_case).
 */
export function normalizeNylasContact(raw: any, fallbackSource: ContactSource): ContactInput | null {
  if (!raw || typeof raw !== 'object') return null;
  const providerContactId = clean(raw.id, 500);
  if (!providerContactId) return null;
  const source = isContactSource(raw.source) ? raw.source : fallbackSource;

  const seen = new Set<string>();
  const emails: ContactEmail[] = [];
  for (const item of Array.isArray(raw.emails) ? raw.emails : []) {
    const email = normalizeContactEmail(typeof item === 'string' ? item : item?.email);
    if (!email || seen.has(email)) continue;
    seen.add(email);
    const type = clean(item?.type, 40);
    emails.push(type ? { email, type } : { email });
    if (emails.length >= MAX_EMAILS) break;
  }
  if (!emails.length) return null;

  const givenName = clean(raw.givenName ?? raw.given_name);
  const familyName = clean(raw.surname ?? raw.familyName ?? raw.family_name);
  const nickname = clean(raw.nickname);
  const named = clean(raw.displayName ?? raw.display_name);
  // A provider can fill the display name with the address itself.
  const displayName =
    (named && !named.includes('@') ? named : undefined) ||
    clean([givenName, familyName].filter(Boolean).join(' ')) ||
    nickname;

  const phones: ContactPhone[] = [];
  for (const item of Array.isArray(raw.phoneNumbers ?? raw.phone_numbers)
    ? (raw.phoneNumbers ?? raw.phone_numbers)
    : []) {
    const number = clean(item?.number, 60);
    if (!number) continue;
    const type = clean(item?.type, 40);
    phones.push(type ? { number, type } : { number });
    if (phones.length >= MAX_PHONES) break;
  }

  const groups: string[] = [];
  for (const item of Array.isArray(raw.groups) ? raw.groups : []) {
    const name = clean(item?.name ?? item?.id, 120);
    if (name && !groups.includes(name)) groups.push(name);
    if (groups.length >= MAX_GROUPS) break;
  }

  const fields = {
    providerContactId,
    source,
    displayName,
    givenName,
    familyName,
    nickname,
    emails,
    phones: phones.length ? phones : undefined,
    company: clean(raw.companyName ?? raw.company_name),
    jobTitle: clean(raw.jobTitle ?? raw.job_title),
    photoUrl: photoUrl(raw.pictureUrl ?? raw.picture_url),
    groups: groups.length ? groups : undefined,
  };
  const stored = Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  ) as Omit<ContactInput, 'searchText' | 'contentHash'>;
  return {
    ...stored,
    searchText: buildContactSearchText(stored),
    contentHash: stableHash(JSON.stringify(stored)),
  };
}

// ---- Names -----------------------------------------------------------------

function nameHeader(header: string): string {
  return header
    .replace(/<[^>]*>/g, '')
    .replaceAll('"', '')
    .replace(/\s+/g, ' ')
    .trim();
}

function compact(value: string) {
  return normalizeSearchText(value).replace(/\s+/g, '');
}

/**
 * True when a From header gives no real name: a bare address, a name that is
 * an address, or a name that only repeats the local part ("jdoe" for
 * jdoe@example.com).
 */
export function isWeakHeaderName(header: string | null | undefined): boolean {
  const raw = String(header || '').trim();
  const email = emailFromHeader(raw);
  const name = nameHeader(raw);
  if (!name) return true;
  if (name.includes('@')) return true;
  if (!email) return false;
  const local = email.split('@')[0] || '';
  return compact(name) === compact(local);
}

/**
 * The saved contact name to show for a sender, or undefined when the header
 * name should stay. A contact name replaces only a weak header name.
 */
export function preferredSenderName(
  header: string | null | undefined,
  contactName: string | null | undefined,
): string | undefined {
  const name = clean(contactName);
  if (!name || name.includes('@')) return undefined;
  return isWeakHeaderName(header) ? name : undefined;
}

// ---- Ranking ------------------------------------------------------------------

export type SuggestionSource = ContactSource | 'recent';

export interface ContactCandidate {
  contactId?: string;
  accountId?: string;
  source: SuggestionSource;
  name?: string;
  givenName?: string;
  familyName?: string;
  nickname?: string;
  emails: string[];
  company?: string;
  jobTitle?: string;
  photoUrl?: string;
}

export interface MailActivity {
  lastAt?: number;
  count?: number;
}

export interface RankedContact extends ContactCandidate {
  email: string;
  score: number;
  lastAt?: number;
  count?: number;
}

const SOURCE_RANK: Record<SuggestionSource, number> = { ...CONTACT_SOURCE_WEIGHT, recent: 2 };

function words(value: string | undefined): string[] {
  return normalizeSearchText(value).split(' ').filter(Boolean);
}

/**
 * How well one address of a candidate matches the query: 5 exact, 4 prefix of
 * the full name or address, 3 every query word starts a word, 2 substring,
 * 1 company only, 0 no match.
 */
export function matchTier(query: string, candidate: ContactCandidate, email: string): number {
  const raw = query.trim().toLowerCase();
  const normalized = normalizeSearchText(query);
  if (!raw || !normalized) return 0;
  const name = normalizeSearchText(candidate.name);
  // `normalized` is not empty, so an empty name matches neither test.
  if (email === raw || name === normalized) return 5;
  if (email.startsWith(raw) || name.startsWith(normalized)) return 4;
  const tokens = normalized.split(' ');
  const haystack = [
    ...words(candidate.name),
    ...words(candidate.givenName),
    ...words(candidate.familyName),
    ...words(candidate.nickname),
    ...words(email),
  ];
  if (tokens.every((token) => haystack.some((word) => word.startsWith(token)))) return 3;
  if (!/\s/.test(raw) && (email.includes(raw) || compact(candidate.name || '').includes(compact(raw)))) {
    return 2;
  }
  const company = words(candidate.company);
  if (tokens.every((token) => company.some((word) => word.startsWith(token)))) return 1;
  return 0;
}

const DAY_MS = 86_400_000;

/** 0 to 9 points for recent and frequent mail with this address. */
export function activityScore(activity: MailActivity | undefined, now = Date.now()): number {
  if (!activity) return 0;
  let score = 0;
  const age = activity.lastAt ? now - activity.lastAt : Number.POSITIVE_INFINITY;
  if (age <= 7 * DAY_MS) score += 5;
  else if (age <= 30 * DAY_MS) score += 3;
  else if (age <= 180 * DAY_MS) score += 1;
  const count = Number(activity.count) || 0;
  if (count >= 10) score += 4;
  else if (count >= 3) score += 2;
  else if (count >= 1) score += 1;
  return Math.min(9, score);
}

/**
 * Ranks candidates for one query: match quality first, then the source
 * (saved contacts, then people the user wrote to, then the directory), then
 * recent mail activity. One row for each address.
 */
export function rankContactCandidates(
  query: string,
  candidates: ContactCandidate[],
  activity: ReadonlyMap<string, MailActivity> = new Map(),
  options: { limit?: number; now?: number; minTier?: number } = {},
): RankedContact[] {
  const minTier = options.minTier ?? 1;
  const best = new Map<string, RankedContact>();
  for (const candidate of candidates) {
    let chosen: { email: string; tier: number } | undefined;
    for (const email of candidate.emails) {
      const tier = matchTier(query, candidate, email);
      if (!chosen || tier > chosen.tier) chosen = { email, tier };
    }
    if (!chosen || chosen.tier < minTier) continue;
    const mail = activity.get(chosen.email);
    const score = chosen.tier * 100 + SOURCE_RANK[candidate.source] * 10 + activityScore(mail, options.now);
    const existing = best.get(chosen.email);
    const ranked: RankedContact = {
      ...candidate,
      email: chosen.email,
      score,
      lastAt: mail?.lastAt,
      count: mail?.count,
    };
    if (!existing || score > existing.score) {
      // A recent-mail row keeps the saved name when it loses to a contact.
      best.set(chosen.email, existing && !ranked.name ? { ...ranked, name: existing.name } : ranked);
    } else if (!existing.name && candidate.name) {
      best.set(chosen.email, { ...existing, name: candidate.name });
    }
  }
  return [...best.values()]
    .sort((a, b) => b.score - a.score || (b.lastAt || 0) - (a.lastAt || 0) || a.email.localeCompare(b.email))
    .slice(0, options.limit ?? 20);
}

export interface AliasExpansion {
  email: string | null;
  displayName?: string;
  candidates: Array<{ email: string; name?: string; source: SuggestionSource }>;
}

/**
 * Resolves a first name, nickname, or full name to one address. It answers
 * only when one person matches at the best match level; otherwise it returns
 * the candidates and no address.
 */
export function expandAliasFromCandidates(
  alias: string,
  candidates: ContactCandidate[],
  activity: ReadonlyMap<string, MailActivity> = new Map(),
): AliasExpansion {
  const direct = normalizeContactEmail(alias);
  if (direct) {
    const known = candidates.find((candidate) => candidate.emails.includes(direct));
    return { email: direct, displayName: known?.name, candidates: [] };
  }
  const wanted = normalizeSearchText(alias);
  if (!wanted) return { email: null, candidates: [] };
  const levelFor = (candidate: ContactCandidate) => {
    if (normalizeSearchText(candidate.name) === wanted) return 3;
    const first = words(candidate.name)[0];
    if (
      normalizeSearchText(candidate.nickname) === wanted ||
      normalizeSearchText(candidate.givenName) === wanted ||
      first === wanted
    )
      return 2;
    if (
      candidate.emails.some((email) => {
        const local = normalizeSearchText(email.split('@')[0]);
        return local === wanted || local.split(' ')[0] === wanted;
      })
    )
      return 1;
    return 0;
  };
  const scored = candidates
    .map((candidate) => ({ candidate, level: levelFor(candidate) }))
    .filter((entry) => entry.level > 0);
  if (!scored.length) return { email: null, candidates: [] };
  const top = Math.max(...scored.map((entry) => entry.level));
  // One person can show up in several sources and accounts. Rows that share
  // an address are the same person.
  const people: Array<{ emails: Set<string>; best: ContactCandidate }> = [];
  for (const { candidate } of scored.filter((entry) => entry.level === top)) {
    const person = people.find((entry) => candidate.emails.some((email) => entry.emails.has(email)));
    if (person) {
      for (const email of candidate.emails) person.emails.add(email);
      if (SOURCE_RANK[candidate.source] > SOURCE_RANK[person.best.source]) person.best = candidate;
    } else {
      people.push({ emails: new Set(candidate.emails), best: candidate });
    }
  }
  const ranked = rankContactCandidates(
    alias,
    people.map((person) => person.best),
    activity,
    { limit: 5, minTier: 0 },
  );
  if (people.length === 1) {
    const person = people[0].best;
    return { email: person.emails[0], displayName: person.name, candidates: [] };
  }
  return {
    email: null,
    candidates: ranked.map((entry) => ({ email: entry.email, name: entry.name, source: entry.source })),
  };
}
