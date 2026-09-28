import { emailFromHeader } from '../shared/format';
import { normalizeContactEmail } from './model';

// Pure helpers for the To, Cc, and Bcc fields. The web field keeps chips and
// hands the composer one header string ("Name <a@b.io>, c@d.io"), which the
// send path already reads (lib/nylas/normalize.ts emailList).

export interface RecipientChip {
  email: string;
  name?: string;
  valid: boolean;
  // The text the user typed, for an address that is not valid.
  raw?: string;
}

/**
 * Splits a header list on commas, semicolons, and new lines outside quotes
 * and angle brackets: `"Doe, Ann" <ann@x.io>; bob@y.io` is two parts.
 */
export function splitAddressList(value: string | null | undefined): string[] {
  const parts: string[] = [];
  let current = '';
  let quoted = false;
  let angled = false;
  for (const char of String(value || '')) {
    if (char === '"') quoted = !quoted;
    else if (char === '<' && !quoted) angled = true;
    else if (char === '>' && !quoted) angled = false;
    if ((char === ',' || char === ';' || char === '\n') && !quoted && !angled) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

/** True when the text is one complete address (with or without a name). */
export function isCompleteAddress(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  const email = normalizeContactEmail(emailFromHeader(trimmed));
  if (!email) return false;
  return trimmed.toLowerCase() === email || /<[^<>]+>\s*$/.test(trimmed);
}

function cleanName(name: string): string | undefined {
  // The send path splits on commas, so a name keeps none.
  const clean = name
    .replace(/[<>",;]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return clean || undefined;
}

/** Chips for pasted or stored text. Parts that are not addresses become invalid chips. */
export function parseRecipientText(value: string | null | undefined): RecipientChip[] {
  const chips: RecipientChip[] = [];
  const seen = new Set<string>();
  for (const part of splitAddressList(value)) {
    const email = normalizeContactEmail(emailFromHeader(part));
    if (!email) {
      if (seen.has(`typed:${part}`)) continue;
      seen.add(`typed:${part}`);
      chips.push({ email: '', valid: false, raw: part });
      continue;
    }
    if (seen.has(email)) continue;
    seen.add(email);
    const name = cleanName(part.replace(/<[^>]*>/g, ''));
    chips.push(name && name.toLowerCase() !== email ? { email, name, valid: true } : { email, valid: true });
  }
  return chips;
}

export function formatRecipient(chip: RecipientChip): string {
  if (!chip.valid) return (chip.raw || '').replace(/[,;]/g, ' ').trim();
  const name = chip.name ? cleanName(chip.name) : undefined;
  return name ? `${name} <${chip.email}>` : chip.email;
}

/** The header string for the composer: chips, then any text still being typed. */
export function formatRecipients(chips: RecipientChip[], draft = ''): string {
  return [...chips.map(formatRecipient), draft.trim()].filter(Boolean).join(', ');
}

const chipKey = (chip: RecipientChip) => (chip.valid ? chip.email : `typed:${chip.raw}`);

/** Adds chips, skipping addresses (and typed text) the field already has. */
export function addChips(existing: RecipientChip[], added: RecipientChip[]): RecipientChip[] {
  const seen = new Set(existing.map(chipKey));
  const out = [...existing];
  for (const chip of added) {
    if (seen.has(chipKey(chip))) continue;
    seen.add(chipKey(chip));
    out.push(chip);
  }
  return out;
}

export interface TextPart {
  text: string;
  match: boolean;
}

/** Splits text into plain and matched parts for bold highlights. Bad ranges are skipped. */
export function highlightParts(text: string, ranges: Array<{ start: number; length: number }>): TextPart[] {
  const sorted = ranges
    .filter((range) => range.start >= 0 && range.length > 0 && range.start + range.length <= text.length)
    .sort((a, b) => a.start - b.start);
  const parts: TextPart[] = [];
  let cursor = 0;
  for (const range of sorted) {
    if (range.start < cursor) continue;
    if (range.start > cursor) parts.push({ text: text.slice(cursor, range.start), match: false });
    parts.push({ text: text.slice(range.start, range.start + range.length), match: true });
    cursor = range.start + range.length;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), match: false });
  return parts.length ? parts : [{ text, match: false }];
}
