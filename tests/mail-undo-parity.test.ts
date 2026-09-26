import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import './tools/harness';
import { convexTest } from 'convex-test';
import { toastWithUndo } from '../components/inbox/mail-undo-toast';
import { api } from '../convex/_generated/api';
import schema from '../convex/schema';
import { runWithAiRequestContext } from '../lib/ai/context';
import { undoOperation } from '../lib/ai/operations';
import {
  changedFolders,
  createMailUndoExecutors,
  MAIL_UNDO,
  mailOperationReason,
  mapLimit,
  quotedSubject,
  recordMailOperation,
} from '../lib/mail/mail-operations';
import { consumeOneTimeCode } from '../lib/mail/one-time-code-cleanup';
import { revertedFolderIds } from '../lib/nylas/provider';
import { runBulkMove } from '../lib/shell/bulk-mail';
import { runBulkTriage } from '../lib/shell/bulk-triage';
import { getThread } from '../lib/store/threads';
import { saveBulkTriageVerdicts } from '../lib/tools/ai';
import {
  addLabel,
  applySmartLabels,
  archiveThread,
  bulkMoveThreads,
  muteThread,
  removeLabel,
  restoreFromTrash,
  snoozeThreadTool,
  trashThread,
} from '../lib/tools/mail-mutate';
import { applySmartCorrection, createSmartRule, describeSmartRule } from '../lib/tools/smart-labels';
import { runTool, seedThreadMessage, withToolContext } from './tools/harness';
import { accountRow, type HttpHarness, withHttpHarness } from './tools/http-harness';

const SECRET = 'mail-undo-secret';
let previousSecret: string | undefined;
beforeEach(() => {
  previousSecret = process.env.LAB86_CONVEX_INTERNAL_SECRET;
  process.env.LAB86_CONVEX_INTERNAL_SECRET = SECRET;
});
afterEach(() => {
  if (previousSecret === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
  else process.env.LAB86_CONVEX_INTERNAL_SECRET = previousSecret;
});

/** A Gmail thread whose folders change on every PUT, like the provider. */
function gmailThreads(h: HttpHarness, initial: Record<string, string[]>) {
  const folders = new Map(Object.entries(initial));
  h.onConvex('accounts:getConnectedAccount', () => accountRow({ userId: 'test_user_tools' }));
  h.onNylas('GET', /\/v3\/grants\/grant_1\/folders$/, () => ({
    json: {
      data: [
        { id: 'INBOX', name: 'INBOX', attributes: ['\\Inbox'] },
        { id: 'TRASH', name: 'TRASH', attributes: ['\\Trash'] },
        { id: 'Label_x', name: 'Receipts' },
      ],
    },
  }));
  h.onNylas('GET', /\/v3\/grants\/grant_1\/threads\/[^/]+$/, ({ path }) => {
    const id = path.split('/').pop() as string;
    if (!folders.has(id)) return { status: 404, json: { error: { type: 'not_found', message: 'gone' } } };
    return { json: { data: { id, folders: folders.get(id) } } };
  });
  h.onNylas('PUT', /\/v3\/grants\/grant_1\/threads\/[^/]+$/, ({ path, body }) => {
    const id = path.split('/').pop() as string;
    folders.set(id, body.folders);
    return { json: { data: { id, folders: body.folders } } };
  });
  h.onConvex('mailCorpus:getCorpusThread', (args) => ({
    _id: args.providerThreadId,
    subject: args.providerThreadId === 't1' ? 'Quarterly plan' : 'Other',
    fromAddress: 'Ann <ann@example.com>',
    labels: ['INBOX'],
  }));
  h.onConvex('userData:getDoc', () => null);
  const recorded: any[] = [];
  h.onConvex('operations:record', (args) => {
    recorded.push(args);
    return `op_${recorded.length}`;
  });
  return { folders, recorded };
}

describe('provider folder reversal', () => {
  test('Gmail undo takes back only its own change and keeps later labels', () => {
    const change = { before: ['INBOX', 'Label_1'], after: ['Label_1'] };
    expect(revertedFolderIds('google', ['Label_1', 'Label_later'], change)).toEqual([
      'Label_1',
      'Label_later',
      'INBOX',
    ]);
    // A label the change added comes off; one it removed comes back.
    expect(
      revertedFolderIds('google', ['INBOX', 'MUTE'], { before: ['INBOX'], after: ['INBOX', 'MUTE'] }),
    ).toEqual(['INBOX']);
  });

  test('one-folder providers go back to the folder they left, the inbox first', () => {
    expect(
      revertedFolderIds('microsoft', ['AAMk-archive'], { before: ['AAMk-inbox'], after: ['AAMk-archive'] }),
    ).toEqual(['AAMk-inbox']);
    expect(
      revertedFolderIds(
        'microsoft',
        ['AAMk-archive'],
        { before: ['AAMk-sent', 'AAMk-inbox'], after: ['AAMk-archive'] },
        'AAMk-inbox',
      ),
    ).toEqual(['AAMk-inbox']);
    expect(revertedFolderIds('icloud', ['X', 'MUTE'], { before: ['X'], after: ['X', 'MUTE'] })).toEqual([
      'X',
    ]);
  });

  test('no-op changes record nothing', () => {
    expect(changedFolders({ before: ['A', 'B'], after: ['B', 'A'] })).toBe(false);
    expect(changedFolders({ before: ['A'], after: [] })).toBe(true);
  });
});

describe('mail tools record undoable operations', () => {
  test('archive records the subject, a reason for agent calls, and a folder inverse', async () => {
    await withHttpHarness(async (h) => {
      const { recorded } = gmailThreads(h, { t1: ['INBOX', 'UNREAD', 'Label_9'] });
      const result = await runTool(
        archiveThread.handler,
        { account: 'acct_1', threadId: 't1', reason: 'The meeting it asked about is over.' },
        { agent: 'ai', operationBatchId: 'batch_1' },
      );
      expect(result).toEqual({ ok: true, operationId: 'op_1' });
      expect(recorded[0]).toMatchObject({
        userId: 'test_user_tools',
        agent: 'ai',
        tool: 'archive_thread',
        surface: 'mail',
        summary: 'Archived "Quarterly plan"',
        reason: 'The meeting it asked about is over.',
        batchId: 'batch_1',
        target: { kind: 'thread', id: 't1', accountId: 'acct_1' },
        inverse: {
          kind: MAIL_UNDO.threadFolders,
          payload: {
            threads: [
              {
                account: 'acct_1',
                threadId: 't1',
                before: ['INBOX', 'UNREAD', 'Label_9'],
                after: ['UNREAD', 'Label_9'],
              },
            ],
          },
        },
      });
    });
  });

  test('trash then undo through the operations log puts the thread back', async () => {
    await withHttpHarness(async (h) => {
      const { folders, recorded } = gmailThreads(h, { t1: ['INBOX', 'Label_9'] });
      const trashed = await runTool(trashThread.handler, { account: 'acct_1', threadId: 't1' });
      expect(trashed.operationId).toBe('op_1');
      expect(folders.get('t1')).toEqual(['Label_9', 'TRASH']);
      expect(recorded[0].summary).toBe('Moved "Quarterly plan" to Trash');
      expect(recorded[0].reason).toBeUndefined();

      // The user adds a label after the trash; undo must keep it.
      folders.set('t1', ['Label_9', 'TRASH', 'Label_new']);
      h.onConvex('operations:claimUndo', () => ({
        state: 'claimed',
        tool: 'trash_thread',
        surface: 'mail',
        summary: recorded[0].summary,
        inverse: recorded[0].inverse,
      }));
      let completed = false;
      h.onConvex('operations:completeUndo', () => {
        completed = true;
        return null;
      });
      const undone = await undoOperation('test_user_tools', 'op_1');
      expect(undone).toEqual({ undone: 'Moved "Quarterly plan" to Trash', surface: 'mail' });
      expect(completed).toBe(true);
      expect(folders.get('t1')).toEqual(['Label_9', 'Label_new', 'INBOX']);
    });
  });

  test('restore records a move back to the inbox', async () => {
    await withHttpHarness(async (h) => {
      const { recorded } = gmailThreads(h, { t1: ['TRASH'] });
      await runTool(restoreFromTrash.handler, { account: 'acct_1', threadId: 't1' });
      expect(recorded[0].summary).toBe('Moved "Quarterly plan" back to the inbox');
    });
  });

  test('a move that changes nothing records nothing', async () => {
    await withHttpHarness(async (h) => {
      const { recorded } = gmailThreads(h, { t1: ['Label_9'] });
      const result = await runTool(archiveThread.handler, { account: 'acct_1', threadId: 't1' });
      expect(result).toEqual({ ok: true, operationId: undefined });
      expect(recorded).toEqual([]);
    });
  });

  test('bulk moves record one operation for the threads that moved', async () => {
    await withHttpHarness(async (h) => {
      const { recorded } = gmailThreads(h, { t1: ['INBOX'], t2: ['INBOX', 'Label_2'] });
      const result = await runTool(bulkMoveThreads.handler, {
        to: 'archive',
        items: [
          { account: 'acct_1', threadId: 't1' },
          { account: 'acct_1', threadId: 't2' },
          { account: 'acct_1', threadId: 't2' },
          { account: 'acct_1', threadId: 'gone' },
        ],
      });
      expect(result.ok).toBe(false);
      expect(result.moved).toEqual([
        { account: 'acct_1', threadId: 't1' },
        { account: 'acct_1', threadId: 't2' },
      ]);
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0].threadId).toBe('gone');
      expect(result.operationId).toBe('op_1');
      expect(recorded).toHaveLength(1);
      expect(recorded[0].summary).toBe('Archived 2 threads');
      expect(recorded[0].target).toMatchObject({
        kind: 'threads',
        count: 2,
        ids: ['acct_1:t1', 'acct_1:t2'],
      });
      expect(recorded[0].inverse.payload.threads).toHaveLength(2);
    });
  });

  test('labels record a message folder inverse', async () => {
    await withHttpHarness(async (h) => {
      const { recorded } = gmailThreads(h, {});
      h.onNylas('GET', /\/v3\/grants\/grant_1\/messages\/m1$/, () => ({
        json: { data: { id: 'm1', folders: ['INBOX'] } },
      }));
      h.onNylas('PUT', /\/v3\/grants\/grant_1\/messages\/m1$/, () => ({ json: { data: { id: 'm1' } } }));
      const result = await runTool(addLabel.handler, {
        account: 'acct_1',
        messageId: 'm1',
        label: 'Receipts',
      });
      expect(result.operationId).toBe('op_1');
      expect(recorded[0]).toMatchObject({
        summary: 'Added the label "Receipts" to a message',
        inverse: {
          kind: MAIL_UNDO.messageFolders,
          payload: { account: 'acct_1', messageId: 'm1', before: ['INBOX'], after: ['INBOX', 'Label_x'] },
        },
      });
    });
  });

  test('remove label, mute, and smart labels each record a folder inverse', async () => {
    await withHttpHarness(async (h) => {
      const { folders, recorded } = gmailThreads(h, { t1: ['INBOX'], t2: ['INBOX'] });
      const messageFolders = new Map([['m9', ['INBOX', 'Label_x']]]);
      h.onNylas('GET', /\/v3\/grants\/grant_1\/messages\/[^/]+$/, ({ path }) => {
        const id = path.split('/').pop() as string;
        return { json: { data: { id, folders: messageFolders.get(id) || ['INBOX'] } } };
      });
      h.onNylas('PUT', /\/v3\/grants\/grant_1\/messages\/[^/]+$/, ({ path, body }) => {
        messageFolders.set(path.split('/').pop() as string, body.folders);
        return { json: { data: { id: 'm' } } };
      });
      h.onNylas('POST', /\/v3\/grants\/grant_1\/folders$/, ({ body }) => ({
        json: { data: { id: `Label_${body.name}`, name: body.name } },
      }));
      h.onConvex('userData:upsertDoc', () => ({ ok: true }));

      const removed = await runTool(removeLabel.handler, {
        account: 'acct_1',
        messageId: 'm9',
        label: 'Receipts',
      });
      expect(removed.operationId).toBe('op_1');
      expect(recorded[0]).toMatchObject({
        summary: 'Removed the label "Receipts"',
        inverse: { payload: { before: ['INBOX', 'Label_x'], after: ['INBOX'] } },
      });

      const muted = await runTool(muteThread.handler, { account: 'acct_1', threadId: 't1' }, { agent: 'ai' });
      expect(muted.operationId).toBe('op_2');
      expect(folders.get('t1')).toEqual(['INBOX', 'MUTE']);
      expect(recorded[1]).toMatchObject({
        summary: 'Muted "Quarterly plan"',
        reason: 'Albatross did this while working on your request.',
      });

      const labeled = await runTool(applySmartLabels.handler, {
        account: 'acct_1',
        items: [
          { threadId: 't2', labels: ['MailOS/Receipts'] },
          { threadId: 't2', messageId: 'm10', labels: ['MailOS/Receipts'] },
        ],
      });
      expect(labeled).toMatchObject({ ok: true, applied: 2, operationId: 'op_3' });
      expect(recorded[2]).toMatchObject({
        summary: 'Applied labels to 1 thread and 1 message',
        reason: 'Labels: MailOS/Receipts',
        target: { kind: 'threads', count: 2, accountId: 'acct_1' },
        inverse: { kind: MAIL_UNDO.threadFolders },
      });
      expect(recorded[2].inverse.payload.threads).toHaveLength(1);
      expect(recorded[2].inverse.payload.messages).toHaveLength(1);
    });
  }, 15_000);

  test('snooze records the wake time in the user zone and an unsnooze inverse', async () => {
    await withHttpHarness(async (h) => {
      const { recorded } = gmailThreads(h, { t1: ['INBOX'] });
      h.onConvex('mailCorpus:createSnooze', () => 'snooze_1');
      const untilTs = Date.parse('2030-10-04T13:00:00.000Z');
      const result = await runTool(snoozeThreadTool.handler, { account: 'acct_1', threadId: 't1', untilTs });
      expect(result.operationId).toBe('op_1');
      expect(recorded[0].summary).toBe('Snoozed "Quarterly plan" until Fri, Oct 4, 9:00 AM');
      expect(recorded[0].inverse).toEqual({
        kind: MAIL_UNDO.unsnooze,
        payload: { account: 'acct_1', threadId: 't1' },
      });
    });
  });
});

describe('smart rule moves', () => {
  test('describes what a rule does in plain words', () => {
    expect(describeSmartRule({ scope: 'sender', match: 'deals@shop.com', effect: 'always_noise' })).toBe(
      'mail from deals@shop.com goes to Noise',
    );
    expect(
      describeSmartRule({
        scope: 'domain',
        match: 'shop.com',
        effect: 'always_category',
        category: 'orders',
      }),
    ).toBe('mail from @shop.com goes to Orders');
    expect(
      describeSmartRule({ scope: 'subject_pattern', match: 'weekly', effect: 'always_custom_label' }, 'News'),
    ).toBe('mail with "weekly" in the subject gets the label "News"');
    expect(describeSmartRule({ scope: 'thread', match: 't', effect: 'never_main' })).toBe(
      'this thread stays out of Main',
    );
  });

  function fakeUserData(h: HttpHarness) {
    const docs = new Map<string, any>();
    h.onConvex('userData:getDoc', (args) => {
      const doc = docs.get(`${args.kind}:${args.key}`);
      return doc ? { key: args.key, doc, updatedAt: 1 } : null;
    });
    h.onConvex('userData:listDocs', (args) =>
      [...docs.entries()]
        .filter(([key]) => key.startsWith(`${args.kind}:`))
        .map(([key, doc]) => ({ key: key.split(':').slice(1).join(':'), doc, updatedAt: 1 })),
    );
    h.onConvex('userData:upsertDoc', (args) => {
      docs.set(`${args.kind}:${args.key}`, args.doc);
      return { ok: true };
    });
    h.onConvex('smart:reclassifyMatchingThreads', () => ({ patched: 1 }));
    return docs;
  }

  test('a quick correction records a rule operation whose undo turns the rule off', async () => {
    await withHttpHarness(async (h) => {
      const docs = fakeUserData(h);
      const { recorded } = gmailThreads(h, {});
      h.onConvex('mailCorpus:getCorpusThread', () => ({
        _id: 't9',
        subject: 'Weekend sale',
        fromAddress: 'Shop <deals@shop.com>',
        labels: ['INBOX'],
      }));
      h.onConvex('userData:getDoc', (args) => {
        const doc = docs.get(`${args.kind}:${args.key}`);
        return doc ? { key: args.key, doc, updatedAt: 1 } : null;
      });
      const result = await runTool(applySmartCorrection.handler, {
        account: 'acct_1',
        threadId: 't9',
        action: 'always_noise',
      });
      expect(result.operationId).toBe('op_1');
      expect(recorded[0]).toMatchObject({
        tool: 'apply_smart_correction',
        summary: 'New rule: mail from deals@shop.com goes to Noise',
        reason: 'You corrected where "Weekend sale" belongs.',
        inverse: {
          kind: MAIL_UNDO.disableRule,
          payload: { ruleId: result.rule._id, scope: 'sender', match: 'deals@shop.com' },
        },
      });

      h.onConvex('operations:claimUndo', () => ({
        state: 'claimed',
        tool: 'apply_smart_correction',
        surface: 'mail',
        summary: recorded[0].summary,
        inverse: recorded[0].inverse,
      }));
      h.onConvex('operations:completeUndo', () => null);
      await undoOperation('test_user_tools', 'op_1');
      expect(docs.get(`smartRule:${result.rule._id}`).enabled).toBe(false);
      const reclassifies = h.convexCalls.filter((call) => call.path === 'smart:reclassifyMatchingThreads');
      expect(reclassifies.length).toBe(2);
    });
  });

  test('create_smart_rule applies the rule now and records the agent reason', async () => {
    await withHttpHarness(async (h) => {
      fakeUserData(h);
      const { recorded } = gmailThreads(h, {});
      const result = await runTool(
        createSmartRule.handler,
        {
          name: 'Receipts',
          scope: 'domain',
          match: 'stripe.com',
          effect: 'always_category',
          category: 'finance_admin',
          reason: 'You asked to file Stripe mail under finance.',
        },
        { agent: 'ai' },
      );
      expect(result.operationId).toBe('op_1');
      expect(recorded[0].summary).toBe('New rule: mail from @stripe.com goes to Finance/Admin');
      expect(recorded[0].reason).toBe('You asked to file Stripe mail under finance.');
      expect(h.convexCalls.some((call) => call.path === 'smart:reclassifyMatchingThreads')).toBe(true);
    });
  });
});

describe('mail undo executors', () => {
  const deps = () => ({
    revertThread: mock(async (_input: any): Promise<any> => ({ ok: true })),
    revertMessage: mock(async (_input: any): Promise<any> => ({ ok: true })),
    unsnooze: mock(async (_input: any): Promise<any> => ({ restored: 1 })),
    disableRule: mock(async (_id: string): Promise<any> => ({})),
    reclassify: mock(async (): Promise<any> => ({})),
    replaceTriage: mock(async (): Promise<any> => undefined),
  });

  test('thread and message changes revert, and a partial failure says how many', async () => {
    const d = deps();
    const executors = createMailUndoExecutors(d as any);
    await executors[MAIL_UNDO.threadFolders](
      {
        threads: [{ account: 'a', threadId: 't1', before: ['INBOX'], after: [] }],
        messages: [{ account: 'a', messageId: 'm1', before: [], after: ['L'] }],
      },
      { userId: 'u' },
    );
    expect(d.revertThread.mock.calls[0][0]).toEqual({
      userId: 'u',
      account: 'a',
      threadId: 't1',
      before: ['INBOX'],
      after: [],
    });
    expect(d.revertMessage.mock.calls[0][0]).toMatchObject({ userId: 'u', messageId: 'm1' });

    d.revertThread.mockImplementation(async (input: any) => {
      if (input.threadId === 't2') throw new Error('rate limited');
      return { ok: true };
    });
    await expect(
      executors[MAIL_UNDO.threadFolders](
        {
          threads: [
            { account: 'a', threadId: 't1', before: ['INBOX'], after: [] },
            { account: 'a', threadId: 't2', before: ['INBOX'], after: [] },
          ],
        },
        { userId: 'u' },
      ),
    ).rejects.toThrow('Restored 1 of 2 threads. 1 could not be restored.');
    d.revertThread.mockImplementation(async () => null);
    await expect(
      executors[MAIL_UNDO.threadFolders](
        { threads: [{ account: 'a', threadId: 't1', before: [], after: [] }] },
        { userId: 'u' },
      ),
    ).rejects.toThrow('Could not restore the thread.');
    d.revertMessage.mockImplementation(async () => null);
    await expect(
      executors[MAIL_UNDO.messageFolders](
        { account: 'a', messageId: 'm1', before: [], after: [] },
        { userId: 'u' },
      ),
    ).rejects.toThrow('Connected Nylas account not found.');
    await expect(executors[MAIL_UNDO.messageFolders]({} as any, { userId: 'u' })).rejects.toThrow(
      'messageId required.',
    );
  });

  test('unsnooze, rule, triage, and unblock inverses each run their store change', async () => {
    const d = deps();
    const executors = createMailUndoExecutors(d as any);
    await executors[MAIL_UNDO.unsnooze]({ account: 'a', threadId: 't' }, { userId: 'u' });
    expect(d.unsnooze.mock.calls[0][0]).toEqual({ userId: 'u', account: 'a', threadId: 't' });
    await expect(executors[MAIL_UNDO.unsnooze]({} as any, { userId: 'u' })).rejects.toThrow('threadId');

    await executors[MAIL_UNDO.disableRule](
      { ruleId: 'r1', scope: 'sender', match: 'x@y.z' },
      { userId: 'u' },
    );
    expect(d.disableRule.mock.calls[0][0]).toBe('r1');
    expect(d.reclassify.mock.calls[0]).toEqual([
      'u',
      { ruleId: 'r1', scope: 'sender', match: 'x@y.z' },
    ] as any);
    await expect(executors[MAIL_UNDO.disableRule]({} as any, { userId: 'u' })).rejects.toThrow('ruleId');

    await executors[MAIL_UNDO.restoreTriage](
      { items: [{ account: 'a', threadId: 't', previous: null }] },
      { userId: 'u' },
    );
    expect(d.replaceTriage.mock.calls[0]).toEqual(['a', 't', null] as any);

    d.reclassify.mockImplementation(async () => {
      throw new Error('convex busy');
    });
    await executors[MAIL_UNDO.unblockSender](
      {
        ruleId: 'r2',
        scope: 'sender',
        match: 'x@y.z',
        threads: [{ account: 'a', threadId: 't3', before: ['INBOX'], after: [] }],
      },
      { userId: 'u' },
    );
    expect(d.disableRule.mock.calls[1][0]).toBe('r2');
    expect(d.revertThread.mock.calls.at(-1)?.[0]).toMatchObject({ threadId: 't3' });
  });
});

describe('bulk triage undo', () => {
  test('saving verdicts captures the previous verdict, and undo restores it', async () => {
    const { account, threadId } = await seedThreadMessage({ threadId: 'triage-undo-1', messageId: 'tu-m1' });
    const changes: any[] = [];
    const saved = await withToolContext(() =>
      saveBulkTriageVerdicts(
        [{ id: threadId, account }],
        [{ id: threadId, priority: 1, action: 'reply', reason: 'Asks for a date' }],
        changes,
      ),
    );
    expect(saved).toBe(1);
    expect(changes).toEqual([{ account, threadId, previous: null }]);
    await createMailUndoExecutors()[MAIL_UNDO.restoreTriage](
      { items: changes },
      { userId: 'test_user_tools' },
    );
    const thread = await withToolContext(() => getThread(account, threadId));
    expect(thread?.triage ?? null).toBeNull();
  });

  test('the triage run collects one operation id per saved group', async () => {
    const outcome = await runBulkTriage([{ id: 'a' }, { id: 'b' }], async (group) => ({
      verdicts: group,
      model: 'fast',
      saved: group.length,
      operationId: 'op_t',
    }));
    expect(outcome.operationIds).toEqual(['op_t']);
  });
});

describe('operation plumbing', () => {
  test('recording is skipped without a user, and uses the injected recorder otherwise', async () => {
    const recorder = mock(async (_input: any) => 'op_x');
    expect(
      await recordMailOperation({ userId: null, tool: 't', summary: 's', target: {} }, recorder as any),
    ).toBeUndefined();
    expect(
      await recordMailOperation(
        { userId: 'u', tool: 't', summary: 'x'.repeat(400), reason: '  why  ', target: {} },
        recorder as any,
      ),
    ).toBe('op_x');
    expect(recorder.mock.calls[0][0].summary).toHaveLength(240);
    expect(recorder.mock.calls[0][0].reason).toBe('why');
    // No hosted Convex: nothing to write to, and the change itself stands.
    expect(await recordMailOperation({ userId: 'u', tool: 't', summary: 's', target: {} })).toBeUndefined();
  });

  test('reasons and subjects read plainly', () => {
    expect(mailOperationReason({ agent: 'user' })).toBeUndefined();
    expect(mailOperationReason({ agent: 'ai' })).toBe('Albatross did this while working on your request.');
    expect(mailOperationReason({ agent: 'user' }, ' Old news ')).toBe('Old news');
    expect(quotedSubject('')).toBe('a thread');
    expect(quotedSubject('x'.repeat(100))).toHaveLength(82);
  });

  test('mapLimit keeps order and settles every item', async () => {
    const results = await mapLimit([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error('two');
      return n * 10;
    });
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
  });

  test('operations store the reason, trimmed, for Activity', async () => {
    const t = convexTest(schema, {
      '../convex/_generated/api.js': () => import('../convex/_generated/api.js'),
      '../convex/operations.ts': () => import('../convex/operations'),
      '../convex/narrative.ts': () => import('../convex/narrative'),
    });
    const id = await t.mutation(api.operations.record, {
      internalSecret: SECRET,
      userId: 'u1',
      agent: 'user',
      tool: 'archive_thread',
      surface: 'mail',
      summary: 'Archived "Plan"',
      reason: '  Blocked sender  ',
      target: { kind: 'thread', id: 't' },
      inverse: { kind: MAIL_UNDO.threadFolders, payload: { threads: [] } },
    });
    const row = await t.run((ctx) => ctx.db.get(id));
    expect(row?.reason).toBe('Blocked sender');
  });
});

describe('one-time code cleanup', () => {
  test('an automatic cleanup move shows in Activity with Undo', async () => {
    const record = mock(async (_input: any) => 'op_c');
    const result = await consumeOneTimeCode(
      { userId: 'u', codeId: 'c1', cleanup: 'trash' },
      {
        mutate: (async (_ref: any, args: any) =>
          'codeId' in args && !('cleanup' in args)
            ? {
                accountId: 'a',
                providerMessageId: 'm',
                providerThreadId: 't',
                alreadyUsed: false,
                cleanup: null,
              }
            : null) as any,
        moveMessage: (async () => ({ ok: true, before: ['INBOX'], after: ['TRASH'] })) as any,
        record: record as any,
      },
    );
    expect(result.cleanupStatus).toBe('trashed');
    expect(record.mock.calls[0][0]).toMatchObject({
      userId: 'u',
      tool: 'one_time_code_cleanup',
      summary: 'Moved a used sign-in code email to Trash',
      inverse: {
        kind: MAIL_UNDO.messageFolders,
        payload: { account: 'a', messageId: 'm', before: ['INBOX'], after: ['TRASH'] },
      },
    });
  });
});

describe('web undo helpers', () => {
  test('bulk moves go out in chunks and keep each chunk operation', async () => {
    const keys = Array.from({ length: 150 }, (_, i) => `acct:t${i}`);
    const calls: number[] = [];
    const outcome = await runBulkMove(
      keys,
      (key) => ({ account: 'acct', threadId: key.split(':')[1] }),
      async (items) => {
        calls.push(items.length);
        if (items.length === 50) throw new Error('down');
        return {
          moved: items.filter((item) => item.threadId !== 't3'),
          failed: [{ account: 'acct', threadId: 't3' }],
          operationId: 'op_chunk',
        };
      },
    );
    expect(calls).toEqual([100, 50]);
    expect(outcome.succeeded).toHaveLength(99);
    expect(outcome.failed).toHaveLength(51);
    expect(outcome.operationIds).toEqual(['op_chunk']);
  });

  test('the toast offers Undo only for a recorded change and confirms after the server', async () => {
    const notify = {
      success: mock((..._args: any[]) => undefined),
      error: mock((..._args: any[]) => undefined),
    };
    toastWithUndo('Archived', undefined, { notify: notify as any });
    expect(notify.success.mock.calls[0]).toEqual(['Archived', undefined] as any);

    const call = mock(async (_name: string, _args?: any): Promise<any> => ({ ok: true, undone: 'x' }));
    const onUndone = mock(() => undefined);
    toastWithUndo('Archived 2 threads', ['op_1', 'op_2'], {
      notify: notify as any,
      call: call as any,
      onUndone,
    });
    const options = notify.success.mock.calls[1][1] as any;
    expect(options.action.label).toBe('Undo');
    options.action.onClick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(call.mock.calls.map((c) => c[1])).toEqual([{ operationId: 'op_1' }, { operationId: 'op_2' }]);
    expect(notify.success.mock.calls.at(-1)?.[0]).toBe('Undone');
    expect(onUndone).toHaveBeenCalled();

    call.mockImplementation(async () => {
      throw new Error('This operation can no longer be undone.');
    });
    toastWithUndo('Archived', 'op_3', { notify: notify as any, call: call as any });
    (notify.success.mock.calls.at(-1)?.[1] as any).action.onClick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(notify.error.mock.calls.at(-1)?.[0]).toBe('This operation can no longer be undone.');
  });
});

// Keep the request context import used: the executors run store calls as the user.
void runWithAiRequestContext;
