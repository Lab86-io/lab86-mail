import { describe, expect, mock, test } from 'bun:test';
import { NextRequest } from 'next/server';
import { createComposePost } from '../app/api/compose/route';
import { createDispatchPost } from '../app/api/cron/mail-outbox/route';

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
