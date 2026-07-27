import { describe, expect, test } from 'bun:test';
import { NextRequest } from 'next/server';
import { createCloudFileOAuthCallback } from '../app/api/files/oauth/callback/route';
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
    const handler = createCloudFileOAuthCallback({
      consumeCloudFileOAuthState: async () => ({
        userId: user.userId,
        provider: 'google_drive' as const,
        nativeCallback: true,
      }),
      exchangeCloudFileAuthorizationCode: async () => ({ access_token: 'token' }),
      saveCloudFileConnection: async () => ({
        connectionId: 'google_1',
        accountKey: 'account_1',
      }),
    } as any);

    const response = await handler(
      new NextRequest('http://localhost/api/files/oauth/callback?state=state_native&code=code'),
    );

    expect(response.headers.get('location')).toBe('lab86://files?files_connected=Google+Drive');
  });
});
