import { describe, expect, mock, test } from 'bun:test';
import { NextRequest } from 'next/server';
import { createComposePost } from '../app/api/compose/route';
import { createDispatchPost } from '../app/api/cron/mail-outbox/route';
import { DraftAttachmentError } from '../lib/files/draft-attachments';
import { SealedFileError, SealedFileNeedsAllow } from '../lib/files/materialize';
import type { DraftAttachment } from '../lib/shared/types';

// Invented data only.
const user = { userId: 'owner', email: 'sender@example.test', name: 'Sender', source: 'clerk' as const };
const key = `outbox:${crypto.randomUUID()}`;
const sealed: DraftAttachment = {
  source: 'file',
  fileId: 'sealed_1',
  provider: 'upload',
  format: 'native',
  name: 'W-9.pdf',
  sealed: true,
};
const invoice: DraftAttachment = {
  source: 'file',
  fileId: 'office_1',
  provider: 'office',
  format: 'pdf',
  name: 'Invoice 42.pdf',
};

function request(fields: Record<string, string> = {}) {
  const body = new FormData();
  for (const [k, v] of Object.entries({
    account: user.email,
    to: 'Pay <ap@example.com>',
    subject: 'Invoice',
    body: 'Attached.',
    pendingId: key,
    draftAttachments: JSON.stringify([
      { fileId: 'office_1', provider: 'office', format: 'pdf' },
      { source: 'file', fileId: 'sealed_1', provider: 'upload' },
    ]),
    ...fields,
  }))
    body.set(k, v);
  return new NextRequest('http://localhost/api/compose', { method: 'POST', body });
}

const pdf = (name: string) => ({
  filename: name,
  contentType: 'application/pdf',
  content: Buffer.from('%PDF-1.7'),
  size: 8,
});

function deps(list: DraftAttachment[] = [invoice, sealed]) {
  return {
    requireCurrentUser: async () => user,
    enforceUserRateLimit: async () => undefined,
    getPref: async () => '10',
    writeAudit: mock(async (): Promise<any> => undefined),
    checkDraftAttachments: mock(async () => list),
    sendTokenValid: mock(
      async (_user: string, token: string, sendKey: string) => token === 'tok' && sendKey === key,
    ),
    resolveDraftAttachments: mock(
      async (_user: string, _list: readonly DraftAttachment[], options: { hold?: boolean }) =>
        options.hold
          ? { attachments: [pdf('Invoice 42.pdf')], held: [{ fileId: 'sealed_1', filename: 'W-9.pdf' }] }
          : { attachments: [pdf('Invoice 42.pdf'), pdf('W-9.pdf')], held: [] },
    ),
    enqueueOutbox: mock(async () => ({
      id: key,
      fireAt: Date.now() + 10_000,
      undoSeconds: 10,
      status: 'pending',
    })),
    sendPrepared: mock(async (): Promise<any> => ({ _id: 'sent', account: user.email })),
    cacheSentMessage: async () => undefined,
    resolveFrom: async () => ({ selfAddresses: [] }),
  };
}

describe('compose with draft attachments', () => {
  test('a held send carries the plain files and only a reference for a sealed file', async () => {
    const d = deps();
    const res = await createComposePost(d)(request());
    expect(res.status).toBe(200);
    expect(d.checkDraftAttachments).toHaveBeenCalledWith('owner', [
      { fileId: 'office_1', provider: 'office', format: 'pdf' },
      { source: 'file', fileId: 'sealed_1', provider: 'upload' },
    ]);
    expect(d.resolveDraftAttachments.mock.calls[0][2] as unknown).toEqual({
      recipients: ['Pay <ap@example.com>', undefined, undefined],
      hold: true,
      usedBytes: 0,
    });
    const payload = (d.enqueueOutbox.mock.calls[0] as unknown[])[3] as any;
    expect(payload.attachments.map((a: any) => a.filename)).toEqual(['Invoice 42.pdf']);
    expect(payload.sealedAttachments).toEqual([{ fileId: 'sealed_1', filename: 'W-9.pdf' }]);
    expect(d.sendPrepared).not.toHaveBeenCalled();
    const audit = (d.writeAudit.mock.calls[0] as any[])[0];
    expect(audit.args.draftAttachments).toEqual(['Invoice 42.pdf', 'W-9.pdf']);
  });

  test('an instant send fills every file now', async () => {
    const d = deps();
    expect((await createComposePost(d)(request({ undoSeconds: '0' }))).status).toBe(200);
    expect(d.resolveDraftAttachments.mock.calls[0][2]).toMatchObject({ hold: false });
    const prepared = (d.sendPrepared.mock.calls[0] as unknown[])[1] as any;
    expect(prepared.attachments.map((a: any) => a.filename)).toEqual(['Invoice 42.pdf', 'W-9.pdf']);
  });

  test('a scheduled send takes plain files and refuses a sealed file', async () => {
    const sendAt = String(Date.now() + 2 * 60 * 60_000);
    const plain = deps([invoice]);
    expect((await createComposePost(plain)(request({ sendAt }))).status).toBe(200);
    expect((plain.sendPrepared.mock.calls[0] as unknown[])[2]).toBe(Number(sendAt));
    const d = deps();
    const res = await createComposePost(d)(request({ sendAt }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      ok: false,
      error: 'A file with saved details from Passwords and IDs cannot go in a scheduled send. Send it now.',
    });
    expect(d.sendPrepared).not.toHaveBeenCalled();
  });

  test('a send without a send grant gets 409 with the send id, the domains, and the items', async () => {
    const d = deps();
    d.resolveDraftAttachments.mockImplementation(async () => {
      throw new SealedFileNeedsAllow([
        {
          itemId: 'si_x',
          itemLabel: 'Social Security number',
          fieldLabels: ['Number'],
          domains: ['example.com'],
        },
      ]);
    });
    const res = await createComposePost(d)(request());
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      ok: false,
      code: 'needs_allow',
      error:
        'This file has your saved Social Security number. Before it goes in mail to example.com, allow it for this send or for all mail to that domain.',
      grant: 'send',
      sendId: key,
      domains: ['example.com'],
      allow: [
        {
          itemId: 'si_x',
          itemLabel: 'Social Security number',
          fieldLabels: ['Number'],
          domains: ['example.com'],
        },
      ],
    });
    expect(d.enqueueOutbox).not.toHaveBeenCalled();
    d.resolveDraftAttachments.mockImplementation(async () => {
      throw new SealedFileError('not_found', 'This file is not in Files any more.');
    });
    expect((await createComposePost(d)(request())).status).toBe(404);
  });

  test('the retry with allowToken passes the send key; a wrong or ended token stops the send', async () => {
    const d = deps();
    expect((await createComposePost(d)(request({ allowToken: 'tok' }))).status).toBe(200);
    expect(d.sendTokenValid).toHaveBeenCalledWith('owner', 'tok', key);
    expect((d.resolveDraftAttachments.mock.calls[0][2] as unknown as { sendKey?: string }).sendKey).toBe(key);
    const ended = deps();
    const res = await createComposePost(ended)(request({ allowToken: 'old' }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      ok: false,
      code: 'allow_ended',
      error: 'This permission ended. Allow the send again.',
    });
    expect(ended.resolveDraftAttachments).not.toHaveBeenCalled();
    // Without a token, no send key: only "Always for mail to" grants count.
    const plain = deps();
    await createComposePost(plain)(request());
    expect(
      (plain.resolveDraftAttachments.mock.calls[0][2] as unknown as { sendKey?: string }).sendKey,
    ).toBeUndefined();
    expect(plain.sendTokenValid).not.toHaveBeenCalled();
  });

  test('bad JSON, a file that is not the user’s, and no draft files at all', async () => {
    const bad = await createComposePost(deps())(request({ draftAttachments: '{nope' }));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ ok: false, error: 'Invalid draft attachments.' });
    const d = deps();
    d.checkDraftAttachments.mockImplementation(async () => {
      throw new DraftAttachmentError('One of the files is not in Files any more.', 404);
    });
    const missing = await createComposePost(d)(request());
    expect(missing.status).toBe(404);
    expect((await missing.json()).error).toBe('One of the files is not in Files any more.');
    const none = deps();
    expect((await createComposePost(none)(request({ draftAttachments: '' }))).status).toBe(200);
    expect(none.checkDraftAttachments).not.toHaveBeenCalled();
    expect(none.resolveDraftAttachments).not.toHaveBeenCalled();
  });
});

describe('the outbox fills held files at dispatch', () => {
  const dispatchRequest = () =>
    new NextRequest('http://localhost/api/cron/mail-outbox', {
      method: 'POST',
      body: JSON.stringify({ userId: user.userId, key }),
    });
  const dependencies = (held = true) => ({
    isInternalCronRequest: () => true,
    writeAudit: mock(async (): Promise<any> => undefined),
    claimOutbox: mock(async () => ({ url: 'https://storage.example.test/payload' })),
    fetch: mock(async () =>
      Response.json({
        userId: user.userId,
        account: user.email,
        to: 'ap@example.com',
        cc: 'cc@example.com',
        body: 'Held',
        attachments: [
          { filename: 'Invoice 42.pdf', contentType: 'application/pdf', content: 'JVBERg==', size: 4 },
        ],
        ...(held ? { sealedAttachments: [{ fileId: 'sealed_1', filename: 'W-9.pdf' }] } : {}),
      }),
    ) as unknown as typeof fetch,
    sendNylasMessage: mock(async (): Promise<any> => ({ _id: 'sent', account: user.email })),
    completeOutbox: mock(async () => undefined),
    upsertMessage: async (): Promise<any> => undefined,
    upsertThread: async (): Promise<any> => undefined,
    fillHeldAttachments: mock(async () => [pdf('W-9.pdf')]),
  });

  test('the sealed file fills for the recipients, and the reference never reaches the provider', async () => {
    const d = dependencies();
    await createDispatchPost(d)(dispatchRequest());
    expect(d.fillHeldAttachments).toHaveBeenCalledWith(
      'owner',
      [{ fileId: 'sealed_1', filename: 'W-9.pdf' }],
      ['ap@example.com', 'cc@example.com', undefined],
    );
    const sent = (d.sendNylasMessage.mock.calls[0] as unknown[])[0] as any;
    expect(sent.attachments.map((a: any) => a.filename)).toEqual(['Invoice 42.pdf', 'W-9.pdf']);
    expect('sealedAttachments' in sent).toBe(false);
    expect(d.completeOutbox).toHaveBeenCalledWith('owner', key, 'sent', 'sent');
    const plain = dependencies(false);
    await createDispatchPost(plain)(dispatchRequest());
    expect(plain.fillHeldAttachments).not.toHaveBeenCalled();
  });

  test('a fill that is refused at dispatch fails the send before the provider', async () => {
    const d = dependencies();
    d.fillHeldAttachments.mockImplementation(async () => {
      throw new SealedFileNeedsAllow([
        {
          itemId: 'si_x',
          itemLabel: 'Social Security number',
          fieldLabels: ['Number'],
          domains: ['example.com'],
        },
      ]);
    });
    await createDispatchPost(d)(dispatchRequest());
    expect(d.sendNylasMessage).not.toHaveBeenCalled();
    expect(d.completeOutbox).toHaveBeenCalledWith('owner', key, 'failed');
  });
});
