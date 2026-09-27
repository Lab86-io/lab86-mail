import { describe, expect, mock, test } from 'bun:test';
import './tools/harness';
import { NextRequest } from 'next/server';
import { createComposePost } from '../app/api/compose/route';
import { activeSignature, insertAtCursor } from '../components/thread/InlineComposer';
import { runWithAiRequestContext } from '../lib/ai/context';
import {
  deleteSavedReply,
  getSavedReply,
  listSavedReplies,
  SAVED_REPLY_LIMIT,
  saveSavedReply,
} from '../lib/mail/saved-replies';
import {
  appendSignature,
  getSignature,
  type MailSignature,
  sanitizeSignatureHtml,
  saveSignature,
  signatureTextToHtml,
  withAccountSignature,
} from '../lib/mail/signature';
import { forwardMessage, sendMessage } from '../lib/tools/compose';
import {
  deleteSavedReplyTool,
  listSavedRepliesTool,
  listSignaturesTool,
  saveSavedReplyTool,
  setSignatureTool,
} from '../lib/tools/mail-templates';
import { runTool, seedThreadMessage, withToolContext } from './tools/harness';
import { accountRow, corpusMessage, nylasMessage, withHttpHarness } from './tools/http-harness';

const signature = (overrides: Partial<MailSignature> = {}): MailSignature => ({
  accountId: 'acct_1',
  enabled: true,
  text: 'Jakob Langtry\nLab86',
  updatedAt: 1,
  ...overrides,
});

describe('appending a signature', () => {
  test('adds the text below the body and a signature block to the HTML', () => {
    expect(appendSignature({ body: 'See you then.\n', html: '<p>See you then.</p>' }, signature())).toEqual({
      body: 'See you then.\n\nJakob Langtry\nLab86',
      html: '<p>See you then.</p><br><br><div data-signature="true">Jakob Langtry<br>Lab86</div>',
      applied: true,
    });
    // A formatted version wins in the HTML part; plain text stays plain.
    const formatted = appendSignature({ body: 'Hi', html: '<p>Hi</p>' }, signature({ html: '<b>Jakob</b>' }));
    expect(formatted.html).toContain('<div data-signature="true"><b>Jakob</b></div>');
    expect(formatted.body).toBe('Hi\n\nJakob Langtry\nLab86');
    expect(appendSignature({ body: '' }, signature())).toEqual({
      body: 'Jakob Langtry\nLab86',
      applied: true,
    });
  });

  test('adds nothing when off, empty, or already in the body', () => {
    expect(appendSignature({ body: 'x' }, signature({ enabled: false }))).toEqual({
      body: 'x',
      applied: false,
    });
    expect(appendSignature({ body: 'x' }, signature({ text: '  ' })).applied).toBe(false);
    expect(appendSignature({ body: 'x' }, null).applied).toBe(false);
    expect(appendSignature({ body: 'Thanks!\n\njakob langtry\n  lab86' }, signature()).applied).toBe(false);
  });

  test('plain text is escaped for the HTML part', () => {
    expect(signatureTextToHtml('A & B <ceo>\n"Lab"')).toBe('A &amp; B &lt;ceo&gt;<br>&quot;Lab&quot;');
  });

  test('formatted signatures keep simple tags and safe links only', async () => {
    const clean = await sanitizeSignatureHtml(
      '<b onclick="x()">Jakob</b><script>alert(1)</script><img src="https://t.example/p.gif"><a href="javascript:alert(1)">bad</a><a href="https://lab86.io" style="color:red">site</a>',
    );
    expect(clean).toBe('<b>Jakob</b><a>bad</a><a href="https://lab86.io">site</a>');
    expect(await sanitizeSignatureHtml('   ')).toBe('');
  });
});

describe('signature storage and tools', () => {
  test('saving validates length and needs text to turn on', async () => {
    await withToolContext(async () => {
      await expect(saveSignature({ accountId: 'a', enabled: true, text: '   ' })).rejects.toThrow(
        'Write a signature before you turn it on.',
      );
      await expect(saveSignature({ accountId: 'a', enabled: false, text: 'x'.repeat(2001) })).rejects.toThrow(
        'at most 2000',
      );
      const saved = await saveSignature({
        accountId: 'sig-a',
        enabled: true,
        text: ' Jakob \r\n Lab86 ',
        html: '<i>Jakob</i><iframe></iframe>',
      });
      expect(saved).toMatchObject({
        accountId: 'sig-a',
        enabled: true,
        text: 'Jakob \n Lab86',
        html: '<i>Jakob</i>',
      });
      expect(await getSignature('sig-a')).toMatchObject({ text: 'Jakob \n Lab86' });
    });
  });

  test('set_signature and list_signatures round-trip for a mailbox', async () => {
    const set = await runTool(setSignatureTool.handler, {
      account: 'tool-acct',
      enabled: true,
      text: 'Best,\nJakob',
    });
    expect(set.signature).toMatchObject({ accountId: 'tool-acct', enabled: true, text: 'Best,\nJakob' });
    const listed = await runTool(listSignaturesTool.handler, {});
    expect(listed.signatures.find((row) => row.accountId === 'tool-acct')).toMatchObject({ enabled: true });
  });

  test('connected mailboxes each get a row, with the default when none is saved', async () => {
    await withHttpHarness(async (h) => {
      h.onConvex('accounts:listConnectedAccounts', () => [
        accountRow({ userId: 'test_user_tools', accountId: 'acct_1', email: 'ann@example.com' }),
        accountRow({
          userId: 'test_user_tools',
          accountId: 'acct_2',
          email: 'bob@example.com',
          grantId: 'g2',
        }),
      ]);
      h.onConvex('userData:listDocs', () => [
        { key: 'acct_2', doc: signature({ accountId: 'acct_2', text: 'Bob' }), updatedAt: 1 },
        { key: 'acct_gone', doc: signature({ accountId: 'acct_gone', text: 'Old' }), updatedAt: 1 },
      ]);
      const result = await runTool(listSignaturesTool.handler, {});
      expect(result.signatures.map((row) => [row.accountId, row.email ?? null, row.text])).toEqual([
        ['acct_1', 'ann@example.com', ''],
        ['acct_2', 'bob@example.com', 'Bob'],
        ['acct_gone', null, 'Old'],
      ]);
    });
  });

  test('a send names the mailbox by email and still finds its signature', async () => {
    await withHttpHarness(async (h) => {
      h.onConvex('userData:getDoc', (args) =>
        args.key === 'acct_1' ? { key: 'acct_1', doc: signature(), updatedAt: 1 } : null,
      );
      h.onConvex('accounts:listConnectedAccounts', () => [accountRow({ userId: 'user_1' })]);
      const result = await runWithAiRequestContext({ userId: 'user_1' }, () =>
        withAccountSignature({ account: 'ann@example.com', body: 'Hello' }),
      );
      expect(result).toEqual({ body: 'Hello\n\nJakob Langtry\nLab86', applied: true });
      expect(
        await runWithAiRequestContext({ userId: 'user_1' }, () =>
          withAccountSignature({ account: 'acct_1', body: 'Hello', include: false }),
        ),
      ).toEqual({ body: 'Hello', applied: false });
    });
  });
});

describe('signatures on the way out', () => {
  const user = {
    userId: 'test_user_tools',
    email: 'jakob@example.test',
    name: 'Jakob',
    source: 'clerk' as const,
  };
  const route = (overrides: Record<string, unknown> = {}) => {
    const enqueueOutbox = mock(async (..._args: any[]) => ({
      id: 'outbox:1',
      fireAt: Date.now() + 5000,
      undoSeconds: 5,
      status: 'pending',
    }));
    const handler = createComposePost({
      requireCurrentUser: async () => user,
      enforceUserRateLimit: async () => undefined,
      getPref: async () => '5',
      writeAudit: async () => undefined,
      enqueueOutbox,
      cacheSentMessage: async () => undefined,
      ...overrides,
    } as any);
    return { handler, enqueueOutbox };
  };
  const form = (fields: Record<string, string>) => {
    const body = new FormData();
    for (const [key, value] of Object.entries({ account: 'jakob@example.test', ...fields }))
      body.set(key, value);
    return new NextRequest('http://localhost/api/compose', { method: 'POST', body });
  };

  test('the compose route adds the signature unless the composer leaves it off', async () => {
    await withToolContext(() =>
      saveSignature({ accountId: 'jakob@example.test', enabled: true, text: 'Jakob' }),
    );
    const { handler, enqueueOutbox } = route();
    const sent = await handler(
      form({ to: 'a@example.test', subject: 'Hi', body: 'Hello there', html: '<p>Hello there</p>' }),
    );
    expect(sent.status).toBe(200);
    expect(enqueueOutbox.mock.calls[0][3]).toMatchObject({
      body: 'Hello there\n\nJakob',
      html: '<p>Hello there</p><br><br><div data-signature="true">Jakob</div>',
    });

    await handler(form({ to: 'a@example.test', subject: 'Hi', body: 'No sig', signature: '0' }));
    expect(enqueueOutbox.mock.calls[1][3]).toMatchObject({ body: 'No sig' });
  });

  test('a forward carries the signature under the note, above the forwarded message', async () => {
    const { messageId } = await seedThreadMessage({
      account: 'jakob@example.test',
      threadId: 'sig-fwd-thread',
      messageId: 'sig-fwd-msg',
      textBody: 'Original body',
    });
    await withToolContext(() =>
      saveSignature({ accountId: 'jakob@example.test', enabled: true, text: 'Jakob' }),
    );
    const { handler, enqueueOutbox } = route();
    await handler(form({ mode: 'forward', to: 'z@example.test', body: 'FYI', messageId }));
    const payload = enqueueOutbox.mock.calls[0][3] as any;
    expect(payload.body.indexOf('FYI\n\nJakob')).toBe(0);
    expect(payload.body.indexOf('Jakob')).toBeLessThan(payload.body.indexOf('Original body'));
  });

  test('assistant sends add the signature, and includeSignature false leaves it off', async () => {
    await withHttpHarness(async (h) => {
      h.onConvex('accounts:getConnectedAccount', () => accountRow());
      h.onConvex('userData:getDoc', (args) =>
        args.kind === 'mailSignature' ? { key: args.key, doc: signature(), updatedAt: 1 } : null,
      );
      h.onConvex('mailCorpus:getCorpusMessage', () =>
        corpusMessage({ _id: 'orig', subject: 'Launch', textBody: 'Launch notes' }),
      );
      h.onNylas('POST', /\/v3\/grants\/grant_1\/messages\/send$/, () => ({
        json: { data: nylasMessage({ id: 'sent_1', thread_id: 'thread_1' }) },
      }));
      const ctx = { agent: 'ai' as const, userId: 'user_1' };
      const run = <T>(fn: () => Promise<T>) => runWithAiRequestContext({ userId: 'user_1', agent: 'ai' }, fn);
      await run(() =>
        sendMessage.handler({ account: 'acct_1', to: 'a@example.com', subject: 'Hi', body: 'Hello' }, ctx),
      );
      await run(() =>
        sendMessage.handler(
          { account: 'acct_1', to: 'a@example.com', subject: 'Hi', body: 'Plain', includeSignature: false },
          ctx,
        ),
      );
      await run(() =>
        forwardMessage.handler(
          { account: 'acct_1', messageId: 'orig', to: 'z@example.com', body: 'See below' },
          ctx,
        ),
      );
      const sends = h.nylasCalls.filter((call) => call.path.endsWith('/messages/send'));
      expect(sends[0].body.body).toBe('Hello\n\nJakob Langtry\nLab86');
      expect(sends[1].body.body).toBe('Plain');
      expect(sends[2].body.body.startsWith('See below\n\nJakob Langtry\nLab86')).toBe(true);
      expect(sends[2].body.body).toContain('Launch notes');
    });
  });
});

describe('saved replies', () => {
  test('create, rename, list in name order, and delete', async () => {
    await withToolContext(
      async () => {
        const first = await saveSavedReply({
          name: '  Meeting   times ',
          body: 'I am free Tue and Thu.\r\n',
        });
        expect(first).toMatchObject({ name: 'Meeting times', body: 'I am free Tue and Thu.' });
        await saveSavedReply({ name: 'Address', body: '1 Main St' });
        expect((await listSavedReplies()).map((reply) => reply.name)).toEqual(['Address', 'Meeting times']);
        await expect(saveSavedReply({ name: 'address', body: 'dup' })).rejects.toThrow('already exists');
        const renamed = await saveSavedReply({ id: first.id, name: 'Availability', body: first.body });
        expect(renamed).toMatchObject({ id: first.id, createdAt: first.createdAt, name: 'Availability' });
        await expect(saveSavedReply({ id: 'missing', name: 'X', body: 'y' })).rejects.toThrow('not found');
        await expect(saveSavedReply({ name: '', body: 'y' })).rejects.toThrow('name');
        await expect(saveSavedReply({ name: 'N', body: ' ' })).rejects.toThrow('text');
        await expect(saveSavedReply({ name: 'x'.repeat(81), body: 'y' })).rejects.toThrow('at most 80');
        await expect(saveSavedReply({ name: 'Long', body: 'y'.repeat(5001) })).rejects.toThrow(
          'at most 5000',
        );
        expect(await deleteSavedReply(first.id)).toMatchObject({ id: first.id, name: 'Availability' });
        expect(await getSavedReply(first.id)).toBeNull();
        expect(await deleteSavedReply(first.id)).toBeNull();
      },
      { userId: 'saved_replies_user' },
    );
  });

  test(`at most ${SAVED_REPLY_LIMIT} saved replies are kept`, async () => {
    await withToolContext(
      async () => {
        for (let index = 0; index < SAVED_REPLY_LIMIT; index += 1)
          await saveSavedReply({ name: `Reply ${index}`, body: 'text' });
        await expect(saveSavedReply({ name: 'One more', body: 'text' })).rejects.toThrow('up to 100');
      },
      { userId: 'saved_replies_limit_user' },
    );
  });

  test('the tools let the composer, settings, and the assistant use them', async () => {
    const created = await runTool(saveSavedReplyTool.handler, { name: 'Thanks', body: 'Thank you!' });
    const listed = await runTool(listSavedRepliesTool.handler, {});
    expect(listed.replies.some((reply) => reply.id === created.reply.id)).toBe(true);
    expect(await runTool(deleteSavedReplyTool.handler, { id: created.reply.id })).toMatchObject({
      ok: true,
      deleted: true,
      reply: { id: created.reply.id, name: 'Thanks', body: 'Thank you!' },
    });
    await expect(runTool(deleteSavedReplyTool.handler, { id: created.reply.id })).rejects.toThrow(
      'not found',
    );
  });
});

describe('composer helpers', () => {
  test('the composer shows the signature for the From mailbox only when it is on', () => {
    const rows = [
      { accountId: 'acct_1', email: 'ann@example.com', enabled: true, text: 'Ann' },
      { accountId: 'acct_2', email: 'bob@example.com', enabled: false, text: 'Bob' },
    ];
    expect(activeSignature(rows, 'acct_1')?.text).toBe('Ann');
    expect(activeSignature(rows, 'ANN@example.com')?.text).toBe('Ann');
    expect(activeSignature(rows, 'acct_2')).toBeNull();
    expect(activeSignature(undefined, 'acct_1')).toBeNull();
  });

  test('a saved reply goes in at the caret, over a selection, or at the end', () => {
    expect(insertAtCursor('Hi Ann, ', 'thanks!', 8, 8)).toBe('Hi Ann, thanks!');
    expect(insertAtCursor('Hi Ann, XX', 'thanks!', 8, 10)).toBe('Hi Ann, thanks!');
    expect(insertAtCursor('Hi Ann,', 'thanks!', null)).toBe('Hi Ann,\n\nthanks!');
    expect(insertAtCursor('', 'thanks!', undefined)).toBe('thanks!');
  });
});
