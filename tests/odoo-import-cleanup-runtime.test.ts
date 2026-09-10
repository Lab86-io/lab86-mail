import { afterAll, beforeAll, expect, test } from 'bun:test';
import { convexTest } from 'convex-test';
import { api } from '../convex/_generated/api';
import schema from '../convex/schema';
import { createDefaultDocumentModel } from '../lib/documents/model';

const modules = {
  '../convex/_generated/api.js': () => import('../convex/_generated/api.js'),
  '../convex/documents.ts': () => import('../convex/documents'),
  '../convex/accounts.ts': () => import('../convex/accounts'),
};
const secret = 'odoo-import-cleanup-test';
const auth = { internalSecret: secret, userId: 'import-owner' };
let previous: string | undefined;
beforeAll(() => {
  previous = process.env.LAB86_CONVEX_INTERNAL_SECRET;
  process.env.LAB86_CONVEX_INTERNAL_SECRET = secret;
});
afterAll(() => {
  if (previous === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
  else process.env.LAB86_CONVEX_INTERNAL_SECRET = previous;
});

async function fixture() {
  const t = convexTest(schema, modules);
  const storageId = await t.run((ctx) => ctx.storage.store(new Blob(['synthetic original workbook'])));
  const args = { ...auth, documentId: 'import-id', storageId };
  const creation = {
    ...auth,
    documentId: args.documentId,
    kind: 'sheet' as const,
    title: 'Workbook',
    model: createDefaultDocumentModel('sheet'),
    importSource: {
      storageId,
      format: 'xlsx' as const,
      filename: 'Workbook.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      size: 27,
      sha256: 'synthetic-digest',
      warnings: [],
      importedAt: 1,
    },
  };
  return { t, storageId, args, creation };
}

test('failed import cancellation deletes only unattached original bytes and prevents delayed create', async () => {
  const { t, storageId, args, creation } = await fixture();
  expect(await t.mutation((api as any).documents.cancelImport, args)).toEqual({ status: 'cancelled' });
  expect(await t.run(async (ctx) => Boolean(await ctx.storage.get(storageId)))).toBe(false);
  await expect(t.mutation(api.documents.create, creation)).rejects.toThrow('import was cancelled');
  expect(await t.query(api.documents.get, { ...auth, documentId: args.documentId })).toBeNull();
  expect(await t.mutation((api as any).documents.cancelImport, args)).toEqual({ status: 'cancelled' });
  expect(await t.run((ctx) => ctx.db.query('documentImportCancellations').collect())).toHaveLength(1);
});

test('a committed import wins over ambiguous-response compensation without losing its original', async () => {
  const { t, storageId, args, creation } = await fixture();
  await t.mutation(api.documents.create, creation);
  const settled = await t.mutation((api as any).documents.cancelImport, args);
  expect(settled.status).toBe('attached');
  expect(settled.document.documentId).toBe(args.documentId);
  expect(await t.run(async (ctx) => Boolean(await ctx.storage.get(storageId)))).toBe(true);
  expect(await t.run((ctx) => ctx.db.query('documentImportCancellations').collect())).toHaveLength(0);
});

test('cleanup never deletes another owner’s attached original or exposes their document', async () => {
  const { t, storageId, args, creation } = await fixture();
  await t.mutation(api.documents.create, { ...creation, userId: 'other-owner' });
  expect(await t.mutation((api as any).documents.cancelImport, args)).toEqual({ status: 'attached' });
  expect(await t.run(async (ctx) => Boolean(await ctx.storage.get(storageId)))).toBe(true);
  await expect(
    t.mutation((api as any).documents.cancelImport, { ...args, internalSecret: 'wrong' }),
  ).rejects.toThrow();
});

test('user deletion removes cancellation metadata only for that user', async () => {
  const { t, args } = await fixture();
  await t.mutation((api as any).documents.cancelImport, args);
  const otherStorage = await t.run((ctx) => ctx.storage.store(new Blob(['other'])));
  await t.mutation((api as any).documents.cancelImport, {
    ...auth,
    userId: 'other-owner',
    documentId: 'other',
    storageId: otherStorage,
  });
  await t.mutation(api.accounts.deleteUserCascade, auth);
  expect(
    (await t.run((ctx) => ctx.db.query('documentImportCancellations').collect())).map((row) => row.userId),
  ).toEqual(['other-owner']);
});
