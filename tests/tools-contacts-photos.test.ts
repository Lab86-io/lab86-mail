import { describe, expect, mock, test } from 'bun:test';
import './tools/harness';
import { kvUpsert } from '../lib/store/kv';
import { getPhotoFromCache, setPhotoCache } from '../lib/store/photos';
import { contactLookup, expandAlias } from '../lib/tools/contacts';
import {
  companyLogoUrl,
  isCompanyDomain,
  logoDomainForEmail,
  photoUrlFromContact,
  resolvePhotoUrl,
  resolveProviderProfilePhoto,
  setPhotoResolutionDependenciesForTest,
} from '../lib/tools/photo-resolution';
import {
  resolvePhotos,
  setPhotoToolDependenciesForTest,
  withTimeout,
  withTimeoutResult,
} from '../lib/tools/photos';
import { runTool, withToolContext } from './tools/harness';

describe('contact and photo tools', () => {
  test('contact_lookup and expand_alias remain stubbed', async () => {
    expect(await runTool(contactLookup.handler, { account: 'jakob@example.test', query: 'alex' })).toEqual({
      contacts: [],
    });
    expect(await runTool(expandAlias.handler, { account: 'jakob@example.test', alias: 'alex' })).toEqual({
      email: null,
    });
  });

  test('resolve_photos dedupes emails and negative-caches misses', async () => {
    const first = await runTool(resolvePhotos.handler, {
      account: 'jakob@example.test',
      emails: ['Alex@Example.test', 'alex@example.test', 'missing@example.test'],
    });
    expect(first.photos['alex@example.test']).toBeNull();
    expect(first.photos['missing@example.test']).toBeNull();
    expect(Object.keys(first.photos)).toHaveLength(2);

    const second = await runTool(resolvePhotos.handler, {
      account: 'jakob@example.test',
      emails: ['alex@example.test'],
    });
    expect(second.photos['alex@example.test']).toBeNull();
  });

  test('resolve_photos falls back to company-domain logos for public domains', async () => {
    const result = await runTool(resolvePhotos.handler, {
      account: '__all__',
      emails: ['alerts@linear.app'],
    });
    expect(result.photos['alerts@linear.app']).toBe('/api/logos/linear.app');
  });

  test('resolve_photos reuses fresh public cache entries', async () => {
    await withToolContext(() =>
      setPhotoCache('alerts@linear.app', 'https://cdn.example/linear.png', 'company'),
    );

    const result = await runTool(resolvePhotos.handler, {
      account: '__all__',
      emails: ['alerts@linear.app'],
    });
    expect(result.photos['alerts@linear.app']).toBe('https://cdn.example/linear.png');
  });

  test('resolve_photos ignores legacy provider-scoped cache entries', async () => {
    await withToolContext(() =>
      kvUpsert('photo', 'friend@gmail.com', {
        email: 'friend@gmail.com',
        url: 'https://private.example/avatar.png',
        source: 'provider',
        version: 2,
        at: Date.now(),
      }),
    );

    const result = await runTool(resolvePhotos.handler, {
      account: '__all__',
      emails: ['friend@gmail.com'],
    });
    expect(result.photos['friend@gmail.com']).toBeNull();
    const refreshed = await withToolContext(() => getPhotoFromCache('friend@gmail.com'));
    expect(refreshed?.source).toBe('none');
  });

  test('resolve_photos retries legacy negative cache entries before falling back to initials', async () => {
    await withToolContext(() =>
      kvUpsert('photo', 'friend@gmail.com', {
        email: 'friend@gmail.com',
        url: null,
        at: Date.now(),
      }),
    );

    const result = await runTool(resolvePhotos.handler, {
      account: '__all__',
      emails: ['friend@gmail.com'],
    });
    expect(result.photos['friend@gmail.com']).toBeNull();
    const refreshed = await withToolContext(() => getPhotoFromCache('friend@gmail.com'));
    expect(refreshed?.version).toBe(2);
    expect(refreshed?.source).toBe('none');
  });

  test('resolve_photos caps provider lookups per batch', async () => {
    const contactsList = mock(async () => ({ data: [] }));
    const restore = setPhotoResolutionDependenciesForTest({
      isNylasConfigured: () => true,
      listNylasAccounts: async () => [{ accountId: 'test-google', authed: true }],
      resolveConnectedAccount: async () => ({
        userId: 'test_user_tools',
        accountId: 'test-google',
        email: 'jakob@gmail.com',
        provider: 'google',
        status: 'connected',
        displayName: 'Jakob',
        grantId: 'grant_google',
        scopes: [],
      }),
      requireNylas: () =>
        ({
          contacts: {
            list: contactsList,
            find: mock(async () => ({ data: null })),
          },
        }) as any,
    });
    const emails = Array.from({ length: 26 }, (_, index) => `person${index}@gmail.com`);
    try {
      const result = await runTool(resolvePhotos.handler, {
        account: '__all__',
        emails,
      });
      expect(Object.keys(result.photos)).toHaveLength(26);
      expect(contactsList).toHaveBeenCalledTimes(24);
      expect(result.photos['person24@gmail.com']).toBeNull();
      expect(result.photos['person25@gmail.com']).toBeNull();
    } finally {
      restore();
    }
  });

  test('withTimeout resolves values, rejected promises, and slow promises', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 50, 'fallback')).resolves.toBe('ok');
    await expect(withTimeout(Promise.reject(new Error('nope')), 50, 'fallback')).resolves.toBe('fallback');
    await expect(withTimeout(new Promise<string>(() => undefined), 1, 'fallback')).resolves.toBe('fallback');
  });

  test('withTimeoutResult distinguishes provider misses from failures', async () => {
    await expect(withTimeoutResult(Promise.resolve('ok'), 50, 'fallback')).resolves.toEqual({
      status: 'resolved',
      value: 'ok',
    });
    await expect(withTimeoutResult(Promise.reject(new Error('nope')), 50, 'fallback')).resolves.toEqual({
      status: 'rejected',
      value: 'fallback',
    });
    await expect(withTimeoutResult(new Promise<string>(() => undefined), 1, 'fallback')).resolves.toEqual({
      status: 'timeout',
      value: 'fallback',
    });
  });

  test('resolve_photos tries provider photos before company logos', async () => {
    const reset = setPhotoToolDependenciesForTest({
      resolveProviderProfilePhoto: async () => 'https://cdn.example/alex.png',
      companyLogoUrl: () => '/api/logos/microsoft.com',
    });
    try {
      const result = await runTool(resolvePhotos.handler, {
        account: 'jakob@example.test',
        emails: ['alex@microsoft.com'],
      });
      expect(result.photos['alex@microsoft.com']).toBe('https://cdn.example/alex.png');
      const cached = await withToolContext(() => getPhotoFromCache('alex@microsoft.com'));
      expect(cached).toBeNull();
    } finally {
      reset();
    }
  });

  test('resolve_photos does not negative-cache provider timeouts', async () => {
    const reset = setPhotoToolDependenciesForTest({
      providerLookupTimeoutMs: 1,
      companyLogoUrl: () => null,
      resolveProviderProfilePhoto: async () => new Promise<string | null>(() => undefined),
    });
    try {
      const email = 'slow-provider@example.net';
      const result = await runTool(resolvePhotos.handler, {
        account: 'jakob@example.test',
        emails: [email],
      });
      expect(result.photos[email]).toBeNull();
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(await withToolContext(() => getPhotoFromCache(email))).toBeNull();
    } finally {
      reset();
    }
  });

  test('resolveProviderProfilePhoto normalizes provider contact lookups', async () => {
    let queriedEmail = '';
    const reset = setPhotoResolutionDependenciesForTest({
      isNylasConfigured: () => true,
      resolveConnectedAccount: async () => nylasRow('google', 'grant_google'),
      requireNylas: () =>
        ({
          contacts: {
            list: async ({ identifier, queryParams }: any) => {
              queriedEmail = queryParams.email;
              expect(identifier).toBe('grant_google');
              return {
                data: [
                  {
                    emails: [{ email: 'Friend@Gmail.com' }],
                    pictureUrl: ' https://cdn.example/friend.png ',
                  },
                ],
              };
            },
            find: async () => {
              throw new Error('detail lookup should not run');
            },
          },
        }) as any,
    });
    try {
      await expect(
        resolveProviderProfilePhoto({
          userId: 'user_1',
          account: 'primary',
          email: 'Friend@Gmail.com',
        }),
      ).resolves.toBe('https://cdn.example/friend.png');
      expect(queriedEmail).toBe('friend@gmail.com');
    } finally {
      reset();
    }
  });

  test('resolveProviderProfilePhoto fetches detailed contact photos and handles missing ids', async () => {
    let mode: 'detail' | 'missing-id' = 'detail';
    const reset = setPhotoResolutionDependenciesForTest({
      isNylasConfigured: () => true,
      resolveConnectedAccount: async () => nylasRow('microsoft', 'grant_ms'),
      requireNylas: () =>
        ({
          contacts: {
            list: async () => ({
              data: [
                mode === 'detail'
                  ? { id: 'contact_1', emails: [{ email: 'friend@outlook.com' }] }
                  : { emails: [{ email: 'friend@outlook.com' }] },
              ],
            }),
            find: async ({ identifier, contactId, queryParams }: any) => {
              expect(identifier).toBe('grant_ms');
              expect(contactId).toBe('contact_1');
              expect(queryParams.profilePicture).toBe(true);
              return { data: { picture: 'data:image/png;base64,abc' } };
            },
          },
        }) as any,
    });
    try {
      await expect(
        resolveProviderProfilePhoto({
          userId: 'user_1',
          account: 'work',
          email: 'friend@outlook.com',
        }),
      ).resolves.toBe('data:image/png;base64,abc');

      mode = 'missing-id';
      await expect(
        resolveProviderProfilePhoto({
          userId: 'user_1',
          account: 'work',
          email: 'friend@outlook.com',
        }),
      ).resolves.toBeNull();
    } finally {
      reset();
    }
  });

  test('resolveProviderProfilePhoto searches all connected accounts by provider preference', async () => {
    const rows = {
      google: nylasRow('google', 'grant_google'),
      microsoft: nylasRow('microsoft', 'grant_ms'),
      icloud: nylasRow('icloud', 'grant_icloud'),
      imap: nylasRow('imap', 'grant_imap'),
    };
    const calls: string[] = [];
    const reset = setPhotoResolutionDependenciesForTest({
      isNylasConfigured: () => true,
      listNylasAccounts: async () => [
        { accountId: 'imap', authed: true },
        { accountId: 'google', authed: true },
        { accountId: 'microsoft', authed: true },
        { accountId: 'icloud', authed: true },
        { accountId: 'disconnected', authed: false },
      ],
      resolveConnectedAccount: async (_userId, accountId) => rows[accountId as keyof typeof rows] || null,
      requireNylas: () =>
        ({
          contacts: {
            list: async ({ identifier, queryParams }: any) => {
              calls.push(identifier);
              if (queryParams.email.endsWith('@example.org') && identifier === 'grant_google') {
                throw new Error('try next provider');
              }
              return {
                data: [
                  {
                    emails: [{ email: queryParams.email }],
                    pictureUrl: `https://cdn.example/${identifier}.png`,
                  },
                ],
              };
            },
            find: async () => ({ data: null }),
          },
        }) as any,
    });
    try {
      await expect(
        resolveProviderProfilePhoto({ userId: 'user_1', account: '__all__', email: 'person@gmail.com' }),
      ).resolves.toBe('https://cdn.example/grant_google.png');
      expect(calls.at(-1)).toBe('grant_google');

      calls.length = 0;
      await expect(
        resolveProviderProfilePhoto({ userId: 'user_1', account: '__all__', email: 'person@outlook.com' }),
      ).resolves.toBe('https://cdn.example/grant_ms.png');
      expect(calls[0]).toBe('grant_ms');

      calls.length = 0;
      await expect(
        resolveProviderProfilePhoto({ userId: 'user_1', account: '__all__', email: 'person@icloud.com' }),
      ).resolves.toBe('https://cdn.example/grant_icloud.png');
      expect(calls[0]).toBe('grant_icloud');

      calls.length = 0;
      await expect(
        resolveProviderProfilePhoto({ userId: 'user_1', account: '__all__', email: 'person@example.org' }),
      ).resolves.toBe('https://cdn.example/grant_ms.png');
      expect(calls.slice(0, 2)).toEqual(['grant_google', 'grant_ms']);
    } finally {
      reset();
    }
  });

  test('photo resolution helpers keep initials fallback and public company logos distinct', async () => {
    expect(photoUrlFromContact({ pictureUrl: ' https://example.com/avatar.png ' })).toBe(
      'https://example.com/avatar.png',
    );
    expect(photoUrlFromContact({ picture: 'data:image/png;base64,abc' })).toBe('data:image/png;base64,abc');
    expect(photoUrlFromContact({ pictureUrl: 'ftp://example.com/avatar.png' })).toBeNull();
    expect(photoUrlFromContact({ pictureUrl: '' })).toBeNull();
    expect(photoUrlFromContact({ pictureUrl: 42 })).toBeNull();

    expect(isCompanyDomain('linear.app')).toBe(true);
    expect(isCompanyDomain('gmail.com')).toBe(false);
    expect(isCompanyDomain('example.com')).toBe(false);
    expect(isCompanyDomain('example.test')).toBe(false);
    expect(isCompanyDomain('localhost')).toBe(false);
    expect(companyLogoUrl('alerts@Linear.app')).toBe('/api/logos/linear.app');
    expect(logoDomainForEmail('alerts@mail.microsoftonline.com')).toBe('microsoft.com');
    expect(companyLogoUrl('friend@gmail.com')).toBeNull();

    await expect(
      resolveProviderProfilePhoto({
        userId: null,
        account: 'jakob@example.test',
        email: 'alerts@linear.app',
      }),
    ).resolves.toBeNull();
    await expect(
      resolvePhotoUrl({ userId: null, account: 'jakob@example.test', email: 'alerts@linear.app' }),
    ).resolves.toBe('/api/logos/linear.app');
  });
});

function nylasRow(provider: 'google' | 'microsoft' | 'icloud' | 'imap', grantId: string) {
  return {
    userId: 'user_1',
    accountId: provider,
    email: `${provider}@example.test`,
    provider,
    status: 'connected',
    grantId,
    scopes: [],
  };
}
