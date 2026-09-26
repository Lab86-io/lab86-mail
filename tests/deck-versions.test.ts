import { describe, expect, test } from 'bun:test';
import JSZip from 'jszip';
import { hiringDeck, referenceDeck } from '../lib/documents/deck-fixtures';
import {
  deckModelForSave,
  deckModelsEqual,
  downgradeDeckModel,
  LEGACY_DECK_THEME,
  upgradeDeckModel,
} from '../lib/documents/deck-versions';
import { prepareDocumentEdits } from '../lib/documents/edits';
import { exportDocument } from '../lib/documents/export';
import { createDefaultDocumentModel, documentModelText, parseDocumentModel } from '../lib/documents/model';

const v1 = () => {
  const model = createDefaultDocumentModel('deck', 'd');
  if (model.kind !== 'deck' || model.version !== 1) throw new Error('fixture');
  model.slides[0].elements[0].text = 'Hello';
  model.slides[0].elements.push({
    id: 'box',
    type: 'shape',
    role: 'shape',
    x: 10,
    y: 70,
    width: 30,
    height: 20,
    fill: '#AABBCC',
    color: '#112233',
  } as never);
  return model;
};

describe('deck version lift and downgrade', () => {
  test('a version 1 deck lifts losslessly and downgrades back to the same bytes', () => {
    const source = v1();
    const lifted = upgradeDeckModel(source);
    expect(lifted.version).toBe(2);
    expect(lifted.theme).toEqual(LEGACY_DECK_THEME);
    expect(lifted.slides[0].elements[0]).toMatchObject({
      type: 'text',
      text: 'Hello',
      role: 'title',
      fontWeight: 650,
    });
    expect(lifted.slides[0].elements[2]).toMatchObject({
      type: 'shape',
      shape: 'rect',
      fill: '#AABBCC',
      stroke: { color: '#112233', width: 0.75 },
    });
    expect(downgradeDeckModel(lifted)).toEqual(source);
    expect(deckModelsEqual(source, lifted)).toBe(true);
    expect(parseDocumentModel(lifted)).toEqual(lifted);
  });
  test('a version 2 feature blocks the downgrade, so the save writes version 2', () => {
    const lifted = upgradeDeckModel(v1());
    const withLine = {
      ...lifted,
      slides: [
        {
          ...lifted.slides[0],
          elements: [
            ...lifted.slides[0].elements,
            {
              id: 'rule',
              type: 'line' as const,
              x: 5,
              y: 50,
              width: 90,
              height: 0,
              stroke: { color: '#000000', width: 1 },
            },
          ],
        },
      ],
    };
    expect(downgradeDeckModel(withLine)).toBeNull();
    expect(deckModelForSave(withLine, 1).version).toBe(2);
    expect(deckModelForSave(lifted, 1).version).toBe(1);
    expect(deckModelForSave(lifted, 2).version).toBe(2);
    const big = {
      ...lifted,
      slides: [{ ...lifted.slides[0], elements: [{ ...lifted.slides[0].elements[0], fontSize: 200 }] }],
    };
    expect(downgradeDeckModel(big as typeof lifted)).toBeNull();
  });
  test('the reference decks are valid version 2 models with readable text', () => {
    expect(referenceDeck('editorial').slides).toHaveLength(6);
    expect(referenceDeck('signal').slides).toHaveLength(6);
    expect(hiringDeck().slides).toHaveLength(3);
    for (const deck of [referenceDeck('editorial'), referenceDeck('signal'), hiringDeck()]) {
      expect(parseDocumentModel(deck)).toEqual(deck);
      for (const slide of deck.slides) {
        expect(new Set(slide.elements.map((element) => element.id)).size).toBe(slide.elements.length);
        for (const element of slide.elements) {
          expect(element.x + element.width).toBeLessThanOrEqual(100.0001);
          expect(element.y + element.height).toBeLessThanOrEqual(100.0001);
        }
      }
    }
    expect(documentModelText(referenceDeck('editorial'))).toContain('Spend: Q1 180');
    expect(documentModelText(referenceDeck('editorial'))).toContain('Painted valley');
  });
});

describe('deck edits across versions', () => {
  const record = (model: ReturnType<typeof referenceDeck>) => ({
    documentId: 'deck',
    kind: 'deck' as const,
    title: 'Reference',
    model,
    currentRevision: 1,
    sourceRefs: [],
    createdAt: 1,
    updatedAt: 1,
  });
  test('element edits on a version 1 deck keep version 1 until a version 2 element arrives', () => {
    const source = v1();
    const moved = prepareDocumentEdits(source, [
      {
        op: 'element_upsert',
        slideId: 'd-slide-1',
        element: {
          id: 'box',
          type: 'shape',
          shape: 'rect',
          x: 5,
          y: 5,
          width: 10,
          height: 10,
          fill: '#AABBCC',
          stroke: { color: '#112233', width: 0.75 },
        },
      },
    ]);
    expect(moved.kind === 'deck' && moved.version).toBe(1);
    const chart = prepareDocumentEdits(source, [
      {
        op: 'element_upsert',
        slideId: 'd-slide-1',
        element: {
          id: 'c',
          type: 'chart',
          chart: 'bar',
          x: 5,
          y: 5,
          width: 50,
          height: 40,
          categories: ['a'],
          series: [{ name: 's', values: [1] }],
        },
      },
    ]);
    expect(chart.kind === 'deck' && chart.version).toBe(2);
    expect(chart.kind === 'deck' && chart.slides[0].elements.at(-1)?.type).toBe('chart');
  });
  test('restyle moves the theme and every text color together', () => {
    const restyled = prepareDocumentEdits(referenceDeck('editorial'), [
      { op: 'deck_restyle', theme: 'dark', accent: '#ff0000' },
    ]);
    if (restyled.kind !== 'deck' || restyled.version !== 2) throw new Error('expected deck v2');
    expect(restyled.theme.colors.accent).toBe('#ff0000');
    expect(restyled.slides[0].background).toBe('#111827');
  });
  test('PPTX export keeps charts, lines, images and text as native, editable parts', async () => {
    const exported = await exportDocument(record(referenceDeck('editorial')));
    const zip = await JSZip.loadAsync(exported.bytes);
    const names = Object.keys(zip.files);
    expect(names.filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))).toHaveLength(6);
    expect(names.some((name) => name.startsWith('ppt/charts/chart'))).toBe(true);
    expect(names.some((name) => name.startsWith('ppt/media/'))).toBe(true);
    const slide5 = await zip.file('ppt/slides/slide5.xml')!.async('string');
    expect(slide5).toContain('prstGeom prst="line"');
    expect(slide5).toContain('prstGeom prst="ellipse"');
    const slide1 = await zip.file('ppt/slides/slide1.xml')!.async('string');
    expect(slide1).toContain('typeface="Georgia"');
    expect(slide1).toContain('The Lakeshore Trail');
    expect(slide1).toContain('<p:pic>');
    const notesOrChart = await zip.file('ppt/slides/slide4.xml')!.async('string');
    expect(notesOrChart).toContain('<c:chart');
  }, 30_000);
});
