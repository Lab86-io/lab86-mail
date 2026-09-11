import { afterEach, expect, test } from 'bun:test';
import { __resetDraftStoreForTest, flushDraft, peekDraft, retainDraft } from '../lib/documents/draft-store';
import { parseDocumentModel } from '../lib/documents/model';
import { assertModelWithinLimit, modelByteLength } from '../lib/documents/sheet-workbook';

afterEach(() => __resetDraftStoreForTest());

test('full workbook parsing retains styles, formats, figures, validation, and unknown engine extensions', () => {
  const model = {
    kind: 'sheet',
    version: 2,
    engine: 'o-spreadsheet',
    engineVersion: '19.0.50',
    activeSheetId: 'plan',
    workbook: {
      version: '19',
      revisionId: 'engine-revision',
      styles: { '1': { bold: true } },
      formats: { '1': '#,##0' },
      customEngineField: { preserved: true },
      sheets: [
        {
          id: 'plan',
          name: 'Plan',
          rowNumber: 100,
          colNumber: 26,
          cells: { B1: '=2+2' },
          figures: [{ id: 'chart', data: { type: 'bar' } }],
          merges: ['A1:A2'],
          dataValidationRules: [{ id: 'rule', criterion: { type: 'number' } }],
          styles: { B1: 1 },
        },
      ],
    },
  };
  const parsed = parseDocumentModel(model, 'sheet');
  expect(parsed).toEqual(model);
  expect(modelByteLength(parsed)).toBe(new TextEncoder().encode(JSON.stringify(model)).byteLength);
  expect(() => assertModelWithinLimit({ ...model, padding: 'é'.repeat(500_000) })).toThrow('limit');
});

test('an old flush cannot remove a newer retained draft for the same document', async () => {
  retainDraft('A', { title: 'First', model: { value: 1 }, base: '1' });
  let release!: () => void;
  const saving = flushDraft('A', async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return { ok: true };
  });
  retainDraft('A', { title: 'Later typing', model: { value: 2 }, base: '2' });
  retainDraft('B', { title: 'Other file', model: { value: 3 }, base: '1' });
  release();
  await saving;
  expect(peekDraft('A')?.model).toEqual({ value: 2 });
  expect(peekDraft('B')?.model).toEqual({ value: 3 });
});

test('a failed flush retains the exact draft and makes its error available for recovery', async () => {
  retainDraft('A', { title: 'Local draft', model: { value: 1 }, base: '4' });
  const result = await flushDraft('A', async () => ({
    ok: false,
    error: 'Revision conflict',
    conflict: true,
  }));
  expect(result.ok).toBe(false);
  expect(peekDraft('A')).toMatchObject({
    title: 'Local draft',
    model: { value: 1 },
    base: '4',
    lastError: 'Revision conflict',
  });
});
