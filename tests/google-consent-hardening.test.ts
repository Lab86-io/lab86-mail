import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { getFunctionName } from 'convex/server';
import { NextRequest } from 'next/server';
import { POST as publishToGoogle } from '../app/api/documents/[documentId]/google/route';
import { PATCH as saveGoogleEdit } from '../app/api/files/google/editor/route';
import { createCloudFileOAuthCallback } from '../app/api/files/oauth/callback/route';
import { createCloudFileOAuthFinalize } from '../app/api/files/oauth/finalize/route';
import { GET as filesStatus } from '../app/api/files/status/route';
import { createNylasConnectGet } from '../app/api/nylas/connect/route';
import * as currentUser from '../lib/auth/current-user';
import {
  CALENDAR_ACCESS_BANNER,
  CALENDAR_ACCESS_BODY,
  CALENDAR_ACCESS_TITLE,
  calendarReconnectHref,
} from '../lib/calendar/sync-copy';
import { __setGoogleDocumentDepsForTest } from '../lib/documents/google';
import * as documentService from '../lib/documents/service';
import {
  __setCloudFileConnectionDepsForTest,
  assertCloudFileConsent,
  driveWriteCheck,
  getCloudFileAccess,
  grantedCloudFileScopes,
  saveCloudFileConnection,
} from '../lib/files/connections';
import {
  DOCUMENTS_SCOPE,
  DRIVE_FILE_SCOPE,
  DRIVE_READ_REFUSED,
  DRIVE_READONLY_SCOPE,
  DRIVE_SCOPE,
  DriveCapabilityError,
  DriveConsentError,
  driveCapabilities,
  driveReconnectMessage,
  driveWriteRefusal,
  missingDriveCapabilities,
} from '../lib/files/drive-capabilities';
import { refreshTokenIdentifiers } from '../lib/google/token-identifiers';
import { NYLAS_NOT_CONFIGURED, nylasWithoutKeys, requireNylas } from '../lib/nylas/client';
import * as rateLimit from '../lib/rate-limit';

const USER = { userId: 'user-1', email: 'ann@example.com', name: 'Ann', source: 'clerk' as const };

const restores: Array<() => void> = [];
afterEach(() => {
  for (const restore of restores.splice(0).reverse()) restore();
  __setCloudFileConnectionDepsForTest();
  __setGoogleDocumentDepsForTest();
});

function signIn() {
  const user = spyOn(currentUser, 'requireCurrentUser').mockResolvedValue(USER as any);
  const limit = spyOn(rateLimit, 'enforceUserRateLimit').mockResolvedValue(undefined as any);
  restores.push(
    () => user.mockRestore(),
    () => limit.mockRestore(),
  );
}

function driveRows(rows: Array<Record<string, unknown>>) {
  __setCloudFileConnectionDepsForTest({
    convexQuery: (async (fn: unknown) => {
      expect(getFunctionName(fn as any)).toBe('cloudFiles:listConnections');
      return rows;
    }) as any,
  });
}

const readOnly = {
  connectionId: 'drive-ro',
  provider: 'google_drive',
  status: 'connected',
  scopes: [DRIVE_READONLY_SCOPE],
};
const docsOnly = { ...readOnly, connectionId: 'drive-docs', scopes: [DRIVE_READONLY_SCOPE, DOCUMENTS_SCOPE] };
const full = {
  ...readOnly,
  connectionId: 'drive-full',
  scopes: [DRIVE_READONLY_SCOPE, DRIVE_FILE_SCOPE, DOCUMENTS_SCOPE],
};

describe('Google Drive capabilities', () => {
  test('come from the scopes that the user gave', () => {
    expect(driveCapabilities([DRIVE_READONLY_SCOPE])).toEqual({
      read: true,
      createFiles: false,
      editDocs: false,
    });
    expect(driveCapabilities(full.scopes)).toEqual({ read: true, createFiles: true, editDocs: true });
    // The full drive scope of an old connection gives everything.
    expect(driveCapabilities([DRIVE_SCOPE])).toEqual({ read: true, createFiles: true, editDocs: true });
    expect(driveCapabilities(null)).toEqual({ read: false, createFiles: false, editDocs: false });
    expect(missingDriveCapabilities([DRIVE_READONLY_SCOPE])).toEqual(['createFiles', 'editDocs']);
    expect(missingDriveCapabilities(docsOnly.scopes)).toEqual(['createFiles']);
    expect(missingDriveCapabilities(undefined)).toEqual(['createFiles', 'editDocs']);
  });

  test('the reconnect message names what is missing, in plain words', () => {
    expect(driveReconnectMessage(['createFiles'])).toBe(
      'Reconnect Google Drive to let Albatross make new Google files.',
    );
    expect(driveReconnectMessage(['createFiles', 'editDocs'])).toBe(
      'Reconnect Google Drive to let Albatross make new Google files and save edits to Google Docs.',
    );
    expect(driveReconnectMessage([])).toBe('');
    for (const text of [DRIVE_READ_REFUSED, driveReconnectMessage(['createFiles', 'editDocs'])]) {
      expect(text).not.toMatch(/\bAI\b/);
    }
    const error = new DriveCapabilityError('editDocs');
    expect(error).toMatchObject({ status: 403, code: 'GOOGLE_DRIVE_RECONNECT', capability: 'editDocs' });
    expect(new DriveConsentError().message).toBe(DRIVE_READ_REFUSED);
  });

  test('a write is refused only when Google would refuse it for certain', () => {
    const ro = [DRIVE_READONLY_SCOPE];
    expect(driveWriteRefusal({ scopes: ro, newFile: true, kind: 'doc' })).toBe('createFiles');
    expect(driveWriteRefusal({ scopes: docsOnly.scopes, newFile: true, kind: 'doc' })).toBeNull();
    expect(driveWriteRefusal({ scopes: docsOnly.scopes, newFile: true, kind: 'sheet' })).toBe('createFiles');
    expect(driveWriteRefusal({ scopes: full.scopes, newFile: true, kind: 'deck' })).toBeNull();
    expect(driveWriteRefusal({ scopes: ro, newFile: false, kind: 'doc' })).toBe('editDocs');
    // drive.file can save a Doc that Albatross made; Google decides.
    expect(
      driveWriteRefusal({ scopes: [DRIVE_READONLY_SCOPE, DRIVE_FILE_SCOPE], newFile: false, kind: 'doc' }),
    ).toBeNull();
    expect(driveWriteRefusal({ scopes: ro, newFile: false, kind: 'sheet' })).toBe('createFiles');
    expect(driveWriteRefusal({ scopes: full.scopes, newFile: false, kind: 'sheet' })).toBeNull();
  });
});

describe('Google Drive consent', () => {
  test('a consent without drive.readonly is refused before anything is stored', async () => {
    const mutation = mock(async () => ({ ok: true }));
    const fetchMock = mock(async () => Response.json({ id: '1' }));
    __setCloudFileConnectionDepsForTest({ convexMutation: mutation as any, fetch: fetchMock as any });
    await expect(
      saveCloudFileConnection({
        userId: 'user-1',
        provider: 'google_drive',
        tokens: {
          access_token: 'a',
          refresh_token: 'r',
          scope: `openid email ${DRIVE_FILE_SCOPE} ${DOCUMENTS_SCOPE}`,
        },
      }),
    ).rejects.toBeInstanceOf(DriveConsentError);
    expect(mutation).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('read access alone connects; the missing write access is shown, not refused', () => {
    expect(() => assertCloudFileConsent('google_drive', { scope: DRIVE_READONLY_SCOPE })).not.toThrow();
    expect(() => assertCloudFileConsent('google_drive', { scope: DRIVE_SCOPE })).not.toThrow();
    // No scope field: Google sent the requested scopes.
    expect(() => assertCloudFileConsent('google_drive', {})).not.toThrow();
    expect(() => assertCloudFileConsent('onedrive', { scope: 'User.Read' })).not.toThrow();
    expect(grantedCloudFileScopes('google_drive', {})).toContain(DRIVE_READONLY_SCOPE);
  });

  test('the web callback shows the refusal, and the native finalize returns it', async () => {
    const refuse = async () => {
      throw new DriveConsentError();
    };
    const callback = createCloudFileOAuthCallback({
      consumeCloudFileOAuthState: async () => ({
        userId: USER.userId,
        provider: 'google_drive' as const,
        redirectTo: '/?view=files',
      }),
      requireCurrentUser: async () => USER,
      exchangeCloudFileAuthorizationCode: async () => ({ access_token: 'a', scope: DRIVE_FILE_SCOPE }),
      saveCloudFileConnection: refuse,
    } as any);
    const redirect = await callback(
      new NextRequest('http://localhost/api/files/oauth/callback?state=s&code=c'),
    );
    const location = new URL(redirect.headers.get('location') || '');
    expect(location.searchParams.get('files_error')).toBe(DRIVE_READ_REFUSED);

    const finalize = createCloudFileOAuthFinalize({
      requireCurrentUser: async () => USER,
      enforceUserRateLimit: async () => ({ ok: true }) as any,
      consumeCloudFileOAuthCompletion: async () => ({
        provider: 'google_drive' as const,
        authorizationCode: 'c',
      }),
      exchangeCloudFileAuthorizationCode: async () => ({ access_token: 'a' }),
      saveCloudFileConnection: refuse,
    } as any);
    const response = await finalize(
      new NextRequest('http://localhost/api/files/oauth/finalize', {
        method: 'POST',
        body: JSON.stringify({ completionToken: 'valid_completion_token_1234567890' }),
      }),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ ok: false, error: DRIVE_READ_REFUSED });
  });

  test('a Google Drive refresh stores the identifiers of the refresh token in use', async () => {
    const mutation = mock(async (..._args: unknown[]) => ({ ok: true }));
    __setCloudFileConnectionDepsForTest({
      convexMutation: mutation as any,
      convexQuery: (async () => ({
        connection: { connectionId: 'drive-1', provider: 'google_drive', status: 'connected', scopes: [] },
        credentials: {
          accessTokenEncrypted: 'enc:old',
          refreshTokenEncrypted: 'enc:1//0g-drive',
          expiresAt: 1,
        },
      })) as any,
      decryptSecret: ((value: string) => value.replace('enc:', '')) as any,
      encryptSecret: ((value: string) => `enc:${value}`) as any,
      fetch: (async () => Response.json({ access_token: 'fresh', expires_in: 3600 })) as any,
      now: () => 10_000,
    });
    const saved = [process.env.GOOGLE_DRIVE_CLIENT_ID, process.env.GOOGLE_DRIVE_CLIENT_SECRET];
    process.env.GOOGLE_DRIVE_CLIENT_ID = 'drive-client';
    process.env.GOOGLE_DRIVE_CLIENT_SECRET = 'drive-secret';
    restores.push(() => {
      for (const [key, value] of [
        ['GOOGLE_DRIVE_CLIENT_ID', saved[0]],
        ['GOOGLE_DRIVE_CLIENT_SECRET', saved[1]],
      ] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
    expect(await getCloudFileAccess({ userId: 'user-1', connectionId: 'drive-1' })).toMatchObject({
      accessToken: 'fresh',
    });
    expect(mutation.mock.calls[0]?.[1]).toMatchObject({
      accessTokenEncrypted: 'enc:fresh',
      ...refreshTokenIdentifiers('1//0g-drive'),
    });
  });
});

describe('driveWriteCheck', () => {
  test('uses the publish choice of connection: named, linked, then the first Google Drive', async () => {
    driveRows([{ connectionId: 'one', provider: 'onedrive', scopes: [] }, readOnly, full]);
    expect(await driveWriteCheck({ userId: 'u', kind: 'doc' })).toBeInstanceOf(DriveCapabilityError);
    expect(await driveWriteCheck({ userId: 'u', connectionId: 'drive-full', kind: 'doc' })).toBeNull();
    const linked = await driveWriteCheck({
      userId: 'u',
      kind: 'doc',
      linked: { connectionId: 'drive-ro', fileId: 'doc-1' },
    });
    expect(linked?.capability).toBe('editDocs');
    // A file linked to another connection is a new file for this one.
    const moved = await driveWriteCheck({
      userId: 'u',
      connectionId: 'drive-ro',
      kind: 'sheet',
      linked: { connectionId: 'drive-full', fileId: 'sheet-1' },
    });
    expect(moved?.capability).toBe('createFiles');
    expect(await driveWriteCheck({ userId: 'u', connectionId: 'one', kind: 'doc' })).toBeNull();
    expect(await driveWriteCheck({ userId: 'u', connectionId: 'missing', kind: 'doc' })).toBeNull();
  });

  test('a failed lookup lets Google decide', async () => {
    __setCloudFileConnectionDepsForTest({
      convexQuery: (async () => {
        throw new Error('convex down');
      }) as any,
    });
    expect(await driveWriteCheck({ userId: 'u', kind: 'doc' })).toBeNull();
  });
});

describe('the write routes show "Reconnect Google Drive to let Albatross ..."', () => {
  test('the Google editor refuses a Doc save without write access, before any Google call', async () => {
    signIn();
    driveRows([readOnly]);
    const access = mock(async () => {
      throw new Error('must not read Google');
    });
    __setGoogleDocumentDepsForTest({ getCloudFileAccess: access as any });
    const response = await saveGoogleEdit(
      new NextRequest('http://localhost/api/files/google/editor', {
        method: 'PATCH',
        body: JSON.stringify({
          connectionId: 'drive-ro',
          fileId: 'doc-1',
          mimeType: 'application/vnd.google-apps.document',
          title: 'Plan',
          model: { kind: 'doc', version: 1, blocks: [] },
          expectedProviderVersion: '3',
        }),
      }),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      ok: false,
      error: 'Reconnect Google Drive to let Albatross save edits to Google Docs.',
      code: 'GOOGLE_DRIVE_RECONNECT',
    });
    expect(access).not.toHaveBeenCalled();
  });

  test('Publish to Google refuses a new Sheet without drive.file', async () => {
    signIn();
    driveRows([docsOnly]);
    const document = spyOn(documentService, 'getDocument').mockResolvedValue({
      documentId: 'd1',
      kind: 'sheet',
      title: 'Budget',
      model: { kind: 'sheet' },
      currentRevision: 1,
    } as any);
    restores.push(() => document.mockRestore());
    const response = await publishToGoogle(
      new NextRequest('http://localhost/api/documents/d1/google', { method: 'POST', body: '{}' }),
      { params: Promise.resolve({ documentId: 'd1' }) },
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: 'Reconnect Google Drive to let Albatross make new Google files.',
      code: 'GOOGLE_DRIVE_RECONNECT',
    });
  });

  test('the Files status lists the missing write access of each Google Drive connection', async () => {
    signIn();
    driveRows([
      readOnly,
      full,
      { connectionId: 'one', provider: 'onedrive', status: 'connected', scopes: [] },
    ]);
    const response = await filesStatus();
    const body = await response.json();
    expect(body.connections.map((row: any) => [row.connectionId, row.missingCapabilities])).toEqual([
      ['drive-ro', ['createFiles', 'editDocs']],
      ['drive-full', []],
      ['one', undefined],
    ]);
  });
});

describe('calendar access copy and reconnect link', () => {
  test('the link names the account, so it reconnects through its own transport', () => {
    expect(calendarReconnectHref({ provider: 'google', accountId: 'acct 1/2' })).toBe(
      '/api/nylas/connect?provider=google&account=acct+1%2F2&redirectTo=%2F',
    );
    expect(calendarReconnectHref({ accountId: 'a' }, '/?view=calendar')).toBe(
      '/api/nylas/connect?provider=google&account=a&redirectTo=%2F%3Fview%3Dcalendar',
    );
  });

  test('the copy does not blame old accounts and does not say AI', () => {
    for (const text of [CALENDAR_ACCESS_TITLE, CALENDAR_ACCESS_BODY, CALENDAR_ACCESS_BANNER]) {
      expect(text).not.toMatch(/\bAI\b|before calendar support/);
    }
    expect(CALENDAR_ACCESS_BODY).toContain('Reconnect the account and select calendar access.');
  });
});

describe('direct Google grants without Nylas keys', () => {
  test('a google: grant goes to the adapter; a Nylas grant gets the configuration error', async () => {
    const calls: any[] = [];
    const client = nylasWithoutKeys({
      messages: {
        list: async (args: any) => {
          calls.push(args);
          return { data: [], requestId: 'google-direct' };
        },
      },
    }) as any;
    expect(await client.messages.list({ identifier: 'google:abc' })).toEqual({
      data: [],
      requestId: 'google-direct',
    });
    expect(calls).toEqual([{ identifier: 'google:abc' }]);
    await expect(client.messages.list({ identifier: 'nylas-grant' })).rejects.toThrow(NYLAS_NOT_CONFIGURED);
    await expect(client.grants.destroy({ grantId: 'nylas-grant' })).rejects.toThrow(NYLAS_NOT_CONFIGURED);
    expect(() => client.auth).toThrow(NYLAS_NOT_CONFIGURED);
    expect(client.then).toBeUndefined();
    expect(client.messages.then).toBeUndefined();
  });

  test('requireNylas does not throw without NYLAS_API_KEY and NYLAS_CLIENT_ID', async () => {
    const saved = { key: process.env.NYLAS_API_KEY, id: process.env.NYLAS_CLIENT_ID };
    delete process.env.NYLAS_API_KEY;
    delete process.env.NYLAS_CLIENT_ID;
    try {
      const client = requireNylas() as any;
      expect(requireNylas()).toBe(client);
      await expect(client.threads.list({ identifier: 'nylas-grant' })).rejects.toThrow(NYLAS_NOT_CONFIGURED);
    } finally {
      if (saved.key !== undefined) process.env.NYLAS_API_KEY = saved.key;
      if (saved.id !== undefined) process.env.NYLAS_CLIENT_ID = saved.id;
    }
  });

  test('the connect route starts a direct Google sign-in without Nylas keys', async () => {
    let rateLimited = 0;
    const starts: any[] = [];
    const deps = (choice: any, googleConfigured = true) => ({
      requireCurrentUser: async () => USER,
      isNylasConfigured: () => false,
      enforceUserRateLimit: async () => {
        rateLimited += 1;
      },
      convexMutation: async () => ({ ok: true }),
      requireNylas: () => {
        throw new Error('must not use Nylas');
      },
      nylasRedirectUri: () => 'https://mail.example/api/nylas/callback',
      randomState: () => 'state',
      directGoogleConnectChoice: async () => choice,
      startGoogleMailConnect: async (input: any) => {
        starts.push(input);
        return { authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=g', mode: input.mode };
      },
      isGoogleDirectConfigured: () => googleConfigured,
    });
    const direct = await createNylasConnectGet(deps({ mode: 'reconnect', account: 'acct-1' }) as any)(
      new NextRequest('http://localhost/api/nylas/connect?provider=google&account=acct-1&format=json'),
    );
    expect(await direct.json()).toEqual({
      ok: true,
      authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=g',
    });
    expect(starts[0]).toMatchObject({ mode: 'reconnect', account: 'acct-1' });

    // No direct choice (a Nylas account with the flag off): the Nylas flow cannot run.
    const nylasAccount = await createNylasConnectGet(deps(null) as any)(
      new NextRequest('http://localhost/api/nylas/connect?provider=google&account=acct-9'),
    );
    expect(nylasAccount.status).toBe(503);

    // Another provider, or no Google client: refused before the rate limit.
    const before = rateLimited;
    for (const [url, configured] of [
      ['http://localhost/api/nylas/connect?provider=microsoft', true],
      ['http://localhost/api/nylas/connect?provider=google', false],
    ] as const) {
      const response = await createNylasConnectGet(deps({ mode: 'new' }, configured) as any)(
        new NextRequest(url),
      );
      expect(response.status).toBe(503);
    }
    expect(rateLimited).toBe(before);
  });
});
