// One-time code extraction.
//
// This runs on every freshly ingested message, so it is deliberately lexical
// and cheap: no model call sits between a code arriving and the phone being
// able to offer it. The cost of that choice is that precision has to come from
// the rules themselves.
//
// Precision matters more than recall here in an asymmetric way. A missed code
// costs the user the same trip to the mailbox they make today. A wrong code
// registered as an AutoFill identity puts a bogus suggestion above the keyboard
// on someone's bank login, which is worse than offering nothing at all. Every
// heuristic below is biased accordingly: an unlabelled number is never a code,
// and a labelled one still has to survive the rejection pass.

export interface OneTimeCodeMessage {
  subject: string;
  from: string;
  receivedAt: number;
  snippet?: string;
  textBody?: string;
  htmlBody?: string;
}

export interface OneTimeCodeCandidate {
  code: string;
  /** Human label shown in the AutoFill row, e.g. "Google verification code". */
  label: string;
  issuer: string;
  /** Domains the code should be offered for, most specific first. */
  serviceIdentifiers: string[];
  expiresAt: number;
  confidence: number;
}

const MINUTE_MS = 60_000;
const DEFAULT_TTL_MS = 10 * MINUTE_MS;
const MAX_TTL_MS = 30 * MINUTE_MS;
const MIN_TTL_MS = 2 * MINUTE_MS;
const SCAN_LIMIT = 12_000;

// A code is only ever read out of a span that names itself as one. These are
// the phrasings that count as naming it.
const CODE_NOUN = String.raw`(?:one[-\s]?time\s+(?:code|passcode|password|pin)|verification\s+code|confirmation\s+code|security\s+code|authentication\s+code|access\s+code|login\s+code|log[-\s]?in\s+code|sign[-\s]?in\s+code|passcode|otp|2fa\s+code|pin\s+code)`;

// What may sit between the noun and the code: a copula, punctuation, and any
// amount of whitespace including the line breaks that HTML mail leaves behind
// when the code is rendered as its own heading.
const CONNECTOR = String.raw`(?:\s+(?:is|are|will\s+be))?\s*[:=–—-]?\s*`;
const CODE_TOKEN = '([0-9]{4,8}|[A-Z0-9]{5,8})';

// "Your verification code is 123456", "Code: 123456", "Use 123456 to sign in".
const LEADING_LABEL = new RegExp(String.raw`${CODE_NOUN}${CONNECTOR}${CODE_TOKEN}\b`, 'gi');
const TRAILING_LABEL = new RegExp(
  String.raw`\b${CODE_TOKEN}\s*(?:is\s+your|as\s+your)\s+(?:\w+\s+){0,2}?${CODE_NOUN}`,
  'gi',
);
const IMPERATIVE_LABEL =
  /\b(?:enter|use|type|submit)\s+(?:the\s+|this\s+)?(?:code\s+)?([0-9]{4,8}|[A-Z0-9]{5,8})\b(?=[^.]{0,60}?\b(?:to|for)\b[^.]{0,60}?\b(?:sign|log|verif|confirm|authenticat|continue|complete|reset|activat)\w*)/gi;

// A bare "Code: 123456" line with no other framing. Weaker, so it scores lower
// and only survives when the message as a whole reads like a verification mail.
const BARE_LABEL = /(?:^|\n)\s*(?:code|pin|otp)\s*[:=]\s*([0-9]{4,8}|[A-Z0-9]{5,8})\s*(?:$|\n)/gim;

// The message has to look like a verification message overall, not merely
// contain a number next to the word "code". Order confirmations are the main
// thing this keeps out: they say "confirmation" constantly and carry long
// digit runs.
const VERIFICATION_CONTEXT =
  /\b(?:verif\w*|authenticat\w*|two[-\s]?factor|2fa|mfa|one[-\s]?time|passcode|otp|sign[-\s]?in|log[-\s]?in|login|security\s+code|confirm\s+your|reset\s+your\s+password|didn'?t\s+request)\b/i;

// Phrases that mean the number nearby is not a login code even when the
// surrounding words look right.
const DISQUALIFYING_CONTEXT =
  /\b(?:order\s*(?:#|no\.?|number)|invoice|tracking\s*(?:#|no\.?|number)|reference\s*(?:#|no\.?|number)|account\s*(?:#|no\.?|number)|ticket\s*(?:#|no\.?|number)|case\s*(?:#|no\.?|number)|coupon|promo\s*code|discount\s*code|zip\s*code|postal\s*code|area\s*code|routing\s*(?:#|number)|flight|gate\s*code|door\s*code)\b/i;

const EXPIRY_PATTERNS: Array<{ pattern: RegExp; unitMs: number }> = [
  { pattern: /expires?\s+in\s+(\d{1,3})\s*(?:minutes?|mins?|m)\b/i, unitMs: MINUTE_MS },
  { pattern: /valid\s+for\s+(?:the\s+next\s+)?(\d{1,3})\s*(?:minutes?|mins?|m)\b/i, unitMs: MINUTE_MS },
  { pattern: /within\s+(\d{1,3})\s*(?:minutes?|mins?)\b/i, unitMs: MINUTE_MS },
  { pattern: /(\d{1,3})\s*(?:minutes?|mins?)\s+(?:to|before it)\s+expir/i, unitMs: MINUTE_MS },
  { pattern: /expires?\s+in\s+(\d{1,2})\s*(?:hours?|hrs?)\b/i, unitMs: 60 * MINUTE_MS },
];

// Bulk-sending infrastructure. A link to one of these says nothing about which
// service the code belongs to, so they never become AutoFill identities.
const ESP_DOMAINS = new Set([
  'sendgrid.net',
  'sendgrid.com',
  'mailgun.org',
  'mailgun.net',
  'mandrillapp.com',
  'mcsv.net',
  'list-manage.com',
  'mailchimp.com',
  'sparkpostmail.com',
  'amazonses.com',
  'postmarkapp.com',
  'mailjet.com',
  'klaviyomail.com',
  'sendinblue.com',
  'brevo.com',
  'customeriomail.com',
  'braze.com',
  'iterable.com',
  'hubspotemail.net',
  'salesforce.com',
  'exacttarget.com',
  'rsgsv.net',
  'ctctusercontent.com',
  'constantcontact.com',
  'awstrack.me',
  'sparkpost.com',
  'mimecast.com',
  'proofpoint.com',
  'safelinks.protection.outlook.com',
  'googleusercontent.com',
  'gstatic.com',
  'w3.org',
]);

// Subdomains that identify the sending system rather than the service.
const MAIL_SUBDOMAIN_LABELS = new Set([
  'mail',
  'email',
  'em',
  'e',
  'mailer',
  'mailers',
  'smtp',
  'send',
  'sends',
  'notify',
  'notifications',
  'notification',
  'noreply',
  'no-reply',
  'reply',
  'alerts',
  'alert',
  'auth',
  'accounts',
  'account',
  'id',
  'login',
  'secure',
  'security',
  'verify',
  'info',
  'news',
  'updates',
  'transactional',
  'txn',
  'msg',
  'messaging',
  'bounce',
  'bounces',
  'usermail',
  'mg',
]);

// Multi-label public suffixes common enough to matter for domain folding.
const MULTI_LABEL_SUFFIXES = new Set([
  'co.uk',
  'org.uk',
  'ac.uk',
  'gov.uk',
  'me.uk',
  'net.uk',
  'com.au',
  'net.au',
  'org.au',
  'edu.au',
  'gov.au',
  'co.nz',
  'net.nz',
  'org.nz',
  'co.jp',
  'or.jp',
  'ne.jp',
  'co.kr',
  'co.in',
  'net.in',
  'org.in',
  'co.za',
  'com.br',
  'com.mx',
  'com.ar',
  'com.sg',
  'com.hk',
  'com.tw',
  'com.tr',
  'com.cn',
  'co.il',
  'com.pl',
]);

export function stripHtmlForScan(html: string): string {
  return html
    .replace(/<(script|style|head)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#(\d+);/g, (_all, dec: string) => {
      const point = Number(dec);
      return point > 31 && point < 0x11_00_00 ? String.fromCodePoint(point) : ' ';
    })
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n');
}

export function registrableDomain(host: string): string {
  const clean = host
    .trim()
    .toLowerCase()
    .replace(/^\.+|\.+$/g, '');
  if (!clean.includes('.')) return '';
  const labels = clean.split('.');
  if (labels.length <= 2) return clean;
  const lastTwo = labels.slice(-2).join('.');
  if (MULTI_LABEL_SUFFIXES.has(lastTwo) && labels.length >= 3) return labels.slice(-3).join('.');
  return lastTwo;
}

function senderDomain(from: string): string {
  const match = /<([^>]+)>/.exec(from);
  const address = (match ? match[1] : from).trim();
  const at = address.lastIndexOf('@');
  if (at < 0) return '';
  return address
    .slice(at + 1)
    .trim()
    .toLowerCase()
    .replace(/[>,;\s].*$/, '');
}

function senderDisplayName(from: string): string {
  const match = /^\s*"?([^"<]+?)"?\s*</.exec(from);
  const name = (match ? match[1] : '').trim();
  if (name && !name.includes('@')) return name;
  return '';
}

/**
 * Drops sending-system subdomains so `accounts.google.com` and
 * `em.mailer.google.com` both fold onto `google.com`, while a genuine product
 * subdomain that is not in the known list is kept as the more specific option.
 */
function serviceHostsFor(host: string): string[] {
  const clean = host.trim().toLowerCase();
  if (!clean.includes('.')) return [];
  const base = registrableDomain(clean);
  if (!base) return [];
  const hosts: string[] = [];
  const labels = clean.split('.');
  const baseLabels = base.split('.');
  const prefix = labels.slice(0, labels.length - baseLabels.length);
  const meaningful = prefix.filter((label) => !MAIL_SUBDOMAIN_LABELS.has(label));
  if (meaningful.length && meaningful.length === prefix.length) hosts.push(clean);
  hosts.push(base);
  return hosts;
}

function linkedDomains(text: string): string[] {
  const found: string[] = [];
  const pattern = /https?:\/\/([A-Za-z0-9.-]+)/gi;
  let match: RegExpExecArray | null = pattern.exec(text);
  while (match) {
    const host = match[1].toLowerCase();
    const base = registrableDomain(host);
    if (base && !ESP_DOMAINS.has(base) && !ESP_DOMAINS.has(host)) found.push(base);
    match = pattern.exec(text);
  }
  return found;
}

function looksLikeYear(code: string): boolean {
  if (code.length !== 4) return false;
  const value = Number(code);
  return Number.isFinite(value) && value >= 1900 && value <= 2100;
}

// The patterns are matched case-insensitively so the surrounding prose can be
// written any way, which means the alphanumeric branch also matches ordinary
// mixed-case words. Codes are not written that way: an alphanumeric one is
// upper case and carries at least one digit. Requiring both is what stops
// "Verify" or "Minutes" being read as a code.
function isWordShaped(code: string): boolean {
  if (!/[A-Za-z]/.test(code)) return false;
  if (code !== code.toUpperCase()) return true;
  return !/\d/.test(code);
}

function isLowEntropy(code: string): boolean {
  if (/^(\d)\1+$/.test(code)) return true;
  if (!/^\d+$/.test(code)) return false;
  const digits = code.split('').map(Number);
  const ascending = digits.every((digit, index) => index === 0 || digit === digits[index - 1] + 1);
  const descending = digits.every((digit, index) => index === 0 || digit === digits[index - 1] - 1);
  return ascending || descending;
}

// A code lifted out of a URL is a link token, not something to type into a
// field, and a code that is part of a longer digit run is a fragment of an
// account or tracking number.
function isEmbedded(text: string, index: number, code: string): boolean {
  const before = text.slice(Math.max(0, index - 48), index);
  const after = text.slice(index + code.length, index + code.length + 24);
  if (/https?:\/\/\S*$/i.test(before)) return true;
  if (/[/?&=#][\w%.-]*$/.test(before) && /^[\w%.-]*[/?&=#]/.test(after)) return true;
  if (/[\d][\s-]?$/.test(before)) return true;
  if (/^[\s-]?[\d]/.test(after)) return true;
  if (/[$£€]\s?$/.test(before)) return true;
  if (/^\s*(?:%|\.\d)/.test(after)) return true;
  return false;
}

function resolveExpiry(text: string, receivedAt: number): number {
  for (const { pattern, unitMs } of EXPIRY_PATTERNS) {
    const match = pattern.exec(text);
    if (!match) continue;
    const amount = Number(match[1]);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const ttl = Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, amount * unitMs));
    return receivedAt + ttl;
  }
  return receivedAt + DEFAULT_TTL_MS;
}

interface RawCandidate {
  code: string;
  index: number;
  weight: number;
}

function collect(text: string, pattern: RegExp, weight: number): RawCandidate[] {
  const found: RawCandidate[] = [];
  pattern.lastIndex = 0;
  let match: RegExpExecArray | null = pattern.exec(text);
  while (match) {
    const code = match[1];
    if (code) {
      // Anchor on the code itself rather than the whole match, so the
      // embedded-context check reads the characters actually around it.
      const offset = match[0].lastIndexOf(code);
      found.push({ code, index: match.index + (offset < 0 ? 0 : offset), weight });
    }
    match = pattern.exec(text);
  }
  return found;
}

export function extractOneTimeCode(message: OneTimeCodeMessage): OneTimeCodeCandidate | null {
  const body = message.textBody?.trim() || (message.htmlBody ? stripHtmlForScan(message.htmlBody) : '') || '';
  const text = `${message.subject || ''}\n${message.snippet || ''}\n${body}`.slice(0, SCAN_LIMIT);
  if (!text.trim()) return null;
  if (!VERIFICATION_CONTEXT.test(text)) return null;

  const candidates = [
    ...collect(text, LEADING_LABEL, 1),
    ...collect(text, TRAILING_LABEL, 1),
    ...collect(text, IMPERATIVE_LABEL, 0.95),
    ...collect(text, BARE_LABEL, 0.8),
  ];
  if (!candidates.length) return null;

  // The disqualifying pass is scoped to the neighbourhood of each candidate
  // rather than the whole message: a security alert that happens to mention an
  // order number elsewhere should still yield its code.
  const viable = candidates.filter((candidate) => {
    const code = candidate.code;
    if (looksLikeYear(code)) return false;
    if (isLowEntropy(code)) return false;
    if (isWordShaped(code)) return false;
    if (isEmbedded(text, candidate.index, code)) return false;
    const window = text.slice(Math.max(0, candidate.index - 120), candidate.index + code.length + 40);
    if (DISQUALIFYING_CONTEXT.test(window)) return false;
    return true;
  });
  if (!viable.length) return null;

  // Prefer the strongest phrasing, then the earliest occurrence — verification
  // mail states the code once, near the top, and repeats it in footers rarely.
  const byCode = new Map<string, RawCandidate>();
  for (const candidate of viable) {
    const existing = byCode.get(candidate.code);
    if (!existing || candidate.weight > existing.weight) byCode.set(candidate.code, candidate);
  }
  const ranked = [...byCode.values()].sort(
    (left, right) => right.weight - left.weight || left.index - right.index,
  );

  // Two differently-labelled codes in one message means the parse is ambiguous,
  // and guessing between them is exactly the failure that puts a wrong code on
  // someone's login screen. Offer nothing instead.
  if (ranked.length > 1 && ranked[0].weight === ranked[1].weight) return null;

  const best = ranked[0];
  const host = senderDomain(message.from);
  const identifiers: string[] = [];
  for (const candidate of serviceHostsFor(host)) {
    if (!ESP_DOMAINS.has(candidate) && !identifiers.includes(candidate)) identifiers.push(candidate);
  }
  // Services that send through an ESP put their own domain only in the links.
  for (const domain of linkedDomains(text)) {
    if (identifiers.length >= 4) break;
    if (!identifiers.includes(domain)) identifiers.push(domain);
  }
  if (!identifiers.length) return null;

  const issuer = senderDisplayName(message.from) || identifiers[identifiers.length - 1];
  const confidence = Math.min(0.99, best.weight * (identifiers.length > 0 ? 1 : 0.5));

  return {
    code: best.code,
    label: `${issuer} verification code`.slice(0, 120),
    issuer: issuer.slice(0, 80),
    serviceIdentifiers: identifiers,
    expiresAt: resolveExpiry(text, message.receivedAt || Date.now()),
    confidence,
  };
}
