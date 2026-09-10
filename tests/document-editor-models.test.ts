import { describe, expect, test } from 'bun:test';
import {
  addElement,
  clampElementBounds,
  createHistory,
  deckModelsEqual,
  deleteSlide,
  duplicateSlide,
  moveSlide,
  nudgeElement,
  pushHistory,
  redoHistory,
  slideColor,
  undoHistory,
  updateElement,
} from '../components/files/editors/deck-model';
import {
  docModelsEqual,
  docModelToEditorJson,
  editorJsonToDocModel,
  effectiveRuns,
  moveDocBlock,
  normalizeRuns,
} from '../components/files/editors/doc-rich-text';
import { createDefaultDocumentModel, parseDocumentModel } from '../lib/documents/model';

describe('rich document model fidelity', () => {
  const doc = {
    kind: 'doc' as const,
    version: 1 as const,
    blocks: [
      { id: 'heading', type: 'heading' as const, level: 1 as const, text: 'Title' },
      {
        id: 'body',
        type: 'paragraph' as const,
        text: 'Strong\ntext',
        runs: [
          { text: 'Strong', bold: true },
          { text: '\ntext', italic: true },
        ],
      },
      { id: 'bullet', type: 'bullet' as const, text: 'One' },
      { id: 'bullet2', type: 'bullet' as const, text: 'Two' },
      { id: 'number', type: 'numbered' as const, text: 'First' },
      { id: 'quote', type: 'quote' as const, text: 'A quotation' },
    ],
  };
  test('all block types, IDs, marks and hard breaks round-trip through editor JSON', () => {
    const json = docModelToEditorJson(doc);
    expect(json.content?.map((node) => node.type)).toEqual([
      'heading',
      'paragraph',
      'bulletList',
      'orderedList',
      'blockquote',
    ]);
    expect(editorJsonToDocModel(json)).toEqual(doc);
    expect(parseDocumentModel(doc)).toEqual(doc);
  });
  test('duplicate pasted IDs get new identities without changing prior blocks', () => {
    const json = docModelToEditorJson(doc);
    json.content!.push(structuredClone(json.content![0]));
    const next = editorJsonToDocModel(json, () => 'pasted');
    expect(next.blocks[0].id).toBe('heading');
    expect(next.blocks.at(-1)?.id).toBe('pasted');
    expect(new Set(next.blocks.map((block) => block.id)).size).toBe(next.blocks.length);
  });
  test('run normalization is lossless and stale styles never replace current text', () => {
    expect(
      normalizeRuns([
        { text: 'a', bold: true },
        { text: 'b', bold: true },
        { text: '' },
        { text: 'c', italic: false },
      ]),
    ).toEqual([{ text: 'ab', bold: true }, { text: 'c' }]);
    expect(effectiveRuns({ text: 'new', runs: [{ text: 'old', bold: true }] })).toBeUndefined();
    expect(() => parseDocumentModel({ ...doc, blocks: [{ ...doc.blocks[1], text: 'mismatch' }] })).toThrow(
      'concatenate',
    );
  });
  test('block moves preserve identity and marks and do not mutate source', () => {
    const moved = moveDocBlock(doc, 'body', -1);
    expect(moved.blocks[0]).toEqual(doc.blocks[1]);
    expect(doc.blocks[0].id).toBe('heading');
    expect(moveDocBlock(doc, 'heading', -1)).toBe(doc);
    expect(docModelsEqual(doc, structuredClone(doc))).toBe(true);
    expect(docModelsEqual(doc, moved)).toBe(false);
  });
  test('long wrapped content remains complete through conversion', () => {
    const blocks = Array.from({ length: 50 }, (_, index) => ({
      id: `long-${index}`,
      type: 'paragraph' as const,
      text: `${index} ${'lengthy text '.repeat(100)}`,
    }));
    expect(editorJsonToDocModel(docModelToEditorJson({ kind: 'doc', version: 1, blocks })).blocks).toEqual(
      blocks,
    );
  });
});

describe('presentation edit identity and recovery', () => {
  const base = createDefaultDocumentModel('deck', 'base');
  if (base.kind !== 'deck') throw new Error('Expected deck fixture');
  test('canvas colors match the supported Office export subset', () => {
    expect(slideColor(' a1b2c3 ', '#FFFFFF')).toBe('#A1B2C3');
    expect(slideColor('#a1b2c3', '#FFFFFF')).toBe('#A1B2C3');
    expect(slideColor('url(https://example.test/image)', '#FFFFFF')).toBe('#FFFFFF');
    expect(slideColor('rgb(0,0,0)', '#FFFFFF')).toBe('#FFFFFF');
  });
  test('duplicate/reorder/delete keep fresh IDs, content and neighboring selection', () => {
    let count = 0;
    const copy = duplicateSlide(base, base.activeSlideId, () => `copy-${++count}`);
    expect(copy.slides).toHaveLength(2);
    expect(copy.slides[1].elements.map((element) => element.id)).not.toEqual(
      base.slides[0].elements.map((element) => element.id),
    );
    expect(copy.slides[1].elements.map((element) => element.text)).toEqual(
      base.slides[0].elements.map((element) => element.text),
    );
    const moved = moveSlide(copy, copy.activeSlideId, -1);
    expect(moved.slides[0].id).toBe(copy.activeSlideId);
    const removed = deleteSlide(moved, moved.activeSlideId);
    expect(removed.activeSlideId).toBe(base.activeSlideId);
    expect(deleteSlide(base, base.activeSlideId)).toBe(base);
  });
  test('shape insertion and nudging remain in bounds, including fractional coordinates', () => {
    const added = addElement(base, base.activeSlideId, 'shape', () => 'shape');
    const moved = nudgeElement(added.model, base.activeSlideId, added.elementId, 1000, -1000);
    const shape = moved.slides[0].elements.at(-1)!;
    expect(shape.x + shape.width).toBeLessThanOrEqual(100);
    expect(shape.y).toBe(0);
    const bounds = clampElementBounds({ x: 90, y: 90, width: 33.335, height: 33.335 });
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(100);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(100);
  });
  test('text/shape editing preserves siblings and updates the title projection', () => {
    const first = base.slides[0].elements[0];
    const changed = updateElement(base, base.activeSlideId, first.id, { text: 'New heading', fontSize: 999 });
    expect(changed.slides[0].title).toBe('New heading');
    expect(changed.slides[0].elements[0].fontSize).toBe(160);
    expect(changed.slides[0].elements[1]).toEqual(base.slides[0].elements[1]);
    expect(deckModelsEqual(changed, base)).toBe(false);
  });
  test('typing coalesces, undo/redo restores exact snapshots, external resets history', () => {
    const first = pushHistory(createHistory('before'), 'a', { key: 'text', now: 100 });
    const next = pushHistory(first, 'ab', { key: 'text', now: 200 });
    expect(next.past).toEqual(['before']);
    expect(undoHistory(next).present).toBe('before');
    expect(redoHistory(undoHistory(next)).present).toBe('ab');
    expect(createHistory('server revision').past).toEqual([]);
  });
});
