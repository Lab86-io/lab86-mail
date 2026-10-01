import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { NextRequest } from 'next/server';
import { createComposePost } from '../app/api/compose/route';
import { createDispatchPost } from '../app/api/cron/mail-outbox/route';
import { gmailSendAsIdentities } from '../lib/google/send-as';
import { __setSendAsDepsForTest, SendAsUnavailableError } from '../lib/mail/send-as';
import { SendAsError } from '../lib/shared/send-as';

const user = { userId: 'owner', email: 'sender@example.test', name: 'Sender', source: 'clerk' as const };
const key = `outbox:${crypto.randomUUID()}`;
function request(seconds?: number) {
  const body = new FormData();
  for (const [k, v] of Object.entries({
    account: user.email,
    to: 'recipient@example.test',
    subject: 'Hello',
    body: 'Draft',
    pendingId: key,
  }))
    body.set(k, v);
  if (seconds !== undefined) body.set('undoSeconds', String(seconds));
  return new NextRequest('http://localhost/api/compose', { method: 'POST', body });
}
const deps = () => ({
  requireCurrentUser: async () => user,
  enforceUserRateLimit: async () => undefined,
  getPref: async () => '10',
  writeAudit: async (): Promise<any> => undefined,
  enqueueOutbox: mock(async () => ({
    id: key,
    fireAt: Date.now() + 10000,
    undoSeconds: 10,
    status: 'pending',
  })),
  sendPrepared: mock(async (): Promise<any> => ({ _id: 'sent', account: user.email })),
  cacheSentMessage: async () => undefined,
  resolveFrom: async () => ({ selfAddresses: [] }),
});
describe('compose holds before provider handoff', () => {
  test('uses saved preference when omitted and returns a pending receipt without sending', async () => {
    const d = deps();
    const res = await createComposePost(d)(request());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ pending: { id: key } });
    expect(d.enqueueOutbox).toHaveBeenCalledWith(
      user.userId,
      key,
      10,
      expect.objectContaining({ body: 'Draft', to: 'recipient@example.test' }),
    );
    expect(d.sendPrepared).not.toHaveBeenCalled();
  });
  test('a refused request keeps its own message, and an unknown failure gets a fixed text', async () => {
    const error = spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const noRecipient = request(5);
      const form = await noRecipient.formData();
      form.delete('to');
      const refused = await createComposePost(deps())(
        new NextRequest('http://localhost/api/compose', { method: 'POST', body: form }),
      );
      expect(refused.status).toBe(400);
      expect(await refused.json()).toEqual({ ok: false, error: 'to is required' });

      const d = deps();
      d.enqueueOutbox.mockImplementation(async () => {
        throw new Error('Convex [Request ID: 7] Server Error at internal path');
      });
      const failed = await createComposePost(d)(request(5));
      expect(failed.status).toBe(500);
      // The answer never carries the error message (CASA S7).
      expect(await failed.json()).toEqual({ ok: false, error: 'send failed' });
    } finally {
      error.mockRestore();
    }
  });
  test('a hold failure never falls back to immediate sending', async () => {
    const d = deps();
    d.enqueueOutbox.mockImplementation(async () => {
      throw new Error('Outbox unavailable');
    });
    expect((await createComposePost(d)(request(5))).status).toBe(500);
    expect(d.sendPrepared).not.toHaveBeenCalled();
  });
  test('explicit instant mode bypasses the hold', async () => {
    const d = deps();
    expect((await createComposePost(d)(request(0))).status).toBe(200);
    expect(d.sendPrepared).toHaveBeenCalledTimes(1);
    expect(d.enqueueOutbox).not.toHaveBeenCalled();
  });
});
describe('authenticated outbox dispatch', () => {
  const dispatchRequest = () =>
    new NextRequest('http://localhost/api/cron/mail-outbox', {
      method: 'POST',
      body: JSON.stringify({ userId: user.userId, key }),
    });
  const dependencies = () => ({
    isInternalCronRequest: () => true,
    writeAudit: mock(async (): Promise<any> => undefined),
    claimOutbox: mock(
      async (): Promise<{ url: string } | null> => ({ url: 'https://storage.example.test/payload' }),
    ),
    fetch: mock(async () =>
      Response.json({ userId: user.userId, account: user.email, body: 'Held content' }),
    ) as unknown as typeof fetch,
    sendNylasMessage: mock(async (): Promise<any> => ({ _id: 'sent', account: user.email })),
    completeOutbox: mock(async () => undefined),
    upsertMessage: async (): Promise<any> => undefined,
    upsertThread: async (): Promise<any> => undefined,
  });
  test('rejects public requests and skips cancelled/claimed sends', async () => {
    const d = dependencies();
    d.isInternalCronRequest = () => false;
    expect((await createDispatchPost(d)(dispatchRequest())).status).toBe(401);
    expect(d.claimOutbox).not.toHaveBeenCalled();
    d.isInternalCronRequest = () => true;
    d.claimOutbox.mockResolvedValue(null);
    await createDispatchPost(d)(dispatchRequest());
    expect(d.sendNylasMessage).not.toHaveBeenCalled();
  });
  test('records sent only after provider confirmation', async () => {
    const d = dependencies();
    await createDispatchPost(d)(dispatchRequest());
    expect(d.sendNylasMessage).toHaveBeenCalledTimes(1);
    expect(d.completeOutbox).toHaveBeenCalledWith(user.userId, key, 'sent', 'sent');
  });
  test('ambiguous provider failure is never treated as permission to resend', async () => {
    const d = dependencies();
    d.sendNylasMessage.mockImplementation(async () => {
      throw new Error('Lost response');
    });
    await createDispatchPost(d)(dispatchRequest());
    expect(d.completeOutbox).toHaveBeenCalledWith(user.userId, key, 'unknown');
    expect(d.sendNylasMessage).toHaveBeenCalledTimes(1);
  });
});
describe('send-as From on the compose route', () => {
  const anchor = {
    _id: 'm1',
    threadId: 't1',
    account: 'acct-1',
    subject: 'Plans',
    from: 'Bob <bob@x.example>',
    to: 'Ann <ann@work.example>, carl@x.example',
    cc: 'ann@gmail.com',
    bcc: '',
    date: 1,
    snippet: '',
    textBody: '',
    htmlBody: '',
    labels: [],
    attachments: [],
    headers: {},
    cachedAt: 1,
  };
  function form(fields: Record<string, string>) {
    const body = new FormData();
    for (const [k, v] of Object.entries({ account: 'acct-1', pendingId: key, body: 'Draft', ...fields }))
      body.set(k, v);
    return new NextRequest('http://localhost/api/compose', { method: 'POST', body });
  }
  const routeDeps = (overrides: Record<string, unknown> = {}) => ({
    ...deps(),
    applySignature: async ({ body, html }: { body: string; html?: string }) => ({ body, html }),
    resolveAnchor: mock(async () => anchor as any),
    resolveFrom: mock(async (input: any) => ({
      ...(input.fromAddress ? { fromAddress: input.fromAddress } : {}),
      selfAddresses: [],
    })),
    ...overrides,
  });

  afterEach(() => __setSendAsDepsForTest());

  test('the chosen address is checked and held with an undo send', async () => {
    const d = routeDeps();
    const res = await createComposePost(d as any)(
      form({ to: 'bob@x.example', subject: 'Hi', fromAddress: ' ann@work.example ', undoSeconds: '5' }),
    );
    expect(res.status).toBe(200);
    expect(d.resolveFrom).toHaveBeenCalledWith({
      userId: user.userId,
      account: 'acct-1',
      fromAddress: 'ann@work.example',
    });
    expect(d.enqueueOutbox).toHaveBeenCalledWith(
      user.userId,
      key,
      5,
      expect.objectContaining({ fromAddress: 'ann@work.example', userId: user.userId }),
    );
  });

  test('a scheduled send keeps the chosen address', async () => {
    const d = routeDeps();
    const sendAt = Date.now() + 3_600_000;
    const res = await createComposePost(d as any)(
      form({ to: 'bob@x.example', subject: 'Hi', fromAddress: 'ann@work.example', sendAt: String(sendAt) }),
    );
    expect(res.status).toBe(200);
    expect(d.sendPrepared).toHaveBeenCalledWith(
      user.userId,
      expect.objectContaining({ fromAddress: 'ann@work.example' }),
      sendAt,
    );
  });

  test('a refused address answers 400 with its text and code, and nothing is held', async () => {
    const d = routeDeps({
      resolveFrom: mock(async () => {
        throw new SendAsError('from_unverified');
      }),
    });
    const res = await createComposePost(d as any)(
      form({ to: 'bob@x.example', subject: 'Hi', fromAddress: 'side@club.example' }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      ok: false,
      error: new SendAsError('from_unverified').message,
      code: 'from_unverified',
    });
    expect(d.enqueueOutbox).not.toHaveBeenCalled();
  });

  test('a From check that cannot run answers 503 with a fixed text', async () => {
    const error = spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const d = routeDeps({
        resolveFrom: mock(async () => {
          throw new SendAsUnavailableError();
        }),
      });
      const res = await createComposePost(d as any)(
        form({ to: 'bob@x.example', subject: 'Hi', fromAddress: 'ann@work.example' }),
      );
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ ok: false, error: new SendAsUnavailableError().message });
    } finally {
      error.mockRestore();
    }
  });

  test('a reply-all defaults to the alias the original was sent to and leaves the alias out', async () => {
    __setSendAsDepsForTest({
      getAccount: (async () => ({
        accountId: 'acct-1',
        email: 'ann@gmail.com',
        grantId: 'google:11111111-1111-1111-1111-111111111111',
      })) as any,
      listGmailSendAs: async () =>
        gmailSendAsIdentities([
          { sendAsEmail: 'ann@gmail.com', isPrimary: true, isDefault: true },
          { sendAsEmail: 'ann@work.example', verificationStatus: 'accepted' },
        ]),
    });
    const d: Record<string, unknown> = routeDeps();
    delete d.resolveFrom;
    const res = await createComposePost(d as any)(
      form({ mode: 'reply_all', messageId: 'm1', threadId: 't1' }),
    );
    expect(res.status).toBe(200);
    expect((d as ReturnType<typeof routeDeps>).enqueueOutbox).toHaveBeenCalledWith(
      user.userId,
      key,
      10,
      expect.objectContaining({
        fromAddress: 'ann@work.example',
        to: 'bob@x.example, carl@x.example',
        replyToMessageId: 'm1',
      }),
    );
  });

  test('a forward checks the address against the original too', async () => {
    const d = routeDeps();
    await createComposePost(d as any)(
      form({ mode: 'forward', messageId: 'm1', to: 'dee@x.example', fromAddress: 'ann@work.example' }),
    );
    expect(d.resolveFrom).toHaveBeenCalledWith(
      expect.objectContaining({
        fromAddress: 'ann@work.example',
        anchor: expect.objectContaining({ _id: 'm1' }),
      }),
    );
    expect(d.enqueueOutbox).toHaveBeenCalledWith(
      user.userId,
      key,
      10,
      expect.objectContaining({ fromAddress: 'ann@work.example', to: 'dee@x.example' }),
    );
  });

  test('without a From address and without a default, the payload names none', async () => {
    const d = routeDeps();
    await createComposePost(d as any)(form({ to: 'bob@x.example', subject: 'Hi' }));
    const payload = (d.enqueueOutbox.mock.calls[0] as unknown[])[3] as Record<string, unknown>;
    expect(payload).not.toHaveProperty('fromAddress');
  });

  test('the dispatch sends the held address, and a refused address marks the send failed', async () => {
    const completeOutbox = mock(async () => undefined);
    const sendNylasMessage = mock(async (): Promise<any> => {
      throw new SendAsError('from_unknown');
    });
    await createDispatchPost({
      isInternalCronRequest: () => true,
      writeAudit: mock(async (): Promise<any> => undefined),
      claimOutbox: mock(async () => ({ url: 'https://storage.example.test/payload' })),
      fetch: mock(async () =>
        Response.json({ userId: user.userId, account: 'acct-1', fromAddress: 'ann@work.example', body: 'x' }),
      ) as unknown as typeof fetch,
      sendNylasMessage,
      completeOutbox,
      upsertMessage: async (): Promise<any> => undefined,
      upsertThread: async (): Promise<any> => undefined,
    } as any)(
      new NextRequest('http://localhost/api/cron/mail-outbox', {
        method: 'POST',
        body: JSON.stringify({ userId: user.userId, key }),
      }),
    );
    expect(sendNylasMessage).toHaveBeenCalledWith(
      expect.objectContaining({ fromAddress: 'ann@work.example' }),
    );
    expect(completeOutbox).toHaveBeenCalledWith(user.userId, key, 'failed');
  });
});
