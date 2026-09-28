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
    expect(webhookPayloadForStorage(null)).toEqual({ stored: 'ids', data: { object: {} } });
    expect(webhookPayloadForStorage('text')).toEqual({ stored: 'ids', data: { object: {} } });
    expect(isStoredWebhookPayload({ stored: 'other' })).toBe(false);
  });
});
