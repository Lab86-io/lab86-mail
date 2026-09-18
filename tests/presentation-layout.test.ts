import { afterEach, expect, mock, test } from 'bun:test';
import { __setDocumentAiDepsForTest, composeDocumentPresentation } from '../lib/documents/ai';
import { DECK_THEMES } from '../lib/documents/deck-fixtures';
import { checkDeck, repairDeck } from '../lib/documents/deck-quality';
import type { DeckElementV2, DeckModelV2 } from '../lib/documents/model';
import {
  buildDeckTheme,
  type CompositionContent,
  composeSlide,
  imageLayoutFor,
  PALETTE_NAMES,
} from '../lib/documents/presentation-compositions';
import {
  applyPresentationLayout,
  designPresentationLayouts,
  presentationLayoutSchema,
} from '../lib/documents/presentation-layout';
import { harborBrief, passingSlideReviews } from './fixtures/presentation-briefs';
import { passingVisualReview } from './fixtures/visual-review';

const fixture = (): DeckModelV2 => ({
  kind: 'deck',
  version: 2,
  activeSlideId: 's',
  theme: DECK_THEMES.editorial,
  slides: [
    {
      id: 's',
      title: 'A turning point',
      notes: 'Verified source',
      elements: [
        {
          id: 'title',
          type: 'text',
          role: 'title',
          text: 'A turning point',
          x: 6,
          y: 8,
          width: 42,
          height: 22,
          fontSize: 36,
        },
        {
          id: 'body',
          type: 'text',
          text: 'Four wins became ten.',
          x: 6,
          y: 40,
          width: 40,
          height: 20,
          fontSize: 18,
        },
        {
          id: 'photo',
          type: 'image',
          src: '/owned.png',
          alt: 'Owned source photograph',
          assetId: 'owned',
          x: 54,
          y: 0,
          width: 46,
          height: 100,
        },
        { id: 'old-rule', type: 'line', x: 6, y: 33, width: 35, height: 0 },
      ],
    },
  ],
});
function layout(model = fixture()) {
  const slide = model.slides[0];
  return {
    slideId: slide.id,
    background: 'background' as const,
    decorations: [],
    placements: slide.elements
      .filter((element) => ['text', 'image', 'chart'].includes(element.type))
      .map((element) => ({
        elementId: element.id,
        x: element.x,
        y: element.y,
        width: element.width,
        height: element.height,
        fontSize: null,
        fontWeight: null,
        lineHeight: null,
        align: null,
        color: null,
        fill: null,
        overlay: false,
      })),
  };
}
afterEach(() => __setDocumentAiDepsForTest());

test('model authored geometry replaces the starter without changing words, data, sources or owned images', () => {
  const original = fixture();
  const design = layout(original);
  design.placements[0] = {
    ...design.placements[0],
    x: 8,
    y: 60,
    width: 40,
    height: 28,
    fontSize: 32,
    fontWeight: 700,
    lineHeight: 1.1,
    align: 'left',
    color: 'ink',
  } as any;
  design.placements[1] = { ...design.placements[1], x: 54, y: 60, width: 38, height: 25 };
  design.placements[2] = { ...design.placements[2], x: 6, y: 6, width: 88, height: 44 };
  const result = applyPresentationLayout(
    original,
    presentationLayoutSchema.parse({
      ...design,
      decorations: [{ x: 6, y: 53, width: 6, height: 1, fill: 'accent', shape: 'rect' }],
    }),
  );
  expect(result.slides[0].elements.find((element) => element.id === 'title')).toMatchObject({
    text: 'A turning point',
    x: 8,
    y: 60,
    fontSize: 32,
  });
  expect(result.slides[0].elements.find((element) => element.id === 'photo')).toMatchObject({
    src: '/owned.png',
    assetId: 'owned',
    width: 88,
  });
  expect(result.slides[0].elements.some((element) => element.id === 'old-rule')).toBe(false);
  expect(result.slides[0].notes).toBe(original.slides[0].notes);
  expect(checkDeck(result).ok).toBe(true);
  expect(original).toEqual(fixture());
});

test('partial, unknown, colliding, off-canvas and illegible designs cannot replace a valid slide', () => {
  const original = fixture();
  const valid = layout();
  for (const invalid of [
    { ...valid, slideId: 'unknown' },
    { ...valid, placements: [...valid.placements, valid.placements[0]] },
    {
      ...valid,
      placements: [{ ...valid.placements[0], elementId: 'invented' }, ...valid.placements.slice(1)],
    },
    { ...valid, placements: valid.placements.slice(1) },
    {
      ...valid,
      placements: valid.placements.map((item) => ({ ...item, x: 6, y: 6, width: 88, height: 20 })),
    },
    {
      ...valid,
      placements: valid.placements.map((item) =>
        item.elementId === 'title' ? { ...item, color: 'background' } : item,
      ),
    },
    {
      ...valid,
      placements: valid.placements.map((item) =>
        item.elementId === 'title' ? { ...item, overlay: true } : item,
      ),
    },
  ])
    expect(() => applyPresentationLayout(original, invalid as any)).toThrow();
  expect(original).toEqual(fixture());
});

test('intentional overlays require a readable surface; images always paint beneath copy and locked content stays unchanged', () => {
  const model = fixture();
  model.slides[0].elements[1].locked = true;
  const spec = layout(model);
  spec.placements[0] = {
    ...spec.placements[0],
    x: 60,
    y: 10,
    width: 32,
    height: 25,
    fill: 'background',
    color: 'ink',
    overlay: true,
  } as any;
  spec.placements[1] = { ...spec.placements[1], x: 50, width: 2 };
  const result = applyPresentationLayout(model, spec);
  const ids = result.slides[0].elements.map((element) => element.id);
  expect(ids.indexOf('photo')).toBeLessThan(ids.indexOf('title'));
  expect(result.slides[0].elements.find((element) => element.id === 'body')).toEqual(
    model.slides[0].elements[1],
  );
  expect(checkDeck(result).ok).toBe(true);
  spec.placements[0].color = 'background' as any;
  expect(() => applyPresentationLayout(model, spec)).toThrow('contrast');
});

test('stray decorations are omitted instead of interfering with a label, while full background panels survive', () => {
  const result = applyPresentationLayout(
    fixture(),
    presentationLayoutSchema.parse({
      ...layout(),
      decorations: [
        { x: 6, y: 7, width: 8, height: 4, fill: 'accent', shape: 'rect' },
        { x: 0, y: 0, width: 50, height: 100, fill: 'surface', shape: 'rect' },
      ],
    }),
  );
  const shapes = result.slides[0].elements.filter((element) => element.type === 'shape');
  expect(shapes).toHaveLength(1);
  expect(shapes[0].width).toBe(50);
  expect(result.slides[0].elements.find((element) => element.id === 'title')).toMatchObject({
    text: 'A turning point',
  });
});

test('creative service repairs a rejected design, preserves order, and safely falls back on provider failure', async () => {
  const model = fixture();
  model.slides.push({ ...structuredClone(model.slides[0]), id: 'two' });
  const attempts = new Map<string, number>();
  const generate = mock(async (options: any) => {
    const input = JSON.parse(options.prompt);
    expect(options.feature).toBe('presentation_layout');
    expect(options.reasoningEffort).toBe('high');
    expect(input.narrative).toHaveLength(2);
    const count = (attempts.get(input.slide.id) ?? 0) + 1;
    attempts.set(input.slide.id, count);
    if (input.slide.id === 'two') throw new Error('Provider temporarily unavailable');
    expect(input.slide.elements[0].x).toBeUndefined();
    const design = layout({ ...model, slides: [model.slides.find((slide) => slide.id === input.slide.id)!] });
    if (count === 1) design.slideId = 'wrong';
    else {
      expect(input.feedback).toContain('slideId');
      expect(input.previousDesign.slideId).toBe('wrong');
    }
    return { object: design };
  });
  const result = await designPresentationLayouts(
    model,
    { userId: 'u', instruction: 'Tell a spirited story' },
    generate as any,
  );
  expect(result.designedSlideIds).toEqual(['s']);
  expect(result.fallbackSlideIds).toEqual(['two']);
  expect(result.model.slides.map((slide) => slide.id)).toEqual(['s', 'two']);
  expect(result.model.slides[1]).toEqual(model.slides[1]);
  expect(generate).toHaveBeenCalledTimes(4);
});

test('overflow feedback explains the actual copy requirements and locked geometry is never repaired', async () => {
  const original = fixture();
  let calls = 0;
  const result = await designPresentationLayouts(original, { userId: 'u', instruction: '' }, (async (
    options: any,
  ) => {
    const request = JSON.parse(options.prompt);
    const spec = layout(original);
    if (++calls === 1) {
      Object.assign(spec.placements[0], { width: 10, height: 2, fontSize: 80 });
    } else {
      expect(request.feedback).toContain('canvas height');
      expect(request.previousDesign.placements[0].width).toBe(10);
    }
    return { object: spec };
  }) as any);
  expect(result.designedSlideIds).toEqual(['s']);
  const locked = original.slides[0].elements[0];
  Object.assign(locked, { locked: true, x: 99, width: 42, height: 1 });
  const fixed = repairDeck(original);
  expect(fixed.model.slides[0].elements[0]).toEqual(locked);
  expect(fixed.report.ok).toBe(false);
});

test('layout deadlines retain successful designs and user cancellation stops the pipeline', async () => {
  const model = fixture();
  const result = await designPresentationLayouts(
    model,
    { userId: 'u', instruction: '' },
    (async () => new Promise(() => {})) as any,
    { budgetMs: 20 },
  );
  expect(result.model).toEqual(model);
  expect(result.fallbackSlideIds).toEqual(['s']);
  let calls = 0;
  const retry = await designPresentationLayouts(
    model,
    { userId: 'u', instruction: '' },
    (async () => (++calls === 1 ? new Promise(() => {}) : { object: layout() })) as any,
    { requestTimeoutMs: 10 },
  );
  expect(retry.designedSlideIds).toEqual(['s']);
  const controller = new AbortController();
  controller.abort(new Error('User stopped'));
  await expect(
    designPresentationLayouts(
      model,
      { userId: 'u', instruction: '', abortSignal: controller.signal },
      (async () => ({ object: layout() })) as any,
    ),
  ).rejects.toThrow('User stopped');
});

test('creation sends model-designed geometry into final pixel review', async () => {
  const brief = harborBrief();
  brief.slides = [brief.slides[0]];
  const generate = mock(async (options: any) => {
    if (options.schema !== presentationLayoutSchema) return passingSlideReviews(options);
    const { composePresentationV2 } = await import('../lib/documents/presentation-design');
    const spec = layout(composePresentationV2(brief));
    const title = spec.placements.find((item) => item.elementId.endsWith('-title'))!;
    title.x = 8;
    return { object: spec };
  });
  const review = mock(passingVisualReview);
  __setDocumentAiDepsForTest({
    isDeckV2AuthoringEnabled: () => true,
    generateObjectForCurrentUser: generate as any,
    reviewDeckVisuals: review,
  });
  const result = await composeDocumentPresentation({
    userId: 'u',
    instruction: 'Make a creative opening',
    presentation: brief,
    artwork: 'none',
  });
  expect(generate.mock.calls.some(([options]) => options.schema === presentationLayoutSchema)).toBe(true);
  expect(review).toHaveBeenCalledTimes(1);
  expect(review.mock.calls[0][0].slides[0].elements.find((element) => element.id.endsWith('-title'))?.x).toBe(
    8,
  );
  expect(result.summary).toContain('Designed individual layouts');
});

test('image collisions cannot hide behind decorative flags and readable copy is reflowed beside the image', () => {
  for (const direction of ['left', 'right', 'above', 'below']) {
    const model = fixture();
    const text: DeckElementV2 = {
      id: 'copy',
      type: 'text',
      text: 'Keep this complete sentence.',
      x: 5,
      y: 5,
      width: 90,
      height: 90,
      fontSize: 16,
    };
    const positions = {
      left: [54, 0, 46, 100],
      right: [0, 0, 46, 100],
      above: [0, 54, 100, 46],
      below: [0, 0, 100, 46],
    };
    const [x, y, width, height] = positions[direction as keyof typeof positions];
    const image: DeckElementV2 = {
      id: 'image',
      type: 'image',
      src: '/owned.png',
      x,
      y,
      width,
      height,
      decorative: true,
      overlapAllowed: true,
    };
    model.slides[0].elements = [text, image];
    expect(checkDeck(model).issues.some((issue) => issue.message.includes('covers'))).toBe(true);
    expect(repairDeck(model, 0).report.ok).toBe(false);
    const fixed = repairDeck(model);
    expect(fixed.report.ok).toBe(true);
    expect(fixed.model.slides[0].elements[0]).toMatchObject({
      text: 'Keep this complete sentence.',
      fontSize: 16,
    });
    expect(model.slides[0].elements[0]).toEqual(text);
    text.locked = true;
    expect(repairDeck(model).report.ok).toBe(false);
    text.locked = false;
    text.rotation = 10;
    expect(repairDeck(model).report.ok).toBe(false);
    image.opacity = 0;
    expect(checkDeck(model).issues.some((issue) => issue.kind === 'overlap')).toBe(false);
  }
  const model = fixture();
  model.slides[0].elements = [
    { ...model.slides[0].elements[2], decorative: true, x: 0, width: 100 } as DeckElementV2,
    model.slides[0].elements[0],
  ];
  expect(checkDeck(model).ok).toBe(true);
});

test('additional image compositions reserve text space and auto layout responds to image shape and copy density', () => {
  const content: CompositionContent = {
    role: 'image-auto',
    title: 'The turning point',
    body: 'A new chapter begins with a clear decision.',
    kicker: 'A change in direction',
    items: [],
    image: { asset: { assetId: 'a', src: '/owned.png', aspect: 2.5 } },
  };
  expect(imageLayoutFor(content)).toBe('image-top');
  expect(imageLayoutFor({ ...content, body: 'long '.repeat(50) })).toBe('image-right');
  expect(imageLayoutFor({ ...content, image: undefined })).toBe('image-right');
  expect(imageLayoutFor({ ...content, image: { asset: { ...content.image!.asset!, aspect: 1.5 } } })).toBe(
    'image-bottom',
  );
  expect(imageLayoutFor({ ...content, image: { asset: { ...content.image!.asset!, aspect: 0.7 } } })).toBe(
    'image-left',
  );
  for (const palette of PALETTE_NAMES)
    for (const role of ['image-top', 'image-bottom', 'image-auto'] as const) {
      const theme = buildDeckTheme(palette, 'serif');
      const slide = composeSlide({ ...content, role }, { theme, slideId: 's', index: 0, total: 1 });
      expect(checkDeck({ ...fixture(), theme, slides: [slide] }).ok).toBe(true);
      const fallback = composeSlide(
        { ...content, role, image: undefined },
        { theme, slideId: 's', index: 0, total: 1 },
      );
      expect(fallback.elements.some((element) => element.type === 'image')).toBe(false);
    }
});
