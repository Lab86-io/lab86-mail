import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { __setWebhookIngestDepsForTest } from '../lib/mail/corpus-sync';
import {
  __resetWebhookSamplingForTest,
  enqueueNylasWebhook,
  webhookQueueDepth,
} from '../lib/mail/webhook-queue';

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

beforeEach(() => __resetWebhookSamplingForTest());
afterEach(() => __setWebhookIngestDepsForTest());

describe('webhook queue failure reporting', () => {
  test('a repeated fault is reported once, then sampled at every fiftieth', async () => {
    __setWebhookIngestDepsForTest({
      query: (async () => CONNECTED) as any,
      mutate: (async () => {
        throw new Error('by_grant matched more than one row');
      }) as any,
    });
    const errors = spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      for (let i = 0; i < 50; i += 1) enqueueNylasWebhook(payload());
      await settle();

      const mine = errors.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.includes('by_grant matched more than one row'));
      // The first occurrence and the fiftieth. Fifty identical failures must
      // not print fifty lines, and must not print zero.
      expect(mine).toHaveLength(2);
      expect(mine[0]).toContain('[nylas-webhook] ingest failed (1x this reason');
      expect(mine[1]).toContain('(50x this reason');
    } finally {
      errors.mockRestore();
    }
  });

  // Reasons carry ids, so the set of distinct strings has no natural bound in
  // a process that runs for weeks.
  test('the reason table is bounded rather than growing for the life of the process', async () => {
    const errors = spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      let distinct = 0;
      let fixedReason: string | null = null;
      __setWebhookIngestDepsForTest({
        query: (async () => CONNECTED) as any,
        mutate: (async () => {
          if (fixedReason) throw new Error(fixedReason);
          distinct += 1;
          throw new Error(`reason for delivery ${distinct}`);
        }) as any,
      });
      const send = async (count: number) => {
        for (let i = 0; i < count; i += 1) enqueueNylasWebhook(payload());
        await settle();
      };
      const linesForFirstReason = () =>
        errors.mock.calls.map((call) => String(call[0])).filter((line) => line.endsWith('reason for delivery 1'));

      // Fill the table exactly, then show the first reason is still counted.
      // An implementation that gave up early would report it as new here.
      await send(500);
      errors.mockClear();
      fixedReason = 'reason for delivery 1';
      await send(49);
      expect(linesForFirstReason()).toHaveLength(1);
      expect(linesForFirstReason()[0]).toContain('(50x this reason');

      // One reason past the limit. The table starts again rather than growing.
      fixedReason = null;
      await send(1);
      errors.mockClear();
      fixedReason = 'reason for delivery 1';
      await send(1);

      expect(linesForFirstReason()).toHaveLength(1);
      expect(linesForFirstReason()[0]).toContain('(1x this reason');
    } finally {
      errors.mockRestore();
    }
  }, 30_000);

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

  // The buffer holds 5000 and the pump keeps 4 in flight, so the 5005th
  // delivery is the first one the queue cannot take. Holding the ingest open is
  // what lets the buffer reach that depth at all.
  test('rejects a delivery when the buffer is full so Nylas retries it', async () => {
    let held = true;
    __setWebhookIngestDepsForTest({
      query: (async () => {
        while (held) await new Promise((resolve) => setTimeout(resolve, 5));
        return CONNECTED;
      }) as any,
      mutate: (async () => ({ duplicate: true })) as any,
    });
    const errors = spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      let accepted = 0;
      for (let i = 0; i < 5_004; i += 1) if (enqueueNylasWebhook(payload())) accepted += 1;
      expect(accepted).toBe(5_004);
      expect(webhookQueueDepth().queued).toBe(5_000);

      // The reconciler does not replay deletes, so a dropped delivery is data
      // loss. Refusing it is what makes Nylas send it again.
      expect(enqueueNylasWebhook(payload())).toBe(false);
      const full = errors.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.includes('queue full'));
      expect(full).toHaveLength(1);
      expect(full[0]).toContain('rejected 1 events for retry');
    } finally {
      // Drain before the next test, or the leftover backlog reaches the real
      // Convex client when afterEach restores it.
      held = false;
      for (let i = 0; i < 600 && webhookQueueDepth().queued + webhookQueueDepth().active > 0; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      errors.mockRestore();
    }
    expect(webhookQueueDepth()).toEqual({ queued: 0, active: 0 });
  });
});
