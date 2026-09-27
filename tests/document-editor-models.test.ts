import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  addElement,
  clampElementBounds,
  createHistory,
  deckModelsEqual,
  deleteSlide,
  duplicateElement,
  duplicateSlide,
  elementLabel,
  findElement,
  moveSlide,
  nudgeElement,
  pushHistory,
  redoHistory,
  reorderElement,
  setSlideBackgroundImage,
  slideColor,
  slideWithElementBounds,
  undoHistory,
  updateElement,
  updateTheme,
  upgradeDeckModel,
} from '../components/files/editors/deck-model';
import {
  docModelsEqual,
  docModelToEditorJson,
  editorJsonToDocModel,
  effectiveRuns,
  moveDocBlock,
  normalizeRuns,
} from '../components/files/editors/doc-rich-text';
import { SlideSurface } from '../components/files/editors/SlideRenderer';
import { DECK_THEMES, referenceDeck } from '../lib/documents/deck-fixtures';
import { deckModelForSave } from '../lib/documents/deck-versions';
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
  const stored = createDefaultDocumentModel('deck', 'base');
  if (stored.kind !== 'deck') throw new Error('Expected deck fixture');
  // Editors work on the lifted version 2 deck; identity holds there.
  const base = upgradeDeckModel(stored);
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
    const texts = (elements: readonly object[]) =>
      elements.map((element) => (element as { text?: string }).text);
    expect(texts(copy.slides[1].elements)).toEqual(texts(base.slides[0].elements));
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
    expect(changed.slides[0].elements[0].type === 'text' && changed.slides[0].elements[0].fontSize).toBe(240);
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

describe('slide editor helpers on the version 2 deck', () => {
  const deck = referenceDeck('editorial');
  test('duplicateElement copies with a fresh id, offset and on top, and clamps to the slide', () => {
    const copy = duplicateElement(deck, 'cover', 'cover-foot', () => 'copy');
    const source = findElement(deck, 'cover', 'cover-foot')!;
    const made = findElement(copy.model, 'cover', 'copy')!;
    expect(copy.elementId).toBe('copy');
    expect(made).toMatchObject({
      type: 'text',
      text: source.type === 'text' ? source.text : '',
      x: source.x + 2,
    });
    expect(made.y + made.height).toBeLessThanOrEqual(100);
    expect(copy.model.slides[0].elements.at(-1)?.id).toBe('copy');
    expect(deck.slides[0].elements.some((element) => element.id === 'copy')).toBe(false);
    expect(duplicateElement(deck, 'cover', 'missing').elementId).toBe('');
    expect(elementLabel(made)).toBe('Text');
    expect(elementLabel(findElement(deck, 'metrics', 'm-chart')!)).toBe('Chart');
  });
  test('slideWithElementBounds previews a box without touching the model', () => {
    const preview = slideWithElementBounds(deck.slides[0], 'cover-title', {
      x: 1,
      y: 2,
      width: 3,
      height: 4,
    });
    expect(preview.elements.find((element) => element.id === 'cover-title')).toMatchObject({
      x: 1,
      y: 2,
      width: 3,
      height: 4,
    });
    expect(findElement(deck, 'cover', 'cover-title')).toMatchObject({ x: 6, y: 24 });
    const line = slideWithElementBounds(deck.slides[4], 'p-line', {
      x: 6,
      y: 46,
      width: 77,
      height: 10,
      flip: true,
    });
    expect(line.elements.find((element) => element.id === 'p-line')).toMatchObject({
      flip: true,
      height: 10,
    });
  });
  test('background image set and clear, layer order and theme changes survive the save policy', () => {
    const withImage = setSlideBackgroundImage(deck, 'close', {
      assetId: 'asset',
      src: '/a.png',
      opacity: 0.4,
    });
    expect(withImage.slides[5].backgroundImage).toEqual({ assetId: 'asset', src: '/a.png', opacity: 0.4 });
    const cleared = setSlideBackgroundImage(withImage, 'close', null);
    expect('backgroundImage' in cleared.slides[5]).toBe(false);
    const forward = reorderElement(deck, 'cover', 'cover-image', 1);
    expect(forward.slides[0].elements[1].id).toBe('cover-image');
    const themed = updateTheme(
      updateElement(deck, 'cover', 'cover-title', { fontSize: 40 }),
      DECK_THEMES.signal,
    );
    expect(themed.theme).toEqual(DECK_THEMES.signal);
    expect(findElement(themed, 'cover', 'cover-title')).toMatchObject({ fontSize: 40 });
    expect(deckModelForSave(themed, 2)).toBe(themed);
    // A version 1 deck that gains a rect shape stays version 1; a line makes it version 2 for good.
    const stored = createDefaultDocumentModel('deck', 'v1');
    if (stored.kind !== 'deck') throw new Error('Expected deck fixture');
    const old = upgradeDeckModel(stored);
    const shaped = addElement(old, old.activeSlideId, 'shape', () => 'rect').model;
    expect(deckModelForSave(shaped, 1).version).toBe(1);
    const lined = addElement(old, old.activeSlideId, 'line', () => 'rule').model;
    expect(deckModelForSave(lined, 1).version).toBe(2);
  });
  test('a flat or upright line paints with the stroke thickness around its zero side', () => {
    const html = renderToStaticMarkup(
      createElement(SlideSurface, { slide: deck.slides[4], theme: deck.theme }),
    );
    const flat = html.match(/<svg class="deck-line" data-line="flat"[^>]*style="([^"]*)"/);
    expect(flat?.[1]).toContain('height:0.13cqw');
    expect(flat?.[1]).toContain('min-height:1px');
    expect(flat?.[1]).toContain('top:calc(0.13cqw / -2)');
    expect(html).toContain('x2="100%" y2="50%"');
    const upright = renderToStaticMarkup(
      createElement(SlideSurface, {
        theme: deck.theme,
        slide: {
          id: 's',
          title: 's',
          elements: [
            {
              id: 'v',
              type: 'line',
              x: 50,
              y: 10,
              width: 0,
              height: 80,
              stroke: { color: '#000000', width: 2, dash: 'dash' },
            },
          ],
        },
      }),
    );
    const vertical = upright.match(/<svg class="deck-line" data-line="upright"[^>]*style="([^"]*)"/);
    expect(vertical?.[1]).toContain('width:0.21cqw');
    expect(vertical?.[1]).toContain('min-width:1px');
    expect(upright).toContain('x1="50%" y1="0" x2="50%" y2="100%"');
    expect(upright).toContain('stroke-dasharray:0.63cqw 0.42cqw');
    const diagonal = renderToStaticMarkup(
      createElement(SlideSurface, {
        theme: deck.theme,
        slide: {
          id: 's',
          title: 's',
          elements: [
            {
              id: 'd',
              type: 'line',
              x: 10,
              y: 10,
              width: 40,
              height: 40,
              flip: true,
              stroke: { color: '#000000', width: 1 },
            },
          ],
        },
      }),
    );
    expect(diagonal).toContain('data-line="diagonal"');
    expect(diagonal).toContain('y1="100"');
  });
});
