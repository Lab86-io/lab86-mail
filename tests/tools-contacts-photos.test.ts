import { describe, expect, test } from 'bun:test';
import './tools/harness';
import { kvUpsert } from '../lib/store/kv';
import { getPhotoFromCache } from '../lib/store/photos';
import { contactLookup, expandAlias } from '../lib/tools/contacts';
import {
  companyLogoUrl,
  isCompanyDomain,
  photoUrlFromContact,
  resolvePhotoUrl,
  resolveProviderProfilePhoto,
} from '../lib/tools/photo-resolution';
import { resolvePhotos } from '../lib/tools/photos';
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
    expect(result.photos['alerts@linear.app']).toBe(
      'https://www.google.com/s2/favicons?sz=128&domain=linear.app',
    );
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
    expect(companyLogoUrl('alerts@Linear.app')).toBe(
      'https://www.google.com/s2/favicons?sz=128&domain=linear.app',
    );
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
    ).resolves.toBe('https://www.google.com/s2/favicons?sz=128&domain=linear.app');
  });
});
