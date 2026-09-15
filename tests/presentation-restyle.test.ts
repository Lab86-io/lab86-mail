import { afterEach, describe, expect, mock, test } from 'bun:test';
import { __setDocumentAiDepsForTest, generateDocumentProposal } from '../lib/documents/ai';
import { DECK_THEMES, hiringDeck, referenceDeck } from '../lib/documents/deck-fixtures';
import { checkDeck } from '../lib/documents/deck-quality';
import { documentEditsSchema, prepareDocumentEdits } from '../lib/documents/edits';
import {
  type AlbatrossDocumentRecord,
  createDefaultDocumentModel,
  type DeckElementV2,
  type DeckModelV2,
  deckElementText,
} from '../lib/documents/model';
import { parseSlotName } from '../lib/documents/presentation-compositions';
import {
  composePresentationV2,
  extractSlideContent,
  restyleClassificationSchema,
  restyleDeck,
  restyleOperationFor,
} from '../lib/documents/presentation-design';
import { lakeshoreBrief } from './fixtures/presentation-briefs';

afterEach(() => __setDocumentAiDepsForTest());

function texts(model: DeckModelV2, slideIndex: number) {
  return model.slides[slideIndex].elements
    .filter((element) => element.type === 'text' && parseSlotName(element.name)?.slot !== 'page')
    .map((element) => deckElementText(element))
    .filter((text) => !/^\d{2}$/.test(text))
    .sort();
}

function chartData(model: DeckModelV2) {
  return model.slides.flatMap((slide) =>
    slide.elements
      .filter((element): element is Extract<DeckElementV2, { type: 'chart' }> => element.type === 'chart')
      .map((element) => [element.chart, element.categories, element.series, element.unit, element.source]),
  );
}

describe('deck restyle: theme scope', () => {
  test('moves theme tokens to the new palette and leaves explicit colors and locked elements', () => {
    const source = referenceDeck('editorial');
    source.slides[2].elements.push({
      id: 'brand-mark',
      type: 'shape',
      shape: 'rect',
      x: 90,
      y: 2,
      width: 4,
      height: 4,
      fill: '#123456',
    });
    source.slides[3].elements[0] = { ...source.slides[3].elements[0], locked: true };
    const restyled = restyleDeck(source, { palette: 'signal', fontPair: 'sans', scope: 'theme' });
    expect(restyled.theme).toEqual(DECK_THEMES.signal);
    // Geometry, ids, text, order and notes are exactly as before.
    for (const [index, slide] of source.slides.entries()) {
      const after = restyled.slides[index];
      expect(after.id).toBe(slide.id);
      expect(after.notes).toEqual(slide.notes);
      expect(
        after.elements.map((e) => [e.id, e.type, e.x, e.y, e.width, e.height, deckElementText(e)]),
      ).toEqual(slide.elements.map((e) => [e.id, e.type, e.x, e.y, e.width, e.height, deckElementText(e)]));
    }
    // The cover rule was accent; it is now the signal accent. The soft hairline moved with it.
    expect(restyled.slides[0].elements.find((e) => e.id === 'cover-rule')).toMatchObject({
      stroke: { color: '#2F5BFF' },
    });
    expect(restyled.slides[2].elements.find((e) => e.id === 'img-rule')).toMatchObject({
      stroke: { color: '#9AA3AE' },
    });
    expect(restyled.slides[1].background).toBe('#0B0F14');
    expect(restyled.slides[2].elements.find((e) => e.id === 'brand-mark')).toMatchObject({ fill: '#123456' });
    expect(restyled.slides[3].elements[0]).toEqual(source.slides[3].elements[0]);
    expect(restyled.slides[3].elements.find((e) => e.id === 'm-chart')).toMatchObject({
      colors: ['#2F5BFF'],
    });
    expect(chartData(restyled)).toEqual(chartData(source));
    expect(checkDeck(restyled).ok).toBe(true);
  });

  test('a font pair alone changes only the fonts', () => {
    const source = referenceDeck('editorial');
    const restyled = restyleDeck(source, { fontPair: 'sans', scope: 'theme' });
    expect(restyled.theme.colors).toEqual(source.theme.colors);
    expect(restyled.theme.fonts).toEqual(DECK_THEMES.signal.fonts);
    expect(restyled.slides).toEqual(source.slides);
  });
});

describe('deck restyle: theme and layout', () => {
  test('recomposes composed slides, keeping ids, notes, order, facts and chart data', () => {
    const source = composePresentationV2(lakeshoreBrief('editorial'), {
      assets: [{ assetId: 'dev-art-3', src: '/art/fallback-3.jpg', aspect: 1.5 }],
    });
    const restyled = restyleDeck(source, { palette: 'signal', fontPair: 'sans', scope: 'theme-and-layout' });
    expect(restyled.theme).toEqual(DECK_THEMES.signal);
    expect(restyled.slides.map((slide) => slide.id)).toEqual(source.slides.map((slide) => slide.id));
    for (const [index, slide] of source.slides.entries()) {
      const after = restyled.slides[index];
      expect(after.notes).toEqual(slide.notes);
      expect(after.title).toBe(slide.title);
      expect(texts(restyled, index)).toEqual(texts(source, index));
      // Content elements keep their ids one to one.
      for (const element of slide.elements) {
        const slot = parseSlotName(element.name)?.slot ?? '';
        if (element.type === 'text' || element.type === 'chart' || element.type === 'image')
          expect(
            after.elements.some((candidate) => candidate.id === element.id),
            `${slide.id}/${slot}`,
          ).toBe(true);
      }
    }
    expect(chartData(restyled)).toEqual(chartData(source));
    expect(restyled.slides[0].elements.find((e) => e.type === 'image')).toMatchObject({
      assetId: 'dev-art-3',
    });
    // The layout did move: the signal cover has a chip, not a rule.
    expect(source.slides[0].elements.some((e) => parseSlotName(e.name)?.slot === 'rule')).toBe(true);
    expect(restyled.slides[0].elements.some((e) => parseSlotName(e.name)?.slot === 'chip')).toBe(true);
    expect(checkDeck(restyled).ok).toBe(true);
  });

  test('extracts hand-made slides by structure and keeps every fact and locked element', () => {
    const source = referenceDeck('editorial');
    const locked = { ...source.slides[4].elements[2], locked: true };
    source.slides[4].elements[2] = locked;
    const roles = source.slides.map(
      (slide, index) => extractSlideContent(slide, index, 6, source.theme)?.content.role,
    );
    expect(roles).toEqual(['cover', 'statement', 'image-left', 'metrics', 'process', 'close']);
    const restyled = restyleDeck(source, {
      palette: 'signal',
      scope: 'theme-and-layout',
      lockedElementIds: ['c-foot'],
    });
    for (const index of [0, 1, 2, 3, 4, 5]) {
      expect(texts(restyled, index)).toEqual(texts(source, index));
      expect(restyled.slides[index].notes).toEqual(source.slides[index].notes);
    }
    expect(chartData(restyled)).toEqual(chartData(source));
    expect(restyled.slides[4].elements.find((e) => e.id === locked.id)).toEqual(locked);
    expect(restyled.slides[5].elements.find((e) => e.id === 'c-foot')).toEqual(
      source.slides[5].elements.find((e) => e.id === 'c-foot')!,
    );
    // Titles keep their ids; the composed slide is version 2 with the new fonts left as they were.
    expect(restyled.slides[0].elements.some((e) => e.id === 'cover-title')).toBe(true);
    expect(restyled.theme.fonts).toEqual(DECK_THEMES.editorial.fonts);
    expect(checkDeck(restyled).ok).toBe(true);
  });

  test('the hiring deck and a legacy default deck survive a layout restyle', () => {
    const hiring = restyleDeck(hiringDeck('editorial'), {
      palette: 'signal',
      fontPair: 'sans',
      scope: 'theme-and-layout',
    });
    expect(hiring.slides.map((s) => s.id)).toEqual(['h-cover', 'h-compare', 'h-chart']);
    expect(chartData(hiring)).toEqual(chartData(hiringDeck('editorial')));
    expect(texts(hiring, 1)).toEqual(texts(hiringDeck('editorial'), 1));
    expect(checkDeck(hiring).ok).toBe(true);

    const legacy = createDefaultDocumentModel('deck', 'd');
    if (legacy.kind !== 'deck' || legacy.version !== 1) throw new Error('fixture');
    legacy.slides[0].elements[0].text = 'Quarterly review';
    legacy.slides[0].elements[1].text = 'Numbers, people and the plan for the next quarter.';
    const restyled = prepareDocumentEdits(legacy, [
      { op: 'deck_restyle', palette: 'editorial', fontPair: 'serif', scope: 'theme-and-layout' },
    ]);
    if (restyled.kind !== 'deck' || restyled.version !== 2) throw new Error('expected version 2');
    expect(restyled.theme).toEqual(DECK_THEMES.editorial);
    const cover = restyled.slides[0];
    expect(cover.elements.find((e) => e.id === 'd-slide-1-title')).toMatchObject({
      text: 'Quarterly review',
      role: 'title',
    });
    expect(cover.elements.find((e) => e.id === 'd-slide-1-subtitle')).toMatchObject({
      text: 'Numbers, people and the plan for the next quarter.',
    });
    expect(checkDeck(restyled).ok).toBe(true);
  });
});

describe('deck_restyle operation contract', () => {
  test('accepts the version 2 form and the legacy form, and rejects an empty request', () => {
    expect(documentEditsSchema.safeParse([{ op: 'deck_restyle', palette: 'signal' }]).success).toBe(true);
    expect(
      documentEditsSchema.safeParse([{ op: 'deck_restyle', fontPair: 'sans', scope: 'theme-and-layout' }])
        .success,
    ).toBe(true);
    expect(
      documentEditsSchema.safeParse([
        {
          op: 'deck_restyle',
          palette: {
            background: '#FFFFFF',
            surface: '#EEEEEE',
            ink: '#111111',
            muted: '#555555',
            accent: '#0055AA',
            accentInk: '#FFFFFF',
          },
          lockedElementIds: ['a'],
        },
      ]).success,
    ).toBe(true);
    expect(documentEditsSchema.safeParse([{ op: 'deck_restyle', theme: 'dark' }]).success).toBe(true);
    expect(documentEditsSchema.safeParse([{ op: 'deck_restyle' }]).success).toBe(false);
    expect(documentEditsSchema.safeParse([{ op: 'deck_restyle', palette: 'neon' }]).success).toBe(false);
  });

  test('the legacy form still themes every slide the old way', () => {
    const restyled = prepareDocumentEdits(referenceDeck('editorial'), [
      { op: 'deck_restyle', theme: 'light' },
    ]);
    if (restyled.kind !== 'deck' || restyled.version !== 2) throw new Error('expected version 2');
    expect(restyled.theme.colors.accent).toBe('#7c83ff');
    expect(restyled.slides.every((slide) => slide.background === '#ffffff')).toBe(true);
  });
});

describe('restyle requests through the document proposal', () => {
  const record = (model: AlbatrossDocumentRecord['model']): AlbatrossDocumentRecord => ({
    documentId: 'deck-1',
    kind: 'deck',
    title: 'Lakeshore',
    model,
    currentRevision: 3,
    sourceRefs: [],
    createdAt: 1,
    updatedAt: 2,
  });

  test('an appearance request becomes a restyle proposal without regenerating content', async () => {
    const generate = mock(async () => ({
      object: {
        restyle: true,
        palette: 'signal',
        colors: null,
        fontPair: 'sans',
        scope: 'theme',
        summary: 'Moved the deck to the signal palette with sans fonts.',
      },
    }));
    __setDocumentAiDepsForTest({
      isDeckV2AuthoringEnabled: () => true,
      generateObjectForCurrentUser: generate as any,
    });
    const current = record(referenceDeck('editorial'));
    const proposal = await generateDocumentProposal({
      userId: 'u',
      kind: 'deck',
      instruction: 'Restyle the deck with the signal palette and sans fonts',
      current,
    });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate.mock.calls[0][0]).toMatchObject({
      schema: restyleClassificationSchema,
      speed: 'classify',
    });
    expect(proposal.title).toBe('Lakeshore');
    expect(proposal.summary).toBe('Moved the deck to the signal palette with sans fonts.');
    const model = proposal.model as DeckModelV2;
    expect(model.theme).toEqual(DECK_THEMES.signal);
    expect(texts(model, 2)).toEqual(texts(referenceDeck('editorial'), 2));
    expect(chartData(model)).toEqual(chartData(referenceDeck('editorial')));
  });

  test('a content request on an existing deck never hits the classifier', async () => {
    const current = record(referenceDeck('editorial'));
    const generate = mock(async () => ({
      object: {
        title: 'Lakeshore',
        summary: 'Added a budget slide.',
        model: { ...current.model, activeSlideId: 'statement' },
      },
    }));
    __setDocumentAiDepsForTest({
      isDeckV2AuthoringEnabled: () => true,
      generateObjectForCurrentUser: generate as any,
    });
    const proposal = await generateDocumentProposal({
      userId: 'u',
      kind: 'deck',
      instruction: 'Add a slide about the budget',
      current,
    });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate.mock.calls[0][0]).toMatchObject({ feature: 'document_suggestion' });
    expect(generate.mock.calls[0][0].schema).not.toBe(restyleClassificationSchema);
    expect(proposal.summary).toBe('Added a budget slide.');
  });

  test('a classification that is not a restyle falls back to the content path', async () => {
    const current = record(referenceDeck('editorial'));
    const calls: any[] = [];
    const generate = mock(async (options: any) => {
      calls.push(options);
      if (options.schema === restyleClassificationSchema)
        return {
          object: {
            restyle: false,
            palette: 'keep',
            colors: null,
            fontPair: 'keep',
            scope: 'theme',
            summary: 'n/a',
          },
        };
      return {
        object: {
          title: 'Lakeshore',
          summary: 'Changed the words.',
          model: { ...current.model, activeSlideId: 'close' },
        },
      };
    });
    __setDocumentAiDepsForTest({
      isDeckV2AuthoringEnabled: () => true,
      generateObjectForCurrentUser: generate as any,
    });
    const proposal = await generateDocumentProposal({
      userId: 'u',
      kind: 'deck',
      instruction: 'Rewrite the title so it looks stronger',
      current,
    });
    expect(calls).toHaveLength(2);
    expect(proposal.summary).toBe('Changed the words.');
    expect(
      restyleOperationFor({
        restyle: true,
        palette: 'keep',
        colors: null,
        fontPair: 'keep',
        scope: 'theme',
        summary: 'x',
      }),
    ).toBeNull();
  });

  test('with the flag off, an appearance request runs the existing content path', async () => {
    const current = record(referenceDeck('editorial'));
    const generate = mock(async () => ({
      object: {
        title: 'Lakeshore',
        summary: 'Restyled by hand.',
        model: { ...current.model, activeSlideId: 'close' },
      },
    }));
    __setDocumentAiDepsForTest({
      isDeckV2AuthoringEnabled: () => false,
      generateObjectForCurrentUser: generate as any,
    });
    const proposal = await generateDocumentProposal({
      userId: 'u',
      kind: 'deck',
      instruction: 'Restyle the deck with the signal palette',
      current,
    });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate.mock.calls[0][0].schema).not.toBe(restyleClassificationSchema);
    expect(proposal.summary).toBe('Restyled by hand.');
  });
});
