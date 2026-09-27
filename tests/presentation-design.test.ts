import { afterEach, describe, expect, mock, test } from 'bun:test';
import { __setDocumentAiDepsForTest, generateDocumentProposal } from '../lib/documents/ai';
import { DECK_THEMES, referenceDeck } from '../lib/documents/deck-fixtures';
import {
  compositionArtwork,
  type DeckImageryPlan,
  type ResolvedDeckImagery,
} from '../lib/documents/deck-imagery';
import { checkDeck } from '../lib/documents/deck-quality';
import type { DeckElementV2, DeckModelV2 } from '../lib/documents/model';
import {
  ARTWORK_PREFIX,
  buildDeckTheme,
  DECK_FONT_PAIRS,
  DECK_PALETTES,
  fitTypeSize,
  isArtworkSource,
  parseSlotName,
  resolvePalette,
} from '../lib/documents/presentation-compositions';
import {
  applyCopyRepairs,
  briefFieldForElement,
  composePresentationV2,
  mentionsRestyle,
  PRESENTATION_DESIGN_GUIDANCE_V2,
  presentationAuthoringV2Schema,
  presentationBriefV2Schema,
} from '../lib/documents/presentation-design';
import { slideReviewSchema } from '../lib/documents/presentation-review';
import {
  HILLS,
  harborBrief,
  lakeshoreBrief,
  passingSlideReviews,
  poolArtworks,
  retroBrief,
  VALLEY,
} from './fixtures/presentation-briefs';
import { passingLayoutDesign, passingVisualReview } from './fixtures/visual-review';

type Box = { x: number; y: number; width: number; height: number; type: string };

function boxes(elements: DeckElementV2[]): Box[] {
  return elements.map((element) => ({
    x: element.x,
    y: element.y,
    width: element.width,
    height: element.height,
    type: element.type,
  }));
}

function within(a: number, b: number, tolerance = 0.5) {
  return Math.abs(a - b) <= tolerance;
}

function titleSize(model: DeckModelV2, slideIndex: number) {
  const element = model.slides[slideIndex].elements.find(
    (candidate): candidate is Extract<DeckElementV2, { type: 'text' }> =>
      candidate.type === 'text' && candidate.role === 'title',
  );
  return element?.fontSize;
}

afterEach(() => {
  __setDocumentAiDepsForTest();
  delete process.env.DECK_RENDER_CHECK;
});

describe('presentation design system', () => {
  test('the named palettes and font pairs equal the reference themes', () => {
    expect(DECK_PALETTES.editorial).toEqual(DECK_THEMES.editorial.colors);
    expect(DECK_PALETTES.signal).toEqual(DECK_THEMES.signal.colors);
    expect(DECK_FONT_PAIRS.serif).toEqual(DECK_THEMES.editorial.fonts);
    expect(DECK_FONT_PAIRS.sans).toEqual(DECK_THEMES.signal.fonts);
    expect(buildDeckTheme('editorial', 'serif')).toEqual(DECK_THEMES.editorial);
    expect(buildDeckTheme('signal', 'sans')).toEqual(DECK_THEMES.signal);
  });

  test('a custom palette is kept when it clears contrast and replaced when it does not', () => {
    const custom = {
      background: '#FFFFFF',
      surface: '#EEEEEE',
      ink: '#111111',
      muted: '#555555',
      accent: '#0055AA',
      accentInk: '#FFFFFF',
    };
    expect(resolvePalette(custom)).toEqual({ colors: custom, name: 'custom', adjusted: false });
    const weak = { ...custom, ink: '#DDDDDD' };
    expect(resolvePalette(weak)).toEqual({
      colors: DECK_PALETTES.editorial,
      name: 'editorial',
      adjusted: true,
    });
  });

  test.each([
    'editorial',
    'signal',
  ] as const)('the Lakeshore content composes onto the %s reference geometry within half a percent', (direction) => {
    const composed = composePresentationV2(lakeshoreBrief(direction), { assets: [VALLEY, HILLS] });
    const reference = referenceDeck(direction);
    expect(composed.theme).toEqual(reference.theme);
    expect(composed.slides).toHaveLength(reference.slides.length);
    for (const [index, slide] of reference.slides.entries()) {
      const actual = composed.slides[index];
      const remaining = boxes(actual.elements);
      for (const expected of boxes(slide.elements)) {
        // The page number shares the footer row, so a footer caption may be narrower.
        const footerCaption = expected.type === 'text' && expected.y >= 88;
        const at = remaining.findIndex(
          (candidate) =>
            candidate.type === expected.type &&
            within(candidate.x, expected.x) &&
            within(candidate.y, expected.y) &&
            within(candidate.height, expected.height) &&
            (within(candidate.width, expected.width) ||
              (footerCaption && candidate.width < expected.width && candidate.x + candidate.width <= 86)),
        );
        expect(at, `${slide.id}: no composed element at ${JSON.stringify(expected)}`).toBeGreaterThanOrEqual(
          0,
        );
        remaining.splice(at, 1);
      }
      // Every element the reference lacks is the page number (the statement slide already has one).
      expect(remaining.map((box) => `${box.type}@${box.x},${box.y}`)).toEqual(
        index <= 1 ? [] : ['text@86,90'],
      );
      expect(actual.background).toEqual(slide.background);
    }
    // The type scale steps down by rule to the sizes the reference chose.
    expect([0, 1, 2, 3, 4, 5].map((index) => titleSize(composed, index))).toEqual(
      direction === 'editorial' ? [68, 56, 38, 32, 34, 44] : [62, 58, 38, 32, 34, 44],
    );
    expect(checkDeck(composed).ok).toBe(true);
  });

  test('every composition varies and carries the primitives the system asks for', () => {
    const model = composePresentationV2(retroBrief());
    expect(model.version).toBe(2);
    expect(checkDeck(model)).toEqual({ ok: true, issues: [] });
    const roles = model.slides.map((slide) => parseSlotName(slide.elements[0].name)?.role);
    expect(roles).toEqual(['cover', 'statement', 'chart', 'process', 'comparison', 'quote', 'list', 'close']);
    // A page number in the mono slot on every slide but the cover.
    for (const [index, slide] of model.slides.entries()) {
      const page = slide.elements.find((element) => parseSlotName(element.name)?.slot === 'page');
      if (index === 0) expect(page).toBeUndefined();
      else
        expect(page).toMatchObject({ type: 'text', font: 'mono', text: String(index + 1).padStart(2, '0') });
    }
    const process = model.slides[3];
    expect(process.elements.filter((element) => element.type === 'line')).toHaveLength(1);
    expect(
      process.elements.filter((element) => element.type === 'shape' && element.shape === 'ellipse'),
    ).toHaveLength(4);
    expect(
      process.elements
        .filter((element) => element.type === 'text' && element.font === 'mono')
        .map((e) => e.type === 'text' && e.text),
    ).toEqual(['01', '02', '03', '04', '04']);
    const chart = model.slides[2].elements.find((element) => element.type === 'chart');
    expect(chart).toMatchObject({
      chart: 'line',
      legend: true,
      series: [{ name: 'Sign-ups' }, { name: 'Plan' }],
    });
    const close = model.slides[7];
    expect(
      close.elements.filter((element) => element.type === 'text' && element.role === 'number'),
    ).toHaveLength(3);
    // No two compositions share a layout signature.
    const signatures = model.slides.map((slide) =>
      slide.elements.map((element) => `${element.type}:${element.x}:${element.y}:${element.width}`).join('|'),
    );
    expect(new Set(signatures).size).toBe(signatures.length);
    // No image was requested, so no image element and no outside address.
    expect(JSON.stringify(model)).not.toContain('http');
    expect(model.slides.some((slide) => slide.elements.some((element) => element.type === 'image'))).toBe(
      false,
    );
  });

  test('images resolve to owned assets only; without one the composition is typographic', () => {
    const brief = lakeshoreBrief();
    const none = composePresentationV2(brief);
    expect(none.slides[0].elements.some((element) => element.type === 'image')).toBe(false);
    expect(none.slides[2].elements.some((element) => element.type === 'image')).toBe(false);
    expect(checkDeck(none).ok).toBe(true);
    const one = composePresentationV2(brief, { assets: [HILLS] });
    const coverImage = one.slides[0].elements.find((element) => element.type === 'image');
    expect(coverImage).toMatchObject({ assetId: 'dev-art-1', src: '/art/fallback-1.jpg' });
    expect(one.slides[2].elements.some((element) => element.type === 'image')).toBe(false);
    const both = composePresentationV2(brief, { assets: [HILLS, VALLEY] });
    expect(both.slides[0].elements.find((element) => element.type === 'image')).toMatchObject({
      assetId: 'dev-art-3',
    });
    expect(both.slides[2].elements.find((element) => element.type === 'image')).toMatchObject({
      assetId: 'dev-art-1',
    });
  });

  test('long titles step down to the floor and never below it', () => {
    const long =
      'A very long cover title that keeps going well past the width the display size allows on one slide';
    expect(fitTypeSize(long, [6, 24, 42, 40], 68, 46, { role: 'title', lineHeight: 0.96 })).toBe(46);
    expect(fitTypeSize('Short', [6, 24, 42, 40], 68, 46, { role: 'title', lineHeight: 0.96 })).toBe(68);
    expect(fitTypeSize(long, [6, 16, 52, 18], 34, 28, { role: 'title', lineHeight: 1.04 })).toBe(28);
  });

  test('copy repairs map composed elements back to brief fields and never touch numbers', () => {
    const brief = lakeshoreBrief();
    const model = composePresentationV2(brief);
    const body = model.slides[2].elements.find((element) => parseSlotName(element.name)?.slot === 'body')!;
    expect(briefFieldForElement(body)).toBe('body');
    const detail = model.slides[3].elements.find(
      (element) => parseSlotName(element.name)?.slot === 'item-1-detail',
    )!;
    expect(briefFieldForElement(detail)).toBe('items.1.detail');
    const repaired = applyCopyRepairs(
      brief,
      ['slide-1', 'slide-2', 'slide-3', 'slide-4'],
      [
        { slideId: 'slide-3', field: 'body', text: 'Shorter body.' },
        { slideId: 'slide-4', field: 'items.1.detail', text: 'committed' },
        { slideId: 'slide-4', field: 'items.1.label', text: '' },
        { slideId: 'slide-9', field: 'title', text: 'ignored' },
        { slideId: 'slide-4', field: 'chart.categories', text: 'ignored' },
      ],
    );
    expect(repaired.slides[2].body).toBe('Shorter body.');
    expect(repaired.slides[3].items[1]).toEqual({ label: '68%', detail: 'committed' });
    expect(repaired.slides[3].chart).toEqual(brief.slides[3].chart);
    expect(brief.slides[2].body).not.toBe('Shorter body.');
  });

  test('the brief schema holds the art direction and rejects malformed slides', () => {
    expect(presentationBriefV2Schema.safeParse({ ...lakeshoreBrief(), slides: [] }).success).toBe(false);
    const brief = lakeshoreBrief();
    expect(
      presentationBriefV2Schema.safeParse({
        ...brief,
        slides: [{ ...brief.slides[0], role: 'hero' }],
      }).success,
    ).toBe(false);
    expect(
      presentationBriefV2Schema.safeParse({
        ...brief,
        slides: [
          { ...brief.slides[3], chart: { ...brief.slides[3].chart, series: [{ name: 'x', values: [1] }] } },
        ],
      }).success,
    ).toBe(false);
    expect(
      presentationBriefV2Schema.safeParse({
        ...brief,
        slides: [
          { ...brief.slides[5], items: Array.from({ length: 5 }, () => ({ label: 'a', detail: '' })) },
        ],
      }).success,
    ).toBe(false);
    expect(PRESENTATION_DESIGN_GUIDANCE_V2).toContain('Never invent numbers');
    expect(PRESENTATION_DESIGN_GUIDANCE_V2).not.toMatch(/\bAI\b/);
    expect(mentionsRestyle('Add a slide about the budget')).toBe(false);
    expect(mentionsRestyle('Restyle this with the signal palette')).toBe(true);
  });
});

describe('designed generation through the document proposal', () => {
  const deckV2 = () =>
    __setDocumentAiDepsForTest({
      reviewDeckVisuals: passingVisualReview,
      designPresentationLayouts: passingLayoutDesign,
      isDeckV2AuthoringEnabled: () => true,
    });

  test('with the flag on, a new deck has a brief call and an every-slide review', async () => {
    const generate = mock(async (options: any) =>
      options.schema === slideReviewSchema ? passingSlideReviews(options) : { object: retroBrief() },
    );
    deckV2();
    __setDocumentAiDepsForTest({
      reviewDeckVisuals: passingVisualReview,
      designPresentationLayouts: passingLayoutDesign,
      isDeckV2AuthoringEnabled: () => true,
      generateObjectForCurrentUser: generate as any,
    });
    const proposal = await generateDocumentProposal({
      userId: 'u',
      kind: 'deck',
      instruction: 'Make an eight-slide launch retro',
      sourceContext: 'Sign-ups: 1240, 1310, 980, 1150, 1220, 1275.',
    });
    expect(generate).toHaveBeenCalledTimes(2);
    expect(generate.mock.calls[0][0]).toMatchObject({
      feature: 'document_generation',
      schema: presentationAuthoringV2Schema,
    });
    expect(proposal.model).toMatchObject({ kind: 'deck', version: 2, theme: DECK_THEMES.editorial });
    expect(proposal.summary).not.toMatch(/\bAI\b/);
    expect(checkDeck(proposal.model as DeckModelV2).ok).toBe(true);
  });

  test('with the flag off, the version 1 path runs unchanged', async () => {
    const generate = mock(async () => ({
      object: {
        title: 'Old style',
        summary: 'A version 1 deck',
        palette: 'ink',
        slides: [{ layout: 'cover', title: 'Hello', kicker: '', body: '', items: [], notes: '' }],
      },
    }));
    __setDocumentAiDepsForTest({
      reviewDeckVisuals: passingVisualReview,
      designPresentationLayouts: passingLayoutDesign,
      isDeckV2AuthoringEnabled: () => false,
      generateObjectForCurrentUser: generate as any,
    });
    const proposal = await generateDocumentProposal({ userId: 'u', kind: 'deck', instruction: 'One slide' });
    expect(proposal.model).toMatchObject({ kind: 'deck', version: 1 });
  });

  test('overflow gets targeted repair and preserves source detail; unavailable repair falls back safely', async () => {
    const brief = retroBrief();
    // A chart callout caption is one line tall; the bounded repair cannot make this fit.
    const tooLong = 'from the launch brief '.repeat(7).trim();
    brief.slides[2].items[0].detail = tooLong;
    const calls: any[] = [];
    const generate = mock(async (options: any) => {
      if (options.schema === slideReviewSchema) return passingSlideReviews(options);
      calls.push(options);
      if (calls.length === 1) return { object: brief };
      return {
        object: { fixes: [{ slideId: 'slide-3', field: 'items.0.detail', text: 'From the launch brief.' }] },
      };
    });
    __setDocumentAiDepsForTest({
      reviewDeckVisuals: passingVisualReview,
      designPresentationLayouts: passingLayoutDesign,
      isDeckV2AuthoringEnabled: () => true,
      generateObjectForCurrentUser: generate as any,
    });
    const proposal = await generateDocumentProposal({ userId: 'u', kind: 'deck', instruction: 'Retro' });
    expect(calls).toHaveLength(2);
    expect(calls[1].prompt).toContain('items.0.detail');
    expect(calls[1].prompt).toContain(tooLong);
    const model = proposal.model as DeckModelV2;
    expect(model.slides[2].notes).toContain(tooLong);
    expect(JSON.stringify(model.slides[2].elements)).not.toContain(tooLong);
    expect(checkDeck(model).ok).toBe(true);

    const stubborn = mock(async (options: any) =>
      options.schema === presentationAuthoringV2Schema
        ? { object: brief }
        : options.schema === slideReviewSchema
          ? passingSlideReviews(options)
          : { object: { fixes: [] } },
    );
    __setDocumentAiDepsForTest({
      reviewDeckVisuals: passingVisualReview,
      designPresentationLayouts: passingLayoutDesign,
      isDeckV2AuthoringEnabled: () => true,
      generateObjectForCurrentUser: stubborn as any,
    });
    const recovered = await generateDocumentProposal({ userId: 'u', kind: 'deck', instruction: 'Retro' });
    expect(checkDeck(recovered.model as DeckModelV2).ok).toBe(true);
    expect((recovered.model as DeckModelV2).slides[2].notes).toContain(tooLong);
  });

  test('final composition is always visually reviewed and retains a draft when review is incomplete', async () => {
    const review = mock(async (model: DeckModelV2) => ({
      model,
      report: {
        status: 'needs_review' as const,
        totalSlides: model.slides.length,
        checkedSlideIds: [],
        repairedSlideIds: [],
        issues: [{ slideId: model.slides[0].id, description: 'Review could not finish.' }],
      },
    }));
    __setDocumentAiDepsForTest({
      isDeckV2AuthoringEnabled: () => true,
      generateObjectForCurrentUser: (async () => ({ object: retroBrief() })) as any,
      reviewDeckVisuals: review,
      designPresentationLayouts: passingLayoutDesign,
    });
    const proposal = await generateDocumentProposal({ userId: 'u', kind: 'deck', instruction: 'Retro' });
    expect(review).toHaveBeenCalledTimes(1);
    expect((review.mock.calls[0][0] as DeckModelV2).slides).toHaveLength(8);
    expect(proposal.visualReview?.status).toBe('needs_review');
    expect(proposal.summary).toContain('Draft saved; visual review needs attention');
    expect(proposal.model).toMatchObject({ version: 2 });
  });

  test('a new deck hangs planned paintings; a resolver failure or an empty result degrades to typography', async () => {
    const artworks = poolArtworks(4);
    const resolve = mock(
      async (plan: DeckImageryPlan, _context?: unknown): Promise<ResolvedDeckImagery> => ({
        assets: artworks,
        bySlot: Object.fromEntries(plan.slots.map((slot, index) => [slot.slotId, artworks[index]])),
        notes: [],
      }),
    );
    __setDocumentAiDepsForTest({
      reviewDeckVisuals: passingVisualReview,
      designPresentationLayouts: passingLayoutDesign,
      isDeckV2AuthoringEnabled: () => true,
      generateObjectForCurrentUser: (async () => ({ object: harborBrief() })) as any,
      resolveDeckImagery: resolve as any,
    });
    const proposal = await generateDocumentProposal({
      userId: 'u',
      kind: 'deck',
      instruction: 'Harbor deck',
      assets: [VALLEY],
    });
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve.mock.calls[0][1]).toEqual({ userId: 'u' });
    const plan = resolve.mock.calls[0][0];
    // The owned image took the image-right slot, so the plan skipped it.
    expect(plan.slots.map((slot) => slot.role)).toEqual(['cover', 'statement', 'close', 'quote']);
    const model = proposal.model as DeckModelV2;
    expect(checkDeck(model).ok).toBe(true);
    expect(model.theme.imagery).toMatchObject({ mode: 'paintings', subject: 'harbor ships water dusk' });
    expect(model.slides[0].elements.some((e) => e.type === 'image' && isArtworkSource(e.source))).toBe(true);
    expect(model.slides[2].elements.find((e) => e.type === 'image')).toMatchObject({ assetId: 'dev-art-3' });
    expect(model.slides[1].backgroundImage).toMatchObject({ assetId: 'art-2' });
    expect(model.slides[4].notes).toBe(`${ARTWORK_PREFIX}${compositionArtwork(artworks[3]).credit}`);
    expect(proposal.summary).toContain(
      'The dredging plan for the outer harbor. Added 4 public-domain paintings with credits.',
    );

    const one = mock(
      async (plan: DeckImageryPlan): Promise<ResolvedDeckImagery> => ({
        assets: [artworks[0]],
        bySlot: { [plan.slots[0].slotId]: artworks[0] },
        notes: ['No artwork was imported for slide 2.'],
      }),
    );
    __setDocumentAiDepsForTest({
      reviewDeckVisuals: passingVisualReview,
      designPresentationLayouts: passingLayoutDesign,
      isDeckV2AuthoringEnabled: () => true,
      generateObjectForCurrentUser: (async () => ({ object: harborBrief() })) as any,
      resolveDeckImagery: one as any,
    });
    const single = await generateDocumentProposal({ userId: 'u', kind: 'deck', instruction: 'Harbor deck' });
    expect(single.summary).toContain('Added 1 public-domain painting with credits.');

    const none = mock(async () => ({ assets: [], bySlot: {}, notes: [] }));
    __setDocumentAiDepsForTest({
      reviewDeckVisuals: passingVisualReview,
      designPresentationLayouts: passingLayoutDesign,
      isDeckV2AuthoringEnabled: () => true,
      generateObjectForCurrentUser: (async () => ({ object: harborBrief() })) as any,
      resolveDeckImagery: none as any,
    });
    const plain = await generateDocumentProposal({ userId: 'u', kind: 'deck', instruction: 'Harbor deck' });
    expect(plain.summary).toContain('Artwork was not available; the slides are typographic.');
    expect(JSON.stringify(plain.model)).not.toContain(ARTWORK_PREFIX);
    expect((plain.model as DeckModelV2).theme.imagery).toBeUndefined();

    __setDocumentAiDepsForTest({
      reviewDeckVisuals: passingVisualReview,
      designPresentationLayouts: passingLayoutDesign,
      isDeckV2AuthoringEnabled: () => true,
      generateObjectForCurrentUser: (async () => ({ object: harborBrief() })) as any,
      resolveDeckImagery: (async () => {
        throw new Error('museum down');
      }) as any,
    });
    const degraded = await generateDocumentProposal({
      userId: 'u',
      kind: 'deck',
      instruction: 'Harbor deck',
    });
    expect(degraded.summary).toContain('Artwork could not be added; the slides are typographic.');
    expect(checkDeck(degraded.model as DeckModelV2).ok).toBe(true);

    // artwork none never plans; a brief that declines imagery never plans either.
    const untouched = mock(async () => ({ assets: [], bySlot: {}, notes: [] }));
    __setDocumentAiDepsForTest({
      reviewDeckVisuals: passingVisualReview,
      designPresentationLayouts: passingLayoutDesign,
      isDeckV2AuthoringEnabled: () => true,
      generateObjectForCurrentUser: (async () => ({ object: harborBrief() })) as any,
      resolveDeckImagery: untouched as any,
    });
    const off = await generateDocumentProposal({
      userId: 'u',
      kind: 'deck',
      instruction: 'Harbor deck',
      artwork: 'none',
    });
    expect(off.summary).toContain('The dredging plan for the outer harbor.');
    __setDocumentAiDepsForTest({
      reviewDeckVisuals: passingVisualReview,
      designPresentationLayouts: passingLayoutDesign,
      isDeckV2AuthoringEnabled: () => true,
      generateObjectForCurrentUser: (async () => ({ object: retroBrief() })) as any,
      resolveDeckImagery: untouched as any,
    });
    await generateDocumentProposal({ userId: 'u', kind: 'deck', instruction: 'Retro' });
    expect(untouched).not.toHaveBeenCalled();
    expect(PRESENTATION_DESIGN_GUIDANCE_V2).toContain('imagery is artwork-search subject context');
    expect(PRESENTATION_DESIGN_GUIDANCE_V2).not.toContain('write "none"');
  });

  test('a slide count outside the request is refused before anything composes', async () => {
    __setDocumentAiDepsForTest({
      reviewDeckVisuals: passingVisualReview,
      designPresentationLayouts: passingLayoutDesign,
      isDeckV2AuthoringEnabled: () => true,
      generateObjectForCurrentUser: (async () => ({ object: retroBrief() })) as any,
    });
    await expect(
      generateDocumentProposal({ userId: 'u', kind: 'deck', instruction: 'Exactly three slides' }),
    ).rejects.toThrow('outside the requested count');
  });
});
