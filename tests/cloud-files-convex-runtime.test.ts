import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { convexTest } from 'convex-test';
import { api, internal } from '../convex/_generated/api';
import schema from '../convex/schema';

const convexModules = {
  '../convex/_generated/api.js': () => import('../convex/_generated/api.js'),
  '../convex/cloudFiles.ts': () => import('../convex/cloudFiles'),
};

const SECRET = 'cloud-files-runtime-secret';
const USER = 'cloud_files_user';
let previousSecret: string | undefined;

beforeAll(() => {
  previousSecret = process.env.LAB86_CONVEX_INTERNAL_SECRET;
  process.env.LAB86_CONVEX_INTERNAL_SECRET = SECRET;
});

afterAll(() => {
  if (previousSecret === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
  else process.env.LAB86_CONVEX_INTERNAL_SECRET = previousSecret;
});

function newHarness() {
  return convexTest(schema, convexModules);
}

async function connect(t: ReturnType<typeof newHarness>, overrides: Record<string, unknown> = {}) {
  return t.mutation(api.cloudFiles.upsertConnection, {
    internalSecret: SECRET,
    userId: USER,
    connectionId: 'google_drive_connection',
    provider: 'google_drive' as const,
    accountKey: 'google_account',
    accountEmail: 'files@example.test',
    displayName: 'Files User',
    scopes: ['openid', 'https://www.googleapis.com/auth/drive.readonly'],
    accessTokenEncrypted: 'enc:access',
    refreshTokenEncrypted: 'enc:refresh',
    expiresAt: Date.now() + 3_600_000,
    ...overrides,
  });
}

describe('cloud file Convex lifecycle', () => {
  test('keeps display metadata separate from credentials and updates an account in place', async () => {
    const t = newHarness();
    await connect(t);
    const rotated = await connect(t, {
      connectionId: 'ignored_reconnect_id',
      accessTokenEncrypted: 'enc:rotated',
      refreshTokenEncrypted: undefined,
    });

    expect(rotated.connectionId).toBe('google_drive_connection');
    const rows = await t.query(api.cloudFiles.listConnections, {
      internalSecret: SECRET,
      userId: USER,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      connectionId: 'google_drive_connection',
      provider: 'google_drive',
      status: 'connected',
      accountEmail: 'files@example.test',
    });
    expect(rows[0]).not.toHaveProperty('accountKey');
    expect(rows[0]).not.toHaveProperty('accessTokenEncrypted');

    const stored = await t.query(api.cloudFiles.getConnectionWithCredentials, {
      internalSecret: SECRET,
      userId: USER,
      connectionId: 'google_drive_connection',
    });
    expect(stored?.credentials).toMatchObject({
      accessTokenEncrypted: 'enc:rotated',
      refreshTokenEncrypted: 'enc:refresh',
    });
    await expect(
      t.query(api.cloudFiles.listConnections, {
        internalSecret: 'wrong',
        userId: USER,
      }),
    ).rejects.toThrow(/Invalid Convex internal secret/);
  });

  test('an errored connection remains retryable and a successful access clears the error', async () => {
    const t = newHarness();
    await connect(t);
    await t.mutation(api.cloudFiles.markAccessed, {
      internalSecret: SECRET,
      userId: USER,
      connectionId: 'google_drive_connection',
      error: 'Provider unavailable',
    });

    const retryable = await t.query(api.cloudFiles.getConnectionWithCredentials, {
      internalSecret: SECRET,
      userId: USER,
      connectionId: 'google_drive_connection',
    });
    expect(retryable?.credentials.accessTokenEncrypted).toBe('enc:access');

    await t.mutation(api.cloudFiles.markAccessed, {
      internalSecret: SECRET,
      userId: USER,
      connectionId: 'google_drive_connection',
    });
    const [recovered] = await t.query(api.cloudFiles.listConnections, {
      internalSecret: SECRET,
      userId: USER,
    });
    expect(recovered.status).toBe('connected');
    expect(recovered.error).toBeUndefined();
    expect(recovered.lastAccessedAt).toBeNumber();
  });

  test('only a reconnect error marks the connection broken (DOC-2)', async () => {
    const t = newHarness();
    await connect(t);
    await t.mutation(api.cloudFiles.markAccessed, {
      internalSecret: SECRET,
      userId: USER,
      connectionId: 'google_drive_connection',
      error: 'This Google Drive folder no longer exists.',
    });
    let [row] = await t.query(api.cloudFiles.listConnections, { internalSecret: SECRET, userId: USER });
    expect(row.status).toBe('connected');
    expect(row.error).toBeUndefined();
    expect(row.lastError).toBe('This Google Drive folder no longer exists.');

    await t.mutation(api.cloudFiles.markAccessed, {
      internalSecret: SECRET,
      userId: USER,
      connectionId: 'google_drive_connection',
      error: 'Google Drive access expired. Reconnect this account.',
      reconnect: true,
    });
    [row] = await t.query(api.cloudFiles.listConnections, { internalSecret: SECRET, userId: USER });
    expect(row.status).toBe('error');
    expect(row.error).toContain('Reconnect');
  });

  test('disconnect purges the indexed content of that connection only (CAL-10)', async () => {
    const t = newHarness();
    await connect(t);
    const seed = (connectionId: string, externalId: string) =>
      t.run(async (ctx) => {
        const itemId = await ctx.db.insert('contentItems', {
          userId: USER,
          key: `google_drive:${connectionId}:${externalId}`,
          connectionId,
          source: 'google_drive',
          externalId,
          title: externalId,
          text: 'secret plan',
          version: '1',
          modifiedAt: 1,
          indexedAt: 1,
          partial: false,
          deleted: false,
          status: 'ready',
          attempts: 0,
          nextAttemptAt: 0,
        });
        await ctx.db.insert('contentChunks', {
          userId: USER,
          itemId,
          version: '1',
          text: 'secret plan',
          embedding: new Array(1536).fill(0),
        });
      });
    for (let index = 0; index < 30; index += 1) await seed('google_drive_connection', `file-${index}`);
    await seed('other_connection', 'keep');
    await t.run((ctx) =>
      ctx.db.insert('contentSync', {
        userId: USER,
        connectionId: 'google_drive_connection',
        status: 'idle',
        indexed: 30,
        skipped: 0,
        updatedAt: 1,
      }),
    );

    await t.mutation(api.cloudFiles.disconnect, {
      internalSecret: SECRET,
      userId: USER,
      connectionId: 'google_drive_connection',
    });
    // The purge runs in batches of 25, so it schedules itself once more.
    for (let round = 0; round < 3; round += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      await t.finishInProgressScheduledFunctions();
    }
    const left = await t.run(async (ctx) => ({
      items: (await ctx.db.query('contentItems').collect()).map((row) => row.connectionId),
      chunks: (await ctx.db.query('contentChunks').collect()).length,
      sync: (await ctx.db.query('contentSync').collect()).length,
    }));
    expect(left).toEqual({ items: ['other_connection'], chunks: 1, sync: 0 });
  });

  test('OAuth state is user-bound and single-use, and disconnect removes both rows', async () => {
    const t = newHarness();
    await t.mutation(api.cloudFiles.saveOAuthState, {
      internalSecret: SECRET,
      userId: USER,
      state: 'single_use_state',
      provider: 'onedrive',
      redirectTo: '/?view=files',
      expiresAt: Date.now() + 600_000,
    });

    expect(
      await t.mutation(api.cloudFiles.consumeOAuthState, {
        internalSecret: SECRET,
        state: 'single_use_state',
      }),
    ).toMatchObject({
      userId: USER,
      provider: 'onedrive',
      redirectTo: '/?view=files',
    });
    expect(
      await t.mutation(api.cloudFiles.consumeOAuthState, {
        internalSecret: SECRET,
        state: 'single_use_state',
      }),
    ).toBeNull();

    await connect(t);
    await t.mutation(api.cloudFiles.disconnect, {
      internalSecret: SECRET,
      userId: USER,
      connectionId: 'google_drive_connection',
    });
    expect(await t.run((ctx) => ctx.db.query('cloudFileConnections').collect())).toHaveLength(0);
    expect(await t.run((ctx) => ctx.db.query('cloudFileCredentials').collect())).toHaveLength(0);
  });

  test('expired OAuth states cannot be consumed and are swept from storage', async () => {
    const t = newHarness();
    await t.mutation(api.cloudFiles.saveOAuthState, {
      internalSecret: SECRET,
      userId: USER,
      state: 'expired-on-consume',
      provider: 'google_drive',
      expiresAt: Date.now() - 1,
    });
    expect(
      await t.mutation(api.cloudFiles.consumeOAuthState, {
        internalSecret: SECRET,
        state: 'expired-on-consume',
      }),
    ).toBeNull();

    await t.mutation(api.cloudFiles.saveOAuthState, {
      internalSecret: SECRET,
      userId: USER,
      state: 'expired-for-sweep',
      provider: 'onedrive',
      expiresAt: Date.now() - 1,
    });
    await expect(t.mutation(internal.cloudFiles.sweepExpiredOAuthStates, {})).resolves.toEqual({
      deleted: 1,
    });
    expect(await t.run((ctx) => ctx.db.query('cloudFileOAuthStates').collect())).toHaveLength(0);
  });

  test('native OAuth completions are user-bound, single-use, and expiry-aware', async () => {
    const t = newHarness();
    await t.mutation(api.cloudFiles.saveOAuthCompletion, {
      internalSecret: SECRET,
      userId: USER,
      completionToken: 'native-completion',
      provider: 'google_drive',
      authorizationCodeEncrypted: 'encrypted-code',
      expiresAt: Date.now() + 300_000,
    });
    expect(
      await t.mutation(api.cloudFiles.consumeOAuthCompletion, {
        internalSecret: SECRET,
        userId: 'another-user',
        completionToken: 'native-completion',
      }),
    ).toBeNull();
    expect(
      await t.mutation(api.cloudFiles.consumeOAuthCompletion, {
        internalSecret: SECRET,
        userId: USER,
        completionToken: 'native-completion',
      }),
    ).toEqual({
      provider: 'google_drive',
      authorizationCodeEncrypted: 'encrypted-code',
    });
    expect(
      await t.mutation(api.cloudFiles.consumeOAuthCompletion, {
        internalSecret: SECRET,
        userId: USER,
        completionToken: 'native-completion',
      }),
    ).toBeNull();

    await t.mutation(api.cloudFiles.saveOAuthCompletion, {
      internalSecret: SECRET,
      userId: USER,
      completionToken: 'expired-completion',
      provider: 'onedrive',
      authorizationCodeEncrypted: 'expired-code',
      expiresAt: Date.now() - 1,
    });
    await expect(t.mutation(internal.cloudFiles.sweepExpiredOAuthCompletions, {})).resolves.toEqual({
      deleted: 1,
    });
    expect(await t.run((ctx) => ctx.db.query('cloudFileOAuthCompletions').collect())).toHaveLength(0);
  });
});
