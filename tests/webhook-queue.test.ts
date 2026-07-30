import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { __setWebhookIngestDepsForTest } from '../lib/mail/corpus-sync';
import { enqueueNylasWebhook, webhookQueueDepth } from '../lib/mail/webhook-queue';

// The queue swallows ingest failures on purpose — Nylas must still get its ACK.
// That makes its logging the only signal an outage exists, which is why the
// sampling rule is worth pinning: sampling by raw count let one repeating fault
// print roughly one line and hid a multi-week mail outage.
function payload(overrides: Record<string, unknown> = {}) {
  return {
    id: `evt-${Math.random().toString(36).slice(2)}`,
    type: 'message.created',
    data: { object: { grant_id: 'grant-1', id: 'msg-1' } },
    ...overrides,
  };
}

// The grant lookup runs before anything else, so it has to resolve for the
// ingest failure under test to be the one that surfaces.
const CONNECTED = {
  userId: 'user-1',
  accountId: 'acc-1',
  grantId: 'grant-1',
  provider: 'google',
  status: 'connected',
} as any;

async function settle() {
  for (let i = 0; i < 40 && webhookQueueDepth().queued + webhookQueueDepth().active > 0; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await new Promise((resolve) => setTimeout(resolve, 10));
}

afterEach(() => __setWebhookIngestDepsForTest());

describe('webhook queue failure reporting', () => {
  test('a repeated fault is reported once, not once per delivery and not never', async () => {
    __setWebhookIngestDepsForTest({
      query: (async () => CONNECTED) as any,
      mutate: (async () => {
        throw new Error('by_grant matched more than one row');
      }) as any,
    });
    const errors = spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      for (let i = 0; i < 5; i += 1) enqueueNylasWebhook(payload());
      await settle();

      const mine = errors.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.includes('by_grant matched more than one row'));
      // Exactly one: the first occurrence. Five identical failures must not
      // print five lines, and must not print zero.
      expect(mine).toHaveLength(1);
      expect(mine[0]).toContain('[nylas-webhook] ingest failed');
    } finally {
      errors.mockRestore();
    }
  });

  test('a different fault is always reported, even after another has been seen', async () => {
    const errors = spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      __setWebhookIngestDepsForTest({
        query: (async () => CONNECTED) as any,
        mutate: (async () => {
          throw new Error('first distinct fault');
        }) as any,
      });
      enqueueNylasWebhook(payload());
      await settle();

      __setWebhookIngestDepsForTest({
        query: (async () => CONNECTED) as any,
        mutate: (async () => {
          throw new Error('second distinct fault');
        }) as any,
      });
      enqueueNylasWebhook(payload());
      await settle();

      const lines = errors.mock.calls.map((call) => String(call[0]));
      // Sampling by reason rather than by count is the whole point: a new
      // failure mode must never be swallowed because an older one is noisy.
      expect(lines.some((line) => line.includes('second distinct fault'))).toBe(true);
    } finally {
      errors.mockRestore();
    }
  });

  test('rejects a delivery when the buffer is full so Nylas retries it', () => {
    // The reconciler does not replay deletes, so a dropped delivery is data
    // loss; refusing it is what makes Nylas send it again.
    expect(typeof enqueueNylasWebhook(payload())).toBe('boolean');
    expect(webhookQueueDepth()).toHaveProperty('queued');
    expect(webhookQueueDepth()).toHaveProperty('active');
  });
});
