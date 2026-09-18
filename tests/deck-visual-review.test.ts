import { afterEach, describe, expect, mock, test } from 'bun:test';
import { DECK_THEMES } from '../lib/documents/deck-fixtures';
import {
  __setDeckVisualReviewDepsForTest,
  applyVisualRepairs,
  reviewDeckVisuals,
  visualReviewSummary,
  visualSlideReviewSchema,
} from '../lib/documents/deck-visual-review';
import type { DeckModelV2 } from '../lib/documents/model';

const fixture = (): DeckModelV2 => ({
  kind: 'deck',
  version: 2,
  activeSlideId: 'one',
  theme: DECK_THEMES.editorial,
  slides: [
    {
      id: 'one',
      title: 'Evidence',
      notes: 'Source: supplied records',
      elements: [
        {
          id: 'title',
          type: 'text',
          role: 'title',
          text: 'Evidence',
          x: 5,
          y: 5,
          width: 80,
          height: 15,
          fontSize: 30,
        },
        {
          id: 'graph',
          type: 'chart',
          chart: 'bar',
          categories: ['Jan', 'Feb'],
          series: [{ name: 'Sales', values: [100, 200] }],
          x: 10,
          y: 30,
          width: 70,
          height: 45,
          rotation: 180,
        },
      ],
    },
    {
      id: 'two',
      title: 'Conclusion',
      elements: [
        {
          id: 'body',
          type: 'text',
          text: 'Keep the exact 200 figure.',
          x: 5,
          y: 10,
          width: 85,
          height: 20,
          fontSize: 20,
        },
      ],
    },
  ],
});

const fix = (overrides: Record<string, unknown> = {}) => ({
  elementId: 'graph',
  x: null,
  y: null,
  width: null,
  height: null,
  rotation: 0,
  fontSize: null,
  lineHeight: null,
  color: null,
  fill: null,
  colors: null,
  ...overrides,
});
const render = (model: DeckModelV2) =>
  model.slides.map((slide, index) => ({
    slideId: slide.id,
    index,
    png: Buffer.from(`pixels:${slide.id}:${JSON.stringify(slide.elements)}`),
  }));
function currentSlide(options: any) {
  return JSON.parse(options.messages[0].content[0].text).slide;
}
const clean = (options: any) => ({ object: { slideId: currentSlide(options).id, issues: [], fixes: [] } });
afterEach(() => __setDeckVisualReviewDepsForTest());

describe('image-based slide review', () => {
  test('measured clipping missed by vision gets another repair attempt before returning a draft', async () => {
    let attempts = 0;
    __setDeckVisualReviewDepsForTest({
      renderDeckSlides: async (model) =>
        render(model).map((image) => ({
          ...image,
          issues:
            image.slideId === 'two' &&
            model.slides.find((slide) => slide.id === 'two')!.elements[0].height < 25
              ? [{ elementId: 'body', description: 'The last line is clipped.' }]
              : [],
        })),
      generateObjectForCurrentUser: (async (options: any) => {
        const input = JSON.parse(options.messages[0].content[0].text);
        if (input.slide.id !== 'two') return clean(options);
        if (++attempts !== 2) return clean(options);
        expect(input.previousIssues[0].description).toContain('clipped');
        return {
          object: {
            slideId: 'two',
            issues: [{ elementId: 'body', description: 'Clipped' }],
            fixes: [fix({ elementId: 'body', height: 25 })],
          },
        };
      }) as any,
    });
    const result = await reviewDeckVisuals(fixture(), { userId: 'u' });
    expect(attempts).toBe(3);
    expect(result.report.status).toBe('passed');
    expect(result.model.slides[1].elements[0].height).toBe(25);
  });

  test('a clean vision verdict cannot waive an image covering locked text', async () => {
    const model = fixture();
    model.slides = [model.slides[1]];
    model.slides[0].elements[0].locked = true;
    model.slides[0].elements.push({
      id: 'covering-image',
      type: 'image',
      src: '/owned.png',
      alt: 'Source image',
      x: 5,
      y: 10,
      width: 85,
      height: 20,
      decorative: true,
      overlapAllowed: true,
    });
    __setDeckVisualReviewDepsForTest({
      renderDeckSlides: async (deck) => render(deck),
      generateObjectForCurrentUser: (async (options: any) => {
        expect(JSON.parse(options.messages[0].content[0].text).measuredLayout[0].kind).toBe('overlap');
        return clean(options);
      }) as any,
    });
    const result = await reviewDeckVisuals(model, { userId: 'u' });
    expect(result.report.status).toBe('needs_review');
    expect(JSON.stringify(result.report.issues)).toContain('covers');
    expect(result.model.slides[0].elements[0]).toEqual(model.slides[0].elements[0]);
  });

  test('browser-measured text clipping cannot be approved by a clean model verdict', async () => {
    __setDeckVisualReviewDepsForTest({
      renderDeckSlides: async (model) =>
        render(model).map((image) => ({
          ...image,
          issues: [{ elementId: 'title', description: 'Text is clipped.' }],
        })),
      generateObjectForCurrentUser: (async (options: any) => {
        expect(JSON.parse(options.messages[0].content[0].text).measuredClipping).toHaveLength(1);
        return clean(options);
      }) as any,
    });
    const result = await reviewDeckVisuals(fixture(), { userId: 'u' });
    expect(result.report.status).toBe('needs_review');
    expect(result.report.issues).toHaveLength(2);
  });
  test('sends each rendered image to the selected vision model, repairs a flipped chart, then inspects new pixels', async () => {
    const seen: any[] = [];
    const renderer = mock(async (model: DeckModelV2) => render(model));
    __setDeckVisualReviewDepsForTest({
      renderDeckSlides: renderer,
      generateObjectForCurrentUser: (async (options: any) => {
        seen.push(options);
        const slide = currentSlide(options);
        if (slide.elements.find((element: any) => element.id === 'graph')?.rotation === 180)
          return {
            object: {
              slideId: slide.id,
              issues: [{ elementId: 'graph', description: 'Graph is upside down.' }],
              fixes: [fix()],
            },
          };
        return clean(options);
      }) as any,
    });
    const source = fixture();
    const result = await reviewDeckVisuals(source, { userId: 'u' });
    expect(result.report).toEqual({
      status: 'passed',
      totalSlides: 2,
      checkedSlideIds: ['one', 'two'],
      repairedSlideIds: ['one'],
      issues: [],
    });
    expect(renderer.mock.calls.map(([model]) => model.slides.map((slide) => slide.id))).toEqual([
      ['one', 'two'],
      ['one'],
    ]);
    expect(seen).toHaveLength(3);
    for (const call of seen) {
      expect(call).toMatchObject({
        userId: 'u',
        speed: 'primary',
        requireVision: true,
        feature: 'presentation_visual_review',
      });
      expect(call.messages[0].content[1].image.toString()).toContain(`pixels:${currentSlide(call).id}`);
      expect(call.messages[0].content[1]).toMatchObject({ type: 'image', mediaType: 'image/png' });
    }
    expect(result.model.slides[0].elements[1]).toMatchObject({
      rotation: 0,
      categories: ['Jan', 'Feb'],
      series: [{ name: 'Sales', values: [100, 200] }],
    });
    expect(source.slides[0].elements[1].rotation).toBe(180);
    expect(result.model.slides[0].notes).toBe(source.slides[0].notes);
    expect(visualReviewSummary(result.report)).toContain('Visually checked all 2 slides; repaired 1');
  });

  test('repairs contrast and clipping without rewriting numbers, notes, or the chosen theme', () => {
    const model = fixture();
    const result = applyVisualRepairs(
      model,
      visualSlideReviewSchema.parse({
        slideId: 'two',
        issues: [{ elementId: 'body', description: 'Low contrast and clipped body.' }],
        fixes: [
          fix({
            elementId: 'body',
            height: 25,
            fontSize: 18,
            lineHeight: 1.2,
            color: model.theme.colors.ink,
            fill: model.theme.colors.background,
            rotation: null,
          }),
        ],
      }),
    );
    expect(result.slides[1].elements[0]).toMatchObject({
      text: 'Keep the exact 200 figure.',
      height: 25,
      fontSize: 18,
      color: model.theme.colors.ink,
      fill: model.theme.colors.background,
    });
    expect(result.theme).toEqual(model.theme);
    expect(result.slides[0]).toEqual(model.slides[0]);
  });

  test('reconsiders a rejected repair with its attempted geometry and specific collision feedback', async () => {
    let attempts = 0;
    __setDeckVisualReviewDepsForTest({
      renderDeckSlides: async (model) => render(model),
      generateObjectForCurrentUser: (async (options: any) => {
        const input = JSON.parse(options.messages[0].content[0].text);
        if (input.slide.id === 'two' || input.slide.elements[1].rotation === 0) return clean(options);
        attempts++;
        if (attempts === 2) {
          expect(input.rejectedRepair.fixes[0].y).toBe(5);
          expect(input.rejectedRepair.reason).toContain('overlap');
        }
        return {
          object: {
            slideId: 'one',
            issues: [{ elementId: 'graph', description: 'Upside down' }],
            fixes: [attempts === 1 ? fix({ y: 5 }) : fix()],
          },
        };
      }) as any,
    });
    const result = await reviewDeckVisuals(fixture(), { userId: 'u' });
    expect(result.report.status).toBe('passed');
    expect(attempts).toBe(2);
    expect(result.model.slides[0].elements[1].rotation).toBe(0);
  });

  test('rejects invented elements, off-canvas fixes, and new overlaps', () => {
    const model = fixture();
    for (const patch of [fix({ elementId: 'invented' }), fix({ x: 99 }), fix({ y: 5 })]) {
      const result = applyVisualRepairs(model, {
        slideId: 'one',
        issues: [{ elementId: 'graph', description: 'Broken' }],
        fixes: [patch],
      } as any);
      expect(result).toEqual(model);
    }
    expect(applyVisualRepairs(model, { slideId: 'absent', issues: [], fixes: [] })).toBe(model);
    expect(applyVisualRepairs(model, { slideId: 'one', issues: [], fixes: [fix()] } as any)).toBe(model);
  });

  test('visual repairs retain the chosen accent palette when moving decorations', () => {
    const model = fixture();
    model.slides[1].elements.push({
      id: 'accent',
      type: 'shape',
      x: 5,
      y: 40,
      width: 10,
      height: 1,
      fill: model.theme.colors.accent,
    });
    const rejected = mock((_reason: string) => {});
    const review = {
      slideId: 'two',
      issues: [{ elementId: 'accent', description: 'Move the accent away from the label' }],
      fixes: [fix({ elementId: 'accent', y: 50, fill: '#1f6feb' })],
    };
    expect(applyVisualRepairs(model, review, rejected)).toBe(model);
    expect(rejected.mock.calls[0][0]).toContain('palette');
    review.fixes[0].fill = model.theme.colors.accent;
    expect(applyVisualRepairs(model, review).slides[1].elements[1]).toMatchObject({
      y: 50,
      fill: model.theme.colors.accent,
    });
  });

  test('text and chart recoloring honor the palette while positional repairs preserve custom colors', () => {
    const model = fixture();
    for (const [slideId, patch] of [
      ['two', fix({ elementId: 'body', color: '#123456' })],
      ['two', fix({ elementId: 'body', fill: '#123456' })],
      ['one', fix({ colors: ['#123456'] })],
    ] as const) {
      const rejected = mock((_reason: string) => {});
      expect(
        applyVisualRepairs(
          model,
          { slideId, issues: [{ elementId: null, description: 'Contrast' }], fixes: [patch] },
          rejected,
        ),
      ).toBe(model);
      expect(rejected.mock.calls[0][0]).toContain('palette');
    }
    const graph = model.slides[0].elements[1];
    if (graph.type !== 'chart') throw new Error('Expected chart');
    graph.colors = ['#123456'];
    const review = {
      slideId: 'one',
      issues: [{ elementId: 'graph', description: 'Upside down' }],
      fixes: [fix()],
    };
    expect(applyVisualRepairs(model, review).slides[0].elements[1]).toMatchObject({
      colors: ['#123456'],
      rotation: 0,
    });
    review.fixes = [fix({ colors: ['#123456'] })];
    expect(applyVisualRepairs(model, review).slides[0].elements[1]).toMatchObject({
      colors: ['#123456'],
      rotation: 0,
    });
    review.fixes = [fix({ colors: [model.theme.colors.accent] })];
    expect(applyVisualRepairs(model, review).slides[0].elements[1]).toMatchObject({
      colors: [model.theme.colors.accent],
      rotation: 0,
    });
  });

  test('unfixable visual problems remain explicit and never become a pass', async () => {
    __setDeckVisualReviewDepsForTest({
      renderDeckSlides: async (model) => render(model),
      generateObjectForCurrentUser: (async (options: any) => ({
        object: {
          slideId: currentSlide(options).id,
          issues: [{ elementId: null, description: 'Image contains unreadable labels.' }],
          fixes: [],
        },
      })) as any,
    });
    const result = await reviewDeckVisuals(fixture(), { userId: 'u' });
    expect(result.report.status).toBe('needs_review');
    expect(result.report.issues).toHaveLength(2);
    expect(visualReviewSummary(result.report)).toContain('Draft saved');
  });

  test('retries transient review failures without rerunning successful slide reviews', async () => {
    let attempts = 0;
    __setDeckVisualReviewDepsForTest({
      renderDeckSlides: async (model) => render(model),
      generateObjectForCurrentUser: (async (options: any) => {
        if (currentSlide(options).id === 'two' && attempts++ === 0) throw new Error('503');
        return clean(options);
      }) as any,
    });
    expect((await reviewDeckVisuals(fixture(), { userId: 'u' })).report.status).toBe('passed');
    expect(attempts).toBe(2);
  });

  test.each([
    'wrong-slide',
    'empty-image',
    'missing-slide',
    'render-failure',
    'invalid-review',
  ])('%s keeps the draft and cannot claim all slides were inspected', async (failure) => {
    __setDeckVisualReviewDepsForTest({
      renderDeckSlides: async (model) => {
        if (failure === 'render-failure') throw new Error('Browser unavailable');
        const images = render(model);
        if (failure === 'missing-slide') return images.slice(1);
        return failure === 'empty-image'
          ? images.map((image) => ({ ...image, png: Buffer.alloc(0) }))
          : images;
      },
      generateObjectForCurrentUser: (async (options: any) => ({
        object: failure === 'invalid-review' ? {} : { ...clean(options).object, slideId: 'unrelated' },
      })) as any,
    });
    const result = await reviewDeckVisuals(fixture(), { userId: 'u' });
    expect(result.model).toEqual(fixture());
    expect(result.report.status).toBe('needs_review');
    expect(result.report.checkedSlideIds).toEqual([]);
    expect(result.report.issues).toHaveLength(2);
  });

  test('cancellation is propagated, not returned as a completed draft', async () => {
    const controller = new AbortController();
    controller.abort(new Error('User stopped'));
    await expect(
      reviewDeckVisuals(fixture(), { userId: 'u', abortSignal: controller.signal }),
    ).rejects.toThrow('User stopped');
  });

  test('inspection is bounded even when every repair still leaves a defect', async () => {
    const renderer = mock(async (model: DeckModelV2) => render(model));
    __setDeckVisualReviewDepsForTest({
      renderDeckSlides: renderer,
      generateObjectForCurrentUser: (async (options: any) => {
        const slide = currentSlide(options);
        return {
          object: {
            slideId: slide.id,
            issues: [{ elementId: null, description: 'Still broken' }],
            fixes: slide.id === 'one' ? [fix({ rotation: (slide.elements[1].rotation ?? 0) + 10 })] : [],
          },
        };
      }) as any,
    });
    const result = await reviewDeckVisuals(fixture(), { userId: 'u' });
    expect(result.report.status).toBe('needs_review');
    expect(renderer).toHaveBeenCalledTimes(3);
  });
});
