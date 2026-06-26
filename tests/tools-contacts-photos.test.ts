import { describe, expect, test } from 'bun:test';
import './tools/harness';
import { contactLookup, expandAlias } from '../lib/tools/contacts';
import { resolvePhotos } from '../lib/tools/photos';
import { runTool } from './tools/harness';

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
});
