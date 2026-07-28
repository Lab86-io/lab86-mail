import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import {
  __setCloudFileBrowseDepsForTest,
  browseCloudFiles,
  CloudFileProviderError,
} from '../lib/files/browse';
import {
  __setCloudFileConnectionDepsForTest,
  consumeCloudFileOAuthCompletion,
  consumeCloudFileOAuthState,
  disconnectCloudFileConnection,
  exchangeCloudFileAuthorizationCode,
  fetchCloudFileProvider,
  getCloudFileAccess,
  listCloudFileConnections,
  markCloudFileConnectionAccess,
  saveCloudFileConnection,
  saveCloudFileOAuthCompletion,
  saveCloudFileOAuthState,
} from '../lib/files/connections';

const originalEnvironment = {
  GOOGLE_DRIVE_CLIENT_ID: process.env.GOOGLE_DRIVE_CLIENT_ID,
  GOOGLE_DRIVE_CLIENT_SECRET: process.env.GOOGLE_DRIVE_CLIENT_SECRET,
  MICROSOFT_DRIVE_CLIENT_ID: process.env.MICROSOFT_DRIVE_CLIENT_ID,
  MICROSOFT_DRIVE_CLIENT_SECRET: process.env.MICROSOFT_DRIVE_CLIENT_SECRET,
};

beforeEach(() => {
  process.env.GOOGLE_DRIVE_CLIENT_ID = 'google-client';
  process.env.GOOGLE_DRIVE_CLIENT_SECRET = 'google-secret';
  process.env.MICROSOFT_DRIVE_CLIENT_ID = 'microsoft-client';
  process.env.MICROSOFT_DRIVE_CLIENT_SECRET = 'microsoft-secret';
});

afterEach(() => {
  __setCloudFileConnectionDepsForTest();
  __setCloudFileBrowseDepsForTest();
  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[key as keyof typeof originalEnvironment];
    else process.env[key as keyof typeof originalEnvironment] = value;
  }
});

describe('cloud file connection service', () => {
  test('persists and consumes one short-lived OAuth transaction', async () => {
    const mutation = mock(async (_reference: unknown, input: any) =>
      input.expiresAt
        ? undefined
        : {
            userId: 'user-1',
            provider: 'google_drive',
            redirectTo: '/?view=files',
            nativeCallback: true,
          },
    );
    __setCloudFileConnectionDepsForTest({
      convexMutation: mutation as any,
      now: () => 1_000,
    });

    const state = await saveCloudFileOAuthState({
      userId: 'user-1',
      provider: 'google_drive',
      redirectTo: '/?view=files',
      nativeCallback: true,
    });
    expect(state).toHaveLength(43);
    expect(mutation.mock.calls[0][1]).toMatchObject({
      userId: 'user-1',
      state,
      provider: 'google_drive',
      expiresAt: 601_000,
    });

    const consumed = await consumeCloudFileOAuthState(state);
    expect(consumed).toMatchObject({ userId: 'user-1', nativeCallback: true });
    expect(mutation.mock.calls[1][1]).toEqual({ state });
  });

  test('encrypts and user-binds native OAuth completion codes', async () => {
    const mutation = mock(async (_reference: unknown, input: any) =>
      input.authorizationCodeEncrypted
        ? { ok: true }
        : {
            provider: 'google_drive',
            authorizationCodeEncrypted: 'encrypted-provider-code',
          },
    );
    __setCloudFileConnectionDepsForTest({
      convexMutation: mutation as any,
      encryptSecret: (value: string) => `encrypted-${value}`,
      decryptSecret: () => 'provider-code',
      now: () => 2_000,
    });

    const completionToken = await saveCloudFileOAuthCompletion({
      userId: 'user-1',
      provider: 'google_drive',
      authorizationCode: 'provider-code',
    });
    expect(completionToken).toHaveLength(43);
    expect(mutation.mock.calls[0][1]).toMatchObject({
      userId: 'user-1',
      provider: 'google_drive',
      authorizationCodeEncrypted: 'encrypted-provider-code',
      expiresAt: 302_000,
    });

    await expect(
      consumeCloudFileOAuthCompletion({
        userId: 'user-1',
        completionToken,
      }),
    ).resolves.toEqual({
      provider: 'google_drive',
      authorizationCode: 'provider-code',
    });
    expect(mutation.mock.calls[1][1]).toEqual({
      userId: 'user-1',
      completionToken,
    });
  });

  test('exchanges provider codes and rejects missing or invalid credentials', async () => {
    const fetchMock = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = init?.body as URLSearchParams;
      expect(body.get('client_id')).toBe('google-client');
      expect(body.get('code')).toBe('authorization-code');
      expect(body.get('grant_type')).toBe('authorization_code');
      return Response.json({
        access_token: 'access-token',
        refresh_token: 'refresh-token',
        expires_in: 3600,
      });
    });
    __setCloudFileConnectionDepsForTest({ fetch: fetchMock as any });

    await expect(
      exchangeCloudFileAuthorizationCode({
        provider: 'google_drive',
        code: 'authorization-code',
      }),
    ).resolves.toMatchObject({ access_token: 'access-token' });

    __setCloudFileConnectionDepsForTest({
      fetch: mock(async () => Response.json({ error: 'invalid_grant' }, { status: 400 })) as any,
    });
    await expect(
      exchangeCloudFileAuthorizationCode({
        provider: 'google_drive',
        code: 'bad-code',
      }),
    ).rejects.toThrow('did not issue file access credentials');

    delete process.env.GOOGLE_DRIVE_CLIENT_SECRET;
    await expect(
      exchangeCloudFileAuthorizationCode({
        provider: 'google_drive',
        code: 'code',
      }),
    ).rejects.toThrow('Google Drive is not configured');
  });

  test('stores normalized Google and Microsoft profiles with encrypted tokens', async () => {
    const mutation = mock(async (_reference: unknown, input: any) => ({
      ok: true,
      connectionId: input.connectionId,
    }));
    const fetchMock = mock(async (url: string | URL | Request) => {
      const endpoint = String(url);
      if (endpoint.includes('googleapis.com')) {
        return Response.json({ id: 'google-account', email: 'drive@example.test', name: 'Drive User' });
      }
      return Response.json({
        id: 'microsoft-account',
        mail: null,
        userPrincipalName: 'onedrive@example.test',
        displayName: 'OneDrive User',
      });
    });
    __setCloudFileConnectionDepsForTest({
      convexMutation: mutation as any,
      encryptSecret: ((value: string) => `encrypted:${value}`) as any,
      fetch: fetchMock as any,
      now: () => 10_000,
    });

    const google = await saveCloudFileConnection({
      userId: 'user-1',
      provider: 'google_drive',
      tokens: {
        access_token: 'google-access',
        refresh_token: 'google-refresh',
        expires_in: 120,
        scope: 'openid email',
      },
    });
    const microsoft = await saveCloudFileConnection({
      userId: 'user-1',
      provider: 'onedrive',
      tokens: { access_token: 'ms-access' },
    });

    expect(google).toMatchObject({
      accountKey: 'google-account',
      accountEmail: 'drive@example.test',
      displayName: 'Drive User',
    });
    expect(microsoft).toMatchObject({
      accountKey: 'microsoft-account',
      accountEmail: 'onedrive@example.test',
    });
    expect(mutation.mock.calls[0][1]).toMatchObject({
      accessTokenEncrypted: 'encrypted:google-access',
      refreshTokenEncrypted: 'encrypted:google-refresh',
      expiresAt: 130_000,
      scopes: ['openid', 'email'],
    });
    expect(mutation.mock.calls[1][1].scopes).toContain('Files.ReadWrite');
  });

  test('returns live access and refreshes near-expiry OneDrive credentials', async () => {
    const mutation = mock(async () => ({ ok: true }));
    const rows = [
      null,
      {
        connection: {
          connectionId: 'google-1',
          provider: 'google_drive',
          status: 'connected',
          scopes: [],
        },
        credentials: { accessTokenEncrypted: 'encrypted:live', expiresAt: 500_000 },
      },
      {
        connection: {
          connectionId: 'onedrive-1',
          provider: 'onedrive',
          status: 'connected',
          scopes: [],
        },
        credentials: {
          accessTokenEncrypted: 'encrypted:expired',
          refreshTokenEncrypted: 'encrypted:refresh',
          expiresAt: 50_000,
        },
      },
    ];
    const query = mock(async () => rows.shift() as any);
    const fetchMock = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = init?.body as URLSearchParams;
      expect(body.get('refresh_token')).toBe('refresh');
      expect(body.get('scope')).toContain('Files.ReadWrite');
      return Response.json({
        access_token: 'refreshed-access',
        refresh_token: 'rotated-refresh',
        expires_in: 60,
      });
    });
    __setCloudFileConnectionDepsForTest({
      convexMutation: mutation as any,
      convexQuery: query as any,
      decryptSecret: ((value: string) => value.replace('encrypted:', '')) as any,
      encryptSecret: ((value: string) => `encrypted:${value}`) as any,
      fetch: fetchMock as any,
      now: () => 100_000,
    });

    await expect(getCloudFileAccess({ userId: 'user-1', connectionId: 'missing' })).resolves.toBeNull();
    await expect(getCloudFileAccess({ userId: 'user-1', connectionId: 'google-1' })).resolves.toMatchObject({
      accessToken: 'live',
    });
    await expect(getCloudFileAccess({ userId: 'user-1', connectionId: 'onedrive-1' })).resolves.toMatchObject(
      { accessToken: 'refreshed-access' },
    );
    expect(mutation.mock.calls[0][1]).toMatchObject({
      connectionId: 'onedrive-1',
      accessTokenEncrypted: 'encrypted:refreshed-access',
      refreshTokenEncrypted: 'encrypted:rotated-refresh',
      expiresAt: 160_000,
    });
  });

  test('serializes concurrent refreshes and rejects a refresh that was not persisted', async () => {
    const row = {
      connection: {
        connectionId: 'google-1',
        provider: 'google_drive' as const,
        status: 'connected' as const,
        scopes: [],
      },
      credentials: {
        accessTokenEncrypted: 'encrypted:expired',
        refreshTokenEncrypted: 'encrypted:refresh',
        expiresAt: 1,
      },
    };
    const fetchMock = mock(async () =>
      Response.json({ access_token: 'fresh-access', refresh_token: 'fresh-refresh', expires_in: 60 }),
    );
    const mutation = mock(async () => ({ ok: true }));
    __setCloudFileConnectionDepsForTest({
      convexMutation: mutation as any,
      convexQuery: (async () => row) as any,
      decryptSecret: ((value: string) => value.replace('encrypted:', '')) as any,
      encryptSecret: ((value: string) => `encrypted:${value}`) as any,
      fetch: fetchMock as any,
      now: () => 100_000,
    });

    const [first, second] = await Promise.all([
      getCloudFileAccess({ userId: 'user-1', connectionId: 'google-1' }),
      getCloudFileAccess({ userId: 'user-1', connectionId: 'google-1' }),
    ]);
    expect(first?.accessToken).toBe('fresh-access');
    expect(second?.accessToken).toBe('fresh-access');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mutation).toHaveBeenCalledTimes(1);

    __setCloudFileConnectionDepsForTest({
      convexMutation: (async () => ({ ok: false })) as any,
      convexQuery: (async () => row) as any,
      decryptSecret: ((value: string) => value.replace('encrypted:', '')) as any,
      encryptSecret: ((value: string) => `encrypted:${value}`) as any,
      fetch: fetchMock as any,
      now: () => 100_000,
    });
    await expect(getCloudFileAccess({ userId: 'user-1', connectionId: 'google-1' })).rejects.toThrow(
      'Reconnect this account',
    );
  });

  test('adds provider timeouts without overriding a caller signal', async () => {
    const fetchMock = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return Response.json({ ok: true });
    });
    await fetchCloudFileProvider(fetchMock as any, 'https://provider.example.test');

    const controller = new AbortController();
    await fetchCloudFileProvider(fetchMock as any, 'https://provider.example.test', {
      signal: controller.signal,
    });
    expect(fetchMock.mock.calls[1][1]?.signal).toBe(controller.signal);

    await expect(
      fetchCloudFileProvider(
        (async () => {
          throw Object.assign(new Error('aborted'), { name: 'TimeoutError' });
        }) as any,
        'https://provider.example.test',
      ),
    ).rejects.toThrow('provider request timed out');
  });

  test('fails expired credentials without a refresh token or after a rejected refresh', async () => {
    const row = {
      connection: {
        connectionId: 'google-1',
        provider: 'google_drive',
        status: 'connected',
        scopes: [],
      },
      credentials: { accessTokenEncrypted: 'encrypted:expired', expiresAt: 1 },
    };
    __setCloudFileConnectionDepsForTest({
      convexQuery: (async () => row) as any,
      decryptSecret: ((value: string) => value.replace('encrypted:', '')) as any,
      now: () => 100_000,
    });
    await expect(getCloudFileAccess({ userId: 'user-1', connectionId: 'google-1' })).rejects.toThrow(
      'Reconnect this account',
    );

    row.credentials = {
      accessTokenEncrypted: 'encrypted:expired',
      expiresAt: 1,
      refreshTokenEncrypted: 'encrypted:refresh',
    } as any;
    __setCloudFileConnectionDepsForTest({
      convexQuery: (async () => row) as any,
      decryptSecret: ((value: string) => value.replace('encrypted:', '')) as any,
      fetch: (async () => Response.json({ error: 'invalid_grant' }, { status: 400 })) as any,
      now: () => 100_000,
    });
    await expect(getCloudFileAccess({ userId: 'user-1', connectionId: 'google-1' })).rejects.toThrow(
      'File access expired',
    );
  });

  test('lists, disconnects, and records connection access state', async () => {
    const query = mock(async () => [
      {
        connectionId: 'google-1',
        provider: 'google_drive',
        status: 'connected',
        scopes: [],
      },
    ]);
    const mutation = mock(async () => undefined);
    __setCloudFileConnectionDepsForTest({
      convexMutation: mutation as any,
      convexQuery: query as any,
    });

    await expect(listCloudFileConnections('user-1')).resolves.toHaveLength(1);
    await disconnectCloudFileConnection('user-1', 'google-1');
    await markCloudFileConnectionAccess('user-1', 'google-1', 'provider unavailable');
    expect(mutation.mock.calls[0][1]).toEqual({
      userId: 'user-1',
      connectionId: 'google-1',
    });
    expect(mutation.mock.calls[1][1]).toMatchObject({ error: 'provider unavailable' });
  });
});

describe('cloud file browsing service', () => {
  test('builds bounded Google search and folder requests and records success', async () => {
    const accessed = mock(async () => undefined);
    const fetchMock = mock(async (url: string | URL | Request) => {
      const parsed = new URL(String(url));
      expect(parsed.hostname).toBe('www.googleapis.com');
      expect(parsed.searchParams.get('q')).toContain("name contains 'O\\'Reilly'");
      return Response.json({
        nextPageToken: 'next',
        files: [{ id: 'file-1', name: 'Plan', mimeType: 'application/pdf' }],
      });
    });
    __setCloudFileBrowseDepsForTest({
      getCloudFileAccess: (async () => ({
        connection: {
          connectionId: 'google-1',
          provider: 'google_drive',
          status: 'connected',
          scopes: [],
        },
        accessToken: 'access',
      })) as any,
      markCloudFileConnectionAccess: accessed as any,
      fetch: fetchMock as any,
    });

    const page = await browseCloudFiles({
      userId: 'user-1',
      connectionId: 'google-1',
      folderId: 'ignored-for-search',
      query: `  O'Reilly  `,
      cursor: 'page-token',
    });
    expect(page.items[0]).toMatchObject({ id: 'file-1', provider: 'google_drive' });
    expect(page.nextCursor).toBe('next');
    expect(accessed).toHaveBeenCalledWith('user-1', 'google-1');
  });

  test('uses safe OneDrive cursors and marks provider failures', async () => {
    const accessed = mock(async () => undefined);
    const fetchMock = mock(async (url: string | URL | Request) => {
      expect(String(url)).toContain('/drive/items/folder-1/children');
      return Response.json({ error: 'expired' }, { status: 401 });
    });
    __setCloudFileBrowseDepsForTest({
      getCloudFileAccess: (async () => ({
        connection: {
          connectionId: 'onedrive-1',
          provider: 'onedrive',
          status: 'connected',
          scopes: [],
        },
        accessToken: 'access',
      })) as any,
      markCloudFileConnectionAccess: accessed as any,
      fetch: fetchMock as any,
    });

    await expect(
      browseCloudFiles({
        userId: 'user-1',
        connectionId: 'onedrive-1',
        folderId: 'folder-1',
      }),
    ).rejects.toThrow('File access expired');
    expect(accessed.mock.calls[0][2]).toContain('Reconnect');

    await expect(
      browseCloudFiles({
        userId: 'user-1',
        connectionId: 'onedrive-1',
        cursor: 'https://attacker.example.test/page',
      }),
    ).rejects.toThrow('Invalid OneDrive page cursor');
  });

  test('normalizes OneDrive search results and rejects missing connections', async () => {
    __setCloudFileBrowseDepsForTest({
      getCloudFileAccess: (async (input: any) =>
        input.connectionId === 'missing'
          ? null
          : {
              connection: {
                connectionId: 'onedrive-1',
                provider: 'onedrive',
                status: 'connected',
                scopes: [],
              },
              accessToken: 'access',
            }) as any,
      markCloudFileConnectionAccess: (async () => undefined) as any,
      fetch: (async (url: string | URL | Request) => {
        expect(String(url)).toContain("/root/search(q='quarterly%20plan')");
        return Response.json({
          value: [{ id: 'file-1', name: 'Quarterly plan', file: { mimeType: 'text/plain' } }],
        });
      }) as any,
    });

    await expect(browseCloudFiles({ userId: 'user-1', connectionId: 'missing' })).rejects.toThrow(
      'File connection not found',
    );
    const result = await browseCloudFiles({
      userId: 'user-1',
      connectionId: 'onedrive-1',
      query: 'quarterly plan',
    });
    expect(result.items[0]).toMatchObject({ provider: 'onedrive', name: 'Quarterly plan' });
  });

  test('resolves shared-drive folder shortcuts before listing their children', async () => {
    const requests: string[] = [];
    __setCloudFileBrowseDepsForTest({
      getCloudFileAccess: (async () => ({
        connection: {
          connectionId: 'google-1',
          provider: 'google_drive',
          status: 'connected',
          scopes: [],
        },
        accessToken: 'access',
      })) as any,
      markCloudFileConnectionAccess: (async () => undefined) as any,
      fetch: (async (url: string | URL | Request) => {
        const endpoint = String(url);
        requests.push(endpoint);
        if (endpoint.includes('/drive/v3/files/shortcut-folder?')) {
          return Response.json({
            id: 'shortcut-folder',
            mimeType: 'application/vnd.google-apps.shortcut',
            driveId: 'shared-drive-1',
            shortcutDetails: {
              targetId: 'real-folder',
              targetMimeType: 'application/vnd.google-apps.folder',
            },
          });
        }
        return Response.json({
          files: [{ id: 'file-1', name: 'Shared plan', mimeType: 'application/pdf' }],
        });
      }) as any,
    });

    const page = await browseCloudFiles({
      userId: 'user-1',
      connectionId: 'google-1',
      folderId: 'shortcut-folder',
    });
    const listURL = new URL(requests[1]);
    expect(listURL.searchParams.get('q')).toContain("'real-folder' in parents");
    expect(listURL.searchParams.get('corpora')).toBe('drive');
    expect(listURL.searchParams.get('driveId')).toBe('shared-drive-1');
    expect(page.items[0]?.name).toBe('Shared plan');
  });

  test('preserves actionable Google provider failures', async () => {
    __setCloudFileBrowseDepsForTest({
      getCloudFileAccess: (async () => ({
        connection: {
          connectionId: 'google-1',
          provider: 'google_drive',
          status: 'connected',
          scopes: [],
        },
        accessToken: 'access',
      })) as any,
      markCloudFileConnectionAccess: (async () => undefined) as any,
      fetch: (async () =>
        Response.json(
          { error: { message: 'Invalid folder query', errors: [{ reason: 'invalidParameter' }] } },
          { status: 400 },
        )) as any,
    });

    const error = await browseCloudFiles({
      userId: 'user-1',
      connectionId: 'google-1',
      query: 'plan',
    }).catch((caught) => caught);
    expect(error).toBeInstanceOf(CloudFileProviderError);
    expect(error).toMatchObject({
      status: 400,
      code: 'INVALID_REQUEST',
      providerStatus: 400,
      providerReason: 'invalidParameter',
    });
  });
});
