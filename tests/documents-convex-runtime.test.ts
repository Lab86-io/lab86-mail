import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { convexTest } from 'convex-test';
import { api } from '../convex/_generated/api';
import schema from '../convex/schema';
import { createDefaultDocumentModel } from '../lib/documents/model';

const convexModules = {
  '../convex/_generated/api.js': () => import('../convex/_generated/api.js'),
  '../convex/albatrossWork.ts': () => import('../convex/albatrossWork'),
  '../convex/documents.ts': () => import('../convex/documents'),
};

const SECRET = 'documents-runtime-secret';
const USER = 'documents-runtime-user';
let previousSecret: string | undefined;

beforeAll(() => {
  previousSecret = process.env.LAB86_CONVEX_INTERNAL_SECRET;
  process.env.LAB86_CONVEX_INTERNAL_SECRET = SECRET;
});

afterAll(() => {
  if (previousSecret === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
  else process.env.LAB86_CONVEX_INTERNAL_SECRET = previousSecret;
});

function newHarness() {
  return convexTest(schema, convexModules);
}

async function createDocument(
  t: ReturnType<typeof newHarness>,
  documentId: string,
  kind: 'doc' | 'sheet' | 'deck' = 'doc',
) {
  return t.mutation(api.documents.create, {
    internalSecret: SECRET,
    userId: USER,
    documentId,
    kind,
    title: documentId,
    model: createDefaultDocumentModel(kind, documentId),
  });
}

describe('document Convex transactions', () => {
  test('filters archived and other-kind rows before applying the list limit', async () => {
    const t = newHarness();
    await createDocument(t, 'visible-doc');
    await createDocument(t, 'archived-doc');
    await createDocument(t, 'newer-sheet', 'sheet');
    await t.mutation(api.documents.archive, {
      internalSecret: SECRET,
      userId: USER,
      documentId: 'archived-doc',
    });
    await t.run(async (ctx) => {
      const rows = await ctx.db.query('documents').collect();
      for (const row of rows) {
        const updatedAt =
          row.documentId === 'newer-sheet' ? 3_000 : row.documentId === 'archived-doc' ? 2_000 : 1_000;
        await ctx.db.patch(row._id, { updatedAt });
      }
    });

    const listed = await t.query(api.documents.list, {
      internalSecret: SECRET,
      userId: USER,
      kind: 'doc',
      limit: 1,
    });

    expect(listed.map((row) => row.documentId)).toEqual(['visible-doc']);
  });

  test('makes suggestion creation idempotent and applies a proposal atomically once', async () => {
    const t = newHarness();
    await createDocument(t, 'memo');
    const proposedModel = {
      kind: 'doc' as const,
      version: 1 as const,
      blocks: [{ id: 'paragraph', type: 'paragraph' as const, text: 'Choose Acme.' }],
    };
    const input = {
      internalSecret: SECRET,
      userId: USER,
      suggestionId: 'suggestion-1',
      documentId: 'memo',
      title: 'Revised memo',
      description: 'Clarify the decision',
      proposedModel,
    };

    const first = await t.mutation(api.documents.createSuggestion, input);
    const replay = await t.mutation(api.documents.createSuggestion, input);
    expect(replay).toEqual(first);
    expect(await t.run((ctx) => ctx.db.query('documentSuggestions').collect())).toHaveLength(1);

    const applied = await t.mutation(api.documents.applySuggestion, {
      internalSecret: SECRET,
      userId: USER,
      documentId: 'memo',
      suggestionId: 'suggestion-1',
      expectedRevision: 1,
    });
    expect(applied).toMatchObject({
      ok: true,
      document: { title: 'Revised memo', currentRevision: 2 },
    });
    const [storedSuggestion] = await t.run((ctx) => ctx.db.query('documentSuggestions').collect());
    expect(storedSuggestion.status).toBe('applied');
    expect(await t.run((ctx) => ctx.db.query('documentRevisions').collect())).toHaveLength(2);

    await expect(
      t.mutation(api.documents.applySuggestion, {
        internalSecret: SECRET,
        userId: USER,
        documentId: 'memo',
        suggestionId: 'suggestion-1',
        expectedRevision: 2,
      }),
    ).resolves.toEqual({ ok: false, code: 'ALREADY_RESOLVED' });
  });

  test('prevents two active documents from claiming the same Google file', async () => {
    const t = newHarness();
    await createDocument(t, 'first');
    await createDocument(t, 'second');
    const google = {
      internalSecret: SECRET,
      userId: USER,
      connectionId: 'google-1',
      fileId: 'file-1',
      mimeType: 'application/vnd.google-apps.document',
      syncedRevision: 1,
    };

    await expect(
      t.mutation(api.documents.linkGoogleFile, { ...google, documentId: 'first' }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      t.mutation(api.documents.linkGoogleFile, { ...google, documentId: 'second' }),
    ).resolves.toEqual({ ok: false, code: 'ALREADY_LINKED', documentId: 'first' });
    await expect(
      t.query(api.documents.findByGoogleFile, {
        internalSecret: SECRET,
        userId: USER,
        connectionId: 'google-1',
        fileId: 'file-1',
      }),
    ).resolves.toMatchObject({ documentId: 'first' });
  });

  test('accepts a document as a first-class Albatross project artifact', async () => {
    const t = newHarness();
    const projectId = await t.mutation(api.albatrossWork.createProject, {
      internalSecret: SECRET,
      userId: USER,
      title: 'Launch decision',
    });
    await expect(
      t.mutation(api.albatrossWork.linkArtifact, {
        internalSecret: SECRET,
        userId: USER,
        projectId,
        artifactKind: 'document',
        artifactId: 'memo-document',
        title: 'Launch decision memo',
        role: 'primary',
      }),
    ).resolves.toBeDefined();
    const [link] = await t.run((ctx) => ctx.db.query('albatrossProjectLinks').collect());
    expect(link).toMatchObject({
      artifactKind: 'document',
      artifactId: 'memo-document',
      role: 'primary',
    });
  });
});
