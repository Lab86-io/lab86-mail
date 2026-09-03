import { emailFromHeader } from '@/lib/shared/format';
import { MailThreadDetailSchema, MailThreadSummarySchema } from './contract';
import { MobileInputError } from './http';

// Mapping boundary between the untyped corpus/tool rows and the strict v1
// read schemas. Every field is defensively coerced and capped here so a
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

function smartPrimary(value: unknown): string | undefined {
  const primary = (value as { primary?: unknown } | null | undefined)?.primary;
  return typeof primary === 'string' && primary ? cap(primary, 240) : undefined;
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
  });
}

function mailAttachment(value: any) {
  const id = cap(value?.id || value?.attachmentId, 240);
  if (!id) return null;
  const size = Math.floor(Number(value?.size));
  return {
    id,
    name: cap(value?.filename || value?.name, 500) || 'attachment',
    contentType: cap(value?.contentType || value?.content_type, 200) || 'application/octet-stream',
    size: Number.isFinite(size) && size >= 0 ? size : undefined,
  };
}

function mailMessage(message: any, accountID: string, threadID: string) {
  return {
    id: cap(message?._id || message?.id, 240),
    threadID,
    accountID,
    subject: cap(message?.subject, 2_000, '(no subject)') || '(no subject)',
    fromHeader: cap(message?.from, 1_000),
    fromEmail: emailFromHeader(message?.from || null) ?? undefined,
    to: cap(message?.to, 20_000),
    cc: cap(message?.cc, 20_000),
    bcc: cap(message?.bcc, 20_000),
    sentAt: epochMs(message?.date),
    snippet: cap(message?.snippet, 500),
    bodyText: cap(message?.textBody, 500_000),
    bodyHTML: message?.htmlBody == null ? undefined : cap(message.htmlBody, 1_000_000),
    labels: labelList(message?.labels),
    unread: Boolean(message?.unread),
    starred: Boolean(message?.starred),
    attachments: (Array.isArray(message?.attachments) ? message.attachments : [])
      .map(mailAttachment)
      .filter(Boolean)
      .slice(0, 100),
  };
}

export function mailThreadDetailFromTool(thread: any, accountID: string, threadID: string) {
  const messages = (Array.isArray(thread?.messages) ? thread.messages : [])
    .map((message: any) => mailMessage(message, accountID, threadID))
    .filter((message: any) => message.id)
    // The contract promises ordered messages; enforce it at the boundary so
    // the response never depends on the tool's own ordering.
    .sort((left: any, right: any) => left.sentAt - right.sentAt);
  return MailThreadDetailSchema.parse({
    threadID,
    accountID,
    subject: cap(thread?.subject, 2_000, '(no subject)') || '(no subject)',
    messages,
    summary: typeof thread?.summary === 'string' ? cap(thread.summary, 20_000) : undefined,
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
