import { afterEach, describe, expect, mock, test } from 'bun:test';
import { getFunctionName } from 'convex/server';
import { NextRequest } from 'next/server';
import { createClerkWebhookPost } from '../app/api/clerk/webhook/route';
import { __setCloudFileConnectionDepsForTest } from '../lib/files/connections';
import { __setGoogleSharedGrantDepsForTest } from '../lib/google/shared-grant';
import {
  type AccountDeletionDeps,
  defaultAccountDeletionDeps,
  deleteUserData,
} from '../lib/security/account-deletion';

function deletionDeps(overrides: Partial<AccountDeletionDeps> = {}): AccountDeletionDeps {
  return {
    listConnectedAccounts: mock(async () => [
      { accountId: 'a1', grantId: 'g1' },
      { accountId: 'a2', grantId: 'g2' },
    ]),
    deleteNylasAccount: mock(async () => ({ ok: true })),
    listCloudFileConnections: mock(async () => [
      { connectionId: 'drive-1', provider: 'google_drive' },
      { connectionId: 'onedrive-1', provider: 'onedrive' },
    ]),
    disconnectCloudFileConnection: mock(async (_userId: string, connectionId: string) => ({
      revoked: connectionId === 'drive-1',
    })),
    deleteUserCascade: mock(async () => ({ ok: true, counts: {} })),
    ...overrides,
  };
}

afterEach(() => {
  __setCloudFileConnectionDepsForTest();
  __setGoogleSharedGrantDepsForTest();
});

describe('deleteUserData', () => {
  test('disconnects every grant and file connection, then runs the cascade', async () => {
    const order: string[] = [];
    const deps = deletionDeps({
      deleteNylasAccount: mock(async (_userId: string, accountId: string) => {
        order.push(`mail:${accountId}`);
        return { ok: true };
      }),
      disconnectCloudFileConnection: mock(async (_userId: string, connectionId: string) => {
        order.push(`files:${connectionId}`);
        return { revoked: connectionId === 'drive-1' };
      }),
      deleteUserCascade: mock(async () => {
        order.push('cascade');
        return { ok: true, counts: {} };
      }),
    });
    const result = await deleteUserData('user_1', deps);
    expect(result.ok).toBe(true);
    expect(deps.deleteNylasAccount).toHaveBeenCalledWith('user_1', 'a1', 'g1');
    expect(deps.deleteNylasAccount).toHaveBeenCalledWith('user_1', 'a2', 'g2');
    expect(deps.deleteUserCascade).toHaveBeenCalledWith('user_1');
    // Mailboxes first, so they do not block the Drive revoke; the cascade last.
    expect(order).toEqual(['mail:a1', 'mail:a2', 'files:drive-1', 'files:onedrive-1', 'cascade']);
    expect(result.drives).toEqual([
      { connectionId: 'drive-1', ok: true, revoked: true },
      { connectionId: 'onedrive-1', ok: true, revoked: false },
    ]);
  });

  test('stops before the cascade when a file connection cannot be disconnected', async () => {
    const deps = deletionDeps({
      disconnectCloudFileConnection: mock(async () => {
        throw new Error('convex down');
      }),
      listCloudFileConnections: mock(async () => [{ connectionId: 'drive-1', provider: 'google_drive' }]),
    });
    const result = await deleteUserData('user_1', deps);
    expect(result).toEqual({
      ok: false,
      disconnected: [
        { accountId: 'a1', ok: true },
        { accountId: 'a2', ok: true },
      ],
      drives: [{ connectionId: 'drive-1', ok: false, error: 'convex down' }],
    });
    expect(deps.deleteUserCascade).not.toHaveBeenCalled();
  });

  test('a user with no file connections goes straight to the cascade', async () => {
    const deps = deletionDeps({ listCloudFileConnections: mock(async () => null as any) });
    const result = await deleteUserData('user_1', deps);
    expect(result).toMatchObject({ ok: true, drives: [] });
    expect(deps.disconnectCloudFileConnection).not.toHaveBeenCalled();
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
      drives: [],
    });
    expect(deps.deleteUserCascade).not.toHaveBeenCalled();
    // A mailbox failure stops before any Drive token is revoked.
    expect(deps.disconnectCloudFileConnection).not.toHaveBeenCalled();
  });
});

describe('account deletion revokes Google Drive tokens with the Drive disconnect rules', () => {
  const DRIVE_ROW = {
    connection: {
      connectionId: 'drive-1',
      provider: 'google_drive',
      accountEmail: 'ann@example.com',
      status: 'connected',
      scopes: [],
    },
    credentials: { accessTokenEncrypted: 'enc:access', refreshTokenEncrypted: 'enc:refresh' },
  };

  function realDriveDisconnect(input: { environment: string; otherConnection?: boolean }) {
    const revokes: string[] = [];
    const removed: string[] = [];
    __setGoogleSharedGrantDepsForTest({
      env: () => ({ RAILWAY_ENVIRONMENT_NAME: input.environment, GOOGLE_DRIVE_CLIENT_ID: '1-drive' }),
      query: (async (fn: unknown) => {
        const name = getFunctionName(fn as any);
        if (name === 'googleDirect:googleAccessUsesAddress') return input.otherConnection === true;
        // The mailboxes of this user are gone before the Drive step.
        if (name === 'accounts:listConnectedAccounts') return [];
        return null;
      }) as any,
    });
    __setCloudFileConnectionDepsForTest({
      convexQuery: (async () => DRIVE_ROW) as any,
      convexMutation: (async (_fn: unknown, args: any) => {
        removed.push(args.connectionId);
        return { ok: true };
      }) as any,
      decryptSecret: ((value: string) => value.replace('enc:', '')) as any,
      fetch: (async (_url: unknown, init?: RequestInit) => {
        revokes.push(String(new URLSearchParams(String(init?.body)).get('token')));
        return new Response(null, { status: 200 });
      }) as any,
    });
    return { revokes, removed };
  }

  function depsWithRealDrive() {
    return deletionDeps({
      listCloudFileConnections: mock(async () => [{ connectionId: 'drive-1', provider: 'google_drive' }]),
      disconnectCloudFileConnection: defaultAccountDeletionDeps.disconnectCloudFileConnection,
    });
  }

  test('production revokes the Drive refresh token, then deletes the rows', async () => {
    const { revokes, removed } = realDriveDisconnect({ environment: 'production' });
    const result = await deleteUserData('user_1', depsWithRealDrive());
    expect(revokes).toEqual(['refresh']);
    expect(removed).toEqual(['drive-1']);
    expect(result).toMatchObject({
      ok: true,
      drives: [{ connectionId: 'drive-1', ok: true, revoked: true }],
    });
  });

  test('outside production, or while another connection uses the address, the rows go with no revoke', async () => {
    const staging = realDriveDisconnect({ environment: 'staging' });
    expect(await deleteUserData('user_1', depsWithRealDrive())).toMatchObject({
      ok: true,
      drives: [{ connectionId: 'drive-1', ok: true, revoked: false }],
    });
    expect(staging.revokes).toEqual([]);
    expect(staging.removed).toEqual(['drive-1']);

    const shared = realDriveDisconnect({ environment: 'production', otherConnection: true });
    await deleteUserData('user_1', depsWithRealDrive());
    expect(shared.revokes).toEqual([]);
    expect(shared.removed).toEqual(['drive-1']);
  });
});

describe('Clerk webhook', () => {
  function webhookDeps(
    event: unknown,
    deleteResult: any = { ok: true, disconnected: [], drives: [], cascade: {} },
  ) {
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
