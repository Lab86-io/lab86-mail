// What Personal details refuses to keep (docs/albatross-thread.md).
//
// Personal details hold facts that the model may read: a name, a phone, an
// address. Secrets and ID numbers never go here. Passwords, one-time codes,
// card and bank numbers, Social Security and other ID numbers, and API keys
// are refused on save, by the label and by the value. PR 2 adds the secure
// store, where the model uses such values without seeing them.

export type RefusedKind = 'password' | 'code' | 'card' | 'bank' | 'id_number' | 'api_key';

export interface Refusal {
  kind: RefusedKind;
  /** User-facing copy (Simplified Technical English). */
  message: string;
}

const MESSAGES: Record<RefusedKind, string> = {
  password: 'Albatross does not keep passwords in Personal details.',
  code: 'Albatross does not keep sign-in codes.',
  card: 'Albatross does not keep card numbers.',
  bank: 'Albatross does not keep bank account or routing numbers.',
  id_number: 'Albatross does not keep ID numbers in Personal details.',
  api_key: 'Albatross does not keep keys or tokens in Personal details.',
};

const LABEL_RULES: Array<[RegExp, RefusedKind]> = [
  [/pass ?(word|phrase|code)|\bpwd\b/i, 'password'],
  [
    /one[- ]?time|verification code|security code|auth(entication)? code|\b2fa\b|\bmfa\b|\botp\b|\bpin\b/i,
    'code',
  ],
  [/\b(cvv|cvc|csc)\b|card (number|no\b)|credit card|debit card|expir(y|ation) date/i, 'card'],
  [/routing|account (number|no\b)|\biban\b|\bswift\b|\bbic\b|sort code/i, 'bank'],
  [
    /social security|\bssn\b|\bitin\b|\bein\b|tax id|national (id|insurance)|passport|driver'?s? licen[cs]e|licen[cs]e (number|no\b)|\bid (number|no\b)|\bnin\b|\bsin\b/i,
    'id_number',
  ],
  [/api[ _-]?key|secret|token|private key|access key/i, 'api_key'],
];

/** True when the digits pass the Luhn check (card numbers). */
export function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = digits.charCodeAt(index) - 48;
    if (digit < 0 || digit > 9) return false;
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return digits.length > 0 && sum % 10 === 0;
}

const SSN_SHAPE = /\b(?!000|666|9\d\d)\d{3}[- ](?!00)\d{2}[- ](?!0000)\d{4}\b/;
const API_KEY_SHAPES = [
  /\bsk-[A-Za-z0-9_-]{16,}/, // OpenAI-style
  /\bsk_(live|test)_[A-Za-z0-9]{16,}/, // Stripe
  /\b(AKIA|ASIA)[A-Z0-9]{16}\b/, // AWS access key id
  /\bgh[pousr]_[A-Za-z0-9]{30,}/, // GitHub
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/, // Slack
  /\bAIza[0-9A-Za-z_-]{30,}/, // Google API key
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

/** Digit runs of 13 to 19 digits, with spaces or dashes inside, that pass Luhn. */
function hasCardNumber(text: string): boolean {
  for (const match of text.matchAll(/(?:\d[ -]?){12,18}\d/g)) {
    const digits = match[0].replace(/\D/g, '');
    if (digits.length >= 13 && digits.length <= 19 && luhnValid(digits)) return true;
  }
  return false;
}

/** Why a label refuses a value, or null. */
export function refuseLabel(label: string | null | undefined): Refusal | null {
  const text = String(label || '');
  for (const [pattern, kind] of LABEL_RULES) if (pattern.test(text)) return { kind, message: MESSAGES[kind] };
  return null;
}

/** Why a value must not be kept, from its shape alone, or null. */
export function refuseValue(value: string | null | undefined): Refusal | null {
  const text = String(value || '');
  if (!text) return null;
  if (hasCardNumber(text)) return { kind: 'card', message: MESSAGES.card };
  if (SSN_SHAPE.test(text)) return { kind: 'id_number', message: MESSAGES.id_number };
  if (API_KEY_SHAPES.some((pattern) => pattern.test(text)))
    return { kind: 'api_key', message: MESSAGES.api_key };
  return null;
}

/**
 * The refusal for one detail: the label (custom details) first, then every
 * string inside the value. Phone numbers and postal codes are short enough
 * that the card check does not match them.
 */
export function refuseDetail(input: { label?: string | null; value: unknown }): Refusal | null {
  const byLabel = refuseLabel(input.label);
  if (byLabel) return byLabel;
  for (const text of stringsIn(input.value)) {
    const byValue = refuseValue(text);
    if (byValue) return byValue;
  }
  return null;
}

function stringsIn(value: unknown, depth = 0): string[] {
  if (depth > 4 || value === null || value === undefined) return [];
  if (typeof value === 'string') return [value];
  if (typeof value === 'number') return [String(value)];
  if (Array.isArray(value)) return value.flatMap((entry) => stringsIn(entry, depth + 1));
  if (typeof value === 'object') return Object.values(value).flatMap((entry) => stringsIn(entry, depth + 1));
  return [];
}

export function refusalMessage(kind: RefusedKind): string {
  return MESSAGES[kind];
}
