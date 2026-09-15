import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { convexTest } from 'convex-test';
import { api } from '../convex/_generated/api';
import schema from '../convex/schema';

const assets = (api as any).documentAssets;
const modules = {
  '../convex/_generated/api.js': () => import('../convex/_generated/api.js'),
  '../convex/documentAssets.ts': () => import('../convex/documentAssets'),
  '../convex/accounts.ts': () => import('../convex/accounts'),
};
const secret = 'asset-runtime-secret';
const auth = { internalSecret: secret, userId: 'asset-owner' };
let previous: string | undefined;
beforeAll(() => {
  previous = process.env.LAB86_CONVEX_INTERNAL_SECRET;
  process.env.LAB86_CONVEX_INTERNAL_SECRET = secret;
});
afterAll(() => {
  if (previous === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
  else process.env.LAB86_CONVEX_INTERNAL_SECRET = previous;
});

describe('owned presentation images', () => {
  test('records an upload once per hash, scopes reads to the owner, and removes the blob with the row', async () => {
    const t = convexTest(schema, modules);
    const upload = (text: string) => t.run((ctx) => ctx.storage.store(new Blob([text])));
    const first = await t.mutation(assets.create, {
      ...auth,
      storageId: await upload('one'),
      mime: 'image/png',
      size: 3,
      width: 640,
      height: 480,
      sha256: 'hash-1',
    });
    expect(first.url).toBeTruthy();
    expect(first.width).toBe(640);
    // Same hash again: the duplicate blob is dropped and the first record returned.
    const duplicateBlob = await upload('one-again');
    const again = await t.mutation(assets.create, {
      ...auth,
      storageId: duplicateBlob,
      mime: 'image/png',
      size: 3,
      width: 640,
      height: 480,
      sha256: 'hash-1',
    });
    expect(again.assetId).toBe(first.assetId);
    expect(await t.run((ctx) => ctx.storage.getUrl(duplicateBlob))).toBeNull();
    // Owner scoping.
    expect(await t.query(assets.get, { ...auth, assetId: first.assetId })).toMatchObject({
      assetId: first.assetId,
    });
    expect(await t.query(assets.get, { ...auth, userId: 'someone-else', assetId: first.assetId })).toBeNull();
    expect(await t.query(assets.get, { ...auth, assetId: 'not-an-id' })).toBeNull();
    // Removal deletes the blob.
    const row = await t.run((ctx) => ctx.db.get(first.assetId));
    expect(await t.mutation(assets.remove, { ...auth, userId: 'someone-else', assetId: first.assetId })).toBe(
      false,
    );
    expect(await t.mutation(assets.remove, { ...auth, assetId: first.assetId })).toBe(true);
    expect(await t.run((ctx) => ctx.storage.getUrl((row as any).storageId))).toBeNull();
    expect(await t.query(assets.get, { ...auth, assetId: first.assetId })).toBeNull();
  });
  test('rejects calls without the internal secret', async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.mutation(assets.create, {
        userId: 'x',
        storageId: await t.run((ctx) => ctx.storage.store(new Blob(['a']))),
        mime: 'image/png',
        size: 1,
        width: 1,
        height: 1,
        sha256: 'h',
      }),
    ).rejects.toThrow();
  });
});
