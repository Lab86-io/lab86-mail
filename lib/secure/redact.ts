// Values that look like secrets in the user's own words (docs/albatross-secure-store.md, V9).
//
// The composers warn before a message goes out (detectSecretShapes). The
// server is the backstop: a user message, a form answer, or a note to a run
// that still holds such a value reaches the model and the saved chat as
// "[removed: looks like a Social Security number]". This module is pure and
// safe in the browser. The checks are strict on purpose, so tracking numbers,
// phone numbers, and order numbers stay as they are.

export type SecretShapeKind = 'ssn' | 'card' | 'api_key';

export const SECRET_SHAPE_NAMES: Record<SecretShapeKind, string> = {
  ssn: 'a Social Security number',
  card: 'a card number',
  api_key: 'an API key',
};

export interface SecretShapeMatch {
  kind: SecretShapeKind;
  start: number;
  end: number;
}

export function redactedMarker(kind: SecretShapeKind) {
  return `[removed: looks like ${SECRET_SHAPE_NAMES[kind]}]`;
}

function luhn(digits: string) {
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = digits.charCodeAt(index) - 48;
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

/** A card network prefix with a length that network uses. */
function cardNetwork(digits: string) {
  const length = digits.length;
  if (/^4/.test(digits)) return [13, 16, 19].includes(length);
  if (/^(5[1-5]|222[1-9]|22[3-9]\d|2[3-6]\d\d|27[01]\d|2720)/.test(digits)) return length === 16;
  if (/^3[47]/.test(digits)) return length === 15;
  if (/^(6011|65|64[4-9])/.test(digits)) return length >= 16 && length <= 19;
  if (/^35(2[89]|[3-8]\d)/.test(digits)) return length >= 16 && length <= 19;
  return false;
}

const SSN_GROUPED = /\b(?!000|666|9\d\d)\d{3}([- ])(?!00)\d{2}\1(?!0000)\d{4}\b/g;
const SSN_NAMED =
  /\b(?:ssn|social security(?: number| no\.?)?|soc\.? ?sec\.?)\b[^0-9\n]{0,20}((?!000|666|9\d\d)\d{3}(?!00)\d{2}(?!0000)\d{4})\b/gi;
const CARD_CANDIDATE = /\b\d(?:[ -]?\d){12,18}\b/g;
const API_KEYS = [
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bsk_(?:live|test)_[A-Za-z0-9]{16,}/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
];

/** Every secret-shaped value in a text, in order, without overlaps. */
export function detectSecretShapes(text: string): SecretShapeMatch[] {
  const found: SecretShapeMatch[] = [];
  const source = String(text || '');
  if (!source) return found;
  for (const match of source.matchAll(SSN_GROUPED))
    found.push({ kind: 'ssn', start: match.index ?? 0, end: (match.index ?? 0) + match[0].length });
  for (const match of source.matchAll(SSN_NAMED)) {
    const start = (match.index ?? 0) + match[0].lastIndexOf(match[1]);
    found.push({ kind: 'ssn', start, end: start + match[1].length });
  }
  for (const match of source.matchAll(CARD_CANDIDATE)) {
    const digits = match[0].replace(/\D/g, '');
    if (digits.length >= 13 && digits.length <= 19 && cardNetwork(digits) && luhn(digits))
      found.push({ kind: 'card', start: match.index ?? 0, end: (match.index ?? 0) + match[0].length });
  }
  for (const pattern of API_KEYS)
    for (const match of source.matchAll(pattern))
      found.push({ kind: 'api_key', start: match.index ?? 0, end: (match.index ?? 0) + match[0].length });
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const kept: SecretShapeMatch[] = [];
  for (const match of found) {
    const last = kept.at(-1);
    if (last && match.start < last.end) continue;
    kept.push(match);
  }
  return kept;
}

/** The text with each secret-shaped value replaced by its marker. */
export function redactSecretShapes(text: string): { text: string; kinds: SecretShapeKind[] } {
  const matches = detectSecretShapes(text);
  if (!matches.length) return { text, kinds: [] };
  let out = '';
  let at = 0;
  for (const match of matches) {
    out += text.slice(at, match.start) + redactedMarker(match.kind);
    at = match.end;
  }
  out += text.slice(at);
  return { text: out, kinds: [...new Set(matches.map((match) => match.kind))] };
}

/** Every string inside a JSON value, redacted. The same object comes back when nothing changed. */
export function redactDeep<T>(value: T, depth = 0): T {
  if (depth > 8) return value;
  if (typeof value === 'string') {
    const next = redactSecretShapes(value);
    return (next.kinds.length ? next.text : value) as T;
  }
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((entry) => {
      const out = redactDeep(entry, depth + 1);
      if (out !== entry) changed = true;
      return out;
    });
    return (changed ? next : value) as T;
  }
  if (value && typeof value === 'object') {
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      const out = redactDeep(entry, depth + 1);
      if (out !== entry) changed = true;
      next[key] = out;
    }
    return (changed ? next : value) as T;
  }
  return value;
}

/**
 * The messages with the user's own words redacted: user text parts, and the
 * answers to every question that waits for the user (the ask_* tools: forms,
 * free-text answers, choices). Assistant text stays: the model never had the
 * value.
 */
export function redactUserMessages<T>(messages: readonly T[]): T[] {
  let changed = false;
  const next = messages.map((message: any) => {
    if (!message || !Array.isArray(message.parts)) return message;
    let partsChanged = false;
    const parts = message.parts.map((part: any) => {
      if (message.role === 'user' && part?.type === 'text' && typeof part.text === 'string') {
        const out = redactSecretShapes(part.text);
        if (!out.kinds.length) return part;
        partsChanged = true;
        return { ...part, text: out.text };
      }
      const name =
        typeof part?.toolName === 'string' ? part.toolName : String(part?.type || '').replace(/^tool-/, '');
      if (name.startsWith('ask_') && part?.output !== undefined) {
        const output = redactDeep(part.output);
        if (output === part.output) return part;
        partsChanged = true;
        return { ...part, output };
      }
      return part;
    });
    if (!partsChanged) return message;
    changed = true;
    return { ...message, parts };
  });
  return changed ? next : (messages as T[]);
}
