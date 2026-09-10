import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { convexTest } from 'convex-test';
import { api, internal } from '../convex/_generated/api';
import schema from '../convex/schema';
import { exportDocument } from '../lib/documents/export';
import { createDefaultDocumentModel } from '../lib/documents/model';
import { validateOfficeArchive } from '../lib/documents/office-security';

const office = (api as any).officeDocuments;
const modules = {
  '../convex/_generated/api.js': () => import('../convex/_generated/api.js'),
  '../convex/officeDocuments.ts': () => import('../convex/officeDocuments'),
  '../convex/accounts.ts': () => import('../convex/accounts'),
};
const secret = 'office-runtime-secret';
const userId = 'office-owner';
const auth = { internalSecret: secret, userId };
let previous: string | undefined;
beforeAll(() => {
  previous = process.env.LAB86_CONVEX_INTERNAL_SECRET;
  process.env.LAB86_CONVEX_INTERNAL_SECRET = secret;
});
afterAll(() => {
  if (previous === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
  else process.env.LAB86_CONVEX_INTERNAL_SECRET = previous;
});

describe('binary Office working copies', () => {
  test('user deletion removes original workbook bytes and preserves other owners', async () => {
    const t = convexTest(schema, modules);
    const uploads = new Map<string, string>();
    for (const owner of [userId, 'other-workbook-owner']) {
      const storageId = await t.run((ctx) => ctx.storage.store(new Blob([owner])));
      uploads.set(owner, storageId);
      await t.run((ctx) =>
        ctx.db.insert('documents', {
          userId: owner,
          documentId: `workbook-${owner}`,
          kind: 'sheet',
          title: 'Original workbook',
          model: createDefaultDocumentModel('sheet'),
          currentRevision: 1,
          sourceRefs: [],
          createdAt: 1,
          updatedAt: 1,
          importSource: {
            format: 'xlsx',
            filename: 'Original.xlsx',
            mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            size: owner.length,
            sha256: owner,
            storageId,
            warnings: [],
            importedAt: 1,
            revision: 1,
          },
        }),
      );
    }
    await t.mutation(api.accounts.deleteUserCascade, auth);
    expect(await t.run(async (ctx) => Boolean(await ctx.storage.get(uploads.get(userId) as any)))).toBe(
      false,
    );
    expect(
      await t.run(async (ctx) => Boolean(await ctx.storage.get(uploads.get('other-workbook-owner') as any))),
    ).toBe(true);
    const remaining = await t.run((ctx) => ctx.db.query('documents').collect());
    expect(remaining.map((row) => row.userId)).toEqual(['other-workbook-owner']);
  });

  test('deleting an account removes its private Office bytes without touching another owner', async () => {
    const t = convexTest(schema, modules);
    const uploads = new Map<string, string>();
    for (const ownerId of [userId, 'retained-user']) {
      const storageId = await t.run((ctx) => ctx.storage.store(new Blob([ownerId])));
      uploads.set(ownerId, storageId);
      await t.mutation(office.create, {
        ...auth,
        userId: ownerId,
        documentId: ownerId,
        title: 'Private.docx',
        extension: 'docx',
        storageId,
        size: ownerId.length,
        sha256: ownerId,
      });
    }
    await t.mutation(internal.accounts.purgeUserDataBatch, { userId });
    expect(await t.query(office.list, auth)).toHaveLength(0);
    expect(await t.run(async (ctx) => Boolean(await ctx.storage.get(uploads.get(userId) as any)))).toBe(
      false,
    );
    expect(await t.query(office.list, { ...auth, userId: 'retained-user' })).toHaveLength(1);
    expect(
      await t.run(async (ctx) => Boolean(await ctx.storage.get(uploads.get('retained-user') as any))),
    ).toBe(true);
  });
  test('round-trips original DOCX/XLSX/PPTX bytes and isolates ownership', async () => {
    const t = convexTest(schema, modules);
    for (const kind of ['doc', 'sheet', 'deck'] as const) {
      const file = await exportDocument({
        documentId: kind,
        title: 'Synthetic file',
        kind,
        model: createDefaultDocumentModel(kind, kind),
        currentRevision: 1,
        sourceRefs: [],
        createdAt: 1,
        updatedAt: 1,
      });
      const bytes = new Uint8Array(file.bytes);
      const storageId = await t.run((ctx) => ctx.storage.store(new Blob([bytes])));
      await t.mutation(office.create, {
        ...auth,
        documentId: kind,
        title: `Synthetic.${file.extension}`,
        extension: file.extension,
        storageId,
        size: bytes.length,
        sha256: validateOfficeArchive(bytes, file.extension),
      });
      const record = await t.query(office.get, { ...auth, documentId: kind });
      expect(record.currentRevision).toBe(1);
      expect(record.versions[0].recovery).toBe(false);
      const retained = await t.run(async (ctx) => (await ctx.storage.get(storageId))!.arrayBuffer());
      expect(new Uint8Array(retained)).toEqual(bytes);
      expect(await t.query(office.get, { ...auth, userId: 'someone-else', documentId: kind })).toBeNull();
    }
    expect(await t.query(office.list, { ...auth, userId: 'someone-else' })).toEqual([]);
    await expect(t.query(office.list, { userId, internalSecret: 'wrong' })).rejects.toThrow();
  });

  test('saves once, preserves concurrent conflict as recovery, and rejects foreign/expired sessions', async () => {
    const t = convexTest(schema, modules);
    const store = (text: string) => t.run((ctx) => ctx.storage.store(new Blob([text])));
    const original = await store('original');
    await t.mutation(office.create, {
      ...auth,
      documentId: 'file',
      title: 'File.docx',
      extension: 'docx',
      storageId: original,
      size: 8,
      sha256: 'original',
    });
    for (const sessionId of ['a', 'b'])
      expect(
        await t.mutation(office.startSession, {
          ...auth,
          documentId: 'file',
          sessionId,
          key: sessionId,
          expectedRevision: 1,
        }),
      ).toMatchObject({ ok: true });
    const change = await store('first change');
    const first = {
      ...auth,
      documentId: 'file',
      sessionId: 'a',
      key: 'a',
      expectedRevision: 1,
      storageId: change,
      size: 12,
      sha256: 'changed',
    };
    expect(await t.mutation(office.saveVersion, first)).toMatchObject({ ok: true, revision: 2 });
    expect(
      await t.mutation(office.saveVersion, { ...first, storageId: await store('first change') }),
    ).toMatchObject({ ok: true, revision: 2 });
    const conflict = {
      ...auth,
      documentId: 'file',
      sessionId: 'b',
      key: 'b',
      expectedRevision: 1,
      storageId: await store('concurrent change'),
      size: 17,
      sha256: 'conflict',
    };
    expect(await t.mutation(office.saveVersion, conflict)).toMatchObject({
      ok: false,
      code: 'REVISION_CONFLICT',
      revision: 3,
    });
    const document = await t.query(office.get, { ...auth, documentId: 'file' });
    expect(document.currentRevision).toBe(2);
    expect(document.versions).toHaveLength(3);
    expect(document.versions.find((row: { revision: number }) => row.revision === 3).recovery).toBe(true);
    expect(
      new Uint8Array(await t.run(async (ctx) => (await ctx.storage.get(original))!.arrayBuffer())),
    ).toEqual(new TextEncoder().encode('original'));
    expect(
      await t.query(office.getSession, { ...auth, userId: 'other', documentId: 'file', sessionId: 'a' }),
    ).toBeNull();
    expect(await t.mutation(office.saveVersion, { ...first, userId: 'other' })).toMatchObject({
      ok: false,
      code: 'SESSION_INVALID',
    });
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query('officeSessions').collect())
        await ctx.db.patch(row._id, { expiresAt: 1 });
    });
    expect(await t.query(office.getSession, { ...auth, documentId: 'file', sessionId: 'a' })).toBeNull();
    expect(await t.mutation(office.saveVersion, first)).toMatchObject({ ok: false, code: 'SESSION_INVALID' });
  });

  test('retains ambiguous A to B to A content as recovery instead of falsely acknowledging a revert', async () => {
    const t = convexTest(schema, modules);
    const store = (text: string) => t.run((ctx) => ctx.storage.store(new Blob([text])));
    await t.mutation(office.create, {
      ...auth,
      documentId: 'revert',
      title: 'Revert.docx',
      extension: 'docx',
      storageId: await store('original'),
      size: 8,
      sha256: 'original',
    });
    await t.mutation(office.startSession, {
      ...auth,
      documentId: 'revert',
      sessionId: 'session',
      key: 'key',
      expectedRevision: 1,
    });
    const save = async (text: string) => {
      const record = await t.query(office.get, { ...auth, documentId: 'revert' });
      return t.mutation(office.saveVersion, {
        ...auth,
        documentId: 'revert',
        sessionId: 'session',
        key: 'key',
        expectedRevision: record.currentRevision,
        storageId: await store(text),
        size: text.length,
        sha256: text,
      });
    };
    expect(await save('A')).toMatchObject({ ok: true, revision: 2 });
    expect(await save('B')).toMatchObject({ ok: true, revision: 3 });
    expect(await save('A')).toMatchObject({ ok: false, code: 'REVISION_CONFLICT', revision: 4 });
    expect(await save('A')).toMatchObject({ ok: false, code: 'REVISION_CONFLICT', revision: 4 });
    const record = await t.query(office.get, { ...auth, documentId: 'revert' });
    expect(record.currentRevision).toBe(3);
    expect(record.versions).toHaveLength(4);
    expect(record.versions[0]).toMatchObject({ revision: 4, recovery: true, sha256: 'A' });
  });

  test('keeps a slower first-seen callback as recovery when another transfer commits first', async () => {
    const t = convexTest(schema, modules);
    const store = (text: string) => t.run((ctx) => ctx.storage.store(new Blob([text])));
    await t.mutation(office.create, {
      ...auth,
      documentId: 'out-of-order',
      title: 'Out of order.docx',
      extension: 'docx',
      storageId: await store('original'),
      size: 8,
      sha256: 'original',
    });
    await t.mutation(office.startSession, {
      ...auth,
      documentId: 'out-of-order',
      sessionId: 'ordered-session',
      key: 'ordered-key',
      expectedRevision: 1,
    });
    // Both callback handlers saw revision 1 before beginning their transfers.
    const callback = {
      ...auth,
      documentId: 'out-of-order',
      sessionId: 'ordered-session',
      key: 'ordered-key',
      expectedRevision: 1,
    };
    expect(
      await t.mutation(office.saveVersion, {
        ...callback,
        storageId: await store('newer B'),
        size: 7,
        sha256: 'newer-B',
      }),
    ).toMatchObject({ ok: true, revision: 2 });
    expect(
      await t.mutation(office.saveVersion, {
        ...callback,
        storageId: await store('older A'),
        size: 7,
        sha256: 'older-A',
      }),
    ).toMatchObject({ ok: false, code: 'REVISION_CONFLICT', revision: 3 });
    const record = await t.query(office.get, { ...auth, documentId: 'out-of-order' });
    expect(record.currentRevision).toBe(2);
    expect(record.version.sha256).toBe('newer-B');
    expect(record.versions[0]).toMatchObject({ revision: 3, recovery: true, sha256: 'older-A' });
    expect(
      await t.query(office.getSession, { ...auth, documentId: 'out-of-order', sessionId: 'ordered-session' }),
    ).toMatchObject({ lastRevision: 2 });
  });
});
