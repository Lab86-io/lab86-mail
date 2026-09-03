import { describe, expect, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { BriefSkeleton } from '../components/report/BriefSkeleton';
import { BriefCanvas } from '../components/report/brief-canvas/BriefCanvas';
import { WeekAheadText } from '../components/report/brief-canvas/BriefLetter';
import type { BriefDocumentV2 } from '../lib/shared/brief-document';
import {
  areaPulseDocumentFixture,
  letterBriefDocumentFixture,
  richBriefDocumentFixture,
} from '../lib/shared/brief-document-fixtures';

function render(
  value: unknown,
  extras?: { masthead?: boolean; embedded?: boolean; noiseCount?: number | null; footer?: React.ReactNode },
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <BriefCanvas
        value={value}
        masthead={extras?.masthead}
        embedded={extras?.embedded}
        noiseCount={extras?.noiseCount}
        footer={extras?.footer}
      />
    </QueryClientProvider>,
  );
}

function count(html: string, needle: string) {
  return html.split(needle).length - 1;
}

describe('the daily letter', () => {
  test('renders in one 620 px measure with no story cards and no grid', () => {
    const html = render(letterBriefDocumentFixture);
    expect(html).toContain('data-brief-letter="daily"');
    expect(html).toContain('max-width:620px');
    expect(html).not.toContain('data-brief-editorial-grid');
    expect(html).not.toContain('data-brief-story-card');
  });

  test('the lede region is the serif opening with a dinkus and no border', () => {
    const html = render(letterBriefDocumentFixture);
    expect(html).toContain('data-brief-region="lede"');
    expect(html).toContain('data-brief-letter-lede');
    expect(html).toContain('font-display text-[22px]');
    expect(html).toContain('Two replies wait on you before the review at ten.');
    // The lede is the opening, so the header does not repeat the summary.
    expect(count(html, 'Two replies wait on you before the review at ten.')).toBe(1);
    expect(html).toContain('h-px w-10');
  });

  test('the answer region renders each thread as a mail row', () => {
    const html = render(letterBriefDocumentFixture);
    expect(html).toContain('data-brief-region="answer"');
    expect(html).toContain('>Answer</span>');
    expect(html).toContain('Maya Chen');
    expect(html).toContain('Review deck for Thursday');
    expect(html).toContain('Maya sent the deck on Tuesday and asked for your notes before the review.');
    expect(html).toContain('data-brief-letter-action');
    expect(html).toContain('>Open</button>');
    // The avatar is the initials of the sender.
    expect(html).toContain('aria-label="maya chen"');
    expect(html).toContain('>MC</span>');
  });

  test('the today region leads with the event and its time', () => {
    const html = render(letterBriefDocumentFixture);
    expect(html).toContain('data-brief-region="today"');
    expect(html).toContain('>Today</span>');
    expect(html).toContain('Product review');
    expect(html).toContain('10:00 AM to 10:45 AM, Room 2');
    expect(html).toContain('>Calendar</p>');
    expect(html).toContain('Passport renewal: form due');
  });

  test('the know region renders its row', () => {
    const html = render(letterBriefDocumentFixture);
    expect(html).toContain('data-brief-region="know"');
    expect(html).toContain('>Know</span>');
    expect(html).toContain('Priya Raman');
    expect(html).toContain('Vendor contract signed');
  });

  test('lane kickers carry the editorial voice and no count', () => {
    const html = render(letterBriefDocumentFixture);
    const kickers = [...html.matchAll(/data-brief-letter-kicker[^>]*class="([^"]*)"[^>]*>([^<]+)<\/span>/g)];
    expect(kickers.map((match) => match[2])).toEqual(['Answer', 'Today', 'Know']);
    for (const match of kickers) {
      expect(match[1]).toContain('--color-accent-2');
      expect(match[2]).not.toMatch(/\d/);
    }
    expect(html).not.toContain('replies owed');
  });

  test('the week ahead marks weekday names in the data voice', () => {
    const html = render(letterBriefDocumentFixture);
    expect(html).toContain('data-brief-region="week-ahead"');
    expect(html).toContain('>Week ahead</span>');
    expect(html).toContain('data-brief-letter-week-ahead');
    const marks = html.match(/data-brief-weekday[^>]*>([^<]+)<\/span>/g) ?? [];
    expect(marks.map((mark) => mark.replace(/^.*>([^<]+)<\/span>$/, '$1'))).toEqual([
      'Thursday',
      'Friday',
      'Saturday',
      'Sunday',
    ]);
    for (const mark of marks) expect(mark).toContain('--color-accent-3');
    // No markup reached the document text.
    expect(letterBriefDocumentFixture.regions[4].summary).not.toContain('<');
  });

  test('the areas region is three lines at most, name then line', () => {
    const html = render(letterBriefDocumentFixture);
    expect(html).toContain('data-brief-region="areas"');
    expect(count(html, 'data-brief-letter-area')).toBe(2);
    expect(html).toContain('>Home</button>');
    expect(html).toContain(' · Choose the lease option before Friday.');
    expect(html).toContain('>Product</button>');
  });

  test('the footer prints the noise count once, from stats', () => {
    expect(render(letterBriefDocumentFixture, { noiseCount: 42 })).toContain(
      '42 other messages did not need you today.',
    );
    expect(render(letterBriefDocumentFixture, { noiseCount: 1 })).toContain(
      '1 other message did not need you today.',
    );
    expect(render(letterBriefDocumentFixture, { noiseCount: 0 })).not.toContain('data-brief-letter-footer');
    expect(render(letterBriefDocumentFixture)).not.toContain('data-brief-letter-footer');
  });

  test('embedded under Today the letter has no header of its own', () => {
    const html = render(letterBriefDocumentFixture, { embedded: true, noiseCount: 3 });
    expect(html).not.toContain('<h1');
    expect(html).not.toContain('<header');
    expect(html).toContain('data-brief-letter="daily"');
    expect(html).toContain('3 other messages did not need you today.');
  });

  test('with the masthead the plate names the edition and the lede is not repeated', () => {
    const html = render(letterBriefDocumentFixture, {
      masthead: true,
      footer: <div>Footer slot content</div>,
    });
    expect(html).toContain('The Monday Brief');
    expect(html).toContain('Footer slot content');
    expect(html).not.toContain('first-letter:text-5xl');
    expect(count(html, 'Two replies wait on you before the review at ten.')).toBe(1);
  });

  test('an empty letter says so and keeps the week ahead', () => {
    const document: BriefDocumentV2 = {
      ...letterBriefDocumentFixture,
      regions: letterBriefDocumentFixture.regions.filter((region) =>
        ['lede', 'week-ahead'].includes(region.id),
      ),
    };
    const html = render(document);
    expect(html).toContain('Nothing needs an answer today. The week ahead is below.');
    expect(html).toContain('data-brief-region="week-ahead"');
    expect(html).not.toContain('data-brief-letter-kicker');
  });

  test('rows enter with the note stagger and no icon precedes the action text', () => {
    const html = render(letterBriefDocumentFixture);
    expect(html).toContain('animation-delay:120ms');
    expect(html).toContain('animation-delay:170ms');
    expect(html).toContain('animation-delay:205ms');
    expect(html).toContain('animation-delay:265ms');
    expect(html).not.toMatch(/<svg[^>]*>[\s\S]{0,200}?>Open</);
  });
});

describe('the area pulse letter', () => {
  test('renders lede, pulse lines, the ask, and open work in order', () => {
    const html = render(areaPulseDocumentFixture);
    expect(html).toContain('data-brief-letter="area"');
    const order = [
      'data-brief-region="lede"',
      'data-brief-region="pulse"',
      'data-brief-region="ask"',
      'data-brief-region="open-work"',
    ];
    const positions = order.map((needle) => html.indexOf(needle));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(count(html, 'data-brief-letter-pulse')).toBe(3);
    expect(html).toContain('>Last change</span>');
    expect(html).toContain('Daniel sent two lease options on Tuesday.');
    expect(html).toContain('Get this out of my head');
    // The live open-work list loads on the client; the server prints its shape.
    expect(html).toContain('data-brief-region="open-work"');
    expect(html).not.toContain('data-brief-story-card');
  });

  test('the area title stays in the header without the repeated summary', () => {
    const html = render(areaPulseDocumentFixture);
    expect(html).toContain('<h1');
    expect(html).toContain('>Home</h1>');
    expect(count(html, 'The lease is the only open decision.')).toBe(1);
  });
});

describe('older editions', () => {
  test('a seven-lane document keeps the editorial grid and its cards', () => {
    const html = render(richBriefDocumentFixture);
    expect(html).not.toContain('data-brief-letter=');
    expect(html).toContain('data-brief-editorial-grid');
    expect(html).toContain('data-brief-story-card');
    expect(html).toContain('Thursday Brief');
    expect(html).toContain('<h1');
    // The old header keeps its summary paragraph; the letter drops it.
    expect(html).toContain('A product review leads the day');
  });
});

describe('WeekAheadText', () => {
  test('marks nothing when there is no weekday', () => {
    const html = renderToStaticMarkup(<WeekAheadText text="Nothing is due." />);
    expect(html).toContain('Nothing is due.');
    expect(html).not.toContain('data-brief-weekday');
  });
});

describe('BriefSkeleton', () => {
  test('draws one lede block and the requested rows in the letter measure', () => {
    const html = renderToStaticMarkup(<BriefSkeleton rows={3} />);
    expect(html).toContain('data-brief-skeleton');
    expect(html).toContain('max-width:620px');
    expect(count(html, 'rounded-full shimmer')).toBe(3);
    expect(renderToStaticMarkup(<BriefSkeleton masthead />)).toContain('h-[min(36vh,300px)]');
  });
});
