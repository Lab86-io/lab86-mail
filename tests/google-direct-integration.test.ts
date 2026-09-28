import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { getFunctionName } from 'convex/server';
import { __setGoogleMailAdapterDepsForTest } from '../lib/google/adapter/mail';
import { encodeAttachmentId } from '../lib/google/gmail-message';
import { __setGoogleHttpDepsForTest } from '../lib/google/http';
import { __setGoogleTokenDepsForTest } from '../lib/google/tokens';
import {
  __setMailClassifierLoadersForTest,
  __setWebhookIngestDepsForTest,
  applyProviderMessageChanges,
  backfillMailCorpusAccount,
  ingestNylasWebhookPayload,
} from '../lib/mail/corpus-sync';
import { deleteNylasAccount } from '../lib/nylas/provider';
import { encryptSecret } from '../lib/security/crypto';
import { plainMessage, receiptMessage } from './google-gmail-fixtures';
import { accountRow, withHttpHarness } from './tools/http-harness';

const GRANT = 'google:acct_1';
let savedKey: string | undefined;

beforeEach(() => {
  savedKey = process.env.LAB86_MAIL_ENCRYPTION_KEY;
  process.env.LAB86_MAIL_ENCRYPTION_KEY = 'google-direct-integration-test-key';
  // The token store is covered in its own test; here every call has a token.
  __setGoogleHttpDepsForTest({ getGoogleAccessToken: async () => 'access-token', sleep: async () => {} });
  __setMailClassifierLoadersForTest({
    smart: async () => ({ kickLlmClassification: async () => undefined }) as any,
    areas: async () => ({ kickAreaClassification: async () => undefined }) as any,
  });
});

afterEach(() => {
  if (savedKey === undefined) delete process.env.LAB86_MAIL_ENCRYPTION_KEY;
  else process.env.LAB86_MAIL_ENCRYPTION_KEY = savedKey;
  __setGoogleHttpDepsForTest();
  __setGoogleTokenDepsForTest();
  __setGoogleMailAdapterDepsForTest();
  __setWebhookIngestDepsForTest();
  __setMailClassifierLoadersForTest();
});

describe('a real caller with a google: grant goes to Gmail', () => {
  test('the corpus backfill lists Gmail and stores the Nylas-shaped rows', async () => {
    await withHttpHarness(async (h) => {
      h.onConvex('accounts:getConnectedAccount', () => accountRow({ grantId: GRANT }));
      h.onConvex('mailCorpus:markSyncState', () => ({ ok: true }));
      h.onConvex('mailCorpus:upsertCorpusBatch', () => ({ ok: true }));
      h.onNylas('GET', /\/gmail\/v1\/users\/me\/messages$/, () => ({
        json: { messages: [{ id: '1a0e656c36a59a89' }], nextPageToken: 'gmail-page-2' },
      }));
      h.onNylas('GET', /\/gmail\/v1\/users\/me\/messages\/1a0e656c36a59a89$/, () => ({
        json: receiptMessage(),
      }));

      const result = await backfillMailCorpusAccount({ userId: 'user_1', accountId: 'acct_1' });
      expect(result).toMatchObject({
        ok: true,
        grantId: GRANT,
        messages: 1,
        nextPageToken: 'gmail-page-2',
        corpusReady: false,
      });
      expect(h.nylasCalls.some((call) => call.path.startsWith('/v3/'))).toBe(false);
      const list = h.nylasCalls.find((call) => call.path.endsWith('/messages'));
      expect(new URLSearchParams(list?.search).get('maxResults')).toBe('20');
      const batch = h.convexCalls.find((call) => call.path === 'mailCorpus:upsertCorpusBatch');
      expect(batch?.args.grantId).toBe(GRANT);
      expect(batch?.args.messages[0]).toMatchObject({
        providerMessageId: '1a0e656c36a59a89',
        providerThreadId: '1a0e656c36a59a89',
        from: 'Ng, Kin Man (NIH/NLM/NCBI) [C] <kin.ng@nih.gov>',
        labels: ['UNREAD', 'INBOX', 'CATEGORY_UPDATES'],
        unread: true,
        receivedAt: 1789440527000,
      });
      expect(batch?.args.messages[0].attachments[0]).toEqual({
        filename: 'Invoice-VKHXRY-00028.pdf',
        mimeType: 'application/octet-stream',
        size: 42076,
        attachmentId: encodeAttachmentId({
          filename: 'Invoice-VKHXRY-00028.pdf',
          contentType: 'application/octet-stream',
          size: 42076,
        }),
      });
    });
  });
});

describe('disconnect of a direct account', () => {
  test('revokes the token and destroys the old Nylas grant before the account rows go', async () => {
    await withHttpHarness(async (h) => {
      const order: string[] = [];
      h.onConvex('googleDirect:getGrantCredentials', () => {
        order.push('credentials');
        return {
          userId: 'user_1',
          accountId: 'acct_1',
          email: 'ann@example.com',
          scopes: [],
          refreshTokenEncrypted: encryptSecret('refresh-token-1'),
          previousNylasGrantId: 'nylas_old',
        };
      });
      h.onConvex('googleDirect:removeGrant', () => {
        order.push('removeGrant');
        return { removed: 1, previousNylasGrantIds: ['nylas_old'] };
      });
      h.onConvex('accounts:deleteConnectedAccount', () => {
        order.push('deleteAccount');
        return { ok: true };
      });
      h.onNylas('POST', /^\/revoke$/, ({ body }) => {
        order.push(`revoke:${body}`);
        return { json: {} };
      });
      h.onNylas('DELETE', /\/v3\/grants\/nylas_old$/, () => {
        order.push('destroyNylas');
        return { json: { request_id: 'r' } };
      });
      expect(await deleteNylasAccount('user_1', 'acct_1', GRANT)).toEqual({ ok: true });
      expect(order).toEqual([
        'credentials',
        'revoke:token=refresh-token-1',
        'removeGrant',
        'destroyNylas',
        'deleteAccount',
      ]);
    });
  });

  test('a failed revoke still removes the token row and the account', async () => {
    await withHttpHarness(async (h) => {
      h.onConvex('googleDirect:getGrantCredentials', () => null);
      h.onConvex('googleDirect:removeGrant', () => ({ removed: 0, previousNylasGrantIds: [] }));
      h.onConvex('accounts:deleteConnectedAccount', () => ({ ok: true }));
      expect(await deleteNylasAccount('user_1', 'acct_1', GRANT)).toEqual({ ok: true });
      expect(h.convexCalls.map((call) => call.path)).toEqual([
        'googleDirect:getGrantCredentials',
        'googleDirect:removeGrant',
        'accounts:deleteConnectedAccount',
      ]);
    });
  });
});

describe('applyProviderMessageChanges', () => {
  test('deletes, then upserts in small batches through the webhook ingest path', async () => {
    await withHttpHarness(async (h) => {
      h.onConvex('mailCorpus:deleteCorpusMessage', () => ({ ok: true }));
      h.onConvex('mailCorpus:upsertCorpusBatch', () => ({ ok: true }));
      h.onConvex('mailCorpus:markSyncState', () => ({ ok: true }));
      h.convexFallback = () => null;
      const row = accountRow({ grantId: GRANT });
      const upserts = Array.from({ length: 21 }, (_, index) => ({
        ...plainMessage({ id: `m${index}`, threadId: `t${index}` }),
        grantId: GRANT,
        folders: ['INBOX'],
        from: [{ name: 'Bob', email: 'bob@example.com' }],
        body: 'hello',
        date: 1_789_000_000,
      }));
      const result = await applyProviderMessageChanges(row, {
        upserts,
        deletes: ['gone-1'],
        progress: { source: 'google_history' },
      });
      expect(result).toEqual({ upserted: 21, deleted: 1 });
      const paths = h.convexCalls.map((call) => call.path);
      expect(paths[0]).toBe('mailCorpus:deleteCorpusMessage');
      expect(h.convexCalls[0].args).toEqual({
        userId: 'user_1',
        accountId: 'acct_1',
        providerMessageId: 'gone-1',
      });
      const batches = h.convexCalls.filter((call) => call.path === 'mailCorpus:upsertCorpusBatch');
      expect(batches.map((call) => call.args.messages.length)).toEqual([20, 1]);
      expect(batches[0].args.progress).toEqual({ stage: 'provider_changes', source: 'google_history' });
      expect(await applyProviderMessageChanges(row, { upserts: [], deletes: [] })).toEqual({
        upserted: 0,
        deleted: 0,
      });
    });
  });
});

describe('Nylas webhooks after a switch', () => {
  test('an event for the old Nylas grant is marked processed and ignored', async () => {
    const mutations: Array<{ args: any }> = [];
    __setWebhookIngestDepsForTest({
      query: (async (fn: unknown, args: any) =>
        getFunctionName(fn as any) === 'googleDirect:accountForPreviousNylasGrant' &&
        args.grantId === 'nylas_old'
          ? { userId: 'user_1', accountId: 'acct_1', grantId: GRANT }
          : null) as any,
      mutate: (async (_fn: unknown, args: any) => {
        mutations.push({ args });
        return { duplicate: false };
      }) as any,
    });
    const result = await ingestNylasWebhookPayload({
      id: 'evt-1',
      type: 'message.created',
      data: { object: { id: 'm1', grant_id: 'nylas_old', thread_id: 't1', body: 'x' } },
    });
    expect(result).toMatchObject({ ok: true, ignored: 'switched_to_google' });
    expect(mutations.at(-1)?.args).toMatchObject({ eventId: 'evt-1', status: 'processed' });
  });

  test('an unknown grant still fails loudly', async () => {
    __setWebhookIngestDepsForTest({
      query: (async () => null) as any,
      mutate: (async () => ({ duplicate: false })) as any,
    });
    const result = await ingestNylasWebhookPayload({
      id: 'evt-2',
      type: 'message.created',
      data: { object: { id: 'm1', grant_id: 'nobody', thread_id: 't1', body: 'x' } },
    });
    expect(result).toMatchObject({ ok: false, error: 'unknown grant' });
  });
});
