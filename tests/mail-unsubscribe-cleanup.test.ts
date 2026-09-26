import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import './tools/harness';
import { convexTest } from 'convex-test';
import { api } from '../convex/_generated/api';
import schema from '../convex/schema';
import { MAIL_UNDO } from '../lib/mail/mail-operations';
import { blockSender } from '../lib/mail/sender-block';
import { cleanupReason, keptMessageHeaders, rankSendersForCleanup } from '../lib/mail/sender-cleanup';
import { newCleanupBatchId, senderCleanupSummary } from '../lib/mail/sender-cleanup-view';
import {
  parseListUnsubscribe,
  postOneClickUnsubscribe,
  preferredUnsubscribeMethod,
  unsubscribeFromThread,
  unsubscribeTarget,
} from '../lib/mail/unsubscribe';
import { unsubscribeConfirmCopy, unsubscribeResultMessage } from '../lib/mail/unsubscribe-copy';
import { listSmartRules } from '../lib/store/smart-rules';
import { blockSenderTool, listSenderCleanup, unsubscribeSender } from '../lib/tools/mail-senders';
import { invokeTool, ToolValidationError } from '../lib/tools/registry';
import { runTool, seedThreadMessage, toolContext, withToolContext } from './tools/harness';

const SECRET = 'unsubscribe-secret';
let previousSecret: string | undefined;
beforeAll(() => {
  previousSecret = process.env.LAB86_CONVEX_INTERNAL_SECRET;
  process.env.LAB86_CONVEX_INTERNAL_SECRET = SECRET;
});
afterAll(() => {
  if (previousSecret === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
  else process.env.LAB86_CONVEX_INTERNAL_SECRET = previousSecret;
});

describe('List-Unsubscribe parsing (RFC 2369 and RFC 8058)', () => {
  test('one-click needs the Post header and an https address', () => {
    const header = '<mailto:leave@list.example?subject=remove%20me>, <https://list.example/u/abc>';
    expect(parseListUnsubscribe(header, 'List-Unsubscribe=One-Click')).toEqual({
      oneClickUrl: 'https://list.example/u/abc',
      httpUrl: 'https://list.example/u/abc',
      mailto: {
        to: 'leave@list.example',
        subject: 'remove me',
        body: 'Please unsubscribe me from this list.',
      },
    });
    const noPost = parseListUnsubscribe(header, null);
    expect(noPost.oneClickUrl).toBeUndefined();
    expect(preferredUnsubscribeMethod(noPost)).toBe('mailto');
    expect(preferredUnsubscribeMethod(parseListUnsubscribe(header, 'List-Unsubscribe=One-Click'))).toBe(
      'one_click',
    );
    // Plain http is a page to open, never a one-click POST.
    const http = parseListUnsubscribe('<http://list.example/u>', 'List-Unsubscribe=One-Click');
    expect(http).toEqual({ httpUrl: 'http://list.example/u' });
    expect(preferredUnsubscribeMethod(http)).toBe('link');
  });

  test('bare lists, bad entries, and empty headers', () => {
    expect(parseListUnsubscribe('mailto:out@news.example?body=stop', undefined)).toEqual({
      mailto: { to: 'out@news.example', subject: 'unsubscribe', body: 'stop' },
    });
    expect(parseListUnsubscribe('<mailto:not-an-address>, <ftp://x.example>, <%%%>', null)).toEqual({});
    expect(parseListUnsubscribe('', null)).toEqual({});
    expect(preferredUnsubscribeMethod({})).toBeNull();
  });
});

describe('stored headers', () => {
  test('only list and bulk headers are kept', () => {
    expect(
      keptMessageHeaders({
        'List-Unsubscribe': ' <https://x.example/u> ',
        received: 'from a by b',
        'DKIM-Signature': 'v=1',
        precedence: 'bulk',
        'list-id': '',
      }),
    ).toEqual({ 'list-unsubscribe': '<https://x.example/u>', precedence: 'bulk' });
    expect(keptMessageHeaders({ received: 'x' })).toBeUndefined();
    expect(keptMessageHeaders(null)).toBeUndefined();
  });
});

function unsubscribeDeps(headers: Record<string, string> | null, stored: Record<string, string> = {}) {
  return {
    threadMessages: mock(async () => [
      { _id: 'm_sent', from: 'Me <me@example.com>', date: 3, labels: ['SENT'], headers: {} },
      {
        _id: 'm_list',
        from: 'Weekly Deals <deals@shop.example>',
        date: 2,
        labels: ['INBOX'],
        headers: stored,
      },
    ]),
    fetchHeaders: mock(async () => headers),
    storeHeaders: mock(async () => ({ stored: true })),
    postOneClick: mock(async () => ({ status: 200 })),
    sendMail: mock(async () => ({ _id: 'sent_unsub' })),
    record: mock(async () => 'op_unsub'),
  };
}

describe('unsubscribe', () => {
  test('reads missing headers from the provider once and keeps the list lines', async () => {
    const deps = unsubscribeDeps({
      'list-unsubscribe': '<https://shop.example/u/1>',
      'list-unsubscribe-post': 'List-Unsubscribe=One-Click',
      'list-id': 'Deals <deals.shop.example>',
      received: 'x',
    });
    const target = await unsubscribeTarget({ userId: 'u', account: 'a', threadId: 't' }, deps as any);
    expect(target).toMatchObject({
      messageId: 'm_list',
      sender: 'Weekly Deals',
      senderEmail: 'deals@shop.example',
      listId: 'deals.shop.example',
      method: 'one_click',
    });
    expect(deps.fetchHeaders.mock.calls[0]).toEqual([
      { userId: 'u', account: 'a', messageId: 'm_list' },
    ] as any);
    expect((deps.storeHeaders.mock.calls[0] as any)[0]).toEqual({
      userId: 'u',
      accountId: 'a',
      providerMessageId: 'm_list',
      headers: {
        'list-unsubscribe': '<https://shop.example/u/1>',
        'list-unsubscribe-post': 'List-Unsubscribe=One-Click',
        'list-id': 'Deals <deals.shop.example>',
      },
    });
  });

  test('stored headers skip the provider read', async () => {
    const deps = unsubscribeDeps(null, { 'list-unsubscribe': '<mailto:out@shop.example>' });
    const target = await unsubscribeTarget({ userId: 'u', account: 'a', threadId: 't' }, deps as any);
    expect(target.method).toBe('mailto');
    expect(deps.fetchHeaders).not.toHaveBeenCalled();
  });

  test('one-click posts and is recorded in Activity without Undo', async () => {
    const deps = unsubscribeDeps({
      'list-unsubscribe': '<https://shop.example/u/1>',
      'list-unsubscribe-post': 'List-Unsubscribe=One-Click',
    });
    const result = await unsubscribeFromThread(
      { userId: 'u', account: 'a', threadId: 't', batchId: 'b1' },
      deps as any,
    );
    expect(result).toEqual({
      status: 'unsubscribed',
      method: 'one_click',
      sender: 'Weekly Deals',
      operationId: 'op_unsub',
    });
    expect(deps.postOneClick.mock.calls[0]).toEqual(['https://shop.example/u/1'] as any);
    const recorded = (deps.record.mock.calls[0] as any)[0];
    expect(recorded).toMatchObject({
      tool: 'unsubscribe_sender',
      summary: 'Unsubscribed from Weekly Deals',
      reason: 'A one-click unsubscribe request went to shop.example. An unsubscribe cannot be undone.',
      target: { kind: 'sender', id: 'deals@shop.example', accountId: 'a', threadId: 't' },
      batchId: 'b1',
    });
    expect(recorded.inverse).toBeUndefined();
  });

  test('mailto sends a request from the mailbox; a link-only sender returns the page', async () => {
    const mail = unsubscribeDeps({ 'list-unsubscribe': '<mailto:out@shop.example?subject=stop>' });
    const requested = await unsubscribeFromThread({ userId: 'u', account: 'a', threadId: 't' }, mail as any);
    expect(requested).toMatchObject({ status: 'requested', to: 'out@shop.example' });
    expect((mail.sendMail.mock.calls[0] as any)[0]).toEqual({
      userId: 'u',
      account: 'a',
      to: 'out@shop.example',
      subject: 'stop',
      body: 'Please unsubscribe me from this list.',
    });
    expect((mail.record.mock.calls[0] as any)[0].summary).toBe('Asked Weekly Deals to stop sending mail');

    const link = unsubscribeDeps({ 'list-unsubscribe': '<https://shop.example/prefs>' });
    expect(await unsubscribeFromThread({ userId: 'u', account: 'a', threadId: 't' }, link as any)).toEqual({
      status: 'open_link',
      method: 'link',
      sender: 'Weekly Deals',
      url: 'https://shop.example/prefs',
    });
    expect(link.record).not.toHaveBeenCalled();

    const none = unsubscribeDeps({});
    await expect(
      unsubscribeFromThread({ userId: 'u', account: 'a', threadId: 't' }, none as any),
    ).rejects.toThrow('Weekly Deals does not offer a way to unsubscribe. Block the sender instead.');
    await expect(
      unsubscribeFromThread({ userId: 'u', account: 'a', threadId: 't', method: 'one_click' }, link as any),
    ).rejects.toThrow('does not support one-click');
    const disconnected = unsubscribeDeps({ 'list-unsubscribe': '<mailto:out@shop.example>' });
    disconnected.sendMail.mockImplementation(async () => null as any);
    await expect(
      unsubscribeFromThread({ userId: 'u', account: 'a', threadId: 't' }, disconnected as any),
    ).rejects.toThrow('Reconnect this mailbox');
  });

  test('an empty thread has nothing to unsubscribe from', async () => {
    const deps = unsubscribeDeps(null);
    deps.threadMessages.mockImplementation(async () => []);
    await expect(
      unsubscribeTarget({ userId: 'u', account: 'a', threadId: 't' }, deps as any),
    ).rejects.toThrow('no messages');
  });

  test('the one-click POST follows RFC 8058 and never follows a redirect', async () => {
    const fetchImpl = mock(async (_url: any, _init?: any) => new Response('', { status: 202 }));
    const assertUrl = mock(async (url: string) => url);
    expect(await postOneClickUnsubscribe('https://shop.example/u', fetchImpl as any, assertUrl)).toEqual({
      status: 202,
    });
    const [url, init] = fetchImpl.mock.calls[0] as any[];
    expect(url).toBe('https://shop.example/u');
    expect(init).toMatchObject({
      method: 'POST',
      body: 'List-Unsubscribe=One-Click',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    fetchImpl.mockImplementation(async () => new Response('', { status: 500 }));
    await expect(
      postOneClickUnsubscribe('https://shop.example/u', fetchImpl as any, assertUrl),
    ).rejects.toThrow('answered with an error (500)');
    await expect(
      postOneClickUnsubscribe('http://shop.example/u', fetchImpl as any, assertUrl),
    ).rejects.toThrow('https');
    // The real guard refuses private addresses before any request.
    await expect(postOneClickUnsubscribe('https://127.0.0.1/u', fetchImpl as any)).rejects.toThrow(
      'private or reserved',
    );
  });

  test('the tool refuses to run without the confirmation', async () => {
    const { account, threadId } = await seedThreadMessage({ threadId: 'unsub-confirm' });
    await expect(
      invokeTool(unsubscribeSender, { account, threadId }, toolContext({ agent: 'user' })),
    ).rejects.toBeInstanceOf(ToolValidationError);
  });

  test('confirmation copy says where the request goes', () => {
    expect(
      unsubscribeConfirmCopy({ sender: 'Deals', method: 'one_click', destination: 'shop.example' }),
    ).toEqual({
      title: 'Unsubscribe from Deals?',
      description:
        'Albatross sends a one-click unsubscribe request to shop.example. An unsubscribe cannot be undone.',
      confirmLabel: 'Unsubscribe',
      action: 'unsubscribe',
    });
    expect(
      unsubscribeConfirmCopy(
        { sender: 'Deals', method: 'mailto', destination: 'out@shop.example' },
        'me@x.com',
      ).description,
    ).toBe(
      'Albatross sends an email from me@x.com to out@shop.example that asks to take you off the list. An unsubscribe cannot be undone.',
    );
    expect(
      unsubscribeConfirmCopy({ sender: 'Deals', method: 'link', destination: 'shop.example' }).action,
    ).toBe('open_link');
    expect(unsubscribeConfirmCopy({ sender: '', method: null, destination: null })).toMatchObject({
      title: 'this sender has no unsubscribe option',
      action: 'block',
      confirmLabel: 'Block sender',
    });
    expect(unsubscribeResultMessage({ status: 'unsubscribed', sender: 'Deals' })).toBe(
      'Unsubscribed from Deals',
    );
    expect(unsubscribeResultMessage({ status: 'requested', sender: 'Deals' })).toBe(
      'Unsubscribe request sent to Deals',
    );
    expect(unsubscribeResultMessage({ status: 'open_link', sender: 'Deals' })).toBe(
      'Opened the unsubscribe page for Deals',
    );
  });
});

describe('block sender', () => {
  const blockDeps = (rules: any[] = []) => ({
    listRules: mock(async () => rules),
    createRule: mock(async (input: any) => ({ _id: 'rule_new', enabled: true, ...input })),
    reclassify: mock(async () => ({})),
    inboxThreads: mock(async () => [
      { accountId: 'a', threadId: 't1' },
      { accountId: 'a', threadId: 't2' },
      { accountId: 'a', threadId: 't3' },
    ]),
    moveThread: mock(async ({ threadId }: any): Promise<any> => {
      if (threadId === 't3') throw new Error('rate limited');
      return threadId === 't2'
        ? { ok: true, before: ['X'], after: ['X'] }
        : { ok: true, before: ['INBOX'], after: [] };
    }),
    record: mock(async () => 'op_block'),
  });

  test('creates an always-Noise rule, archives inbox threads, and records one undo', async () => {
    const deps = blockDeps();
    const result = await blockSender({ userId: 'u', sender: 'Deals <DEALS@shop.example>' }, deps as any);
    expect(result).toEqual({
      ok: false,
      sender: 'deals@shop.example',
      ruleId: 'rule_new',
      archived: 1,
      failed: 1,
      operationId: 'op_block',
    });
    expect((deps.createRule.mock.calls[0] as any)[0]).toMatchObject({
      scope: 'sender',
      match: 'deals@shop.example',
      effect: 'always_noise',
    });
    expect(deps.reclassify.mock.calls[0]).toEqual([
      'u',
      { scope: 'sender', match: 'deals@shop.example' },
    ] as any);
    const recorded = (deps.record.mock.calls[0] as any)[0];
    expect(recorded).toMatchObject({
      tool: 'block_sender',
      summary: 'Blocked deals@shop.example',
      reason: 'Mail from deals@shop.example goes to Noise from now on, and 1 thread left the inbox.',
      inverse: {
        kind: MAIL_UNDO.unblockSender,
        payload: {
          ruleId: 'rule_new',
          scope: 'sender',
          match: 'deals@shop.example',
          threads: [{ account: 'a', threadId: 't1', before: ['INBOX'], after: [] }],
        },
      },
    });
  });

  test('an existing block is reused and its undo only brings the threads back', async () => {
    const deps = blockDeps([
      {
        _id: 'rule_old',
        enabled: true,
        scope: 'sender',
        match: 'deals@shop.example',
        effect: 'always_noise',
      },
    ]);
    const result = await blockSender(
      { userId: 'u', sender: 'deals@shop.example', archiveExisting: true },
      deps as any,
    );
    expect(result.ruleId).toBe('rule_old');
    expect(deps.createRule).not.toHaveBeenCalled();
    expect((deps.record.mock.calls[0] as any)[0].inverse.kind).toBe(MAIL_UNDO.threadFolders);

    const quiet = blockDeps([
      {
        _id: 'rule_old',
        enabled: true,
        scope: 'sender',
        match: 'deals@shop.example',
        effect: 'always_noise',
      },
    ]);
    await blockSender({ userId: 'u', sender: 'deals@shop.example', archiveExisting: false }, quiet as any);
    expect(quiet.inboxThreads).not.toHaveBeenCalled();
    expect((quiet.record.mock.calls[0] as any)[0].inverse).toBeUndefined();
    await expect(blockSender({ userId: 'u', sender: 'nobody' }, quiet as any)).rejects.toThrow(
      'Choose a sender address',
    );
  });

  test('the tool blocks the sender of a thread', async () => {
    const { account, threadId } = await seedThreadMessage({
      threadId: 'block-thread',
      from: 'Promo <promo@shop.example>',
    });
    const result = await runTool(blockSenderTool.handler, { account, threadId });
    expect(result).toMatchObject({ sender: 'promo@shop.example', archived: 0 });
    const rules = await withToolContext(() => listSmartRules());
    expect(rules.some((rule) => rule.match === 'promo@shop.example' && rule.effect === 'always_noise')).toBe(
      true,
    );
    await expect(runTool(blockSenderTool.handler, { account, threadId: 'no-such-thread' })).rejects.toThrow(
      'Could not find the sender',
    );
    // Without a hosted corpus there is no sender list.
    expect(await runTool(listSenderCleanup.handler, {})).toEqual({ senders: [], scanned: 0 });
  });
});

describe('sender cleanup ranking', () => {
  const thread = (overrides: Record<string, unknown>) => ({
    accountId: 'a',
    providerThreadId: `t${Math.random()}`,
    fromAddress: 'Deals <deals@shop.example>',
    subject: 'Sale',
    lastDate: 1,
    unread: true,
    labels: ['INBOX'],
    smartPrimary: 'noise',
    ...overrides,
  });

  test('ranks low-value senders and leaves out the user and one-off senders', () => {
    const rows = rankSendersForCleanup(
      [
        thread({ lastDate: 5, providerThreadId: 'deals-new', subject: 'Newest sale' }),
        thread({ lastDate: 3 }),
        thread({ lastDate: 2, unread: false, smartPrimary: 'main' }),
        thread({
          fromAddress: 'News <news@paper.example>',
          smartPrimary: 'main',
          jev: { purpose: 'newsletter' },
        }),
        thread({ fromAddress: 'News <news@paper.example>', smartPrimary: 'main', unread: false }),
        thread({ fromAddress: 'Me <me@example.com>' }),
        thread({ fromAddress: 'Me <me@example.com>' }),
        thread({ fromAddress: 'Once <once@x.example>' }),
        thread({ fromAddress: 'Friend <friend@x.example>', smartPrimary: 'main' }),
        thread({ fromAddress: 'Friend <friend@x.example>', smartPrimary: 'main' }),
        thread({ fromAddress: 'Sent <s@x.example>', labels: ['SENT'] }),
        thread({ fromAddress: 'Sent <s@x.example>', labels: ['SENT'] }),
      ],
      { selfEmails: ['ME@example.com'] },
    );
    expect(rows.map((row) => row.sender)).toEqual(['deals@shop.example', 'news@paper.example']);
    expect(rows[0]).toMatchObject({
      name: 'Deals',
      threads: 3,
      unread: 2,
      inInbox: 3,
      lowValue: 2,
      lastDate: 5,
      latest: { threadId: 'deals-new', subject: 'Newest sale' },
      reason: '3 threads, 2 unopened, 2 sorted as Noise or promotions',
    });
    expect(cleanupReason({ threads: 2, unread: 2, lowValue: 2 })).toBe(
      '2 threads, none opened, all sorted as Noise or promotions',
    );
    expect(rankSendersForCleanup([thread({}), thread({})], { limit: 0 })).toHaveLength(1);
  });

  test('batch block summary and batch ids', () => {
    expect(senderCleanupSummary({ blocked: ['a@x.example'], failed: [], archived: 1 })).toEqual({
      success: 'Blocked a@x.example. 1 thread left the inbox.',
      error: null,
    });
    expect(senderCleanupSummary({ blocked: ['a', 'b'], failed: ['c', 'd'], archived: 0 })).toEqual({
      success: 'Blocked 2 senders.',
      error: 'Could not block 2 senders. Try again.',
    });
    expect(newCleanupBatchId()).toMatch(/^batch_[0-9a-f-]{36}$/);
  });
});

describe('Convex reads for cleanup, block, and voice', () => {
  const modules = {
    '../convex/_generated/api.js': () => import('../convex/_generated/api.js'),
    '../convex/mailCorpus.ts': () => import('../convex/mailCorpus'),
  };
  const base = { userId: 'u1', accountId: 'acct', grantId: 'g', provider: 'google' as const };
  const ts = 1_760_000_000_000;

  async function seed() {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert('connectedAccounts', {
        userId: 'u1',
        accountId: 'acct',
        email: 'me@example.com',
        provider: 'google',
        status: 'connected',
        scopes: [],
        grantId: 'g',
        createdAt: ts,
        updatedAt: ts,
      });
      const threads = [
        ['t1', 'Deals <deals@shop.example>', ['INBOX'], 'noise'],
        ['t2', 'Deals <deals@shop.example>', ['INBOX'], 'noise'],
        ['t3', 'Deals <deals@shop.example>', ['Label_1'], 'noise'],
        ['t4', 'Joanne <jo.deals@shop.example>', ['INBOX'], 'main'],
      ] as const;
      for (const [index, [id, from, labels, primary]] of threads.entries()) {
        await ctx.db.insert('mailCorpusThreads', {
          ...base,
          providerThreadId: id,
          subject: `Subject ${id}`,
          fromAddress: from,
          lastDate: ts + index,
          snippet: '',
          labels: [...labels],
          unread: true,
          smartPrimary: primary,
          yearMonth: '2025-10',
          createdAt: ts,
          updatedAt: ts,
        });
      }
      for (const [index, from] of ['Me <me@example.com>', 'Deals <deals@shop.example>'].entries()) {
        await ctx.db.insert('mailCorpusMessages', {
          ...base,
          providerMessageId: `m${index}`,
          providerThreadId: 't1',
          subject: 'Hello',
          from,
          to: 'x@example.com',
          receivedAt: ts + index,
          snippet: 'snippet',
          textBody: index === 0 ? 'Hi Ann,\n\nSounds good.\n\nBest,\nMe' : 'Sale',
          searchText: 'hello',
          labels: index === 0 ? ['SENT'] : ['INBOX'],
          headers: {},
          yearMonth: '2025-10',
          createdAt: ts,
          updatedAt: ts,
        });
      }
    });
    return t;
  }

  test('cleanup candidates, inbox threads from a sender, sent mail, and stored headers', async () => {
    const t = await seed();
    const args = { internalSecret: SECRET, userId: 'u1' };
    const cleanup = await t.query((api as any).mailCorpus.senderCleanupCandidates, args);
    expect(cleanup.scanned).toBe(4);
    expect(cleanup.senders.map((row: any) => [row.sender, row.threads])).toEqual([['deals@shop.example', 3]]);

    const inbox = await t.query((api as any).mailCorpus.inboxThreadsFromSender, {
      ...args,
      sender: 'deals@shop.example',
    });
    expect(inbox.threads.map((row: any) => row.threadId).sort()).toEqual(['t1', 't2']);

    const sent = await t.query((api as any).mailCorpus.recentSentMessages, args);
    expect(sent.messages).toEqual([
      {
        subject: 'Hello',
        to: 'x@example.com',
        receivedAt: ts,
        textBody: 'Hi Ann,\n\nSounds good.\n\nBest,\nMe',
      },
    ]);

    expect(
      await t.mutation((api as any).mailCorpus.setMessageListHeaders, {
        ...args,
        accountId: 'acct',
        providerMessageId: 'm1',
        headers: { 'list-unsubscribe': '<https://shop.example/u>', received: 'x' },
      }),
    ).toEqual({ stored: true });
    const row = await t.run(async (ctx) =>
      ctx.db
        .query('mailCorpusMessages')
        .withIndex('by_account_message', (q) => q.eq('accountId', 'acct').eq('providerMessageId', 'm1'))
        .first(),
    );
    expect(row?.headers).toEqual({ 'list-unsubscribe': '<https://shop.example/u>' });
    expect(
      await t.mutation((api as any).mailCorpus.setMessageListHeaders, {
        ...args,
        accountId: 'acct',
        providerMessageId: 'missing',
        headers: {},
      }),
    ).toEqual({ stored: false });
  });
});

describe('risk and approval', () => {
  test('the assistant must get approval before it unsubscribes', async () => {
    const { APPROVAL_GATED_TOOLS, approvalSummary, toolNeedsApproval } = await import('../lib/ai/approval');
    const { AGENT_TOOL_NAMES } = await import('../lib/ai/loop');
    expect(APPROVAL_GATED_TOOLS.has('unsubscribe_sender')).toBe(true);
    expect(AGENT_TOOL_NAMES.has('unsubscribe_sender')).toBe(true);
    expect(toolNeedsApproval('unsubscribe_sender', { account: 'a', threadId: 't', confirmed: true })).toBe(
      true,
    );
    expect(approvalSummary('unsubscribe_sender', { account: 'me@example.com', method: 'mailto' })).toEqual({
      title: 'Unsubscribe from this mailing list',
      description: 'The sender gets an unsubscribe request. This cannot be undone.',
      metadata: [
        { label: 'How', value: 'An email from your mailbox' },
        { label: 'Mailbox', value: 'me@example.com' },
      ],
      confirmLabel: 'Unsubscribe',
      denyLabel: 'Keep getting it',
      intent: 'destructive',
    });
    expect(approvalSummary('unsubscribe_sender', {}).metadata[0]).toEqual({
      label: 'How',
      value: 'The way the sender offers',
    });
  });

  test('every new mail tool that changes something declares its risk', async () => {
    const { TOOLS } = await import('../lib/tools');
    const expected: Record<string, string> = {
      bulk_move_threads: 'write_self',
      bulk_triage: 'write_self',
      block_sender: 'write_self',
      unsubscribe_sender: 'reach_person',
      set_signature: 'write_self',
      save_saved_reply: 'write_self',
      delete_saved_reply: 'destructive',
    };
    for (const [name, risk] of Object.entries(expected)) {
      expect(TOOLS[name]?.mutating).toBe(true);
      expect(TOOLS[name]?.risk).toBe(risk as any);
    }
  });
});
