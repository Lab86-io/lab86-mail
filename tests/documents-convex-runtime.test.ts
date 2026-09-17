import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { convexTest } from 'convex-test';
import { api } from '../convex/_generated/api';
import schema from '../convex/schema';
import { createDefaultDocumentModel } from '../lib/documents/model';

const convexModules = {
  '../convex/agentExecution.ts': () => import('../convex/agentExecution'),
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
  test('old native saves cannot flatten a rich deck, including renames and downgrade requests', async () => {
    const t = newHarness();
    const model = {
      kind: 'deck',
      version: 2,
      theme: { name: 'Editorial' },
      slides: [{ id: 'cover', elements: [{ type: 'image', assetId: 'owned' }] }],
    };
    const owner = { internalSecret: SECRET, userId: USER, documentId: 'rich-deck' };
    await t.mutation(api.documents.create, { ...owner, kind: 'deck', title: 'Rich deck', model });
    for (const allowDowngrade of [false, true]) {
      expect(
        await t.mutation(api.documents.update, {
          ...owner,
          expectedRevision: 1,
          title: 'Renamed',
          model: createDefaultDocumentModel('deck'),
          allowDowngrade,
        }),
      ).toMatchObject({ ok: false, code: 'RICH_DECK_REQUIRED' });
    }
    expect(await t.query(api.documents.get, owner)).toMatchObject({
      title: 'Rich deck',
      currentRevision: 1,
      model,
    });
    expect(await t.run((ctx) => ctx.db.query('documentRevisions').collect())).toHaveLength(1);
    expect(
      await t.mutation(api.documents.update, { ...owner, expectedRevision: 1, title: 'Renamed' }),
    ).toMatchObject({ ok: true, document: { title: 'Renamed', currentRevision: 2, model } });
    expect(
      await t.mutation(api.documents.update, {
        ...owner,
        expectedRevision: 2,
        model: { ...model, theme: { name: 'Signal' } },
      }),
    ).toMatchObject({ ok: true, document: { currentRevision: 3 } });
  });

  test('creation records the exact file in recovery and prevents a second commit for the same execution', async () => {
    const t = newHarness();
    const identity = { internalSecret: SECRET, userId: USER, runId: 'create-run', key: 'create-key' };
    await t.mutation(api.agentExecution.beginTool, {
      ...identity,
      toolName: 'document_create',
      mutating: true,
    });
    const args = {
      internalSecret: SECRET,
      userId: USER,
      kind: 'deck' as const,
      title: 'PubMed',
      model: createDefaultDocumentModel('deck'),
      execution: { runId: identity.runId, key: identity.key },
    };
    await t.mutation(api.documents.create, { ...args, documentId: 'created-deck' });
    const recovery = await t.query(api.agentExecution.readRun, {
      internalSecret: SECRET,
      userId: USER,
      runId: identity.runId,
    });
    expect(recovery.page[0]).toMatchObject({
      status: 'running',
      effect: { documentId: 'created-deck', revision: 1 },
    });
    await expect(t.mutation(api.documents.create, { ...args, documentId: 'duplicate-deck' })).rejects.toThrow(
      'already committed',
    );
    const documents = await t.query(api.documents.list, { internalSecret: SECRET, userId: USER });
    expect(documents.map((row) => row.documentId)).toEqual(['created-deck']);
  });

  test('an interrupted execution cannot create a late file or leave an orphan revision', async () => {
    const t = newHarness();
    const identity = { internalSecret: SECRET, userId: USER, runId: 'interrupted-run', key: 'create-key' };
    await t.mutation(api.agentExecution.beginTool, {
      ...identity,
      toolName: 'document_create',
      mutating: true,
    });
    await t.mutation(api.agentExecution.finishTool, { ...identity, status: 'unknown' });
    await expect(
      t.mutation(api.documents.create, {
        internalSecret: SECRET,
        userId: USER,
        documentId: 'late-deck',
        kind: 'deck',
        title: 'PubMed',
        model: createDefaultDocumentModel('deck'),
        execution: { runId: identity.runId, key: identity.key },
      }),
    ).rejects.toThrow('no longer active');
    expect(await t.query(api.documents.list, { internalSecret: SECRET, userId: USER })).toEqual([]);
    expect(await t.run((ctx) => ctx.db.query('documentRevisions').collect())).toEqual([]);
  });

  test('restores a version as a new revision and rejects stale or foreign restore requests', async () => {
    const t = newHarness();
    await createDocument(t, 'restore-me');
    await t.mutation(api.documents.update, {
      internalSecret: SECRET,
      userId: USER,
      documentId: 'restore-me',
      expectedRevision: 1,
      title: 'New title',
    });
    const restore = (api as any).documents.restoreRevision;
    expect(
      await t.mutation(restore, {
        internalSecret: SECRET,
        userId: USER,
        documentId: 'restore-me',
        revision: 1,
        expectedRevision: 1,
      }),
    ).toMatchObject({ ok: false, code: 'REVISION_CONFLICT' });
    expect(
      await t.mutation(restore, {
        internalSecret: SECRET,
        userId: 'other',
        documentId: 'restore-me',
        revision: 1,
        expectedRevision: 2,
      }),
    ).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect(
      await t.mutation(restore, {
        internalSecret: SECRET,
        userId: USER,
        documentId: 'restore-me',
        revision: 1,
        expectedRevision: 2,
      }),
    ).toEqual({ ok: true });
    const document = await t.query(api.documents.get, {
      internalSecret: SECRET,
      userId: USER,
      documentId: 'restore-me',
    });
    expect(document).toMatchObject({ title: 'restore-me', currentRevision: 3 });
    expect(
      await t.query(api.documents.listRevisions, {
        internalSecret: SECRET,
        userId: USER,
        documentId: 'restore-me',
      }),
    ).toHaveLength(3);
  });

  test('does not apply AI proposals after their source revision has changed', async () => {
    const t = newHarness();
    await createDocument(t, 'ai-race');
    await t.mutation(api.documents.createSuggestion, {
      internalSecret: SECRET,
      userId: USER,
      documentId: 'ai-race',
      suggestionId: 'stale',
      title: 'AI title',
      description: 'AI revision',
      proposedModel: createDefaultDocumentModel('doc', 'proposed'),
      baseRevision: 1,
    });
    await t.mutation(api.documents.update, {
      internalSecret: SECRET,
      userId: USER,
      documentId: 'ai-race',
      expectedRevision: 1,
      title: 'Human edits',
    });
    expect(
      await t.mutation(api.documents.applySuggestion, {
        internalSecret: SECRET,
        userId: USER,
        documentId: 'ai-race',
        suggestionId: 'stale',
        expectedRevision: 2,
      }),
    ).toMatchObject({ ok: false, code: 'REVISION_CONFLICT' });
    expect(
      await t.query(api.documents.get, { internalSecret: SECRET, userId: USER, documentId: 'ai-race' }),
    ).toMatchObject({ title: 'Human edits', currentRevision: 2 });
  });

  test('requires a fresh proposal for legacy suggestions with no known source revision', async () => {
    const t = newHarness();
    await createDocument(t, 'legacy');
    await t.run((ctx) =>
      ctx.db.insert('documentSuggestions', {
        userId: USER,
        documentId: 'legacy',
        suggestionId: 'legacy-proposal',
        title: 'Old proposal',
        description: 'An unversioned proposal',
        proposedModel: createDefaultDocumentModel('doc', 'old'),
        sourceRefs: [],
        status: 'proposed',
        createdAt: 1,
      }),
    );
    expect(
      await t.mutation(api.documents.applySuggestion, {
        internalSecret: SECRET,
        userId: USER,
        documentId: 'legacy',
        suggestionId: 'legacy-proposal',
        expectedRevision: 1,
      }),
    ).toMatchObject({ ok: false, code: 'REVISION_CONFLICT' });
    expect(
      await t.query(api.documents.get, {
        internalSecret: SECRET,
        userId: USER,
        documentId: 'legacy',
      }),
    ).toMatchObject({ title: 'legacy', currentRevision: 1 });
  });
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
    expect(storedSuggestion.baseRevision).toBe(1);
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

  test('bounds active suggestion reads and only accepts terminal resolution states', async () => {
    const t = newHarness();
    await createDocument(t, 'bounded-suggestions');
    const proposedModel = createDefaultDocumentModel('doc', 'bounded-suggestions');
    await t.run(async (ctx) => {
      for (let index = 0; index < 52; index += 1) {
        await ctx.db.insert('documentSuggestions', {
          userId: USER,
          suggestionId: `proposal-${index}`,
          documentId: 'bounded-suggestions',
          title: `Proposal ${index}`,
          description: 'Bounded proposal',
          proposedModel,
          sourceRefs: [],
          status: 'proposed',
          createdAt: index,
        });
      }
      await ctx.db.insert('documentSuggestions', {
        userId: USER,
        suggestionId: 'resolved-proposal',
        documentId: 'bounded-suggestions',
        title: 'Resolved proposal',
        description: 'Already dismissed',
        proposedModel,
        sourceRefs: [],
        status: 'dismissed',
        resolvedAt: 100,
        createdAt: 100,
      });
    });

    const document = await t.query(api.documents.get, {
      internalSecret: SECRET,
      userId: USER,
      documentId: 'bounded-suggestions',
    });
    expect(document?.suggestions).toHaveLength(50);
    expect(document?.suggestions.every((suggestion) => suggestion.status === 'proposed')).toBe(true);
    await expect(
      t.mutation(api.documents.resolveSuggestion, {
        internalSecret: SECRET,
        userId: USER,
        documentId: 'bounded-suggestions',
        suggestionId: 'proposal-1',
        status: 'proposed' as 'dismissed',
      }),
    ).rejects.toThrow('Validator error');
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
