import { describe, expect, test } from 'bun:test';
import { extractNylasWebhookMetadata } from '../lib/mail/corpus';
import {
  isStoredWebhookPayload,
  WEBHOOK_STORED_IDS,
  webhookPayloadForStorage,
} from '../lib/mail/webhook-storage';

const messagePayload = {
  id: 'evt-1',
  type: 'message.updated',
  time: 1_700_000_000,
  webhook_delivery_attempt: { id: 'attempt-1', count: 2 },
  data: {
    application_id: 'app',
    object: {
      id: 'msg-1',
      grant_id: 'grant-1',
      thread_id: 'thread-1',
      body: '<p>'.repeat(10_000),
      subject: 'Secret subject',
      from: [{ email: 'a@example.com' }],
    },
  },
};

describe('webhook payload storage (M5)', () => {
  test('keeps ids only, and the metadata still routes the event', () => {
    const stored = webhookPayloadForStorage(messagePayload);
    expect(stored.stored).toBe(WEBHOOK_STORED_IDS);
    const text = JSON.stringify(stored);
    expect(text).not.toContain('Secret subject');
    expect(text).not.toContain('<p>');
    expect(text.length).toBeLessThan(400);
    const before = extractNylasWebhookMetadata(messagePayload);
    const after = extractNylasWebhookMetadata(stored);
    expect(after).toEqual(before);
    expect(isStoredWebhookPayload(stored)).toBe(true);
    expect(webhookPayloadForStorage(stored)).toBe(stored);
  });

  test('keeps calendar ids and a recurring mark without the rules', () => {
    const stored = webhookPayloadForStorage({
      type: 'event.updated',
      data: {
        object: {
          id: 'evt',
          grant_id: 'g',
          calendar_id: 'cal',
          recurrence: ['RRULE:FREQ=DAILY'],
          description: 'long text',
        },
      },
    });
    expect(stored.data).toEqual({
      object: { id: 'evt', grant_id: 'g', calendar_id: 'cal', recurrence: [] },
    });
  });

  test('handles odd shapes: a root object, a bare data object, and junk', () => {
    expect(webhookPayloadForStorage({ type: 'x', object: { id: 'o1', grant_id: 'g' } }).data).toEqual({
      object: { id: 'o1', grant_id: 'g' },
    });
    expect(webhookPayloadForStorage({ type: 'grant.expired', data: { grant_id: 'g' } })).toMatchObject({
      data: { grant_id: 'g', object: { grant_id: 'g' } },
    });
    // Junk keeps only the synthesized event id, so a retry reads the same id.
    const junk = webhookPayloadForStorage(null);
    expect(junk).toEqual({
      stored: 'ids',
      id: extractNylasWebhookMetadata(null).eventId,
      data: { object: {} },
    });
    expect(Object.keys(webhookPayloadForStorage('text')).sort()).toEqual(['data', 'id', 'stored']);
    expect(isStoredWebhookPayload({ stored: 'other' })).toBe(false);
  });

  test('a stored copy gives the same metadata for every id and type shape', () => {
    const shapes: unknown[] = [
      // The event id under event_id, and the type on data only.
      { event_id: 'evt-9', data: { type: 'message.created', object: { id: 'm9', grant_id: 'g' } } },
      { eventId: 'evt-8', trigger: 'thread.replied', data: { object: { thread_id: 't8', grant_id: 'g' } } },
      // The message and thread ids on data, not on the object.
      {
        type: 'message.updated',
        data: { message_id: 'm7', thread_id: 't7', grant_id: 'g', object: { body: 'x'.repeat(5_000) } },
      },
      { type: 'message.updated', data: { messageId: 'm6', threadId: 't6', grantId: 'g', object: {} } },
      // No explicit id: the id is made from a hash of the full payload.
      { type: 'message.created', data: { object: { id: 'm5', grant_id: 'g', body: 'long body' } } },
      { data: { object: { grant_id: 'g' } } },
    ];
    for (const payload of shapes) {
      const stored = webhookPayloadForStorage(payload);
      expect(extractNylasWebhookMetadata(stored)).toEqual(extractNylasWebhookMetadata(payload));
      expect(JSON.stringify(stored)).not.toContain('body');
    }
  });
});
