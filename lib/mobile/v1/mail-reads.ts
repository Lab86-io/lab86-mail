import { emailFromHeader } from '@/lib/shared/format';
import { MailThreadSummarySchema } from './contract';
import { MobileInputError } from './http';

// Mapping boundary between the untyped corpus rows and the strict v1 read
// schema. Every field is defensively coerced and capped here so a
// malformed corpus row becomes a 500 with context, never a leaked `any`.

function cap(value: unknown, max: number, fallback = ''): string {
  const text = typeof value === 'string' ? value : value == null ? fallback : String(value);
  return text.length > max ? text.slice(0, max) : text;
}

function epochMs(value: unknown): number {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function labelList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((label) => cap(label, 240))
    .filter((label) => label.length > 0)
    .slice(0, 200);
}

// Native clients filter the unified inbox by this string. Mail that a
// label-move rule filed reports `custom:<labelId>`, so Main leaves it out.
function smartPrimary(value: unknown): string | undefined {
  const smart = value as { primary?: unknown; filedUnder?: unknown } | null | undefined;
  if (typeof smart?.filedUnder === 'string' && smart.filedUnder)
    return cap(`custom:${smart.filedUnder}`, 240);
  const primary = smart?.primary;
  return typeof primary === 'string' && primary ? cap(primary, 240) : undefined;
}

function smartList(value: unknown, max: number, count: number): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value
    .filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
    .map((entry) => cap(entry, max))
    .slice(0, count);
  return items.length ? items : undefined;
}

export function mailThreadSummaryFromCorpus(item: any) {
  return MailThreadSummarySchema.parse({
    id: cap(item?._id, 240),
    accountID: cap(item?.account, 240),
    subject: cap(item?.subject, 2_000, '(no subject)') || '(no subject)',
    fromHeader: cap(item?.fromAddress, 1_000),
    senderEmail: emailFromHeader(item?.fromAddress || null) ?? undefined,
    snippet: cap(item?.snippet, 500),
    lastMessageAt: epochMs(item?.lastDate),
    unread: Boolean(item?.unread),
    starred: Boolean(item?.starred),
    labels: labelList(item?.labels),
    messageCount: Math.max(0, Math.floor(Number(item?.messageCount) || 0)),
    smartCategory: smartPrimary(item?.smartCategory),
    smartSecondary: smartList(item?.smartCategory?.secondary, 80, 16),
    smartLabels: smartList(item?.smartCategory?.customLabels, 240, 50),
  });
}

export function mailListCursor(raw: string | null): number | undefined {
  if (!raw) return undefined;
  if (!/^\d+$/.test(raw)) {
    throw new MobileInputError('cursor must be a non-negative integer timestamp.');
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new MobileInputError('cursor is outside the supported range.');
  }
  return value;
}

export function mailListLimit(raw: string | null): number {
  const requested = Number(raw || 50);
  return Number.isFinite(requested) ? Math.min(Math.max(Math.floor(requested), 1), 100) : 50;
}
