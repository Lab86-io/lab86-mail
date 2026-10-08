// What the secure store keeps, how it shows an item without its value, and
// where an item may be used (docs/albatross-secure-store.md).
//
// Everything here is pure: no key, no network. The values pass through these
// functions on the server only, and no function here puts a value in an error
// message.

import { getDomain, parse as parseHost } from 'tldts';
import { luhnValid, refuseLabel } from '../personal-details/policy';
import { isPrivateHost } from '../shared/private-host';
import {
  DATE_FORMATS,
  ID_NUMBER_LABELS,
  type IdNumberType,
  NUMBER_FORMATS,
  SECURE_FIELD_LABELS,
  SECURE_FIELDS,
  SECURE_REFERENCE,
  type SecureItemKind,
  secureValuesSchemas,
} from './contract';

/** A user keeps at most this many items. */
export const SECURE_ITEMS_MAX = 100;
/** An item works on at most this many sites. */
export const SECURE_SITES_MAX = 20;

export type SecureRefusalReason = 'card' | 'code' | 'bank';

export class SecurePolicyError extends Error {
  constructor(
    readonly code: 'invalid' | 'refused' | 'site' | 'limit',
    message: string,
    readonly field?: string,
    /** For a refusal: what kind of value it is, so a client picks its own line. */
    readonly reason?: SecureRefusalReason,
  ) {
    super(message);
    this.name = 'SecurePolicyError';
  }
}

const REFUSED_COPY = {
  card: 'Albatross does not keep card numbers yet.',
  code: 'Albatross does not keep sign-in codes or recovery codes. They stay with you.',
  bank: 'Albatross does not keep bank account or routing numbers.',
} as const;

/** The refusal reason for a label: cards, codes, and bank numbers. Passwords, IDs, and keys belong here. */
const CODE_LABEL = /recovery codes?|backup codes?|sign[- ]?in codes?|seed phrase|recovery phrase/i;

export function secureLabelRefusal(label: string | null | undefined): SecureRefusalReason | null {
  if (CODE_LABEL.test(String(label || ''))) return 'code';
  const refusal = refuseLabel(label);
  if (!refusal) return null;
  if (refusal.kind === 'card' || refusal.kind === 'code' || refusal.kind === 'bank') return refusal.kind;
  return null;
}

/** The refusal copy for a label, or null. */
export function refuseSecureLabel(label: string | null | undefined): string | null {
  const reason = secureLabelRefusal(label);
  return reason ? REFUSED_COPY[reason] : null;
}

function refused(reason: SecureRefusalReason, field: string) {
  return new SecurePolicyError('refused', REFUSED_COPY[reason], field, reason);
}

function digitsOf(text: string) {
  return text.replace(/\D/g, '');
}

/** A value made only of 13 to 19 digits (with spaces or dashes) that passes Luhn. */
export function looksLikeCardNumber(text: string): boolean {
  if (!/^[\d -]+$/.test(text.trim())) return false;
  const digits = digitsOf(text);
  return digits.length >= 13 && digits.length <= 19 && luhnValid(digits);
}

export interface ParsedSecureItem {
  kind: SecureItemKind;
  label: string;
  /** The secret values, sealed together. */
  values: Record<string, string>;
  /** Plain facts that are safe to show and to give the model. */
  facts: Record<string, string>;
}

function firstIssue(error: { issues: Array<{ path: PropertyKey[]; message: string }> }) {
  const issue = error.issues[0];
  const field = String(issue?.path?.[0] ?? '');
  const name = SECURE_FIELD_LABELS[field] || (field === 'type' ? 'ID type' : field || 'the value');
  return new SecurePolicyError('invalid', `Check ${name}.`, field || undefined);
}

function realDate(value: string) {
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day &&
    year >= 1900 &&
    year <= 2200
  );
}

/**
 * The checked values of one item. Throws SecurePolicyError with user copy.
 * `label` is optional: each kind has a plain default.
 */
export function parseSecureItem(input: {
  kind: SecureItemKind;
  label?: string | null;
  values: Record<string, unknown>;
  now?: number;
}): ParsedSecureItem {
  const now = input.now ?? Date.now();
  const label = String(input.label ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (label.length > 80) throw new SecurePolicyError('invalid', 'Use a shorter name.', 'label');
  const refusedLabel = secureLabelRefusal(label);
  if (refusedLabel) throw refused(refusedLabel, 'label');

  switch (input.kind) {
    case 'sign_in': {
      const parsed = secureValuesSchemas.sign_in.safeParse(input.values);
      if (!parsed.success) throw firstIssue(parsed.error);
      return {
        kind: 'sign_in',
        label: label || 'Sign-in',
        values: { username: parsed.data.username, password: parsed.data.password },
        facts: {},
      };
    }
    case 'id_number': {
      const parsed = secureValuesSchemas.id_number.safeParse(input.values);
      if (!parsed.success) throw firstIssue(parsed.error);
      const data = parsed.data;
      if (looksLikeCardNumber(data.number)) throw refused('card', 'number');
      let number = data.number.replace(/\s+/g, ' ').trim();
      if (data.type === 'ssn') {
        const digits = digitsOf(number);
        if (digits.length !== 9 || !/^[\d -]+$/.test(number))
          throw new SecurePolicyError('invalid', 'A Social Security number has 9 digits.', 'number');
        if (/^(000|666|9)/.test(digits) || digits.slice(3, 5) === '00' || digits.slice(5) === '0000')
          throw new SecurePolicyError('invalid', 'Check the Social Security number.', 'number');
        number = digits;
      }
      if (data.expires && !realDate(data.expires))
        throw new SecurePolicyError('invalid', 'Check Expiry date.', 'expires');
      const country = (data.country || '').toUpperCase();
      if (country && !/^[A-Z]{2}$/.test(country))
        throw new SecurePolicyError('invalid', 'Use a two-letter country code.', 'country');
      const values: Record<string, string> = { number };
      if (data.expires) values.expires = data.expires;
      if (data.name_on_id?.trim()) values.name_on_id = data.name_on_id.trim();
      const facts: Record<string, string> = { type: data.type };
      if (data.region?.trim()) facts.region = data.region.trim();
      if (country) facts.country = country;
      if (data.expires) facts.expires = data.expires.slice(0, 7);
      return { kind: 'id_number', label: label || ID_NUMBER_LABELS[data.type], values, facts };
    }
    case 'date_of_birth': {
      const parsed = secureValuesSchemas.date_of_birth.safeParse(input.values);
      if (!parsed.success) throw firstIssue(parsed.error);
      const date = parsed.data.date;
      if (!realDate(date) || Date.parse(`${date}T00:00:00Z`) > now)
        throw new SecurePolicyError('invalid', 'Check Date of birth.', 'date');
      return { kind: 'date_of_birth', label: label || 'Date of birth', values: { date }, facts: {} };
    }
    case 'api_key': {
      const parsed = secureValuesSchemas.api_key.safeParse(input.values);
      if (!parsed.success) throw firstIssue(parsed.error);
      const key = parsed.data.key.trim();
      if (/\s/.test(key)) throw new SecurePolicyError('invalid', 'A key has no spaces.', 'key');
      if (looksLikeCardNumber(key)) throw refused('card', 'key');
      const header = (parsed.data.header || '').trim();
      if (header && !/^[A-Za-z0-9-]{1,60}$/.test(header))
        throw new SecurePolicyError('invalid', 'Use a header name such as Authorization.', 'header');
      return { kind: 'api_key', label: label || 'API key', values: { key }, facts: header ? { header } : {} };
    }
  }
}

const BULLETS = '••••••••';

/** Masked hints for each saved field. No hint holds more than four characters of a value. */
export function secureHints(kind: SecureItemKind, values: Record<string, string>): Record<string, string> {
  const hints: Record<string, string> = {};
  for (const field of SECURE_FIELDS[kind]) {
    const value = values[field];
    if (!value) continue;
    if (field === 'password') hints[field] = BULLETS;
    else if (field === 'username') {
      const at = value.indexOf('@');
      hints[field] = at > 0 ? `${value[0]}•••${value.slice(at)}` : `${value[0]}•••`;
    } else if (field === 'number') {
      const plain = value.replace(/[\s-]/g, '');
      hints[field] = plain.length >= 6 ? `ends ${plain.slice(-4)}` : 'saved';
    } else if (field === 'key') {
      const prefix = value.match(/^[a-z]{1,8}[-_]/i)?.[0] ?? '';
      hints[field] = value.length >= 16 ? `${prefix}…${value.slice(-4)}` : 'saved';
    } else hints[field] = 'saved';
  }
  return hints;
}

/** Whole years from a YYYY-MM-DD birth date to now (UTC). */
export function ageYears(date: string, now = Date.now()): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const [year, month, day] = date.split('-').map(Number);
  const today = new Date(now);
  let age = today.getUTCFullYear() - year;
  const beforeBirthday =
    today.getUTCMonth() + 1 < month || (today.getUTCMonth() + 1 === month && today.getUTCDate() < day);
  if (beforeBirthday) age -= 1;
  return age >= 0 ? age : null;
}

// ---------------------------------------------------------------------------
// Sites
// ---------------------------------------------------------------------------

/** The site that a host belongs to: its registrable domain (private suffixes count). */
export function siteForHost(host: string): string | null {
  const clean = host.toLowerCase().replace(/\.$/, '');
  if (!clean || isPrivateHost(clean) || parseHost(clean).isIp) return null;
  return getDomain(clean, { allowPrivateDomains: true });
}

/**
 * One site entry as the user typed it: a URL or a host. Sign-ins and IDs keep
 * the registrable domain ("https://secure.chase.com/login" → "chase.com"); an
 * API key keeps the host, because a key belongs to one API host.
 */
export function normalizeSite(raw: string, kind: SecureItemKind): string {
  let text = String(raw || '')
    .trim()
    .toLowerCase();
  if (!text) throw new SecurePolicyError('site', 'Enter a web address, for example chase.com.');
  if (!/^[a-z][a-z0-9+.-]*:\/\//.test(text)) text = `https://${text}`;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new SecurePolicyError('site', 'Enter a web address, for example chase.com.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    throw new SecurePolicyError('site', 'Enter a web address, for example chase.com.');
  const host = url.hostname.replace(/\.$/, '').replace(/^www\./, '');
  const site = siteForHost(host);
  if (!site) throw new SecurePolicyError('site', 'Use a public web address, for example chase.com.');
  return kind === 'api_key' ? host : site;
}

/** The normalized, unique site list of an item. */
export function normalizeSites(raw: readonly string[] | undefined, kind: SecureItemKind): string[] {
  const sites = [...new Set((raw || []).map((entry) => normalizeSite(entry, kind)))];
  if (sites.length > SECURE_SITES_MAX)
    throw new SecurePolicyError('limit', `An item works on ${SECURE_SITES_MAX} sites at most.`);
  return sites;
}

/** True when a site entry covers the host: the same host, or a host under it. */
export function siteCovers(site: string, host: string) {
  const clean = host.toLowerCase().replace(/\.$/, '');
  return clean === site || clean.endsWith(`.${site}`);
}

/** Sign-ins and keys work only on their own sites. IDs and dates may ask for a new site. */
export function kindMayAskForSite(kind: SecureItemKind) {
  return kind === 'id_number' || kind === 'date_of_birth';
}

// ---------------------------------------------------------------------------
// References
// ---------------------------------------------------------------------------

export interface SecureReference {
  raw: string;
  itemId: string;
  field: string;
  format: string | null;
}

/** Every `{{secure:…}}` reference in a text, in order. */
export function findReferences(text: string): SecureReference[] {
  return [...String(text || '').matchAll(new RegExp(SECURE_REFERENCE.source, 'g'))].map((match) => ({
    raw: match[0],
    itemId: match[1],
    field: match[2],
    format: match[3] ?? null,
  }));
}

/** True when the text holds something shaped like a reference, valid or not. */
export function mentionsReference(text: string) {
  return /\{\{\s*secure\s*:/i.test(String(text || ''));
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/**
 * The value of one field in the asked format. Throws SecurePolicyError with
 * copy for the model; the copy never holds the value.
 */
export function formatSecureValue(input: {
  kind: SecureItemKind;
  field: string;
  value: string;
  format: string | null;
  idType?: IdNumberType | string | null;
}): string {
  const { field, value, format } = input;
  if (!format) return value;
  if (field === 'date' || field === 'expires') {
    if (!(DATE_FORMATS as readonly string[]).includes(format))
      throw new SecurePolicyError('invalid', `Use a date format: ${DATE_FORMATS.join(', ')}.`);
    const [year, month, day] = value.split('-');
    switch (format) {
      case 'YYYY-MM-DD':
        return value;
      case 'MM/DD/YYYY':
        return `${month}/${day}/${year}`;
      case 'DD/MM/YYYY':
        return `${day}/${month}/${year}`;
      case 'MM/YYYY':
        return `${month}/${year}`;
      case 'MM':
        return month;
      case 'DD':
        return day;
      case 'YYYY':
        return year;
      case 'M':
        return String(Number(month));
      case 'D':
        return String(Number(day));
      default:
        return MONTHS[Number(month) - 1] ?? month;
    }
  }
  if (field === 'number') {
    if (!(NUMBER_FORMATS as readonly string[]).includes(format))
      throw new SecurePolicyError('invalid', `Use a number format: ${NUMBER_FORMATS.join(', ')}.`);
    const digits = value.replace(/\D/g, '');
    if (format === 'DIGITS') return digits;
    if (format === 'LAST4') return value.replace(/[\s-]/g, '').slice(-4);
    if (input.idType !== 'ssn' || digits.length !== 9)
      throw new SecurePolicyError('invalid', `${format} works only for a Social Security number.`);
    if (format === 'DASHED') return `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}`;
    if (format === 'AREA') return digits.slice(0, 3);
    if (format === 'GROUP') return digits.slice(3, 5);
    return digits.slice(5);
  }
  throw new SecurePolicyError('invalid', `${SECURE_FIELD_LABELS[field] || field} takes no format.`);
}

/** The plain name of what a reference types, for logs and tool results: "Driver's license number". */
export function referenceLabel(itemLabel: string, kind: SecureItemKind, field: string) {
  if (kind === 'date_of_birth') return itemLabel;
  if (kind === 'sign_in') return `${itemLabel} ${field === 'password' ? 'password' : 'username'}`;
  if (kind === 'api_key') return `${itemLabel} key`;
  const name = field === 'number' ? 'number' : (SECURE_FIELD_LABELS[field] || field).toLowerCase();
  return `${itemLabel} ${name}`;
}

/**
 * The strings to remove from text the model reads, for one opened item. Only
 * values that can be told apart from ordinary page text are listed (6
 * characters or more); a value typed into a field is also removed by its
 * field (lib/albatross/browser-agent.ts). Usernames and names are not
 * secret, so they stay.
 */
export function scrubNeedles(kind: SecureItemKind, values: Record<string, string>, idType?: string | null) {
  const needles = new Set<string>();
  const add = (value: string | undefined) => {
    if (value && value.length >= 6) needles.add(value);
  };
  if (kind === 'sign_in') add(values.password);
  if (kind === 'api_key') add(values.key);
  if (kind === 'id_number' && values.number) {
    const number = values.number;
    add(number);
    const plain = number.replace(/[\s-]/g, '');
    add(plain);
    const digits = number.replace(/\D/g, '');
    if (digits.length >= 6 && digits.length === plain.length) add(digits);
    if (idType === 'ssn' && digits.length === 9) {
      add(`${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}`);
      add(`${digits.slice(0, 3)} ${digits.slice(3, 5)} ${digits.slice(5)}`);
    }
  }
  if (kind === 'date_of_birth' && values.date) {
    for (const format of ['YYYY-MM-DD', 'MM/DD/YYYY', 'DD/MM/YYYY'])
      add(formatSecureValue({ kind, field: 'date', value: values.date, format }));
    const [year, month, day] = values.date.split('-');
    add(`${MONTHS[Number(month) - 1]} ${Number(day)}, ${year}`);
    add(`${Number(month)}/${Number(day)}/${year}`);
  }
  return [...needles];
}
