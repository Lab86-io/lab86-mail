import { describe, expect, mock, test } from 'bun:test';
import { NextRequest } from 'next/server';
import { createClerkWebhookPost } from '../app/api/clerk/webhook/route';
import { type AccountDeletionDeps, deleteUserData } from '../lib/security/account-deletion';

function deletionDeps(overrides: Partial<AccountDeletionDeps> = {}): AccountDeletionDeps {
  return {
    listConnectedAccounts: mock(async () => [
      { accountId: 'a1', grantId: 'g1' },
      { accountId: 'a2', grantId: 'g2' },
    ]),
    deleteNylasAccount: mock(async () => ({ ok: true })),
    deleteUserCascade: mock(async () => ({ ok: true, counts: {} })),
    ...overrides,
  };
}

describe('deleteUserData', () => {
  test('disconnects every grant, then runs the cascade', async () => {
    const deps = deletionDeps();
    const result = await deleteUserData('user_1', deps);
    expect(result.ok).toBe(true);
    expect(deps.deleteNylasAccount).toHaveBeenCalledWith('user_1', 'a1', 'g1');
    expect(deps.deleteNylasAccount).toHaveBeenCalledWith('user_1', 'a2', 'g2');
    expect(deps.deleteUserCascade).toHaveBeenCalledWith('user_1');
  });

  test('stops before the cascade when a grant cannot be disconnected', async () => {
    const deps = deletionDeps({
      deleteNylasAccount: mock(async (_userId: string, accountId: string) => {
        if (accountId === 'a2') throw new Error('provider down');
        return { ok: true };
      }),
    });
    const result = await deleteUserData('user_1', deps);
    expect(result).toEqual({
      ok: false,
      disconnected: [
        { accountId: 'a1', ok: true },
        { accountId: 'a2', ok: false, error: 'provider down' },
      ],
    });
    expect(deps.deleteUserCascade).not.toHaveBeenCalled();
  });
});

describe('Clerk webhook', () => {
  function webhookDeps(event: unknown, deleteResult: any = { ok: true, disconnected: [], cascade: {} }) {
    return {
      verifyWebhook: mock(async () => event),
      upsertFromClerk: mock(async () => ({ ok: true })),
      deleteUserData: mock(async () => deleteResult),
      writeAudit: mock(async () => ({}) as any),
    };
  }
  const request = () => new NextRequest('https://mail.lab86.io/api/clerk/webhook', { method: 'POST' });

  test('user.deleted runs the account deletion flow for that user', async () => {
    const deps = webhookDeps({ type: 'user.deleted', data: { id: 'user_gone', deleted: true } });
    const response = await createClerkWebhookPost(deps as any)(request());
    expect(response.status).toBe(200);
    expect(deps.deleteUserData).toHaveBeenCalledWith('user_gone');
    expect(deps.upsertFromClerk).not.toHaveBeenCalled();
  });

  test('user.deleted answers non-2xx so Clerk retries when grants stay connected', async () => {
    const deps = webhookDeps(
      { type: 'user.deleted', data: { id: 'user_gone' } },
      { ok: false, disconnected: [{ accountId: 'a1', ok: false }] },
    );
    const response = await createClerkWebhookPost(deps as any)(request());
    expect(response.status).toBe(502);
  });

  test('user.deleted answers 500 when the deletion flow throws', async () => {
    const deps = webhookDeps({ type: 'user.deleted', data: { id: 'user_gone' } });
    deps.deleteUserData = mock(async () => {
      throw new Error('convex down');
    });
    const errorSpy = mock(() => undefined);
    const original = console.error;
    console.error = errorSpy;
    try {
      const response = await createClerkWebhookPost(deps as any)(request());
      expect(response.status).toBe(500);
    } finally {
      console.error = original;
    }
  });

  test('user.created and user.updated still upsert the user', async () => {
    for (const type of ['user.created', 'user.updated']) {
      const deps = webhookDeps({
        type,
        data: {
          id: 'user_1',
          first_name: 'Ada',
          last_name: 'Lovelace',
          primary_email_address_id: 'e1',
          email_addresses: [{ id: 'e1', email_address: 'ada@example.com' }],
        },
      });
      const response = await createClerkWebhookPost(deps as any)(request());
      expect(response.status).toBe(200);
      expect(deps.upsertFromClerk).toHaveBeenCalledWith({
        userId: 'user_1',
        email: 'ada@example.com',
        name: 'Ada Lovelace',
        imageUrl: undefined,
      });
      expect(deps.deleteUserData).not.toHaveBeenCalled();
    }
  });

  test('an unverified event gets one generic error', async () => {
    const deps = webhookDeps(null);
    deps.verifyWebhook = mock(async () => {
      throw new Error('Missing CLERK_WEBHOOK_SIGNING_SECRET');
    });
    const response = await createClerkWebhookPost(deps as any)(request());
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ ok: false, error: 'Invalid webhook.' });
    expect(deps.deleteUserData).not.toHaveBeenCalled();
  });
});
