import { describe, expect, mock, test } from 'bun:test';
import { runWithAiRequestContext } from '../lib/ai/context';
import { replyAllTargetFor, replyTargetFor, resolveSendAnchor } from '../lib/send/anchor';
import { resolveMessage, resolveThreadMessages, upsertMessage } from '../lib/store/messages';
import { forwardMessage, replyAllMessage, replyMessage } from '../lib/tools/compose';
import { accountRow, corpusMessage, nylasMessage, withHttpHarness } from './tools/http-harness';

const run = <T>(fn: () => Promise<T>) => runWithAiRequestContext({ userId: 'user_1', agent: 'ai' }, fn);
const ctx = { agent: 'ai' as const, userId: 'user_1' };

describe('send anchor resolution (SEND-1)', () => {
  test('a message id resolves that exact message and never an older one', async () => {
    const older = corpusMessage({ _id: 'old', from: 'Old <old@example.com>', date: 1 });
    const loaders = {
      resolveMessage: mock(async () => null),
      resolveThreadMessages: mock(async () => [older]),
    };
    await expect(
      resolveSendAnchor({ account: 'acct_1', messageId: 'new', threadId: 'thread_1' }, loaders as any),
    ).rejects.toThrow(/Cannot find the original message/);
    expect(loaders.resolveThreadMessages).not.toHaveBeenCalled();
  });

  test('a thread id alone resolves the newest message of the full thread', async () => {
    const loaders = {
      resolveMessage: mock(async () => null),
      resolveThreadMessages: mock(async () => [
        corpusMessage({ _id: 'a', date: 1 }),
        corpusMessage({ _id: 'c', date: 3 }),
        corpusMessage({ _id: 'b', date: 2 }),
      ]),
    };
    const anchor = await resolveSendAnchor({ account: 'acct_1', threadId: 'thread_1' }, loaders as any);
    expect(anchor._id).toBe('c');
    await expect(resolveSendAnchor({ account: 'acct_1' }, loaders as any)).rejects.toThrow(
      /original message/,
    );
  });

  test('reply targets thread on the anchor and skip the account itself', () => {
    const anchor = corpusMessage({
      _id: 'm9',
      subject: 'RE: Plans',
      from: 'Bob <bob@example.com>',
      to: 'me@example.com, Carl <carl@example.com>',
      cc: 'dee@example.com',
    }) as any;
    expect(replyTargetFor(anchor)).toEqual({
      to: 'bob@example.com',
      subject: 'RE: Plans',
      replyToMessageId: 'm9',
    });
    expect(replyAllTargetFor(anchor, 'ME@example.com').to).toBe(
      'bob@example.com, carl@example.com, dee@example.com',
    );
    expect(() => replyTargetFor({ ...anchor, from: '' })).toThrow(/sender is missing/);
  });
});

describe('corpus-backed message resolver (KV-1)', () => {
  test('threads come from the corpus bundle, oldest first, with no KV read', async () => {
    await withHttpHarness(async (h) => {
      h.onConvex('mailCorpus:getCorpusThreadBundle', () => ({
        messages: [corpusMessage({ _id: 'b', date: 2 }), corpusMessage({ _id: 'a', date: 1 })],
      }));
      const messages = await run(() => resolveThreadMessages('acct_1', 'thread_1'));
      expect(messages.map((m) => m._id)).toEqual(['a', 'b']);
      expect(h.convexCalls.map((c) => c.path)).toEqual(['mailCorpus:getCorpusThreadBundle']);
      // Hosted runs never write the old KV message cache.
      await run(() => upsertMessage(corpusMessage() as any));
      expect(h.convexCalls).toHaveLength(1);
    });
  });

  test('a thread the corpus lacks comes from the provider', async () => {
    await withHttpHarness(async (h) => {
      h.onConvex('mailCorpus:getCorpusThreadBundle', () => null);
      h.onConvex('accounts:getConnectedAccount', () => accountRow());
      h.onNylas('GET', /\/v3\/grants\/grant_1\/messages$/, () => ({
        json: { data: [nylasMessage({ id: 'n2', date: 2 }), nylasMessage({ id: 'n1', date: 1 })] },
      }));
      const messages = await run(() => resolveThreadMessages('acct_1', 'thread_1'));
      expect(messages.map((m) => m._id)).toEqual(['n1', 'n2']);
    });
  });

  test('one message: thread bundle, then the message index, then the provider', async () => {
    await withHttpHarness(async (h) => {
      h.onConvex('mailCorpus:getCorpusThreadBundle', () => ({ messages: [corpusMessage({ _id: 'x' })] }));
      h.onConvex('mailCorpus:getCorpusMessage', (args) =>
        args.providerMessageId === 'indexed' ? corpusMessage({ _id: 'indexed' }) : null,
      );
      h.onConvex('accounts:getConnectedAccount', () => accountRow());
      h.onNylas('GET', /\/v3\/grants\/grant_1\/messages\/remote$/, () => ({
        json: { data: nylasMessage({ id: 'remote' }) },
      }));
      expect((await run(() => resolveMessage('acct_1', 'x', { threadId: 'thread_1' })))?._id).toBe('x');
      expect((await run(() => resolveMessage('acct_1', 'indexed', { threadId: 'thread_1' })))?._id).toBe(
        'indexed',
      );
      expect((await run(() => resolveMessage('acct_1', 'remote')))?._id).toBe('remote');
      expect(await run(() => resolveMessage('acct_1', 'gone'))).toBeNull();
    });
  });
});

describe('compose tools send to the resolved anchor', () => {
  const sendHarness = (h: Parameters<Parameters<typeof withHttpHarness>[0]>[0]) => {
    h.onConvex('accounts:getConnectedAccount', () => accountRow());
    h.onConvex('mailCorpus:getCorpusThreadBundle', () => ({
      messages: [
        corpusMessage({ _id: 'old', from: 'Old Sender <old@example.com>', date: 1 }),
        corpusMessage({
          _id: 'new',
          from: 'New Sender <new@example.com>',
          cc: 'Carl <carl@example.com>',
          date: 2,
          subject: 'Launch',
        }),
      ],
    }));
    h.onNylas('POST', /\/v3\/grants\/grant_1\/messages\/send$/, () => ({
      json: { data: nylasMessage({ id: 'sent_1', thread_id: 'thread_1' }) },
    }));
  };

  test('reply goes to the sender of the given message with threading', async () => {
    await withHttpHarness(async (h) => {
      sendHarness(h);
      const out = await run(() =>
        replyMessage.handler(
          { account: 'acct_1', messageId: 'new', threadId: 'thread_1', body: 'Thanks' },
          ctx,
        ),
      );
      expect(out).toMatchObject({ ok: true, messageId: 'sent_1' });
      const send = h.nylasCalls.find((c) => c.path.endsWith('/messages/send'));
      expect(send?.body.to).toEqual([{ email: 'new@example.com' }]);
      expect(send?.body.reply_to_message_id).toBe('new');
      expect(send?.body.subject).toBe('Re: Launch');
    });
  });

  test('edited recipients and subject win for reply and reply_all (SEND-4)', async () => {
    await withHttpHarness(async (h) => {
      sendHarness(h);
      await run(() =>
        replyAllMessage.handler(
          {
            account: 'acct_1',
            messageId: 'new',
            threadId: 'thread_1',
            to: 'only@example.com',
            cc: 'cc@example.com',
            subject: 'Changed',
            body: 'Hi',
          },
          ctx,
        ),
      );
      const send = h.nylasCalls.find((c) => c.path.endsWith('/messages/send'));
      expect(send?.body.to).toEqual([{ email: 'only@example.com' }]);
      expect(send?.body.cc).toEqual([{ email: 'cc@example.com' }]);
      expect(send?.body.subject).toBe('Changed');
    });
  });

  test('forward quotes the corpus message', async () => {
    await withHttpHarness(async (h) => {
      sendHarness(h);
      h.onConvex('mailCorpus:getCorpusMessage', () =>
        corpusMessage({ _id: 'new', subject: 'Launch', textBody: 'Body' }),
      );
      await run(() =>
        forwardMessage.handler({ account: 'acct_1', messageId: 'new', to: 'z@example.com' }, ctx),
      );
      const send = h.nylasCalls.find((c) => c.path.endsWith('/messages/send'));
      expect(send?.body.subject).toBe('Fwd: Launch');
      expect(send?.body.body).toContain('Body');
    });
  });
});

describe('assistant send attachments and undo (SEND-2, SEND-3, AI-4, AI-13)', () => {
  const big = new Uint8Array(3 * 1024 * 1024 + 10);
  const attachmentHarness = (h: Parameters<Parameters<typeof withHttpHarness>[0]>[0]) => {
    h.onConvex('accounts:getConnectedAccount', () => accountRow());
    h.onNylas('GET', /\/attachments\/att_1\/download$/, () => ({ raw: big }));
    h.onNylas('POST', /\/v3\/grants\/grant_1\/messages\/send$/, () => ({
      json: { data: { ...nylasMessage({ id: 'sched_msg' }), schedule_id: 'sched_1' } },
    }));
  };

  test('schedule_send carries attachments, sized so large files use multipart', async () => {
    const { scheduleSend } = await import('../lib/tools/compose');
    await withHttpHarness(async (h) => {
      attachmentHarness(h);
      const out = await run(() =>
        scheduleSend.handler(
          {
            account: 'acct_1',
            to: 'z@example.com',
            subject: 'Deck',
            body: 'Attached',
            scheduledFor: Date.now() + 3_600_000,
            attachments: [{ account: 'acct_1', messageId: 'm1', attachmentId: 'att_1', name: 'deck.pdf' }],
          },
          ctx,
        ),
      );
      expect(out).toMatchObject({ ok: true, scheduleId: 'sched_1' });
      const send = h.nylasCalls.find((c) => c.path.endsWith('/messages/send'));
      expect(send?.contentType).toContain('multipart/form-data');
      expect(String(send?.body)).toContain('deck.pdf');
    });
  });

  test('schedule_send input has no from field', async () => {
    const { scheduleSend, sendMessage } = await import('../lib/tools/compose');
    expect(Object.keys((scheduleSend.input as any).shape)).not.toContain('from');
    expect(Object.keys((sendMessage.input as any).shape)).not.toContain('from');
    expect(Object.keys((replyMessage.input as any).shape)).not.toContain('from');
  });

  test('undo_send cancels outbox keys and reports ok:false when nothing was undone', async () => {
    const { undoSend } = await import('../lib/tools/compose');
    await withHttpHarness(async (h) => {
      let cancelled = true;
      h.onConvex('mailOutbox:cancel', () => cancelled);
      const key = `outbox:${crypto.randomUUID()}`;
      expect(await run(() => undoSend.handler({ pendingId: key }, ctx))).toEqual({ ok: true, undone: true });
      expect(h.convexCalls.at(-1)).toEqual({ path: 'mailOutbox:cancel', args: { userId: 'user_1', key } });
      cancelled = false;
      const miss = await run(() => undoSend.handler({ pendingId: key }, ctx));
      expect(miss).toMatchObject({ ok: false, undone: false });
      expect(miss.error).toContain('Nothing was undone');
    });
    const unknown = await run(() => undoSend.handler({ pendingId: 'user_1:not-pending' }, ctx));
    expect(unknown).toMatchObject({ ok: false, undone: false });
    await expect(undoSend.handler({ pendingId: 'outbox:x' }, { agent: 'ai' } as any)).rejects.toThrow(
      /Sign in/,
    );
  });
});
