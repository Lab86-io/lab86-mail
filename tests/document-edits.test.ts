import { afterEach, describe, expect, mock, test } from 'bun:test';
import { runWithAiRequestContext } from '../lib/ai/context';
import { AGENT_TOOL_NAMES, liftToolsForAgent } from '../lib/ai/loop';
import { documentEditsSchema, prepareDocumentEdits } from '../lib/documents/edits';
import { type AlbatrossDocumentRecord, createDefaultDocumentModel } from '../lib/documents/model';
import { TOOLS } from '../lib/tools';
import { __setDocumentToolDepsForTest, documentEdit, documentExport } from '../lib/tools/documents';
import { toolContext, withToolContext } from './tools/harness';

const doc = () => ({
  kind: 'doc' as const,
  version: 1 as const,
  blocks: [
    { id: 'intro', type: 'heading' as const, text: 'Plan', level: 1 as const },
    { id: 'body', type: 'paragraph' as const, text: 'Keep this.' },
  ],
});
function record(model = doc() as AlbatrossDocumentRecord['model']): AlbatrossDocumentRecord {
  return {
    documentId: 'owned-file',
    title: 'Plan',
    kind: model.kind,
    model,
    currentRevision: 4,
    sourceRefs: [],
    createdAt: 1,
    updatedAt: 2,
  };
}
const engine = () => ({
  kind: 'sheet' as const,
  version: 2 as const,
  engine: 'o-spreadsheet' as const,
  engineVersion: '19.0.50',
  workbook: {
    version: 18,
    styles: { '1': { bold: true } },
    sheets: [
      {
        id: 'sheet-id',
        name: 'Budget',
        rowNumber: 100,
        colNumber: 26,
        cells: { A1: 'Revenue' },
        charts: [{ id: 'keep' }],
      },
    ],
  },
});
afterEach(() => __setDocumentToolDepsForTest());

describe('deterministic document edits', () => {
  test('rich runs survive structural edits and are cleared on plain-text replacement', () => {
    const source = doc();
    const rich = {
      ...source,
      blocks: source.blocks.map((block) => ({ ...block, runs: [{ text: block.text, bold: true }] })),
    };
    const moved = prepareDocumentEdits(rich, [{ op: 'block_move', blockId: 'body', afterId: null }]);
    if (moved.kind !== 'doc') throw new Error('Wrong kind');
    expect(moved.blocks[0].runs).toEqual([{ text: 'Keep this.', bold: true }]);
    const edited = prepareDocumentEdits(rich, [
      { op: 'block_update', blockId: 'body', patch: { text: 'Replacement' } },
    ]);
    if (edited.kind !== 'doc') throw new Error('Wrong kind');
    expect(edited.blocks[1].runs).toBeUndefined();
    expect(edited.blocks[0].runs).toEqual(rich.blocks[0].runs);
    expect(() =>
      prepareDocumentEdits(rich, [
        {
          op: 'block_update',
          blockId: 'body',
          patch: { text: 'Replacement', runs: [{ text: 'Stale', italic: true }] },
        },
      ]),
    ).toThrow('concatenate');
  });
  test('inserts, edits, reorders and removes blocks without mutating source', () => {
    const source = doc();
    const result = prepareDocumentEdits(source, [
      { op: 'block_insert', afterId: 'intro', block: { id: 'new', type: 'bullet', text: 'Next' } },
      { op: 'block_update', blockId: 'body', patch: { text: 'Updated' } },
      { op: 'block_move', blockId: 'body', afterId: null },
      { op: 'block_remove', blockId: 'new' },
    ]);
    expect(result.kind).toBe('doc');
    if (result.kind !== 'doc') throw new Error('Wrong kind');
    expect(result.blocks.map((block) => block.id)).toEqual(['body', 'intro']);
    expect(result.blocks[0].text).toBe('Updated');
    expect(source).toEqual(doc());
  });
  test('rejects invalid, ambiguous and wrong-kind targets atomically', () => {
    const source = doc();
    expect(() =>
      prepareDocumentEdits(source, [
        { op: 'block_update', blockId: 'body', patch: { text: 'Never persisted' } },
        { op: 'block_remove', blockId: 'missing' },
      ]),
    ).toThrow('Unknown item');
    expect(source).toEqual(doc());
    expect(() =>
      prepareDocumentEdits(source, [{ op: 'block_move', blockId: 'body', afterId: 'body' }]),
    ).toThrow('itself');
    expect(() =>
      prepareDocumentEdits(source, [{ op: 'block_insert', afterId: null, block: source.blocks[0] }]),
    ).toThrow('Duplicate');
    expect(() => prepareDocumentEdits(source, [{ op: 'slide_remove', slideId: 'body' }])).toThrow(
      'presentation',
    );
    expect(
      documentEditsSchema.safeParse([{ op: 'block_remove', blockId: 'body', extra: true }]).success,
    ).toBe(false);
    expect(() =>
      prepareDocumentEdits({ ...source, blocks: [source.blocks[0], source.blocks[0]] }, [
        { op: 'block_remove', blockId: 'intro' },
      ]),
    ).toThrow('ambiguous');
  });
  test('presentation edits preserve siblings and active slide identity', () => {
    const source = createDefaultDocumentModel('deck', 'deck');
    if (source.kind !== 'deck') throw new Error('Wrong kind');
    const original = source.slides[0];
    const result = prepareDocumentEdits(source, [
      { op: 'slide_insert', afterId: original.id, slide: { id: 'two', title: 'Next', elements: [] } },
      {
        op: 'element_upsert',
        slideId: 'two',
        element: { id: 'text', type: 'text', x: 10, y: 10, width: 80, height: 20, text: 'Hello' },
      },
      { op: 'slide_update', slideId: 'two', patch: { notes: 'Presenter notes' } },
      { op: 'slide_move', slideId: 'two', afterId: null },
      { op: 'slide_remove', slideId: original.id },
    ]);
    if (result.kind !== 'deck') throw new Error('Wrong kind');
    expect(result.activeSlideId).toBe('two');
    expect(result.slides[0].elements[0].text).toBe('Hello');
    expect(result.slides[0].notes).toBe('Presenter notes');
    expect(source.slides).toEqual([original]);
    expect(() => prepareDocumentEdits(result, [{ op: 'slide_remove', slideId: 'two' }])).toThrow(
      'at least one',
    );
    expect(() =>
      prepareDocumentEdits(result, [
        {
          op: 'element_upsert',
          slideId: 'two',
          element: { id: 'bad', type: 'shape', x: 95, y: 0, width: 20, height: 10 },
        },
      ]),
    ).toThrow('canvas');
    expect(() =>
      prepareDocumentEdits(result, [
        {
          op: 'slide_insert',
          afterId: null,
          slide: {
            id: 'bad',
            title: '',
            elements: [{ id: 'bad', type: 'shape', x: 95, y: 0, width: 20, height: 10 }],
          },
        },
      ]),
    ).toThrow('canvas');
  });
  test('Odoo changes are bounded engine commands, not flattened workbook replacements', () => {
    const source = engine();
    const result = prepareDocumentEdits(source, [
      { op: 'cell_update', sheetId: 'sheet-id', cell: 'B2', content: '=SUM(B3:B5)' },
    ]);
    expect(result).toEqual({
      kind: 'sheet-changes',
      version: 1,
      changes: [{ sheet: 'sheet-id', cell: 'B2', content: '=SUM(B3:B5)' }],
    });
    expect(source).toEqual(engine());
    expect(() =>
      prepareDocumentEdits(source, [{ op: 'cell_update', sheetId: 'Budget', cell: 'A1', content: 'No' }]),
    ).toThrow('Unknown item');
    expect(() =>
      prepareDocumentEdits(source, [{ op: 'cell_update', sheetId: 'sheet-id', cell: 'AA1', content: 'No' }]),
    ).toThrow('outside');
  });
  test('legacy cells retain formatting while replacing values and formulas', () => {
    const source = createDefaultDocumentModel('sheet', 'test');
    if (source.kind !== 'sheet') throw new Error('Wrong kind');
    source.sheets[0].cells.A1 = { formula: '1+1', format: 'currency' };
    const result = prepareDocumentEdits(source, [
      { op: 'cell_update', sheetId: source.sheets[0].id, cell: 'A1', content: 'Actual' },
    ]);
    expect(result).toMatchObject({ sheets: [{ cells: { A1: { value: 'Actual', format: 'currency' } } }] });
    if (result.kind !== 'sheet' || result.version !== 1) throw new Error('Wrong kind');
    expect(result.sheets[0].cells.A1.formula).toBeUndefined();
  });
});

describe('document editing through the agent AI SDK toolset', () => {
  const args = () => ({
    documentId: 'owned-file',
    expectedRevision: 4,
    mode: 'apply' as const,
    summary: 'Clarify the introduction',
    operations: [{ op: 'block_update' as const, blockId: 'intro', patch: { text: 'Clear plan' } }],
  });
  test('registered and lifted tool executes under the authenticated chat owner with CAS', async () => {
    const update = mock(async (input: any) => ({
      ok: true as const,
      document: { ...record(input.model), currentRevision: 5 },
    }));
    const generation = mock(async () => {
      throw new Error('Must not generate');
    });
    const get = mock(async () => ({ ...record(), suggestions: [] }));
    __setDocumentToolDepsForTest({
      getDocument: get,
      updateDocument: update,
      generateDocumentProposal: generation,
    });
    expect(TOOLS.document_edit).toBe(documentEdit);
    expect(AGENT_TOOL_NAMES.has('document_edit')).toBe(true);
    const tools = liftToolsForAgent('batch-test');
    // The model sees a JSON schema derived from the zod input (patterns
    // stripped for the OpenAI Responses API); invokeTool still validates with zod.
    expect(tools.document_edit.inputSchema.jsonSchema).toMatchObject({ type: 'object' });
    expect(JSON.stringify(tools.document_edit.inputSchema.jsonSchema)).not.toContain('"pattern"');
    const result = await withToolContext(() =>
      runWithAiRequestContext({ userId: 'test_user_tools', agent: 'ai' }, () =>
        tools.document_edit.execute(args()),
      ),
    );
    expect(result).toMatchObject({
      ok: true,
      status: 'applied',
      revision: 5,
      openPath: '/?view=files&document=owned-file',
    });
    expect(get.mock.calls[0]).toEqual(['test_user_tools', 'owned-file']);
    expect(update.mock.calls[0][0]).toMatchObject({
      userId: 'test_user_tools',
      expectedRevision: 4,
      actor: 'ai',
    });
    expect(generation).not.toHaveBeenCalled();
  });
  test('review defaults to a revision-bound suggestion and does not write contents', async () => {
    const save = mock(async () => ({ ok: true, suggestionId: 'proposal' }));
    const update = mock(async () => {
      throw new Error('Must not update');
    });
    __setDocumentToolDepsForTest({
      getDocument: async () => ({ ...record(), suggestions: [] }),
      createDocumentSuggestion: save,
      updateDocument: update,
    });
    const parsed = documentEdit.input.parse({ ...args(), mode: undefined });
    const result = await documentEdit.handler(parsed, toolContext());
    expect(result).toMatchObject({ status: 'proposed', revision: 4, suggestionId: 'proposal' });
    expect(save.mock.calls[0][0]).toMatchObject({
      baseRevision: 4,
      proposedModel: { blocks: [{ text: 'Clear plan' }, { text: 'Keep this.' }] },
    });
    expect(update).not.toHaveBeenCalled();
  });
  test('stale revision and concurrent saves never overwrite newer typing', async () => {
    const update = mock(async () => ({ ok: false as const, code: 'REVISION_CONFLICT' as const }));
    __setDocumentToolDepsForTest({
      getDocument: async () => ({ ...record(), suggestions: [] }),
      updateDocument: update,
    });
    expect(await documentEdit.handler({ ...args(), expectedRevision: 3 }, toolContext())).toMatchObject({
      ok: false,
      status: 'conflict',
    });
    expect(update).not.toHaveBeenCalled();
    expect(await documentEdit.handler(args(), toolContext())).toMatchObject({
      ok: false,
      status: 'conflict',
      revision: 4,
    });
    expect(update).toHaveBeenCalledTimes(1);
  });
  test('Odoo apply clearly reports pending review and export discloses projection', async () => {
    const update = mock(async () => {
      throw new Error('Must not overwrite engine');
    });
    __setDocumentToolDepsForTest({
      getDocument: async () => ({ ...record(engine()), suggestions: [] }),
      createDocumentSuggestion: async () => ({ ok: true, suggestionId: 'cells' }),
      updateDocument: update,
    });
    const result = await documentEdit.handler(
      { ...args(), operations: [{ op: 'cell_update', sheetId: 'sheet-id', cell: 'B1', content: '=1+1' }] },
      toolContext(),
    );
    expect(result).toMatchObject({ status: 'proposed', revision: 4, suggestionId: 'cells' });
    expect(result.summary).toContain('Not yet applied');
    expect(update).not.toHaveBeenCalled();
    expect(await documentExport.handler({ documentId: 'owned-file' }, toolContext())).toMatchObject({
      fidelity: 'projection',
      warning: expect.stringContaining('values and formulas only'),
    });
  });
  test('missing identity, missing files, invalid IDs and save errors never claim success', async () => {
    await expect(documentEdit.handler(args(), toolContext({ userId: null }))).rejects.toThrow(
      'Not authenticated',
    );
    __setDocumentToolDepsForTest({ getDocument: async () => null });
    await expect(documentEdit.handler(args(), toolContext())).rejects.toThrow('not found');
    __setDocumentToolDepsForTest({
      getDocument: async () => ({ ...record(), suggestions: [] }),
      createDocumentSuggestion: async () => ({ ok: false, suggestionId: 'none' }),
    });
    await expect(documentEdit.handler({ ...args(), mode: 'review' }, toolContext())).rejects.toThrow(
      'could not be saved',
    );
  });
});
