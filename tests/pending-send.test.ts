import { describe, expect, test } from 'bun:test';
import {
  cancelPending,
  getPendingStatus,
  makeProviderPendingId,
  parseProviderPendingId,
  queueSend,
} from '../lib/send/pending';

describe('pending send deadline contract', () => {
  test('provider receipts are owner-bound and preserve the server deadline', () => {
    const fireAt = Date.now() + 30_000;
    const id = makeProviderPendingId({
      userId: 'user-one',
      account: 'mailbox@example.com',
      scheduleId: 'schedule/with+symbols',
      fireAt,
    });

    expect(parseProviderPendingId(id, 'user-one')).toEqual({
      userId: 'user-one',
      account: 'mailbox@example.com',
      scheduleId: 'schedule/with+symbols',
      fireAt,
    });
    expect(parseProviderPendingId(id, 'user-two')).toBeNull();
    expect(getPendingStatus(id)).toEqual({ status: 'pending', fireAt });
  });

  test('re-queueing one id cannot deliver it twice', async () => {
    const id = `test-user:${crypto.randomUUID()}`;
    const deliveries: string[] = [];
    queueSend(id, 15, async () => {
      deliveries.push('old');
    });
    queueSend(id, 1, async () => {
      deliveries.push('replacement');
    });

    await Bun.sleep(30);
    expect(deliveries).toEqual(['replacement']);
    expect(getPendingStatus(id).status).toBe('sent');
  });

  test('cancellation is terminal and prevents the queued mutation', async () => {
    const id = `test-user:${crypto.randomUUID()}`;
    let delivered = false;
    queueSend(id, 10, async () => {
      delivered = true;
    });

    expect(cancelPending(id)).toBe(true);
    expect(getPendingStatus(id).status).toBe('cancelled');
    await Bun.sleep(20);
    expect(delivered).toBe(false);
    expect(getPendingStatus(id).status).toBe('cancelled');
  });
});
