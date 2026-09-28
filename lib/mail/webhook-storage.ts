// Webhook rows keep ids, not mail (M5). A Nylas message payload holds the
// whole message, and one row cost about 37 KB. The live path uses the full
// payload in memory. The durable retry refetches the current object from the
// provider, so the stored row needs only the ids that name that object.

import { capWebhookId, extractNylasWebhookMetadata } from './corpus';

/** The marker of a payload that holds ids only. */
export const WEBHOOK_STORED_IDS = 'ids';

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function pickStrings(source: JsonRecord, keys: readonly string[]) {
  const out: JsonRecord = {};
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value) out[key] = capWebhookId(value) as string;
  }
  return out;
}

const ROOT_KEYS = ['id', 'type', 'event', 'trigger', 'time', 'created_at'] as const;
const OBJECT_KEYS = [
  'id',
  'object',
  'grant_id',
  'grantId',
  'message_id',
  'messageId',
  'thread_id',
  'threadId',
  'calendar_id',
  'calendarId',
  'master_event_id',
  'masterEventId',
] as const;

/** True when the payload was already cut to ids. */
export function isStoredWebhookPayload(payload: unknown): boolean {
  return isRecord(payload) && payload.stored === WEBHOOK_STORED_IDS;
}

// Data-level keys that the metadata extractor reads.
const DATA_KEYS = [
  'id',
  'type',
  'grant_id',
  'grantId',
  'message_id',
  'messageId',
  'thread_id',
  'threadId',
] as const;

/**
 * The ids-only copy of a Nylas webhook payload for the durable row. It keeps
 * the event id, type, grant, and object ids, and a recurring-series mark, so
 * `extractNylasWebhookMetadata` and each retry path still route the event.
 * The root holds the normalized event id and type from the full payload, so
 * a later read of the copy gives the same metadata, also when the id was
 * made from a hash of the full payload.
 */
export function webhookPayloadForStorage(payload: unknown): JsonRecord {
  if (isStoredWebhookPayload(payload)) return payload as JsonRecord;
  const root = isRecord(payload) ? payload : {};
  const data = isRecord(root.data) ? root.data : {};
  const object = isRecord(data.object) ? data.object : isRecord(root.object) ? root.object : data;
  const storedObject: JsonRecord = pickStrings(object, OBJECT_KEYS);
  // A recurring event goes to a full calendar resync on retry. An empty array
  // keeps that mark without the rules.
  if (Array.isArray(object.recurrence)) storedObject.recurrence = [];
  const storedData: JsonRecord = {
    ...pickStrings(data, DATA_KEYS),
    object: storedObject,
  };
  const metadata = extractNylasWebhookMetadata(payload);
  const attempt = isRecord(root.webhook_delivery_attempt)
    ? pickStrings(root.webhook_delivery_attempt, ['id'])
    : undefined;
  return {
    stored: WEBHOOK_STORED_IDS,
    ...pickStrings(root, ROOT_KEYS),
    ...pickStrings(root, ['grant_id', 'grantId']),
    ...(attempt && Object.keys(attempt).length ? { webhook_delivery_attempt: attempt } : {}),
    // The extractor reads the root id and type first.
    id: metadata.eventId,
    ...(metadata.type === 'unknown' ? {} : { type: metadata.type }),
    data: storedData,
  };
}
