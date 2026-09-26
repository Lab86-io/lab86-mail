import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { convexTest } from 'convex-test';
import { api, internal } from '../convex/_generated/api';
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

  test('autosaves share one revision row per window (DOC-4)', async () => {
    const t = newHarness();
    await createDocument(t, 'memo');
    const base = { internalSecret: SECRET, userId: USER, documentId: 'memo' };
    const save = (expectedRevision: number, text: string, reason = 'inline_edit') =>
      t.mutation(api.documents.update, {
        ...base,
        expectedRevision,
        model: { kind: 'doc', version: 1, blocks: [{ id: 'b1', type: 'paragraph', text }] },
        reason,
      });
    for (let revision = 1; revision <= 4; revision += 1) {
      expect(await save(revision, `draft ${revision}`)).toMatchObject({ ok: true });
    }
    const revisions = () => t.query(api.documents.listRevisions, { ...base });
    let rows = await revisions();
    // The create row stays; the four autosaves are one row at revision 5.
    expect(rows.map((row) => row.revision)).toEqual([5, 1]);
    expect(rows.some((row: any) => 'model' in row)).toBe(false);
    expect((await t.query(api.documents.get, base))?.model.blocks[0].text).toBe('draft 4');
    // The merged autosaves wrote one model row in place: one for the create, one for the window.
    expect(await t.run((ctx) => ctx.db.query('documentModels').collect())).toHaveLength(2);

    // A save that is not an autosave starts a new row, and so does a new window.
    await save(5, 'named', 'edit');
    await t.run(async (ctx) => {
      const latest = (await ctx.db.query('documentRevisions').collect()).find((row) => row.revision === 6);
      if (latest) await ctx.db.patch(latest._id, { createdAt: Date.now() - 20 * 60_000 });
    });
    await save(6, 'after edit');
    const autosave = (await revisions())[0];
    await t.run(async (ctx) => {
      const row = (await ctx.db.query('documentRevisions').collect()).find(
        (r) => r.revision === autosave.revision,
      );
      if (row)
        await ctx.db.patch(row._id, { createdAt: Date.now() - 20 * 60_000, windowStartedAt: undefined });
    });
    await save(7, 'next window');
    rows = await revisions();
    expect(rows.map((row) => row.revision)).toEqual([8, 7, 6, 5, 1]);
  });

  test('the list can leave models out, and archive purges history (DOC-4)', async () => {
    const t = newHarness();
    await createDocument(t, 'keep');
    await createDocument(t, 'gone');
    const base = { internalSecret: SECRET, userId: USER };
    const summaries = await t.query(api.documents.list, { ...base, metadataOnly: true });
    expect(summaries.map((row: any) => row.documentId).sort()).toEqual(['gone', 'keep']);
    expect(summaries.every((row: any) => !('model' in row))).toBe(true);
    const full = await t.query(api.documents.list, { ...base });
    expect(full.every((row: any) => row.model?.kind === 'doc')).toBe(true);

    const storageId = await t.run((ctx) => ctx.storage.store(new Blob(['xlsx bytes'])));
    await t.run(async (ctx) => {
      const row = (await ctx.db.query('documents').collect()).find((doc) => doc.documentId === 'gone');
      if (!row) return;
      await ctx.db.patch(row._id, {
        importSource: {
          format: 'xlsx',
          filename: 'a.xlsx',
          mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          size: 10,
          sha256: 'x',
          storageId,
          warnings: [],
          importedAt: 1,
          revision: 1,
        },
      });
      for (let revision = 2; revision <= 60; revision += 1) {
        await ctx.db.insert('documentRevisions', {
          userId: USER,
          documentId: 'gone',
          revision,
          title: 'gone',
          model: {},
          reason: 'edit',
          actor: 'user',
          createdAt: revision,
        });
      }
    });
    await t.mutation(api.documents.archive, { ...base, documentId: 'gone' });
    for (let round = 0; round < 3; round += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      await t.finishInProgressScheduledFunctions();
    }
    const left = await t.run(async (ctx) => ({
      revisions: (await ctx.db.query('documentRevisions').collect()).map((row) => row.documentId),
      models: (await ctx.db.query('documentModels').collect()).map((row) => row.documentId),
      blob: Boolean(await ctx.db.system.get(storageId)),
      importSource: (await ctx.db.query('documents').collect()).find((doc) => doc.documentId === 'gone')
        ?.importSource,
      modelId: (await ctx.db.query('documents').collect()).find((doc) => doc.documentId === 'gone')?.modelId,
    }));
    expect(left).toEqual({
      revisions: ['keep'],
      models: ['keep'],
      blob: false,
      importSource: undefined,
      modelId: undefined,
    });
  });

  test('models live apart from their rows, and reads load them by id (DOC-4)', async () => {
    const t = newHarness();
    const base = { internalSecret: SECRET, userId: USER, documentId: 'big' };
    const paragraph = (text: string) => ({
      kind: 'doc',
      version: 1,
      blocks: [{ id: 'b1', type: 'paragraph', text }],
    });
    const first = paragraph('a'.repeat(200_000));
    const created = await t.mutation(api.documents.create, {
      ...base,
      kind: 'doc',
      title: 'Big',
      model: first,
    });
    expect(created).toMatchObject({ documentId: 'big', currentRevision: 1, model: first });
    expect('modelId' in created).toBe(false);

    const stored = await t.run(async (ctx) => ({
      document: (await ctx.db.query('documents').collect())[0],
      revision: (await ctx.db.query('documentRevisions').collect())[0],
      models: await ctx.db.query('documentModels').collect(),
    }));
    // The document row is metadata and a pointer; its current revision shares the model row.
    expect(stored.document.model).toBeUndefined();
    expect(JSON.stringify(stored.document).length).toBeLessThan(1_000);
    expect(stored.revision.model).toBeUndefined();
    expect(stored.revision.modelId).toBe(stored.document.modelId!);
    expect(stored.models).toHaveLength(1);
    expect(stored.models[0]).toMatchObject({ userId: USER, documentId: 'big', model: first });
    expect(stored.document.modelBytes).toBe(stored.models[0].bytes);

    // Round trip: save and load.
    const second = paragraph('second draft');
    expect(
      await t.mutation(api.documents.update, { ...base, expectedRevision: 1, model: second, reason: 'edit' }),
    ).toMatchObject({ ok: true, document: { model: second, currentRevision: 2 } });
    const loaded = await t.query(api.documents.get, base);
    expect(loaded).toMatchObject({ title: 'Big', currentRevision: 2, model: second, suggestions: [] });
    expect(loaded && ('modelId' in loaded || 'modelBytes' in loaded)).toBe(false);
    // A stale save gets the current model back to rebase on.
    expect(
      await t.mutation(api.documents.update, { ...base, expectedRevision: 1, model: first }),
    ).toMatchObject({ ok: false, code: 'REVISION_CONFLICT', document: { model: second } });

    // History is metadata only; a restore loads the old model by id.
    const history = await t.query(api.documents.listRevisions, base);
    expect(history.map((row) => row.revision)).toEqual([2, 1]);
    expect(history.some((row: any) => 'model' in row || 'modelId' in row)).toBe(false);
    expect(
      await t.mutation(api.documents.restoreRevision, { ...base, revision: 1, expectedRevision: 2 }),
    ).toEqual({ ok: true });
    expect((await t.query(api.documents.get, base))?.model).toEqual(first);

    // Each revision has its own model row, the document shares the current one, and nothing is left over.
    const after = await t.run(async (ctx) => ({
      document: (await ctx.db.query('documents').collect())[0],
      revisions: await ctx.db.query('documentRevisions').collect(),
      models: await ctx.db.query('documentModels').collect(),
    }));
    expect(after.models).toHaveLength(3);
    expect(new Set(after.revisions.map((row) => row.modelId)).size).toBe(3);
    expect(after.revisions.find((row) => row.revision === 3)?.modelId).toBe(after.document.modelId!);
  });

  test('the list returns metadata only unless a caller asks for models (DOC-4)', async () => {
    const t = newHarness();
    const base = { internalSecret: SECRET, userId: USER };
    await createDocument(t, 'one');
    await createDocument(t, 'two', 'sheet');
    const summaries = await t.query(api.documents.list, { ...base, metadataOnly: true });
    expect(summaries.map((row: any) => row.documentId).sort()).toEqual(['one', 'two']);
    for (const row of summaries) {
      expect(Object.keys(row).filter((key) => key.startsWith('model'))).toEqual([]);
    }
    // The metadata list needs no model row at all.
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query('documentModels').collect()) await ctx.db.delete(row._id);
    });
    expect(await t.query(api.documents.list, { ...base, metadataOnly: true })).toHaveLength(2);
  });

  test('a full list stops at the byte budget instead of loading every model (DOC-4)', async () => {
    const t = newHarness();
    const model = {
      kind: 'doc',
      version: 1,
      blocks: [{ id: 'b1', type: 'paragraph', text: 'x'.repeat(850_000) }],
    };
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'])
      await t.mutation(api.documents.create, {
        internalSecret: SECRET,
        userId: USER,
        documentId: id,
        kind: 'doc',
        title: id,
        model,
      });
    const rows = await t.query(api.documents.list, { internalSecret: SECRET, userId: USER });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(8);
    expect(rows.every((row: any) => row.model?.blocks?.[0]?.text.length === 850_000)).toBe(true);
    expect(
      await t.query(api.documents.list, { internalSecret: SECRET, userId: USER, metadataOnly: true }),
    ).toHaveLength(8);
  });

  test('inline models from before still read, move on migration, and move once (DOC-4)', async () => {
    const t = newHarness();
    const base = { internalSecret: SECRET, userId: USER };
    const version = (text: string) => ({
      kind: 'doc',
      version: 1,
      blocks: [{ id: 'b1', type: 'paragraph', text }],
    });
    await t.run(async (ctx) => {
      const row = { userId: USER, kind: 'doc' as const, sourceRefs: [], createdAt: 1, updatedAt: 2 };
      await ctx.db.insert('documents', {
        ...row,
        documentId: 'legacy',
        title: 'Legacy',
        model: version('current'),
        currentRevision: 2,
      });
      await ctx.db.insert('documents', {
        ...row,
        documentId: 'old-archive',
        title: 'Archived',
        model: version('archived'),
        currentRevision: 1,
        archivedAt: 3,
      });
      for (const [revision, text] of [
        [1, 'first'],
        [2, 'current'],
      ] as const)
        await ctx.db.insert('documentRevisions', {
          userId: USER,
          documentId: 'legacy',
          revision,
          title: 'Legacy',
          model: version(text),
          reason: 'edit',
          actor: 'user',
          createdAt: revision,
        });
    });
    // Reads accept the inline form.
    expect((await t.query(api.documents.get, { ...base, documentId: 'legacy' }))?.model).toEqual(
      version('current'),
    );
    expect((await t.query(api.documents.list, base)).map((row: any) => row.model)).toEqual([
      version('current'),
    ]);
    expect(
      (await t.query(api.documents.listRevisions, { ...base, documentId: 'legacy' })).some(
        (row: any) => 'model' in row,
      ),
    ).toBe(false);

    // One page at a time, documents first, then revisions.
    const migrate = internal.documents.migrateInlineModels;
    let result = await t.mutation(migrate, { batchSize: 1, continue: false });
    const pages = [result];
    while (!result.done) {
      result = await t.mutation(migrate, {
        ...result.next!,
        batchSize: 1,
        moved: result.total,
        continue: false,
      });
      pages.push(result);
    }
    expect(result.total).toBe(3);
    expect(pages.map((page) => page.table)).toContain('documentRevisions');

    const rows = await t.run(async (ctx) => ({
      documents: await ctx.db.query('documents').collect(),
      revisions: await ctx.db.query('documentRevisions').collect(),
      models: await ctx.db.query('documentModels').collect(),
    }));
    expect([...rows.documents, ...rows.revisions].some((row) => row.model !== undefined)).toBe(false);
    const legacy = rows.documents.find((row) => row.documentId === 'legacy')!;
    const archived = rows.documents.find((row) => row.documentId === 'old-archive')!;
    // The archived model is dropped, not moved; the current revision shares the document's row.
    expect(archived.modelId).toBeUndefined();
    expect(rows.models).toHaveLength(2);
    expect(rows.revisions.find((row) => row.revision === 2)?.modelId).toBe(legacy.modelId!);
    expect((await t.query(api.documents.get, { ...base, documentId: 'legacy' }))?.model).toEqual(
      version('current'),
    );
    expect(
      await t.mutation(api.documents.restoreRevision, {
        ...base,
        documentId: 'legacy',
        revision: 1,
        expectedRevision: 2,
      }),
    ).toEqual({ ok: true });
    expect((await t.query(api.documents.get, { ...base, documentId: 'legacy' }))?.model).toEqual(
      version('first'),
    );

    // A second run finds nothing to move, including through the scheduled chain.
    await t.mutation(migrate, { batchSize: 8 });
    for (let round = 0; round < 3; round += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      await t.finishInProgressScheduledFunctions();
    }
    expect(await t.mutation(migrate, { table: 'documentRevisions', continue: false })).toMatchObject({
      moved: 0,
      done: true,
    });
    expect(await t.run((ctx) => ctx.db.query('documentModels').collect())).toHaveLength(3);
  });

  test('a save moves an inline document model and drops a row only the document held (DOC-4)', async () => {
    const t = newHarness();
    const base = { internalSecret: SECRET, userId: USER, documentId: 'mixed' };
    const version = (text: string) => ({
      kind: 'doc',
      version: 1,
      blocks: [{ id: 'b1', type: 'paragraph', text }],
    });
    await t.run(async (ctx) => {
      await ctx.db.insert('documents', {
        userId: USER,
        documentId: 'mixed',
        kind: 'doc',
        title: 'Mixed',
        model: version('one'),
        currentRevision: 1,
        sourceRefs: [],
        createdAt: 1,
        updatedAt: 1,
      });
      await ctx.db.insert('documentRevisions', {
        userId: USER,
        documentId: 'mixed',
        revision: 1,
        title: 'Mixed',
        model: version('one'),
        reason: 'inline_edit',
        actor: 'user',
        createdAt: Date.now(),
      });
    });
    // An autosave merges into the inline revision row and moves both models out.
    expect(
      await t.mutation(api.documents.update, {
        ...base,
        expectedRevision: 1,
        model: version('two'),
        reason: 'inline_edit',
      }),
    ).toMatchObject({ ok: true });
    let rows = await t.run(async (ctx) => ({
      document: (await ctx.db.query('documents').collect())[0],
      revisions: await ctx.db.query('documentRevisions').collect(),
      models: await ctx.db.query('documentModels').collect(),
    }));
    expect(rows.revisions).toHaveLength(1);
    expect(rows.revisions[0]).toMatchObject({ revision: 2, modelId: rows.document.modelId });
    expect(rows.revisions[0].model).toBeUndefined();
    expect(rows.document.model).toBeUndefined();
    expect(rows.models.map((row) => row.model)).toEqual([version('two')]);

    // A document row that holds its own model row (as the migration can leave
    // it) loses that row when the next save moves the document on.
    await t.run(async (ctx) => {
      const own = await ctx.db.insert('documentModels', {
        userId: USER,
        documentId: 'mixed',
        model: version('two'),
        bytes: 10,
        createdAt: 1,
      });
      await ctx.db.patch(rows.document._id, { modelId: own });
    });
    await t.mutation(api.documents.update, { ...base, expectedRevision: 2, title: 'Renamed' });
    rows = await t.run(async (ctx) => ({
      document: (await ctx.db.query('documents').collect())[0],
      revisions: await ctx.db.query('documentRevisions').collect(),
      models: await ctx.db.query('documentModels').collect(),
    }));
    expect(rows.models).toHaveLength(2);
    expect(rows.models.every((row) => rows.revisions.some((revision) => revision.modelId === row._id))).toBe(
      true,
    );
    expect(await t.query(api.documents.get, base)).toMatchObject({ title: 'Renamed', model: version('two') });
  });

  test('file indexing and narrative sources read the document model by id (DOC-4)', async () => {
    const t = convexTest(schema, {
      ...convexModules,
      '../convex/content.ts': () => import('../convex/content'),
      '../convex/narrative.ts': () => import('../convex/narrative'),
    });
    const base = { internalSecret: SECRET, userId: USER };
    const model = {
      kind: 'doc',
      version: 1,
      blocks: [{ id: 'b1', type: 'paragraph', text: 'The launch budget memo for Friday.' }],
    };
    await t.mutation(api.documents.create, {
      ...base,
      documentId: 'memo',
      kind: 'doc',
      title: 'Memo',
      model,
    });
    const page = await t.query((api as any).content.localPage, { ...base, source: 'document' });
    expect(page.items[0]).toMatchObject({ externalId: 'memo', text: 'The launch budget memo for Friday.' });

    const narrative = (api as any).narrative;
    await t.mutation(narrative.configure, {
      ...base,
      enabled: true,
      sources: ['documents'],
      timezone: 'America/New_York',
      model: 'z-ai/glm-5.3-flash',
    });
    await t.finishAllScheduledFunctions(() => {});
    expect((await t.mutation(narrative.ingest, { ...base, group: 'documents', recent: true })).changed).toBe(
      1,
    );
    const entry = (await t.run((ctx) => ctx.db.query('narrativeEntries').collect()))[0];
    const read = await t.query(narrative.read, { ...base, id: String(entry._id), sources: true });
    expect(read.sources[0].detail.text).toContain('The launch budget memo for Friday.');
  });
});
