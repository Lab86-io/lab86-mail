import { afterEach, describe, expect, test } from 'bun:test';
import { __setDocumentAiDepsForTest, generateDocumentProposal } from '../lib/documents/ai';
import { DECK_THEMES } from '../lib/documents/deck-fixtures';
import type { DeckSlideV2 } from '../lib/documents/model';
import {
  applyCopyRepairs,
  composePresentation,
  extractSlideContent,
  guessSlideRole,
  requestedPresentationSlideConstraints,
} from '../lib/documents/presentation-design';
import { lakeshoreBrief } from './fixtures/presentation-briefs';
import { passingLayoutDesign, passingVisualReview } from './fixtures/visual-review';

afterEach(() => __setDocumentAiDepsForTest());

const theme = DECK_THEMES.editorial;

describe('copy repairs', () => {
  test('notes shorten, missing items and unknown slides or fields are ignored', () => {
    const brief = lakeshoreBrief();
    // One id more than the brief has slides: a fix for it finds no slide.
    const slideIds = [...brief.slides.map((_, index) => `slide-${index}`), 'slide-extra'];
    const target = brief.slides.findIndex((slide) => slide.items.length < 4 && !slide.chart);
    const charted = brief.slides.findIndex((slide) => slide.chart);
    expect(target).toBeGreaterThanOrEqual(0);
    expect(charted).toBeGreaterThanOrEqual(0);
    const repaired = applyCopyRepairs(brief, slideIds, [
      { slideId: slideIds[target], field: 'notes', text: 'Short notes' },
      { slideId: slideIds[target], field: 'items.3.label', text: 'Nobody' },
      { slideId: slideIds[charted], field: 'chart.source', text: 'Fixture data' },
      { slideId: slideIds[charted], field: 'title', text: 'Shorter title' },
      { slideId: slideIds[target], field: 'title', text: '   ' },
      { slideId: 'slide-extra', field: 'title', text: 'Nobody' },
      { slideId: 'unknown', field: 'title', text: 'Nobody' },
      { slideId: slideIds[target], field: 'bogus', text: 'Nobody' },
    ]);
    expect(repaired.slides[target].notes).toBe('Short notes');
    expect(repaired.slides[target].items).toEqual(brief.slides[target].items);
    // A blank title repair is ignored; a real one is applied.
    expect(repaired.slides[target].title).toBe(brief.slides[target].title);
    expect(repaired.slides[charted].title).toBe('Shorter title');
    expect(repaired.slides[charted].chart?.source).toBe('Fixture data');
    expect(repaired.slides).toHaveLength(brief.slides.length);
    expect(brief.slides[target].notes).not.toBe('Short notes');
  });
});

describe('slide role and content extraction', () => {
  test('the last slide with items reads as the close', () => {
    const slide: DeckSlideV2 = { id: 'last', title: 'Next steps', elements: [] };
    const facts = { items: 1, chart: false, imageSide: null, title: 'Next steps', body: false };
    expect(guessSlideRole(slide, 2, 3, theme, facts)).toBe('close');
    expect(guessSlideRole(slide, 1, 3, theme, facts)).toBe('list');
  });

  test('without a titled element the largest text becomes the title', () => {
    const slide: DeckSlideV2 = {
      id: 'untitled',
      title: '',
      elements: [
        {
          id: 'small',
          type: 'text',
          role: 'body',
          text: 'A smaller line',
          fontSize: 14,
          x: 6,
          y: 40,
          width: 60,
          height: 8,
        },
        {
          id: 'big',
          type: 'text',
          role: 'body',
          text: 'The biggest line',
          fontSize: 40,
          x: 6,
          y: 10,
          width: 80,
          height: 20,
        },
      ],
    };
    const extracted = extractSlideContent(slide, 1, 3, theme);
    expect(extracted?.content.title).toBe('The biggest line');
    expect(extracted?.ids.title).toBe('big');
    expect(extracted?.content.items).toEqual([{ label: 'A smaller line', detail: '' }]);
  });

  test('a caption at the foot of the slide is the footer, or the body away from the cover', () => {
    const elements: DeckSlideV2['elements'] = [
      { id: 'headline', type: 'text', role: 'title', text: 'Cover', x: 6, y: 20, width: 80, height: 20 },
      {
        id: 'foot',
        type: 'text',
        role: 'caption',
        text: 'For the board',
        fontSize: 12,
        x: 6,
        y: 92,
        width: 40,
        height: 4,
      },
    ];
    const cover = extractSlideContent({ id: 'cover', title: 'Cover', elements }, 0, 3, theme);
    expect(cover?.content.role).toBe('cover');
    expect(cover?.content.footer).toBe('For the board');
    expect(cover?.ids.foot).toBe('foot');
    const inside = extractSlideContent({ id: 'inside', title: 'Inside', elements }, 1, 3, theme);
    expect(inside?.content.footer).toBeUndefined();
    expect(inside?.content.body).toBe('For the board');
    expect(inside?.ids.body).toBe('foot');
  });
});

describe('slide count constraints', () => {
  test('more than and fewer than move one endpoint', () => {
    expect(requestedPresentationSlideConstraints('more than 3 slides')).toEqual({ min: 4, max: 30 });
    expect(requestedPresentationSlideConstraints('fewer than five slides')).toEqual({ min: 1, max: 4 });
  });
  test('a range keeps both endpoints without an exact count', () => {
    expect(requestedPresentationSlideConstraints('between 3 and 5 slides')).toEqual({ min: 3, max: 5 });
    expect(requestedPresentationSlideConstraints('4-6 slides')).toEqual({ min: 4, max: 6 });
  });
});

describe('version 1 composition', () => {
  test('light slides lay out timeline and metric items', () => {
    const model = composePresentation({
      title: 'Plan',
      summary: 'Three slides',
      palette: 'clay',
      slides: [
        { layout: 'cover', title: 'Plan', kicker: 'Q3', body: 'The plan', items: [], notes: '' },
        {
          layout: 'timeline',
          title: 'Steps',
          kicker: 'How',
          body: 'In order',
          items: [
            { label: 'Draft', detail: 'Week one' },
            { label: 'Ship', detail: 'Week two' },
          ],
          notes: 'Keep it short',
        },
        {
          layout: 'metrics',
          title: 'Numbers',
          kicker: '',
          body: '',
          items: [{ label: '42%', detail: 'Growth' }],
          notes: '',
        },
      ],
    });
    const texts = (index: number) =>
      model.slides[index].elements
        .filter((element) => element.type === 'text')
        .map((element) => element.text);
    expect(texts(1)).toContain('01');
    expect(texts(1)).toContain('Week two');
    expect(texts(2)).toContain('42%');
    expect(model.slides[1].notes).toBe('Keep it short');
  });
});

describe('document generation guards', () => {
  test('a version 2 brief outside the requested slide count is refused', async () => {
    const brief = lakeshoreBrief();
    __setDocumentAiDepsForTest({
      reviewDeckVisuals: passingVisualReview,
      designPresentationLayouts: passingLayoutDesign,
      isDeckV2AuthoringEnabled: () => true,
      generateObjectForCurrentUser: (async () => ({
        object: { ...brief, slides: brief.slides.slice(0, 1) },
      })) as any,
    });
    await expect(
      generateDocumentProposal({ userId: 'user-1', kind: 'deck', instruction: 'Create six slides' }),
    ).rejects.toThrow('The generator returned 1 slides outside the requested count constraints.');
  });

  test('a version 2 brief that fails its schema is refused as incomplete', async () => {
    __setDocumentAiDepsForTest({
      reviewDeckVisuals: passingVisualReview,
      designPresentationLayouts: passingLayoutDesign,
      isDeckV2AuthoringEnabled: () => true,
      generateObjectForCurrentUser: (async () => ({ object: { title: 'Half a brief' } })) as any,
    });
    await expect(
      generateDocumentProposal({ userId: 'user-1', kind: 'deck', instruction: 'Create a deck' }),
    ).rejects.toThrow('The presentation generator returned an incomplete design.');
  });

  test('invalid workbook changes are refused before any spreadsheet command runs', async () => {
    __setDocumentAiDepsForTest({
      reviewDeckVisuals: passingVisualReview,
      designPresentationLayouts: passingLayoutDesign,
      generateObjectForCurrentUser: (async () => ({
        object: { title: 'Sheet', summary: 'x', changes: 'nope' },
      })) as any,
    });
    await expect(
      generateDocumentProposal({ userId: 'user-1', kind: 'sheet', instruction: 'Add a total row' }),
    ).rejects.toThrow('The spreadsheet model returned invalid workbook changes.');
  });
});
