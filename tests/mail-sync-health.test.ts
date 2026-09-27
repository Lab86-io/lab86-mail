import { afterEach, describe, expect, mock, test } from 'bun:test';
import { NextRequest } from 'next/server';
import { createMailRepairPost } from '../app/api/cron/mail-repair/route';
import { runWithAiRequestContext } from '../lib/ai/context';
import {
  __clearFolderNameCacheForTest,
  __setWebhookIngestDepsForTest,
  ingestNylasWebhookPayload,
  ingestThreadIntoCorpus,
  repairMailCorpusAccount,
  repairUserMailCorpus,
  retryFailedWebhookEvents,
  webhookMessageObject,
} from '../lib/mail/corpus-sync';
import {
  isGrantGoneError,
  isReconnectReason,
  markGrantNeedsReconnect,
  noteGrantFailure,
} from '../lib/nylas/grant-health';
import { normalizeNylasMessage } from '../lib/nylas/normalize';
import { nylasRetryDelayMs, retryAfterMs, withNylasRetry } from '../lib/nylas/retry';
import { listAccounts } from '../lib/tools/mail';
import { accountRow, nylasMessage, withHttpHarness } from './tools/http-harness';

afterEach(() => __setWebhookIngestDepsForTest());

const rateLimited = (retryAfter?: string) =>
  Object.assign(new Error('Too many requests'), {
    statusCode: 429,
    headers: retryAfter === undefined ? {} : { 'retry-after': retryAfter },
  });

describe('Nylas 429 retry (SYNC-1)', () => {
  test('a 429 waits for Retry-After and then succeeds', async () => {
    const sleeps: number[] = [];
    let attempts = 0;
    const result = await withNylasRetry(
      async () => {
        attempts += 1;
        if (attempts === 1) throw rateLimited('3');
        return 'ok';
      },
      2,
      { sleep: async (ms) => sleeps.push(ms) },
    );
    expect(result).toBe('ok');
    expect(sleeps).toEqual([3000]);
  });

  test('the wait is bounded, and a 429 gets at least three retries', async () => {
    const sleeps: number[] = [];
    let attempts = 0;
    await expect(
      withNylasRetry(
        async () => {
          attempts += 1;
          throw rateLimited('999');
        },
        0,
        { sleep: async (ms) => sleeps.push(ms) },
      ),
    ).rejects.toThrow('Too many requests');
    expect(attempts).toBe(4);
    expect(sleeps).toEqual([15_000, 15_000, 15_000]);
  });

  test('Retry-After parses seconds and HTTP dates, with a backoff fallback', () => {
    expect(retryAfterMs({ headers: { 'retry-after': '2' } })).toBe(2000);
    const now = Date.parse('2026-09-26T10:00:00Z');
    expect(retryAfterMs({ headers: { 'retry-after': 'Sat, 26 Sep 2026 10:00:05 GMT' } }, now)).toBe(5000);
    expect(retryAfterMs({ headers: { 'retry-after': 'soon' } })).toBeUndefined();
    expect(retryAfterMs({ headers: new Headers({ 'retry-after': '1' }) })).toBe(1000);
    expect(nylasRetryDelayMs(rateLimited(), 1)).toBe(2000);
    expect(nylasRetryDelayMs({ statusCode: 503 }, 1)).toBe(500);
  });
});

describe('grant health (SYNC-2)', () => {
  test('only grant-level failures count as a dead grant', () => {
    expect(isGrantGoneError({ statusCode: 404, message: 'No grant found with id g' })).toBe(true);
    expect(isGrantGoneError({ statusCode: 404, message: 'Message not found' })).toBe(false);
    expect(isGrantGoneError({ statusCode: 401, message: 'Grant expired, re-authenticate' })).toBe(true);
    expect(isGrantGoneError({ statusCode: 401, message: 'Unauthorized' })).toBe(false);
    expect(isGrantGoneError({ statusCode: 400, providerError: { error: 'invalid_grant' } })).toBe(true);
    expect(isGrantGoneError({ statusCode: 403, message: 'Forbidden' })).toBe(false);
    expect(isGrantGoneError(null)).toBe(false);
  });

  test('marking sends one reason per grant and survives a failed write', async () => {
    const mutate = mock(async (): Promise<any> => ({ updated: 1 }));
    expect(await noteGrantFailure('g1', { statusCode: 404, message: 'No grant found' }, mutate as any)).toBe(
      true,
    );
    expect((mutate.mock.calls[0] as any[])[1]).toEqual({
      grantId: 'g1',
      reason: 'Reconnect needed: the mailbox connection was removed',
    });
    expect(await noteGrantFailure('g1', { statusCode: 500 }, mutate as any)).toBe(false);
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(await markGrantNeedsReconnect(undefined, 'x', mutate as any)).toBe(false);
    const failing = mock(async () => {
      throw new Error('convex down');
    });
    expect(await markGrantNeedsReconnect('g1', 'x', failing as any)).toBe(false);
    expect(isReconnectReason('Reconnect needed: x')).toBe(true);
    expect(isReconnectReason(undefined)).toBe(false);
  });
});

const webhook = (type: string, object: Record<string, unknown>, id = 'evt-1') => ({
  id,
  type,
  data: { object: { grant_id: 'grant_1', ...object } },
});

describe('webhook ingest (SYNC-1, SYNC-2, SYNC-4)', () => {
  test('a full message.updated payload is used directly, with stars and thread id', async () => {
    await withHttpHarness(async (h) => {
      h.convexFallback = () => ({});
      h.onConvex('accounts:getConnectedAccountByGrant', () => accountRow());
      h.onConvex('mailCorpus:recordWebhookEvent', () => ({ duplicate: false }));
      const result = await ingestNylasWebhookPayload(
        webhook('message.updated', {
          id: 'm1',
          thread_id: 't1',
          body: '<p>hi</p>',
          subject: 'Hi',
          from: [{ email: 'bob@example.com' }],
          folders: ['INBOX'],
          unread: false,
          starred: true,
          date: 1_700_000_000,
        }),
      );
      expect(result).toMatchObject({ ok: true });
      expect(h.nylasCalls).toHaveLength(0);
      const batch = h.convexCalls.find((c) => c.path === 'mailCorpus:upsertCorpusBatch');
      expect(batch?.args.messages[0]).toMatchObject({
        providerMessageId: 'm1',
        providerThreadId: 't1',
        starred: true,
      });
    });
  });

  test('a truncated event refetches the message', async () => {
    await withHttpHarness(async (h) => {
      h.convexFallback = () => ({});
      h.onConvex('accounts:getConnectedAccountByGrant', () => accountRow());
      h.onConvex('mailCorpus:recordWebhookEvent', () => ({ duplicate: false }));
      h.onNylas('GET', /\/messages\/m2$/, () => ({ json: { data: nylasMessage({ id: 'm2' }) } }));
      await ingestNylasWebhookPayload(webhook('message.updated.truncated', { id: 'm2', thread_id: 't1' }));
      expect(h.nylasCalls.map((c) => c.path)).toEqual(['/v3/grants/grant_1/messages/m2']);
    });
  });

  test('grant.expired puts the account in the reconnect state', async () => {
    await withHttpHarness(async (h) => {
      h.convexFallback = () => ({});
      h.onConvex('accounts:getConnectedAccountByGrant', () => accountRow());
      h.onConvex('mailCorpus:recordWebhookEvent', () => ({ duplicate: false }));
      h.onConvex('accounts:markGrantReconnectNeeded', () => ({ updated: 1 }));
      const result = await ingestNylasWebhookPayload(webhook('grant.expired', {}));
      expect(result).toMatchObject({ ok: true, reconnectNeeded: true });
      const mark = h.convexCalls.find((c) => c.path === 'accounts:markGrantReconnectNeeded');
      expect(mark?.args).toEqual({
        grantId: 'grant_1',
        reason: 'Reconnect needed: the mailbox sign-in expired',
      });
      expect(h.convexCalls.find((c) => c.path === 'mailCorpus:markWebhookEventProcessed')?.args.status).toBe(
        'processed',
      );
    });
  });

  test('a No Grant refetch error marks the account and rethrows', async () => {
    await withHttpHarness(async (h) => {
      h.convexFallback = () => ({});
      h.onConvex('accounts:getConnectedAccountByGrant', () => accountRow());
      h.onConvex('mailCorpus:recordWebhookEvent', () => ({ duplicate: false }));
      h.onNylas('GET', /\/messages\/m3$/, () => ({
        status: 404,
        json: {
          request_id: 'r',
          error: { type: 'not_found_error', message: 'No grant found with id grant_1' },
        },
      }));
      await expect(
        ingestNylasWebhookPayload(webhook('message.updated.truncated', { id: 'm3', thread_id: 't1' })),
      ).rejects.toThrow(/grant/i);
      expect(h.convexCalls.some((c) => c.path === 'accounts:markGrantReconnectNeeded')).toBe(true);
    });
  });

  test('thread hydration keeps a star (SYNC-4)', async () => {
    await withHttpHarness(async (h) => {
      h.convexFallback = () => ({});
      const message = normalizeNylasMessage(nylasMessage({ id: 's1', starred: true }) as any, 'acct_1');
      await ingestThreadIntoCorpus(accountRow(), [message]);
      const batch = h.convexCalls.find((c) => c.path === 'mailCorpus:upsertCorpusBatch');
      expect(batch?.args.messages[0].starred).toBe(true);
      expect(batch?.args.threads[0].starred).toBe(true);
    });
  });

  test('ingest replaces lone surrogates in provider text and keeps whole emoji', async () => {
    const emoji = '\u{1F600}';
    const high = emoji[0];
    const low = emoji[1];
    const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    await withHttpHarness(async (h) => {
      h.convexFallback = () => ({});
      const message = normalizeNylasMessage(
        nylasMessage({
          id: 'u1',
          subject: `Trip ${emoji} plan ${high}`,
          from: [{ name: `Bob ${low}`, email: 'bob@example.com' }],
          snippet: `${low}hello`,
          body: `<p>Body ${emoji} ${high}</p>`,
          headers: [{ name: 'List-Id', value: `news ${high}` }],
          attachments: [{ id: 'att', filename: `photo${high}.jpg`, content_type: 'image/jpeg', size: 1 }],
        }) as any,
        'acct_1',
      );
      await ingestThreadIntoCorpus(accountRow(), [message]);
      const batch = h.convexCalls.find((c) => c.path === 'mailCorpus:upsertCorpusBatch');
      const [stored] = batch?.args.messages ?? [];
      expect(stored.subject).toBe(`Trip ${emoji} plan \uFFFD`);
      expect(stored.from).toBe('Bob \uFFFD <bob@example.com>');
      expect(stored.snippet).toBe('\uFFFDhello');
      expect(stored.textBody).toContain(`Body ${emoji} \uFFFD`);
      expect(stored.headers['list-id']).toBe('news \uFFFD');
      expect(stored.attachments[0].filename).toBe('photo\uFFFD.jpg');
      expect(batch?.args.threads[0].subject).toBe(`Trip ${emoji} plan \uFFFD`);
      expect(lone.test(JSON.stringify(batch?.args))).toBe(false);
      for (const value of [stored.subject, stored.from, stored.snippet, stored.textBody, stored.searchText])
        expect(lone.test(value)).toBe(false);
    });
  });

  test('ingest stores role labels for Microsoft and iCloud folder ids (SEARCH-1)', async () => {
    __clearFolderNameCacheForTest();
    await withHttpHarness(async (h) => {
      h.convexFallback = () => ({});
      h.onNylas('GET', /\/v3\/grants\/grant_ms\/folders$/, () => ({
        json: { data: [{ id: 'AAMk-in', name: 'Inbox' }] },
      }));
      const ms = accountRow({ provider: 'microsoft', grantId: 'grant_ms' });
      const message = normalizeNylasMessage(
        nylasMessage({ id: 'x1', folders: ['AAMk-in'] }) as any,
        'acct_1',
      );
      await ingestThreadIntoCorpus(ms, [message]);
      await ingestThreadIntoCorpus(ms, [message]);
      // The folder list is cached per grant.
      expect(h.nylasCalls.filter((c) => c.path.endsWith('/folders'))).toHaveLength(1);
      const batch = h.convexCalls.find((c) => c.path === 'mailCorpus:upsertCorpusBatch');
      expect(batch?.args.messages[0].labels).toEqual(['AAMk-in', 'INBOX']);
      expect(batch?.args.threads[0].labels).toEqual(['AAMk-in', 'INBOX']);

      h.convexCalls.length = 0;
      const icloud = accountRow({ provider: 'icloud', grantId: 'grant_ic' });
      const junk = normalizeNylasMessage(
        nylasMessage({ id: 'x2', folders: ['v0:abc:Junk'] }) as any,
        'acct_1',
      );
      await ingestThreadIntoCorpus(icloud, [junk]);
      const icBatch = h.convexCalls.find((c) => c.path === 'mailCorpus:upsertCorpusBatch');
      expect(icBatch?.args.messages[0].labels).toEqual(['v0:abc:Junk', 'SPAM']);
      // A failed folder read never blocks ingest.
      h.convexCalls.length = 0;
      await ingestThreadIntoCorpus(accountRow({ provider: 'microsoft', grantId: 'grant_down' }), [message]);
      expect(
        h.convexCalls.find((c) => c.path === 'mailCorpus:upsertCorpusBatch')?.args.messages[0].labels,
      ).toEqual(['AAMk-in']);
    });
  });

  test('webhook message objects need ids and a body; snake_case thread ids normalize', () => {
    expect(webhookMessageObject({ data: { object: { id: 'a', thread_id: 't', body: '' } } })).not.toBeNull();
    expect(webhookMessageObject({ data: { object: { id: 'a', thread_id: 't' } } })).toBeNull();
    expect(webhookMessageObject({ data: {} })).toBeNull();
    expect(webhookMessageObject(null)).toBeNull();
    const normalized = normalizeNylasMessage({ id: 'a', thread_id: 't', starred: true } as any, 'acct');
    expect(normalized).toMatchObject({ threadId: 't', starred: true });
  });
});

describe('durable webhook retry and repair sweep (SYNC-3)', () => {
  test('failed events are retried with a refetch of the current message', async () => {
    await withHttpHarness(async (h) => {
      h.convexFallback = () => ({});
      h.onConvex('mailCorpus:listRetryableWebhookEvents', () => [
        {
          eventId: 'evt-9',
          type: 'message.updated',
          grantId: 'grant_1',
          attempts: 1,
          // A full but stale payload: the retry must not trust it.
          payload: webhook(
            'message.updated',
            { id: 'm9', thread_id: 't9', body: 'old', unread: true },
            'evt-9',
          ),
        },
        { eventId: 'evt-10', type: 'message.created', attempts: 0, payload: { type: 'message.created' } },
      ]);
      h.onConvex('accounts:getConnectedAccountByGrant', () => accountRow());
      h.onNylas('GET', /\/messages\/m9$/, () => ({
        json: { data: nylasMessage({ id: 'm9', unread: false }) },
      }));
      const result = await retryFailedWebhookEvents();
      expect(result).toEqual({ ok: true, attempted: 2, processed: 1, failed: 1 });
      const batch = h.convexCalls.find((c) => c.path === 'mailCorpus:upsertCorpusBatch');
      expect(batch?.args.messages[0]).toMatchObject({ providerMessageId: 'm9', unread: false });
      const settled = h.convexCalls.filter((c) => c.path === 'mailCorpus:markWebhookEventProcessed');
      expect(settled.map((c) => [c.args.eventId, c.args.status])).toEqual([
        ['evt-9', 'processed'],
        ['evt-10', 'error'],
      ]);
    });
  });

  test('the repair sweep re-reads recent mail in bounded pages', async () => {
    await withHttpHarness(async (h) => {
      h.convexFallback = () => ({});
      h.onConvex('accounts:getConnectedAccount', () => accountRow());
      let page = 0;
      h.onNylas('GET', /\/v3\/grants\/grant_1\/messages$/, () => {
        page += 1;
        // Full pages of 20: the SDK keeps reading short pages up to the limit.
        const data = Array.from({ length: 20 }, (_, i) => nylasMessage({ id: `p${page}_${i}` }));
        return { json: { data, next_cursor: `more${page}` } };
      });
      const now = Date.parse('2026-09-26T00:00:00Z');
      const result = await repairMailCorpusAccount({
        userId: 'user_1',
        accountId: 'acct_1',
        maxPages: 2,
        now,
      });
      expect(result).toEqual({ ok: true, accountId: 'acct_1', messages: 40 });
      expect(h.nylasCalls).toHaveLength(2);
      expect(h.nylasCalls[0].search).toContain(`received_after=${Math.floor((now - 7 * 86_400_000) / 1000)}`);
      expect(h.nylasCalls[1].search).toContain('page_token=more1');
      expect(h.convexCalls.filter((c) => c.path === 'mailCorpus:upsertCorpusBatch')).toHaveLength(2);
    });
  });

  test('the user sweep skips mailboxes that are not ready or need reconnection', async () => {
    await withHttpHarness(async (h) => {
      h.convexFallback = () => ({});
      h.onConvex('accounts:listConnectedAccounts', () => [
        accountRow(),
        accountRow({ accountId: 'acct_2', grantId: 'grant_2' }),
        accountRow({ accountId: 'acct_3', grantId: 'grant_3', status: 'error' }),
      ]);
      h.onConvex('mailCorpus:listSyncTargets', () => [
        { accountId: 'acct_1', corpusReady: true },
        { accountId: 'acct_3', corpusReady: true },
      ]);
      h.onConvex('accounts:getConnectedAccount', (args) => accountRow({ accountId: args.accountId }));
      h.onNylas('GET', /\/v3\/grants\/grant_1\/messages$/, () => ({
        status: 404,
        json: { error: { type: 'not_found_error', message: 'No grant found with id grant_1' } },
      }));
      const results = await repairUserMailCorpus('user_1');
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ accountId: 'acct_1', ok: false });
      expect(h.convexCalls.some((c) => c.path === 'accounts:markGrantReconnectNeeded')).toBe(true);
    });
  });

  test('the cron route checks the secret and starts the right job', async () => {
    const deps = {
      isInternalCronRequest: mock(() => true),
      repairUserMailCorpus: mock(async () => []),
      retryFailedWebhookEvents: mock(async () => ({
        ok: true as const,
        attempted: 0,
        processed: 0,
        failed: 0,
      })),
    };
    const post = createMailRepairPost(deps as any);
    const req = (body: unknown) =>
      new NextRequest('http://localhost/api/cron/mail-repair', {
        method: 'POST',
        body: JSON.stringify(body),
      });
    expect((await post(req({ kind: 'webhooks' }))).status).toBe(202);
    expect(deps.retryFailedWebhookEvents).toHaveBeenCalledTimes(1);
    expect((await post(req({ kind: 'sweep', userId: 'u1' }))).status).toBe(202);
    expect(deps.repairUserMailCorpus).toHaveBeenCalledWith('u1');
    expect((await post(req({ kind: 'sweep' }))).status).toBe(400);
    expect((await post(new NextRequest('http://localhost/x', { method: 'POST', body: 'nope' }))).status).toBe(
      400,
    );
    deps.isInternalCronRequest.mockImplementation(() => false);
    expect((await post(req({ kind: 'webhooks' }))).status).toBe(401);
  });
});

describe('list_accounts shows reconnect-needed mailboxes (SYNC-2)', () => {
  test('dead grants come back unauthed with a reason and get no backfill kick', async () => {
    await withHttpHarness(async (h) => {
      h.onConvex('accounts:listConnectedAccounts', () => [
        accountRow(),
        accountRow({
          accountId: 'acct_2',
          status: 'error',
          error: 'Reconnect needed: the mailbox sign-in expired',
        }),
        accountRow({ accountId: 'acct_3', status: 'disconnected' }),
      ]);
      h.onConvex('mailCorpus:listSyncTargets', () => [
        { accountId: 'acct_1', corpusReady: true, status: 'ready' },
      ]);
      const result = await runWithAiRequestContext({ userId: 'user_1', agent: 'ai' }, () =>
        listAccounts.handler({}, { agent: 'ai', userId: 'user_1' }),
      );
      expect(result.accounts.map((a: any) => [a.accountId, a.authed, a.reconnectReason])).toEqual([
        ['acct_1', true, undefined],
        ['acct_2', false, 'Reconnect needed: the mailbox sign-in expired'],
      ]);
      expect(h.convexCalls.some((c) => c.path === 'mailCorpus:claimCorpusBackfill')).toBe(false);
    });
  });
});
