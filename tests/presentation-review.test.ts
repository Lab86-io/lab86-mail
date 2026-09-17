import { afterEach, describe, expect, mock, test } from 'bun:test';
import { __setDocumentAiDepsForTest, composeDocumentPresentation } from '../lib/documents/ai';
import { compositionArtwork } from '../lib/documents/deck-imagery';
import { checkDeck } from '../lib/documents/deck-quality';
import { parseDocumentModel } from '../lib/documents/model';
import {
  briefFieldForElement,
  composePresentationV2,
  presentationAuthoringSchema,
  presentationAuthoringV2Schema,
} from '../lib/documents/presentation-design';
import {
  copyFields,
  replaceSlideCopy,
  reviewPresentation,
  slideReviewSchema,
} from '../lib/documents/presentation-review';
import { harborBrief, passingSlideReviews, poolArtworks } from './fixtures/presentation-briefs';

afterEach(() => __setDocumentAiDepsForTest());
describe('every-slide presentation review', () => {
  test('oversized preserved source is rejected before review, including JSON escape expansion', async () => {
    const brief = harborBrief();
    brief.slides = [
      {
        ...brief.slides[0],
        items: Array.from({ length: 12 }, () => ({ label: 'L'.repeat(1000), detail: 'D'.repeat(4000) })),
      },
    ];
    const parsed = presentationAuthoringV2Schema.safeParse(brief);
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.message).toContain('40,000 serialized characters');
    const generate = mock(async (options: any) => passingSlideReviews(options));
    await expect(
      reviewPresentation(brief, { userId: 'u', instruction: '' }, generate as any),
    ).rejects.toThrow('40,000 serialized characters');
    expect(generate).not.toHaveBeenCalled();
    const legacy = {
      title: 'Large draft',
      summary: '',
      palette: 'ink',
      slides: [
        { layout: 'columns', title: 'Title', kicker: '', body: '', notes: '', items: brief.slides[0].items },
      ],
    };
    expect(presentationAuthoringSchema.safeParse(legacy).success).toBe(false);
    brief.slides[0].items = [];
    brief.slides[0].notes = '\u0000'.repeat(12000);
    expect(presentationAuthoringV2Schema.safeParse(brief).success).toBe(false);
  });
  test('large accepted drafts preserve originals once and still satisfy the persisted document schema', async () => {
    const brief = harborBrief();
    brief.slides = [
      {
        ...brief.slides[0],
        role: 'list',
        title: 'L'.repeat(1000),
        body: 'D'.repeat(1000),
        kicker: 'K'.repeat(100),
        notes: 'N'.repeat(4000),
        items: Array.from({ length: 12 }, () => ({
          label: 'L'.repeat(1000),
          detail: 'D'.repeat(1500),
          meta: 'M'.repeat(100),
        })),
      },
    ];
    expect(presentationAuthoringV2Schema.safeParse(brief).success).toBe(true);
    __setDocumentAiDepsForTest({
      isDeckV2AuthoringEnabled: () => true,
      generateObjectForCurrentUser: (async (options: any) =>
        options.schema === slideReviewSchema
          ? passingSlideReviews(options)
          : { object: { fixes: [] } }) as any,
    });
    const proposal = await composeDocumentPresentation({
      userId: 'u',
      instruction: '',
      presentation: brief,
      artwork: 'none',
    });
    const model = proposal.model as any;
    expect(() => parseDocumentModel(model)).not.toThrow();
    expect(model.slides[0].notes.length).toBeLessThan(50000);
    expect(model.slides[0].notes).toContain(JSON.stringify(brief.slides[0].items));
    expect(model.slides[0].notes.match(/Original title:/g)).toHaveLength(1);
    expect(model.slides[0].notes).not.toContain('Original items.');
    const slide = harborBrief().slides[0];
    slide.notes = 'Original title:\nAn unrelated user note';
    const original = slide.title;
    replaceSlideCopy(slide, 'title', 'Intermediate repair');
    replaceSlideCopy(slide, 'title', 'Final repair');
    expect(slide.notes).toContain(original);
    expect(slide.notes).not.toContain('Intermediate repair');
    expect(slide.notes).toContain('An unrelated user note');
  });
  test('five to twelve draft items are reviewed in visible groups, with exact evidence and slide count preserved', async () => {
    for (const count of [5, 12]) {
      const brief = harborBrief();
      brief.slides = [
        {
          ...brief.slides[0],
          role: 'list',
          body: 'Verified findings.',
          items: Array.from({ length: count }, (_, index) => ({
            label: `Finding ${index + 1}`,
            detail: `Evidence ${index + 1}`,
            meta: 'Verified',
          })),
        },
      ];
      expect(presentationAuthoringV2Schema.safeParse(brief).success).toBe(true);
      const generate = mock(async (options: any) => {
        const slide = JSON.parse(options.prompt).slides[0];
        expect(slide.items).toHaveLength(4);
        expect(slide.itemCapacity).toBe(4);
        expect(slide.notes).toContain(JSON.stringify(brief.slides[0].items));
        const result = passingSlideReviews(options);
        result.object.reviews[0].fixes = [{ field: 'items.3.label', text: 'Related findings' }] as any;
        return result;
      });
      __setDocumentAiDepsForTest({
        isDeckV2AuthoringEnabled: () => true,
        generateObjectForCurrentUser: generate as any,
      });
      const result = await composeDocumentPresentation({
        userId: 'u',
        instruction: 'Make one slide',
        presentation: brief,
        artwork: 'none',
      });
      const model = result.model as any;
      expect(model.slides).toHaveLength(1);
      expect(checkDeck(model).ok).toBe(true);
      expect(model.slides[0].notes).toContain(JSON.stringify(brief.slides[0].items));
      expect(model.slides[0].elements.some((element: any) => element.text === 'Related findings')).toBe(true);
      expect(result.summary).toContain('Reflowed excess items on 1 slides');
      expect(brief.slides[0].items).toHaveLength(count);
    }
  });
  test('role-specific item capacities prevent invisible callouts and keep originals when review is unavailable', async () => {
    const brief = harborBrief();
    const original = Array.from({ length: 5 }, (_, index) => ({
      label: `Item ${index}`,
      detail: `Evidence ${index}`,
    }));
    brief.slides = ['cover', 'statement', 'table', 'chart', 'quote', 'metrics'].map((role) => ({
      ...brief.slides[0],
      role: role as any,
      items: original,
    }));
    const result = await reviewPresentation(brief, { userId: 'u', instruction: '' }, (async () => {
      throw new Error('Offline');
    }) as any);
    expect(result.brief.slides.map((slide) => slide.items.length)).toEqual([0, 0, 0, 3, 1, 4]);
    for (const slide of result.brief.slides) expect(slide.notes).toContain(JSON.stringify(original));
    expect(result.summary).toContain('editorial review was unavailable');
    const legacy: any = {
      title: 'Legacy',
      summary: '',
      palette: 'ink',
      slides: ['cover', 'statement', 'columns'].map((layout) => ({
        layout,
        title: 'Title',
        kicker: '',
        body: '',
        notes: '',
        items: original,
      })),
    };
    const reviewed = await reviewPresentation(legacy, { userId: 'u', instruction: '' }, (async (
      options: any,
    ) => passingSlideReviews(options)) as any);
    expect(reviewed.brief.slides.map((slide: any) => slide.items.length)).toEqual([0, 0, 3]);
  });
  test('full audience and source captions fit both palettes, artwork covers and line breaks without losing text', () => {
    const artwork = compositionArtwork(poolArtworks(1)[0]);
    for (const palette of ['editorial', 'signal'] as const) {
      const brief = harborBrief();
      brief.palette = palette;
      brief.audience = 'Audience '.repeat(22).trim();
      const source = 'Source '.repeat(28).trim();
      const base = { ...brief.slides[0], body: 'Verified data.', items: [] };
      brief.slides = [
        base,
        ...(['chart', 'metrics'] as const).map((role) => ({
          ...base,
          role,
          chart: {
            type: 'column' as const,
            categories: ['A', 'B'],
            series: [{ name: 'Count', values: [10, 20] }],
            source,
          },
        })),
        {
          ...base,
          role: 'table',
          table: { headers: ['A', 'B'], rows: [['One', '10']], source: 'Source\n'.repeat(28).trim() },
        },
      ];
      const model = composePresentationV2(brief, { artworks: { 0: artwork } });
      expect(checkDeck(model).issues.filter((issue) => issue.severity === 'error')).toEqual([]);
      expect(model.slides[0].elements.find((element) => element.id === 'slide-1-foot')).toMatchObject({
        text: `Prepared for ${brief.audience}`,
        fontSize: 11,
      });
      for (const slide of model.slides.slice(1)) {
        const element = slide.elements.find((element) => element.id.endsWith('-source'))!;
        expect(element).toMatchObject({ text: source });
        expect(briefFieldForElement(element)).toBe(slide.id === 'slide-4' ? 'table.source' : 'chart.source');
      }
    }
  });
  test('source repair recognizes chart and table captions and preserves their exact citations in notes', () => {
    const slide = harborBrief().slides[0];
    slide.chart = {
      type: 'column',
      categories: ['A'],
      series: [{ name: 'Count', values: [1] }],
      source: 'Full chart citation 2026',
    };
    slide.table = { headers: ['A', 'B'], rows: [['X', '1']], source: 'Full table citation 2026' };
    expect(copyFields(slide, true).map((field) => field.field)).toContain('chart.source');
    expect(copyFields(slide, true).map((field) => field.field)).toContain('table.source');
    replaceSlideCopy(slide, 'chart.source', 'Chart 2026');
    replaceSlideCopy(slide, 'table.source', 'Table 2026');
    expect(slide.chart.source).toBe('Chart 2026');
    expect(slide.table.source).toBe('Table 2026');
    expect(slide.notes).toContain('Full chart citation 2026');
    expect(slide.notes).toContain('Full table citation 2026');
  });
  test('a full-length audience fits the cover without rewriting unrelated copy or retrying', async () => {
    const brief = harborBrief();
    brief.audience =
      'The research, operations and customer experience teams across the North American and European offices, together with the executive steering committee and their regional implementation partners for 2026';
    const generate = mock(async (options: any) => passingSlideReviews(options));
    __setDocumentAiDepsForTest({
      isDeckV2AuthoringEnabled: () => true,
      generateObjectForCurrentUser: generate as any,
    });
    const result = await composeDocumentPresentation({
      userId: 'u',
      instruction: '',
      presentation: brief,
      artwork: 'none',
    });
    const model = result.model as any;
    expect(checkDeck(model).ok).toBe(true);
    expect(model.slides[0].elements.find((element: any) => element.id === 'slide-1-foot').text).toBe(
      `Prepared for ${brief.audience}`,
    );
    expect(model.slides[0].elements.find((element: any) => element.id === 'slide-1-title').text).toBe(
      brief.slides[0].title,
    );
    expect(generate).toHaveBeenCalledTimes(1);
  });
  test('reviews every page, including already-fitting pages, with purpose and grounded content', async () => {
    const brief = harborBrief();
    const generate = mock(async (options: any) => {
      expect(options.schema).toBe(slideReviewSchema);
      const prompt = JSON.parse(options.prompt);
      expect(prompt.grounding).toBe('Verified source context');
      expect(prompt.slides).toHaveLength(brief.slides.length);
      expect(prompt.slides.every((slide: any) => slide.fields.length >= 3)).toBe(true);
      return passingSlideReviews(options);
    });
    const result = await reviewPresentation(
      brief,
      { userId: 'u', instruction: 'Harbor', sourceContext: 'Verified source context' },
      generate as any,
    );
    expect(generate).toHaveBeenCalledTimes(1);
    expect(result.brief).toEqual(brief);
    expect(result.summary).toContain(`Reviewed all ${brief.slides.length} slides`);
  });
  test('incomplete critique retries only missing pages, not generation', async () => {
    const ids: string[][] = [];
    const generate = mock(async (options: any) => {
      ids.push(JSON.parse(options.prompt).slides.map((slide: any) => slide.slideId));
      const response = passingSlideReviews(options);
      if (ids.length === 1) response.object.reviews = response.object.reviews.slice(0, 2);
      return response;
    });
    const brief = harborBrief();
    const reviewed = await reviewPresentation(brief, { userId: 'u', instruction: '' }, generate as any);
    expect(ids[1]).toEqual(ids[0].slice(2));
    expect(reviewed.summary).toContain(`Reviewed all ${brief.slides.length}`);
  });
  test('oversized fifth-slide body is remediated and all original evidence survives in notes', async () => {
    const brief = harborBrief();
    const original = 'The harbor plan records 152 blocked packages and 9632 completed editions. '.repeat(10);
    brief.slides[4].body = original;
    brief.slides[4].notes = 'Source: https://example.test/verified-report';
    expect(presentationAuthoringV2Schema.safeParse(brief).success).toBe(true);
    __setDocumentAiDepsForTest({
      isDeckV2AuthoringEnabled: () => true,
      generateObjectForCurrentUser: (async (options: any) => {
        if (options.schema !== slideReviewSchema) return { object: { fixes: [] } };
        const response = passingSlideReviews(options);
        response.object.reviews[4].fixes = [
          { field: 'body', text: '152 packages remain blocked; 9632 editions completed.' },
        ] as any;
        return response;
      }) as any,
    });
    const result = await composeDocumentPresentation({
      userId: 'u',
      instruction: '',
      presentation: brief,
      artwork: 'none',
    });
    const model = result.model as any;
    expect(model.slides).toHaveLength(brief.slides.length);
    expect(model.slides[4].notes).toContain(original);
    expect(model.slides[4].notes).toContain('https://example.test/verified-report');
    expect(
      model.slides[4].elements.some(
        (element: any) => element.text === '152 packages remain blocked; 9632 editions completed.',
      ),
    ).toBe(true);
    expect(checkDeck(model).ok).toBe(true);
    expect(brief.slides[4].body).toBe(original);
  });
  test('rejects changed numeric claims and never edits chart data, order, or citations', async () => {
    const brief = harborBrief();
    brief.slides[0].body = '152 packages completed.';
    const result = await reviewPresentation(brief, { userId: 'u', instruction: '' }, (async (
      options: any,
    ) => {
      const response = passingSlideReviews(options);
      response.object.reviews[0].fixes = [
        { field: 'body', text: '250 packages completed.' },
        { field: 'notes', text: 'invented source' },
      ] as any;
      return response;
    }) as any);
    expect(result.brief).toEqual(brief);
  });
  test('review failures get bounded retries and a truthful fallback with recoverable copy', async () => {
    const brief = harborBrief();
    const original = 'Supporting evidence for this decision. '.repeat(30);
    brief.slides[0].body = original;
    const generate = mock(async () => {
      throw new Error('Unavailable');
    });
    const result = await reviewPresentation(brief, { userId: 'u', instruction: '' }, generate);
    expect(generate).toHaveBeenCalledTimes(2);
    expect(result.brief.slides[0].body.length).toBeLessThanOrEqual(320);
    expect(result.brief.slides[0].notes).toContain(original);
    expect(result.summary).toContain('editorial review was unavailable');
  });
  test('unreadable table data is never silently truncated or saved as a broken slide', async () => {
    const brief = harborBrief();
    brief.slides = [
      {
        ...brief.slides[0],
        role: 'table',
        table: {
          headers: ['Label', 'Value', 'Unit', 'Period'],
          rows: Array.from({ length: 6 }, () => Array(4).fill('W'.repeat(1000))),
          source: 'Exact supplied data',
        },
      },
    ];
    __setDocumentAiDepsForTest({
      isDeckV2AuthoringEnabled: () => true,
      generateObjectForCurrentUser: (async (options: any) =>
        options.schema === slideReviewSchema
          ? passingSlideReviews(options)
          : { object: { fixes: [] } }) as any,
    });
    await expect(
      composeDocumentPresentation({ userId: 'u', instruction: '', presentation: brief, artwork: 'none' }),
    ).rejects.toThrow('layout check');
    expect(brief.slides[0].table!.rows[0][0]).toBe('W'.repeat(1000));
  });

  test('cancellation prevents all followup review and repairs', async () => {
    const controller = new AbortController();
    const generate = mock(async () => {
      controller.abort(new Error('Disconnected'));
      throw new Error('Cancelled');
    });
    await expect(
      reviewPresentation(
        harborBrief(),
        { userId: 'u', instruction: '', abortSignal: controller.signal },
        generate,
      ),
    ).rejects.toThrow('Disconnected');
    expect(generate).toHaveBeenCalledTimes(1);
  });
});
