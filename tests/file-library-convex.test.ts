import { afterAll, beforeAll, expect, test } from 'bun:test';
import { convexTest } from 'convex-test';
import { api } from '../convex/_generated/api';
import schema from '../convex/schema';
import { createDefaultDocumentModel } from '../lib/documents/model';

const modules = {
  '../convex/_generated/api.js': () => import('../convex/_generated/api.js'),
  '../convex/fileLibrary.ts': () => import('../convex/fileLibrary'),
};
let original: string | undefined;
beforeAll(() => {
  original = process.env.LAB86_CONVEX_INTERNAL_SECRET;
  process.env.LAB86_CONVEX_INTERNAL_SECRET = 'library-test';
});
afterAll(() => {
  if (original === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
  else process.env.LAB86_CONVEX_INTERNAL_SECRET = original;
});

test('metadata paging reaches older documents without leaking models or other owners', async () => {
  const t = convexTest(schema, modules);
  await t.run(async (ctx) => {
    for (let i = 0; i < 57; i++)
      await ctx.db.insert('documents', {
        userId: i === 56 ? 'other' : 'owner',
        documentId: `doc-${i}`,
        title: i === 0 ? 'Older Plan' : 'Newer Notes',
        kind: 'doc',
        model: createDefaultDocumentModel('doc'),
        currentRevision: 1,
        sourceRefs: [],
        createdAt: i,
        updatedAt: i,
        ...(i === 55 ? { archivedAt: 99 } : {}),
      });
  });
  const input = {
    userId: 'owner',
    internalSecret: 'library-test',
    kind: 'documents' as const,
    search: 'older PLAN',
  };
  const first = await t.query((api as any).fileLibrary.page, input);
  expect(first.items).toEqual([]);
  expect(first.nextCursor).toBeTruthy();
  const second = await t.query((api as any).fileLibrary.page, { ...input, cursor: first.nextCursor });
  expect(second.items.map((item: any) => item.id)).toEqual(['doc-0']);
  expect(second.items[0]).not.toHaveProperty('model');
  expect(second.nextCursor).toBeNull();
  const other = await t.query((api as any).fileLibrary.page, { ...input, userId: 'other', search: '' });
  expect(other.items.map((item: any) => item.id)).toEqual(['doc-56']);
  await expect(
    t.query((api as any).fileLibrary.page, { ...input, internalSecret: 'wrong' }),
  ).rejects.toThrow();
});
