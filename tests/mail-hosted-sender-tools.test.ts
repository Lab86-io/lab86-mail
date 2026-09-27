import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import './tools/harness';
import { convexTest } from 'convex-test';
import { internal } from '../convex/_generated/api';
import schema from '../convex/schema';
import { runWithAiRequestContext } from '../lib/ai/context';
import { getNylasMessageHeaders, revertNylasMessageFolders } from '../lib/nylas/provider';
import { getUnsubscribeOptions, listSenderCleanup, unsubscribeSender } from '../lib/tools/mail-senders';
import { learnVoiceProfileTool } from '../lib/tools/mail-voice';
import { accountRow, corpusMessage, type HttpHarness, withHttpHarness } from './tools/http-harness';

// The sender, voice, and provider paths against stubbed Convex and Nylas HTTP.

const SECRET = 'hosted-sender-secret';
let previousSecret: string | undefined;
beforeAll(() => {
  previousSecret = process.env.LAB86_CONVEX_INTERNAL_SECRET;
  process.env.LAB86_CONVEX_INTERNAL_SECRET = SECRET;
});
afterAll(() => {
  if (previousSecret === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
  else process.env.LAB86_CONVEX_INTERNAL_SECRET = previousSecret;
});

const ctx = { agent: 'user' as const, userId: 'user_1' };
const run = <T>(fn: () => Promise<T>) => runWithAiRequestContext({ userId: 'user_1', agent: 'user' }, fn);

function listThread(h: HttpHarness, headers: Array<{ name: string; value: string }>) {
  h.onConvex('accounts:getConnectedAccount', () => accountRow());
  h.onConvex('mailCorpus:getCorpusThreadBundle', () => ({
    messages: [corpusMessage({ _id: 'list_msg', from: 'Weekly <news@list.example>', headers: {} })],
  }));
  h.onNylas('GET', /\/v3\/grants\/grant_1\/messages\/list_msg$/, ({ search }) => ({
    json: {
      data: {
        id: 'list_msg',
        headers: search.get('fields') === 'include_headers' ? headers : undefined,
      },
    },
  }));
  const stored: any[] = [];
  h.onConvex('mailCorpus:setMessageListHeaders', (args) => {
    stored.push(args);
    return { stored: true };
  });
  return stored;
}

describe('hosted unsubscribe tools', () => {
  test('options read the headers from Nylas once and store the list lines', async () => {
    await withHttpHarness(async (h) => {
      const stored = listThread(h, [
        { name: 'List-Unsubscribe', value: '<https://list.example/u/9>, <mailto:out@list.example>' },
        { name: 'List-Unsubscribe-Post', value: 'List-Unsubscribe=One-Click' },
        { name: 'List-Id', value: '<weekly.list.example>' },
        { name: 'Received', value: 'from somewhere' },
      ]);
      const options = await run(() =>
        getUnsubscribeOptions.handler({ account: 'acct_1', threadId: 'thread_1' }, ctx),
      );
      expect(options).toEqual({
        sender: 'Weekly',
        senderEmail: 'news@list.example',
        listId: 'weekly.list.example',
        method: 'one_click',
        methods: ['one_click', 'mailto', 'link'],
        destination: 'list.example',
        url: 'https://list.example/u/9',
      });
      expect(stored[0].headers).toEqual({
        'list-unsubscribe': '<https://list.example/u/9>, <mailto:out@list.example>',
        'list-unsubscribe-post': 'List-Unsubscribe=One-Click',
        'list-id': '<weekly.list.example>',
      });
    });
  });

  test('mailto and link options name their destination', async () => {
    await withHttpHarness(async (h) => {
      listThread(h, [{ name: 'List-Unsubscribe', value: '<mailto:out@list.example>' }]);
      const mail = await run(() =>
        getUnsubscribeOptions.handler({ account: 'acct_1', threadId: 'thread_1' }, ctx),
      );
      expect(mail).toMatchObject({ method: 'mailto', destination: 'out@list.example' });
    });
    await withHttpHarness(async (h) => {
      listThread(h, [{ name: 'List-Unsubscribe', value: '<https://list.example/prefs>' }]);
      const link = await run(() =>
        getUnsubscribeOptions.handler({ account: 'acct_1', threadId: 'thread_1' }, ctx),
      );
      expect(link).toMatchObject({ method: 'link', destination: 'list.example' });
      const result = await run(() =>
        unsubscribeSender.handler({ account: 'acct_1', threadId: 'thread_1', confirmed: true }, ctx),
      );
      expect(result).toEqual({
        ok: true,
        status: 'open_link',
        method: 'link',
        sender: 'Weekly',
        url: 'https://list.example/prefs',
      });
    });
    await withHttpHarness(async (h) => {
      listThread(h, []);
      const none = await run(() =>
        getUnsubscribeOptions.handler({ account: 'acct_1', threadId: 'thread_1' }, ctx),
      );
      expect(none).toMatchObject({ method: null, methods: [], destination: null });
    });
  });

  test('a mailto unsubscribe sends from the mailbox and is recorded', async () => {
    await withHttpHarness(async (h) => {
      listThread(h, [{ name: 'List-Unsubscribe', value: '<mailto:out@list.example?subject=remove>' }]);
      h.onNylas('POST', /\/v3\/grants\/grant_1\/messages\/send$/, () => ({
        json: {
          data: { id: 'sent_unsub', thread_id: 'thread_unsub', grant_id: 'grant_1', folders: ['SENT'] },
        },
      }));
      const recorded: any[] = [];
      h.onConvex('operations:record', (args) => {
        recorded.push(args);
        return 'op_unsub';
      });
      const result = await run(() =>
        unsubscribeSender.handler(
          { account: 'acct_1', threadId: 'thread_1', method: 'mailto', confirmed: true },
          ctx,
        ),
      );
      expect(result).toMatchObject({
        ok: true,
        status: 'requested',
        to: 'out@list.example',
        operationId: 'op_unsub',
      });
      const send = h.nylasCalls.find((call) => call.path.endsWith('/messages/send'));
      expect(send?.body.to).toEqual([{ email: 'out@list.example' }]);
      expect(send?.body.subject).toBe('remove');
      expect(recorded[0]).toMatchObject({ tool: 'unsubscribe_sender', surface: 'mail' });
      expect(recorded[0].inverse).toBeUndefined();
    });
  });

  test('the cleanup list reads the Convex ranking', async () => {
    await withHttpHarness(async (h) => {
      h.onConvex('mailCorpus:senderCleanupCandidates', (args) => ({
        senders: [{ sender: 'deals@shop.example' }],
        scanned: 12,
        limit: args.limit,
      }));
      const result = await run(() => listSenderCleanup.handler({ limit: 5 }, ctx));
      expect(result).toMatchObject({ senders: [{ sender: 'deals@shop.example' }], scanned: 12 });
    });
  });
});

describe('hosted provider helpers', () => {
  test('headers come back lowercased, and nothing without a mailbox', async () => {
    await withHttpHarness(async (h) => {
      h.onConvex('accounts:getConnectedAccount', () => accountRow());
      h.onNylas('GET', /\/v3\/grants\/grant_1\/messages\/m1$/, () => ({
        json: { data: { id: 'm1', headers: [{ name: 'List-Id', value: '<a.example>' }, { value: 'x' }] } },
      }));
      expect(await getNylasMessageHeaders({ userId: 'user_1', account: 'acct_1', messageId: 'm1' })).toEqual({
        'list-id': '<a.example>',
      });
    });
    await withHttpHarness(async (h) => {
      h.onConvex('accounts:getConnectedAccount', () => null);
      h.onConvex('accounts:listConnectedAccounts', () => []);
      expect(await getNylasMessageHeaders({ userId: 'user_1', account: 'gone', messageId: 'm1' })).toBeNull();
      expect(
        await revertNylasMessageFolders({
          userId: 'user_1',
          account: 'gone',
          messageId: 'm1',
          before: [],
          after: [],
        }),
      ).toBeNull();
    });
  });

  test('a message label undo removes only the added label', async () => {
    await withHttpHarness(async (h) => {
      h.onConvex('accounts:getConnectedAccount', () => accountRow());
      h.onNylas('GET', /\/v3\/grants\/grant_1\/messages\/m2$/, () => ({
        json: { data: { id: 'm2', folders: ['INBOX', 'Label_new', 'Label_later'] } },
      }));
      h.onNylas('PUT', /\/v3\/grants\/grant_1\/messages\/m2$/, () => ({ json: { data: { id: 'm2' } } }));
      const result = await revertNylasMessageFolders({
        userId: 'user_1',
        account: 'acct_1',
        messageId: 'm2',
        before: ['INBOX'],
        after: ['INBOX', 'Label_new'],
      });
      expect(result).toEqual({
        ok: true,
        before: ['INBOX', 'Label_new', 'Label_later'],
        after: ['INBOX', 'Label_later'],
      });
      expect(h.nylasCalls.find((call) => call.method === 'PUT')?.body).toEqual({
        folders: ['INBOX', 'Label_later'],
      });
    });
  });
});

describe('hosted voice learning', () => {
  test('the learn tool reads sent mail from Convex and saves the card', async () => {
    await withHttpHarness(async (h) => {
      const saved: any[] = [];
      h.onConvex('userData:getDoc', () => null);
      h.onConvex('userData:upsertDoc', (args) => {
        saved.push(args);
        return { ok: true };
      });
      h.onConvex('mailCorpus:recentSentMessages', (args) => ({
        messages: Array.from({ length: args.limit === 50 ? 6 : 0 }, (_, i) => ({
          textBody: `Hi Sam,\n\nThat works, thanks for sending it over ${i}.\n\nBest,\nJakob`,
        })),
      }));
      const result = await run(() => learnVoiceProfileTool.handler(undefined, ctx));
      expect(result.status).toBe('learned');
      expect(saved[0]).toMatchObject({
        kind: 'voiceProfile',
        key: 'default',
        doc: { greeting: 'Hi {name},', signOff: 'Best,\nJakob', sampleCount: 6 },
      });
    });
  });
});

describe('the digest cron action', () => {
  test('does nothing when no hold is due', async () => {
    const t = convexTest(schema, {
      '../convex/_generated/api.js': () => import('../convex/_generated/api.js'),
      '../convex/albatrossNotifications.ts': () => import('../convex/albatrossNotifications'),
      '../convex/albatrossWorkV2.ts': () => import('../convex/albatrossWorkV2'),
      '../convex/albatrossWork.ts': () => import('../convex/albatrossWork'),
      '../convex/boards.ts': () => import('../convex/boards'),
    });
    await expect(t.action((internal as any).albatrossNotifications.mailDigestTick, {})).resolves.toBeNull();
  });
});
