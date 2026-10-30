import { describe, expect, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { JSDOM } from 'jsdom';
import { renderToStaticMarkup } from 'react-dom/server';
import { BriefCanvas } from '../components/report/brief-canvas/BriefCanvas';
import {
  briefLetterHasNoRows,
  briefLetterKind,
  DAILY_LETTER_REGION_IDS,
  DAILY_LETTER_ROW_REGION_IDS,
  NEEDS_YOU_LANE_ID,
  needsYouLaneParts,
  splitNeedsYouClosedLine,
} from '../lib/brief/letter';
import { needsYouLetterFixture } from '../lib/obligations/fixtures';
import type { BriefDocumentV2, BriefNode, BriefRegion } from '../lib/shared/brief-document';

/* The Needs you lane of the daily letter (docs/needs-you.md, screen 6; phase 3 W5). */

function render(value: BriefDocumentV2) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <BriefCanvas value={value} />
    </QueryClientProvider>,
  );
}
const doc = (html: string) => new JSDOM(html).window.document;
const fixture = needsYouLetterFixture();
const lane = fixture.regions.find((region) => region.id === NEEDS_YOU_LANE_ID) as BriefRegion;

describe('the lane in the letter module', () => {
  test('the lane id is allowed in the daily letter, and the letter still reads as daily', () => {
    expect(DAILY_LETTER_REGION_IDS).toContain('needs-you');
    expect(DAILY_LETTER_ROW_REGION_IDS).toEqual(['needs-you', 'answer', 'today', 'know']);
    expect(briefLetterKind(fixture)).toBe('daily');
    expect(fixture.regions.map((region) => region.id)).toEqual([
      'lede',
      'needs-you',
      'today',
      'know',
      'week-ahead',
      'areas',
    ]);
  });

  test('the parts: the rows alone, or a stack of the rows and the closed line', () => {
    const parts = needsYouLaneParts(lane.tree);
    expect(parts.list?.items).toHaveLength(4);
    expect(parts.closed).toContain('Closed by itself since yesterday’s letter:');
    const listOnly = needsYouLaneParts(parts.list as BriefNode);
    expect(listOnly.list).toBe(parts.list);
    expect(listOnly.closed).toBeNull();
    const text: BriefNode = { kind: 'text', emphasis: 'standard', tone: 'neutral', role: 'body', text: 'x' };
    expect(needsYouLaneParts(text)).toEqual({ list: null, closed: null });
    const stackNoList: BriefNode = {
      kind: 'stack',
      emphasis: 'standard',
      tone: 'neutral',
      density: 'standard',
      children: [{ ...text, text: '  ' }],
    };
    expect(needsYouLaneParts(stackNoList)).toEqual({ list: null, closed: null });
  });

  test('the closed line splits into a bold sentence and the rest', () => {
    expect(
      splitNeedsYouClosedLine('Closed by itself since yesterday’s letter: the pipeline passed.'),
    ).toEqual({
      lead: 'Closed by itself since yesterday’s letter.',
      rest: 'The pipeline passed.',
    });
    expect(splitNeedsYouClosedLine('Closed by itself since the last letter')).toEqual({
      lead: 'Closed by itself since the last letter',
      rest: '',
    });
    expect(splitNeedsYouClosedLine('Closed by itself since the last letter:  ')).toEqual({
      lead: 'Closed by itself since the last letter.',
      rest: '',
    });
    expect(splitNeedsYouClosedLine('Nothing closed.')).toEqual({ lead: '', rest: 'Nothing closed.' });
  });

  test('the empty check counts the Needs you rows', () => {
    const lede = fixture.regions[0];
    expect(briefLetterHasNoRows({ regions: [lede, lane] })).toBe(false);
    const parts = needsYouLaneParts(lane.tree);
    const empty: BriefRegion = {
      ...lane,
      tree: { ...(parts.list as Extract<BriefNode, { kind: 'entity_list' }>), items: [] },
    };
    expect(briefLetterHasNoRows({ regions: [lede, empty] })).toBe(true);
    expect(briefLetterHasNoRows({ regions: [lede, { ...lane, id: 'signals' }] })).toBe(true);
  });
});

describe('the lane in the canvas', () => {
  const html = render(fixture);
  const page = doc(html);

  test('takes the place of Answer, in the accent surface, with the count sentence at the right', () => {
    expect(html).toContain('data-brief-letter="daily"');
    expect(page.querySelector('[data-brief-region="answer"]')).toBeNull();
    const section = page.querySelector('[data-brief-region="needs-you"]');
    expect(section?.className).toContain('surface-accent');
    expect(section?.className).not.toContain('surface-accent-2');
    const kickers = [...page.querySelectorAll('[data-brief-letter-kicker]')].map((node) => node.textContent);
    expect(kickers).toEqual(['Needs you', 'Today', 'Know']);
    expect(section?.querySelector('[data-brief-letter-summary]')?.textContent).toBe(
      '8 open · 2 now · 2 due today',
    );
    // The Needs you lane sits after the lede and before Today.
    expect(html.indexOf('data-brief-region="lede"')).toBeLessThan(
      html.indexOf('data-brief-region="needs-you"'),
    );
    expect(html.indexOf('data-brief-region="needs-you"')).toBeLessThan(
      html.indexOf('data-brief-region="today"'),
    );
  });

  test('the rows: Now first, then "Due today", each with its text actions', () => {
    const section = page.querySelector('[data-brief-region="needs-you"]');
    const senders = [...(section?.querySelectorAll('[data-brief-letter-sender]') ?? [])].map(
      (node) => node.textContent,
    );
    expect(senders).toEqual([
      'Harbor Air9:12 AM',
      'Q3 review deckAlbatross',
      'Vendor syncGranola · yesterday',
      'Maya ChenGitHub · 8:05 AM',
    ]);
    const sublabels = [...(section?.querySelectorAll('[data-brief-letter-sublabel]') ?? [])].map(
      (node) => node.textContent,
    );
    expect(sublabels).toEqual(['Due today']);
    expect(html.indexOf('Q3 review deck')).toBeLessThan(html.indexOf('data-brief-letter-sublabel'));
    expect(html.indexOf('data-brief-letter-sublabel')).toBeLessThan(html.indexOf('Vendor sync'));
    const actions = [...(section?.querySelectorAll('[data-brief-letter-action]') ?? [])].map(
      (node) => `${node.getAttribute('data-brief-letter-action-name')}:${node.textContent}`,
    );
    expect(actions).toEqual([
      'open_thread:Open',
      'open_work:Answer',
      'open_url:Open',
      'open_url:Open review',
    ]);
    // The Albatross row carries the Albatross mark, not initials.
    expect(section?.querySelector('[data-brief-letter-work-mark]')).not.toBeNull();
  });

  test('the closed line ends the lane as one plain sentence with a bold start', () => {
    const foot = page.querySelector('[data-brief-region="needs-you"] [data-brief-letter-foot]');
    expect(foot?.querySelector('b')?.textContent).toBe('Closed by itself since yesterday’s letter. ');
    expect(foot?.textContent).toContain(
      'The pipeline on feature/ledger-sync passed on its second run, and the Northwind Bank code went into AutoFill at 7:58 AM.',
    );
  });

  test('a lane with the rows alone renders without the foot; a lane without rows renders nothing', () => {
    const parts = needsYouLaneParts(lane.tree);
    const rowsOnly: BriefDocumentV2 = {
      ...fixture,
      regions: fixture.regions.map((region) =>
        region.id === NEEDS_YOU_LANE_ID ? { ...region, tree: parts.list as BriefNode } : region,
      ),
    };
    const plain = doc(render(rowsOnly));
    expect(plain.querySelector('[data-brief-region="needs-you"]')).not.toBeNull();
    expect(plain.querySelector('[data-brief-letter-foot]')).toBeNull();
    const noRows: BriefDocumentV2 = {
      ...fixture,
      regions: fixture.regions.map((region) =>
        region.id === NEEDS_YOU_LANE_ID
          ? {
              ...region,
              tree: { kind: 'text', emphasis: 'standard', tone: 'neutral', role: 'body', text: 'Nothing.' },
            }
          : region,
      ),
    };
    const none = doc(render(noRows));
    expect(none.querySelector('[data-brief-region="needs-you"]')).toBeNull();
  });
});
