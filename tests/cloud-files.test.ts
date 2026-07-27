import { describe, expect, test } from 'bun:test';
import { NextRequest } from 'next/server';
import { cloudFileBrowseErrorResponse } from '../app/api/files/browse/route';
import { createCloudFileOAuthCallback } from '../app/api/files/oauth/callback/route';
import { createCloudFileOAuthFinalize } from '../app/api/files/oauth/finalize/route';
import { createCloudFileOAuthStart } from '../app/api/files/oauth/start/route';
import {
  buildCloudFileAuthorizationUrl,
  escapeGoogleDriveQuery,
  normalizeGoogleDrivePage,
  normalizeOneDrivePage,
} from '../lib/files/providers';

describe('cloud file provider contracts', () => {
  test('Google authorization is offline, writable, and state-bound', () => {
    const url = new URL(
      buildCloudFileAuthorizationUrl({
        provider: 'google_drive',
        state: 'state_123',
        clientId: 'google_client',
        redirectUri: 'https://mail.example.test/api/files/oauth/callback',
      }),
    );

    expect(url.origin).toBe('https://accounts.google.com');
    expect(url.searchParams.get('state')).toBe('state_123');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('scope')).toContain('drive.readonly');
    expect(url.searchParams.get('scope')).toContain('drive.file');
    expect(url.searchParams.get('scope')).toContain('/auth/documents');
    expect(url.searchParams.get('scope')).toContain('/auth/spreadsheets');
    expect(url.searchParams.get('scope')).toContain('/auth/presentations');
    expect(url.searchParams.has('include_granted_scopes')).toBe(false);
  });

  test('OneDrive authorization asks for delegated read/write access', () => {
    const url = new URL(
      buildCloudFileAuthorizationUrl({
        provider: 'onedrive',
        state: 'state_456',
        clientId: 'microsoft_client',
        redirectUri: 'https://mail.example.test/api/files/oauth/callback',
      }),
    );

    expect(url.hostname).toBe('login.microsoftonline.com');
    expect(url.searchParams.get('scope')).toContain('Files.ReadWrite');
  });

  test('normalizes Google Drive folders and files without provider payload leakage', () => {
    const page = normalizeGoogleDrivePage(
      {
        nextPageToken: 'next_google',
        files: [
          {
            id: 'folder_1',
            name: 'Briefs',
            mimeType: 'application/vnd.google-apps.folder',
            modifiedTime: '2026-07-26T12:00:00.000Z',
            owners: [{ displayName: 'Jamie' }],
            ignoredSecret: 'never-return-this',
          },
          {
            id: 'file_1',
            name: 'Q3 plan.pdf',
            mimeType: 'application/pdf',
            size: '2048',
            webViewLink: 'https://drive.google.com/file/d/file_1/view',
          },
        ],
      },
      'google_drive_account',
    );

    expect(page.nextCursor).toBe('next_google');
    expect(page.items).toHaveLength(2);
    expect(page.items[0]).toMatchObject({
      id: 'folder_1',
      provider: 'google_drive',
      isFolder: true,
      owner: 'Jamie',
    });
    expect(page.items[1]).toMatchObject({
      id: 'file_1',
      size: 2048,
      isFolder: false,
    });
    expect(JSON.stringify(page)).not.toContain('ignoredSecret');
  });

  test('normalizes OneDrive folders, thumbnails, and opaque pagination', () => {
    const page = normalizeOneDrivePage(
      {
        '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/drive/root/children?$skiptoken=opaque',
        value: [
          { id: 'folder_1', name: 'Projects', folder: { childCount: 3 }, size: 0 },
          {
            id: 'file_1',
            name: 'Launch.png',
            size: 1234,
            file: { mimeType: 'image/png' },
            webUrl: 'https://onedrive.live.com/file_1',
            thumbnails: [{ medium: { url: 'https://thumb.example.test/file_1' } }],
          },
        ],
      },
      'onedrive_account',
    );

    expect(page.items[0].isFolder).toBe(true);
    expect(page.items[1]).toMatchObject({
      provider: 'onedrive',
      mimeType: 'image/png',
      thumbnailUrl: 'https://thumb.example.test/file_1',
    });
    expect(page.nextCursor).toContain('$skiptoken=opaque');
  });

  test('escapes Drive search fragments before adding them to q', () => {
    expect(escapeGoogleDriveQuery("O'Reilly\\draft")).toBe("O\\'Reilly\\\\draft");
  });

  test('maps cursor, reconnect, missing, and provider failures to distinct responses', async () => {
    const cursor = cloudFileBrowseErrorResponse(new Error('Invalid OneDrive page cursor.'));
    const reconnect = cloudFileBrowseErrorResponse(new Error('File access expired. Reconnect this account.'));
    const missing = cloudFileBrowseErrorResponse(new Error('File connection not found.'));
    const provider = cloudFileBrowseErrorResponse(new Error('Provider unavailable.'));

    expect(cursor.status).toBe(400);
    expect(reconnect.status).toBe(409);
    expect(await reconnect.json()).toMatchObject({ code: 'RECONNECT_REQUIRED' });
    expect(missing.status).toBe(404);
    expect(provider.status).toBe(502);
  });
});

describe('cloud file OAuth routes', () => {
  const user = {
    userId: 'user_files',
    email: 'files@example.test',
    name: 'Files User',
    source: 'clerk' as const,
  };

  test('start persists a safe return path and redirects to the provider', async () => {
    const calls: any[] = [];
    const handler = createCloudFileOAuthStart({
      requireCurrentUser: async () => user,
      enforceUserRateLimit: async () => ({ ok: true }) as any,
      cloudFileProviderDefinition: () =>
        ({
          id: 'google_drive',
          label: 'Google Drive',
        }) as any,
      cloudFileProviderCredentials: () => ({
        clientId: 'client',
        clientSecret: 'secret',
      }),
      saveCloudFileOAuthState: async (input: any) => {
        calls.push(input);
        return 'state_1';
      },
      buildCloudFileAuthorizationUrl: () => 'https://accounts.google.com/authorize',
    } as any);

    const response = await handler(
      new NextRequest(
        'http://localhost/api/files/oauth/start?provider=google_drive&redirectTo=https://evil.example',
      ),
    );

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('https://accounts.google.com/authorize');
    expect(calls[0]).toMatchObject({
      userId: user.userId,
      provider: 'google_drive',
      redirectTo: '/',
    });
  });

  test('callback consumes state once and never reflects provider errors', async () => {
    let exchanges = 0;
    const handler = createCloudFileOAuthCallback({
      consumeCloudFileOAuthState: async () => ({
        userId: user.userId,
        provider: 'onedrive' as const,
        redirectTo: '/?view=files',
      }),
      exchangeCloudFileAuthorizationCode: async () => {
        exchanges += 1;
        return { access_token: 'token' };
      },
      saveCloudFileConnection: async () => ({
        connectionId: 'onedrive_1',
        accountKey: 'account_1',
      }),
    } as any);

    const response = await handler(
      new NextRequest(
        'http://localhost/api/files/oauth/callback?state=state_1&error_description=private_provider_detail',
      ),
    );
    const location = response.headers.get('location') || '';

    expect(location).toContain('files_error=Authorization+was+not+completed');
    expect(location).not.toContain('private_provider_detail');
    expect(exchanges).toBe(0);
  });

  test('callback rejects a missing, expired, or code-less OAuth transaction before exchange', async () => {
    let exchanges = 0;
    const handler = createCloudFileOAuthCallback({
      consumeCloudFileOAuthState: async (state: string) =>
        state === 'missing-state'
          ? null
          : {
              userId: user.userId,
              provider: 'google_drive' as const,
              redirectTo: '/?view=files',
            },
      exchangeCloudFileAuthorizationCode: async () => {
        exchanges += 1;
        return { access_token: 'token' };
      },
      saveCloudFileConnection: async () => ({
        connectionId: 'google_1',
        accountKey: 'account_1',
      }),
    } as any);

    const noState = await handler(new NextRequest('http://localhost/api/files/oauth/callback?code=code'));
    const expired = await handler(
      new NextRequest('http://localhost/api/files/oauth/callback?state=missing-state&code=code'),
    );
    const noCode = await handler(
      new NextRequest('http://localhost/api/files/oauth/callback?state=live-state'),
    );

    expect(noState.headers.get('location')).toContain('files_error=Missing+OAuth+state');
    expect(expired.headers.get('location')).toContain('files_error=OAuth+state+is+invalid+or+expired');
    expect(noCode.headers.get('location')).toContain(
      'files_error=The+provider+did+not+return+an+authorization+code',
    );
    expect(exchanges).toBe(0);
  });

  test('native start returns an authorization URL and marks the state for app callback', async () => {
    const calls: any[] = [];
    const handler = createCloudFileOAuthStart({
      requireCurrentUser: async () => user,
      enforceUserRateLimit: async () => ({ ok: true }) as any,
      cloudFileProviderDefinition: () => ({ id: 'google_drive', label: 'Google Drive' }) as any,
      cloudFileProviderCredentials: () => ({ clientId: 'client', clientSecret: 'secret' }),
      saveCloudFileOAuthState: async (input: any) => {
        calls.push(input);
        return 'state_native';
      },
      buildCloudFileAuthorizationUrl: () => 'https://accounts.google.com/authorize',
    } as any);

    const response = await handler(
      new NextRequest('http://localhost/api/files/oauth/start?provider=google_drive&native=1&format=json'),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      authorizationUrl: 'https://accounts.google.com/authorize',
    });
    expect(calls[0].nativeCallback).toBe(true);
  });

  test('native callback returns to the app URL scheme', async () => {
    let exchanges = 0;
    const handler = createCloudFileOAuthCallback({
      consumeCloudFileOAuthState: async () => ({
        userId: user.userId,
        provider: 'google_drive' as const,
        nativeCallback: true,
      }),
      saveCloudFileOAuthCompletion: async () => 'completion_token_12345678901234567890',
      exchangeCloudFileAuthorizationCode: async () => {
        exchanges += 1;
        return { access_token: 'token' };
      },
      saveCloudFileConnection: async () => ({
        connectionId: 'google_1',
        accountKey: 'account_1',
      }),
    } as any);

    const response = await handler(
      new NextRequest('http://localhost/api/files/oauth/callback?state=state_native&code=code'),
    );

    expect(response.headers.get('location')).toBe(
      'lab86://files?files_completion=completion_token_12345678901234567890',
    );
    expect(exchanges).toBe(0);
  });

  test('web callback requires the same live user before exchanging a provider code', async () => {
    let exchanges = 0;
    const dependencies = {
      consumeCloudFileOAuthState: async () => ({
        userId: user.userId,
        provider: 'google_drive' as const,
        redirectTo: '/?view=files',
      }),
      requireCurrentUser: async () => ({ ...user, userId: 'different_user' }),
      exchangeCloudFileAuthorizationCode: async () => {
        exchanges += 1;
        return { access_token: 'token' };
      },
      saveCloudFileConnection: async () => ({
        connectionId: 'google_1',
        accountKey: 'account_1',
      }),
    };
    const mismatch = await createCloudFileOAuthCallback(dependencies as any)(
      new NextRequest('http://localhost/api/files/oauth/callback?state=state_web&code=code'),
    );
    expect(mismatch.headers.get('location')).toContain('files_error=Sign+in+again');
    expect(exchanges).toBe(0);

    const success = await createCloudFileOAuthCallback({
      ...dependencies,
      requireCurrentUser: async () => user,
    } as any)(new NextRequest('http://localhost/api/files/oauth/callback?state=state_web&code=code'));
    expect(success.headers.get('location')).toContain('files_connected=Google+Drive');
    expect(exchanges).toBe(1);
  });

  test('native finalize is authenticated, user-bound, and single-use', async () => {
    let exchanges = 0;
    const handler = createCloudFileOAuthFinalize({
      requireCurrentUser: async () => user,
      enforceUserRateLimit: async () => ({ ok: true }) as any,
      consumeCloudFileOAuthCompletion: async (input: any) =>
        input.completionToken === 'valid_completion_token_1234567890'
          ? { provider: 'google_drive' as const, authorizationCode: 'provider-code' }
          : null,
      exchangeCloudFileAuthorizationCode: async ({ code }: any) => {
        exchanges += 1;
        expect(code).toBe('provider-code');
        return { access_token: 'token' };
      },
      saveCloudFileConnection: async () => ({
        connectionId: 'google_1',
        accountKey: 'account_1',
      }),
    } as any);
    const invalid = await handler(
      new NextRequest('http://localhost/api/files/oauth/finalize', {
        method: 'POST',
        body: JSON.stringify({ completionToken: 'invalid_completion_token_123456789' }),
      }),
    );
    expect(invalid.status).toBe(409);
    expect(exchanges).toBe(0);

    const success = await handler(
      new NextRequest('http://localhost/api/files/oauth/finalize', {
        method: 'POST',
        body: JSON.stringify({ completionToken: 'valid_completion_token_1234567890' }),
      }),
    );
    expect(success.status).toBe(200);
    expect(await success.json()).toMatchObject({
      ok: true,
      connected: 'Google Drive',
      connectionId: 'google_1',
    });
    expect(exchanges).toBe(1);
  });
});
