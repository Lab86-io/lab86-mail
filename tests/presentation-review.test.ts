import { afterEach, describe, expect, mock, test } from 'bun:test';
import { __setDocumentAiDepsForTest, composeDocumentPresentation } from '../lib/documents/ai';
import { checkDeck } from '../lib/documents/deck-quality';
import { presentationAuthoringV2Schema } from '../lib/documents/presentation-design';
import { reviewPresentation, slideReviewSchema } from '../lib/documents/presentation-review';
import { harborBrief, passingSlideReviews } from './fixtures/presentation-briefs';

afterEach(() => __setDocumentAiDepsForTest());
describe('every-slide presentation review', () => {
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
