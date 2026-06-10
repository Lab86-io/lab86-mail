export const CORPUS_SEARCH_TEXT_MAX_CHARS = 32_000;

export interface CorpusSearchTextInput {
  subject?: string | null;
  from?: string | null;
  to?: string | null;
  cc?: string | null;
  bcc?: string | null;
  snippet?: string | null;
  textBody?: string | null;
  labels?: string[] | null;
}

export interface NylasWebhookMetadata {
  eventId: string;
  type: string;
  grantId?: string;
  providerMessageId?: string;
  providerThreadId?: string;
  truncated: boolean;
}

export function normalizeCorpusText(value: unknown, maxChars = CORPUS_SEARCH_TEXT_MAX_CHARS) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxChars);
}

export function buildCorpusSearchText(input: CorpusSearchTextInput) {
  const parts = [
    input.subject,
    input.from,
    input.to,
    input.cc,
    input.bcc,
    input.snippet,
    ...(input.labels || []),
    input.textBody,
  ];
  return normalizeCorpusText(parts.filter(Boolean).join('\n'));
}

export function yearMonthFromTimestamp(ts: unknown, fallback = Date.now()) {
  const value = Number(ts);
  const date = new Date(Number.isFinite(value) && value > 0 ? value : fallback);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function extractNylasWebhookMetadata(payload: unknown): NylasWebhookMetadata {
  const root = isRecord(payload) ? payload : {};
  const data = isRecord(root.data) ? root.data : {};
  const object = isRecord(data.object) ? data.object : isRecord(root.object) ? root.object : data;
  const type = firstString(root.type, root.event, root.trigger, data.type) || 'unknown';
  const grantId = firstString(
    object.grant_id,
    object.grantId,
    data.grant_id,
    data.grantId,
    root.grant_id,
    root.grantId,
  );
  const providerMessageId = firstString(
    object.message_id,
    object.messageId,
    object.id,
    data.message_id,
    data.messageId,
  );
  const providerThreadId = firstString(object.thread_id, object.threadId, data.thread_id, data.threadId);
  const sourceId = providerMessageId || providerThreadId || 'unknown-object';
  const eventId =
    firstString(
      root.id,
      root.event_id,
      root.eventId,
      isRecord(root.webhook_delivery_attempt) ? root.webhook_delivery_attempt.id : undefined,
      data.id,
    ) || `${type}:${grantId || 'unknown-grant'}:${sourceId}:${firstString(root.time, root.created_at) || ''}`;
  return {
    eventId,
    type,
    grantId,
    providerMessageId,
    providerThreadId,
    truncated: /\.truncated$/.test(type),
  };
}

function firstString(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
