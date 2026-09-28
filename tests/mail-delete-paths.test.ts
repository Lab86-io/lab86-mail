import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  __setMailClassifierLoadersForTest,
  __setWebhookIngestDepsForTest,
  ingestNylasWebhookPayload,
  retryFailedWebhookEvents,
} from '../lib/mail/corpus-sync';
import { accountRow, withHttpHarness } from './tools/http-harness';

// Every provider delete of a message must reach deleteCorpusMessage, which
// also deletes the stored attachment files of that message (with or without
// a corpus row). Nylas sends a delete for each message (message.deleted), and
// the Gmail History sync also sends a delete for each message (covered in
// google-direct-integration.test.ts).

beforeEach(() => {
  __setWebhookIngestDepsForTest();
  __setMailClassifierLoadersForTest({
    smart: async () => ({ kickLlmClassification: async () => undefined }) as any,
    areas: async () => ({ kickAreaClassification: async () => undefined }) as any,
  });
});
afterEach(() => {
  __setWebhookIngestDepsForTest();
  __setMailClassifierLoadersForTest();
});

const deletedPayload = {
  id: 'evt-del-1',
  type: 'message.deleted',
  data: { object: { id: 'msg-gone', grant_id: 'grant_1', thread_id: 'thread-gone' } },
};

describe('message delete paths reach the attachment cleanup', () => {
  test('a message.deleted webhook calls deleteCorpusMessage for the owner mailbox', async () => {
    await withHttpHarness(async (h) => {
      h.onConvex('accounts:getConnectedAccountByGrant', () => accountRow());
      h.onConvex('mailCorpus:recordWebhookEvent', () => ({ duplicate: false }));
      h.onConvex('mailCorpus:deleteCorpusMessage', () => ({ ok: true }));
      h.convexFallback = () => ({ ok: true });
      const result = await ingestNylasWebhookPayload(deletedPayload);
      expect(result).toMatchObject({ ok: true, eventId: 'evt-del-1' });
      const deletes = h.convexCalls.filter((call) => call.path === 'mailCorpus:deleteCorpusMessage');
      expect(deletes.map((call) => call.args)).toEqual([
        { userId: 'user_1', accountId: 'acct_1', providerMessageId: 'msg-gone' },
      ]);
      // A delete reads nothing from the provider.
      expect(h.nylasCalls).toEqual([]);
    });
  });

  test('the durable retry of a failed message.deleted event calls it too', async () => {
    await withHttpHarness(async (h) => {
      h.onConvex('mailCorpus:listRetryableWebhookEvents', () => [
        {
          eventId: 'evt-del-1',
          type: 'message.deleted',
          grantId: 'grant_1',
          attempts: 1,
          payload: deletedPayload,
        },
      ]);
      h.onConvex('accounts:getConnectedAccountByGrant', () => accountRow());
      h.onConvex('mailCorpus:deleteCorpusMessage', () => ({ ok: true }));
      h.convexFallback = () => ({ ok: true });
      expect(await retryFailedWebhookEvents()).toEqual({ ok: true, attempted: 1, processed: 1, failed: 0 });
      const deletes = h.convexCalls.filter((call) => call.path === 'mailCorpus:deleteCorpusMessage');
      expect(deletes.map((call) => call.args.providerMessageId)).toEqual(['msg-gone']);
    });
  });
});
