import { describe, expect, mock, test } from 'bun:test';
import { NextRequest } from 'next/server';
import { createComposeUndoPost } from '../app/api/compose/undo/route';
import { getPendingStatus, makeProviderPendingId } from '../lib/send/pending';

const user = { userId: 'undo-web', email: 'sender@example.test', name: 'Sender', source: 'clerk' as const };
const receipt = (fireAt = Date.now() + 30_000) =>
  makeProviderPendingId({
    userId: user.userId,
    account: user.email,
    scheduleId: crypto.randomUUID(),
    fireAt,
  });
const request = (id: string) =>
  new NextRequest('http://localhost/api/compose/undo', {
    method: 'POST',
    body: JSON.stringify({ pendingId: id }),
  });
const dependencies = () => ({
  requireCurrentUser: mock(async () => user),
  stopNylasScheduledMessage: mock(async (): Promise<any> => ({ status: 'cancelled' })),
  writeAudit: mock(async (): Promise<any> => undefined),
});

describe('web compose Undo', () => {
  test('successful cancellation is idempotent', async () => {
    const deps = dependencies();
    const post = createComposeUndoPost(deps);
    const id = receipt();
    expect(await (await post(request(id))).json()).toMatchObject({ undone: true });
    expect(await (await post(request(id))).json()).toMatchObject({ undone: true });
    expect(deps.stopNylasScheduledMessage).toHaveBeenCalledTimes(1);
    expect(getPendingStatus(id).status).toBe('cancelled');
  });
  test('failed or empty cancellation never labels a potentially outgoing message failed', async () => {
    for (const throws of [true, false]) {
      const deps = dependencies();
      deps.stopNylasScheduledMessage.mockImplementation(async () => {
        if (throws) throw new Error('Provider unavailable');
        return null;
      });
      const id = receipt();
      expect(await (await createComposeUndoPost(deps)(request(id))).json()).toMatchObject({ undone: false });
      expect(getPendingStatus(id).status).toBe('pending');
    }
  });
  test('expired and foreign receipts cannot cancel sends', async () => {
    const deps = dependencies();
    const post = createComposeUndoPost(deps);
    expect(await (await post(request(receipt(Date.now() - 1_000)))).json()).toMatchObject({ undone: false });
    expect((await post(request('another-user:receipt'))).status).toBe(404);
    expect(deps.stopNylasScheduledMessage).not.toHaveBeenCalled();
  });
});
