import { afterEach, describe, expect, test } from 'bun:test';
import { __setWebhookIngestDepsForTest, ingestNylasWebhookPayload } from '../lib/mail/corpus-sync';

function payload(overrides: Record<string, unknown> = {}) {
  return {
    id: 'evt-1',
    type: 'message.created',
    data: { object: { grant_id: 'grant-1', id: 'msg-1', thread_id: 'th-1' } },
    ...overrides,
  };
}

function harness(options: { duplicate?: boolean; account?: unknown } = {}) {
  const mutations: Array<{ args: any }> = [];
  __setWebhookIngestDepsForTest({
    query: (async () => options.account ?? null) as any,
    mutate: (async (_fn: any, args: any) => {
      mutations.push({ args });
      // recordWebhookEvent is the only call that reports duplicates.
      if (args?.payload !== undefined) return { duplicate: options.duplicate ?? false };
      return {};
    }) as any,
  });
  return mutations;
}

afterEach(() => __setWebhookIngestDepsForTest());

describe('nylas webhook ingest guards', () => {
  test('a redelivered event is acknowledged without being reprocessed', async () => {
    // At-least-once delivery is the design; this dedupe is what keeps it safe.
    const mutations = harness({ duplicate: true });
    const result = await ingestNylasWebhookPayload(payload());

    expect(result).toEqual({ ok: true, duplicate: true, eventId: 'evt-1' });
    // Only the recording call — nothing downstream ran.
    expect(mutations).toHaveLength(1);
  });

  test('an event for an unknown grant is recorded as an error, not retried forever', async () => {
    const mutations = harness({ account: null });
    const result = await ingestNylasWebhookPayload(payload());

    expect(result).toEqual({ ok: false, eventId: 'evt-1', error: 'unknown grant' });
    const marked = mutations.find((m) => m.args?.status === 'error');
    expect(marked?.args.error).toContain('did not map to a connected grant');
  });

  test('an event with no grant id at all is handled the same way', async () => {
    harness();
    const result = await ingestNylasWebhookPayload(payload({ data: { object: { id: 'msg-1' } } }));
    expect(result).toMatchObject({ ok: false, error: 'unknown grant' });
  });

  test('a grant that resolves to a disconnected account is treated as unknown', async () => {
    // getConnectedAccountByGrant only accepts status 'connected'.
    harness({ account: { userId: 'u', accountId: 'a', grantId: 'grant-1', status: 'revoked' } });
    const result = await ingestNylasWebhookPayload(payload());
    expect(result).toMatchObject({ ok: false, error: 'unknown grant' });
  });

  test('the event id falls back to a synthesized, payload-derived key', async () => {
    const mutations = harness({ duplicate: true });
    // No explicit id: two distinct payloads must not collide on the dedupe index.
    const first = await ingestNylasWebhookPayload(payload({ id: undefined }));
    const second = await ingestNylasWebhookPayload(
      payload({ id: undefined, data: { object: { grant_id: 'grant-1', id: 'msg-2' } } }),
    );

    expect(first.eventId).not.toBe(second.eventId);
    expect(mutations).toHaveLength(2);
  });
});
