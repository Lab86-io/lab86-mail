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
  test('keeps narrative regions together while weather belongs to the masthead', () => {
    const html = render(letterBriefDocumentFixture);
    expect(html).toContain('data-brief-letter="daily"');
    expect(html).toContain('daily-brief-layout');
    expect(html).not.toContain('data-brief-column="weather"');
    expect(html.indexOf('data-brief-column="narrative"')).toBeLessThan(
      html.indexOf('data-brief-region="lede"'),
    );
    expect(html).not.toContain('data-brief-editorial-grid');
    expect(html).not.toContain('data-brief-story-card');
    const headed = render(letterBriefDocumentFixture, { masthead: true });
    expect(headed.indexOf('data-brief-header-weather')).toBeLessThan(
      headed.indexOf('data-brief-column="narrative"'),
    );
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
      expect(match[1]).toContain('--surface-accent');
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

// ---- Brief round 2026-09-22: new regions, age, every action, unread, tasks --

import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { BriefLetter } from '../components/report/brief-canvas/BriefLetter';
import type { BriefNodeContext } from '../components/report/brief-canvas/BriefNodeView';
import { briefRefKey } from '../lib/brief/hydration';
import type { BriefActionV2, BriefRegion, BriefSourceRefV2 } from '../lib/shared/brief-document';

const account = 'jakob@example.com';

function threadRow(
  id: string,
  subject: string,
  sender: string,
  extra: { age?: string; lane?: string; actions?: BriefActionV2[] } = {},
) {
  return {
    ref: { kind: 'thread' as const, id, account, label: subject },
    framing: {
      lane: extra.lane ?? 'waiting',
      sender,
      reason: 'No answer since Monday.',
      ...(extra.age ? { age: extra.age } : {}),
    },
    actions: extra.actions ?? [
      { action: 'open_thread', label: 'Open', payload: { account, threadId: id }, style: 'quiet' as const },
      {
        action: 'resolve_thread',
        label: 'Not needed',
        payload: { account, threadId: id, subject, receivedAt: 1_700_000_000_000 },
        style: 'quiet' as const,
      },
    ],
  };
}

const roundRegions: BriefRegion[] = [
  {
    id: 'yesterday',
    summary: 'You closed the deck notes.',
    tree: {
      kind: 'text',
      emphasis: 'standard',
      tone: 'neutral',
      role: 'body',
      text: 'You closed the deck notes on Monday and set out to answer Daniel today.',
    },
  },
  {
    id: 'waiting',
    summary: 'Waiting on: 1 thread.',
    tree: {
      kind: 'entity_list',
      emphasis: 'standard',
      tone: 'neutral',
      variant: 'rows',
      items: [threadRow('thread-invoice', 'Invoice for March', 'Ana Silva', { age: 'Day 3' })],
    },
  },
  {
    id: 'tasks',
    summary: 'Tasks this week: 2.',
    tree: {
      kind: 'entity_list',
      emphasis: 'standard',
      tone: 'neutral',
      variant: 'rows',
      items: [
        {
          ref: { kind: 'task', id: 'card-passport', label: 'Send the passport form' },
          framing: { lane: 'tasks', reason: 'Due Thursday.' },
          actions: [
            {
              action: 'toggle_task',
              label: 'Done',
              payload: { cardId: 'card-passport', completed: true, title: 'Send the passport form' },
              style: 'quiet',
            },
            {
              action: 'dismiss_task',
              label: 'Not needed',
              payload: { cardId: 'card-passport' },
              style: 'quiet',
            },
          ],
        },
        {
          ref: { kind: 'task', id: 'card-lease', label: 'Choose the lease option' },
          framing: { lane: 'tasks', reason: 'Due Friday.' },
          actions: [
            {
              action: 'toggle_task',
              label: 'Done',
              payload: { cardId: 'card-lease', completed: true, title: 'Choose the lease option' },
              style: 'quiet',
            },
          ],
        },
      ],
    },
  },
  {
    id: 'connected',
    summary: 'Connected tools: 1 item.',
    tree: {
      kind: 'entity_list',
      emphasis: 'muted',
      tone: 'neutral',
      variant: 'rows',
      items: [
        {
          ref: { kind: 'mcp', id: 'linear-issue-42', label: 'LAB-42 Fix the login redirect' },
          framing: { lane: 'connected', sender: 'Linear', reason: 'Assigned to you yesterday.' },
          actions: [
            {
              action: 'open_url',
              label: 'Open in Linear',
              payload: { url: 'https://linear.app/lab86/issue/LAB-42' },
              style: 'quiet',
            },
          ],
        },
      ],
    },
  },
];

function roundDocument(): BriefDocumentV2 {
  const regions = letterBriefDocumentFixture.regions;
  const lede = regions[0]!;
  const lanes = regions.filter((region) => ['answer', 'today', 'know'].includes(region.id));
  const tail = regions.filter((region) => ['week-ahead', 'areas'].includes(region.id));
  return {
    ...letterBriefDocumentFixture,
    regions: [lede, roundRegions[0]!, ...lanes, ...roundRegions.slice(1), ...tail],
  };
}

function areaRoundDocument(): BriefDocumentV2 {
  const regions = areaPulseDocumentFixture.regions;
  const before = regions.filter((region) => region.id !== 'open-work');
  const openWork = regions.find((region) => region.id === 'open-work')!;
  return {
    ...areaPulseDocumentFixture,
    regions: [
      ...before,
      {
        id: 'week',
        summary: 'The inspection is on Wednesday.',
        tree: {
          kind: 'text',
          emphasis: 'standard',
          tone: 'neutral',
          role: 'body',
          text: 'The inspection is on Wednesday. The lease reply is due Friday.',
        },
      },
      {
        id: 'mail',
        summary: 'Mail: 1 thread.',
        tree: {
          kind: 'entity_list',
          emphasis: 'standard',
          tone: 'neutral',
          variant: 'rows',
          items: [
            threadRow('thread-lease-2', 'Lease: parking clause', 'Daniel Ortiz', {
              lane: 'mail',
              actions: [
                {
                  action: 'open_thread',
                  label: 'Open',
                  payload: { account, threadId: 'thread-lease-2' },
                  style: 'quiet',
                },
                {
                  action: 'draft_reply',
                  label: 'Reply',
                  payload: { account, threadId: 'thread-lease-2', subject: 'Lease: parking clause' },
                  style: 'quiet',
                },
              ],
            }),
          ],
        },
      },
      openWork,
    ],
  };
}

// Renders the letter itself, past the document repair pass, so the test sees
// exactly what the renderer does with a field.
function renderLetter(
  document: BriefDocumentV2,
  context: BriefNodeContext,
  kind: 'daily' | 'area' = 'daily',
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <BriefLetter document={document} kind={kind} context={context} />
    </QueryClientProvider>,
  );
}

function mockContext(overrides: Partial<BriefNodeContext> = {}): BriefNodeContext {
  return {
    entities: new Map(),
    hiddenRefs: new Set(),
    completedRefs: new Map(),
    onAction: () => {},
    onCanvasAction: () => {},
    ...overrides,
  };
}

describe('the daily letter, brief round 2026-09-22', () => {
  test('renders yesterday, waiting, tasks, and connected in order as a letter', () => {
    const html = render(roundDocument());
    expect(html).toContain('data-brief-letter="daily"');
    const order = [
      'data-brief-region="lede"',
      'data-brief-region="yesterday"',
      'data-brief-region="answer"',
      'data-brief-region="today"',
      'data-brief-region="know"',
      'data-brief-region="waiting"',
      'data-brief-region="tasks"',
      'data-brief-region="connected"',
      'data-brief-region="week-ahead"',
      'data-brief-region="areas"',
    ];
    const positions = order.map((needle) => html.indexOf(needle));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(html).not.toContain('data-brief-story-card');
  });

  test('yesterday reads like the week ahead, directly under the lede', () => {
    const html = render(roundDocument());
    expect(html).toContain('>Yesterday</span>');
    const yesterday = html.slice(
      html.indexOf('data-brief-region="yesterday"'),
      html.indexOf('data-brief-region="answer"'),
    );
    expect(yesterday).toContain('data-brief-letter-week-ahead');
    expect(yesterday).toContain('<span>You closed the deck notes on </span>');
    expect(yesterday).toContain('<span> and set out to answer Daniel today.</span>');
    const marks = yesterday.match(/data-brief-weekday[^>]*>Monday<\/span>/g) ?? [];
    expect(marks).toHaveLength(1);
    expect(html.indexOf('data-brief-region="lede"')).toBeLessThan(
      html.indexOf('data-brief-region="yesterday"'),
    );
  });

  test('the new lanes carry their kickers when the document has no title', () => {
    const html = render(roundDocument());
    const kickers = [...html.matchAll(/data-brief-letter-kicker[^>]*>([^<]+)<\/span>/g)].map(
      (match) => match[1],
    );
    expect(kickers).toEqual(['Answer', 'Today', 'Know', 'Waiting on', 'Tasks this week', 'Connected tools']);
  });

  test('the age label follows the sender, small and muted', () => {
    const html = renderLetter(roundDocument(), mockContext());
    const sender = html.match(
      /data-brief-letter-sender[^>]*>Ana Silva<span data-brief-letter-age="true" class="([^"]*)">Day 3<\/span><\/p>/,
    );
    expect(sender).not.toBeNull();
    expect(sender?.[1]).toContain('text-[11px]');
    expect(sender?.[1]).toContain('--color-text-muted');
    expect(html.match(/data-brief-letter-age/g) ?? []).toHaveLength(1);
    // The label survives the document repair pass on the canvas path too.
    expect(render(roundDocument())).toMatch(/data-brief-letter-age[^>]*>Day 3<\/span>/);
    // No age, no label.
    expect(render(letterBriefDocumentFixture)).not.toContain('data-brief-letter-age');
  });

  test('every known action renders as text; the first keeps the accent', () => {
    const html = render(roundDocument());
    const waiting = html.slice(
      html.indexOf('data-brief-region="waiting"'),
      html.indexOf('data-brief-region="tasks"'),
    );
    const actions = [...waiting.matchAll(/data-brief-letter-action-name="([^"]+)"[^>]*>([^<]+)<\/button>/g)];
    expect(actions.map((match) => [match[1], match[2]])).toEqual([
      ['open_thread', 'Open'],
      ['resolve_thread', 'Not needed'],
    ]);
    expect(waiting).toMatch(/data-brief-letter-action-name="open_thread"[^>]*class="[^"]*--color-accent\)/);
    expect(waiting).toMatch(
      /data-brief-letter-action-name="resolve_thread"[^>]*class="[^"]*--color-text-muted\)/,
    );
    expect(html).not.toMatch(/<svg[^>]*>[\s\S]{0,200}?>Not needed</);
  });

  test('task rows show the day mark and Done, and a completed task strikes through', () => {
    const passport: BriefSourceRefV2 = { kind: 'task', id: 'card-passport' };
    const context = mockContext({
      entities: new Map([
        [
          briefRefKey(passport),
          {
            kind: 'task',
            id: 'card-passport',
            title: 'Send the passport form',
            completed: true,
            dueAt: Date.UTC(2026, 8, 24, 12),
            gone: false,
          },
        ],
      ]),
    });
    const html = renderLetter(roundDocument(), context);
    expect(html).toContain('data-brief-letter-completed="true"');
    expect(html.match(/data-brief-letter-completed="true"/g) ?? []).toHaveLength(1);
    const done = html.slice(html.indexOf('data-brief-letter-completed="true"'));
    expect(done).toMatch(
      /data-brief-letter-subject[^>]*class="[^"]*line-through[^"]*"[^>]*>Send the passport form</,
    );
    expect(done).toContain('>✓</span>');
    expect(done).toContain('>Task</p>');
    expect(done).toContain('>Done</button>');
    expect(done).toContain('>Not needed</button>');
    // The open task keeps its plain subject and a due-day mark.
    const open = html.slice(
      html.indexOf('Choose the lease option') - 400,
      html.indexOf('Choose the lease option'),
    );
    expect(open).not.toContain('line-through');
  });

  test('connected rows render the label, the source, and the reason without hydration', () => {
    const html = render(roundDocument());
    const connected = html.slice(
      html.indexOf('data-brief-region="connected"'),
      html.indexOf('data-brief-region="week-ahead"'),
    );
    expect(connected).toContain('>Linear</p>');
    expect(connected).toContain('LAB-42 Fix the login redirect');
    expect(connected).toContain('Assigned to you yesterday.');
    expect(connected).toContain('>Open in Linear</button>');
  });

  test('an unread thread carries a small mark before its subject', () => {
    const ref: BriefSourceRefV2 = { kind: 'thread', id: 'thread-invoice', account };
    const context = mockContext({
      entities: new Map([
        [
          briefRefKey(ref),
          { kind: 'thread', id: ref.id, account, title: 'Invoice for March', unread: true, gone: false },
        ],
      ]),
    });
    const html = renderLetter(roundDocument(), context);
    expect(html.match(/data-brief-letter-unread/g) ?? []).toHaveLength(1);
    expect(html).toMatch(/data-brief-letter-unread[^>]*class="[^"]*size-1\.5 [^"]*rounded-full/);
    expect(html).toContain('<span class="sr-only">Unread. </span>Invoice for March');
    expect(html).not.toMatch(/data-brief-letter-unread[^>]*>\s*<svg/);
  });

  test('each action dispatches with its own payload and the region id', async () => {
    const calls: Array<{
      action: string;
      payload: Record<string, unknown>;
      ref?: BriefSourceRefV2;
      regionId?: string;
    }> = [];
    const context = mockContext({
      onAction: (action, payload, ref, meta) =>
        void calls.push({ action: action.action, payload, ref, regionId: meta?.regionId }),
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <QueryClientProvider client={queryClient}>
          <BriefLetter document={roundDocument()} kind="daily" context={context} />
        </QueryClientProvider>,
      );
    });
    const buttons = renderer.root.findAllByType('button');
    const named = (name: string, label: string) =>
      buttons.find(
        (button) => button.props['data-brief-letter-action-name'] === name && button.children.includes(label),
      );
    await act(async () => named('resolve_thread', 'Not needed')?.props.onClick());
    await act(async () => named('toggle_task', 'Done')?.props.onClick());
    await act(async () => named('open_url', 'Open in Linear')?.props.onClick());
    renderer.unmount();
    expect(calls.map((call) => [call.action, call.regionId])).toEqual([
      ['resolve_thread', 'waiting'],
      ['toggle_task', 'tasks'],
      ['open_url', 'connected'],
    ]);
    expect(calls[0]?.payload).toEqual({
      account,
      threadId: 'thread-invoice',
      subject: 'Invoice for March',
      receivedAt: 1_700_000_000_000,
    });
    expect(calls[1]?.payload).toEqual({
      cardId: 'card-passport',
      completed: true,
      title: 'Send the passport form',
    });
    expect(calls[1]?.ref).toEqual({ kind: 'task', id: 'card-passport', label: 'Send the passport form' });
    expect(calls[2]?.payload).toEqual({ url: 'https://linear.app/lab86/issue/LAB-42' });
  });

  test('a known region id with another node kind falls through to the generic renderer', () => {
    const document = roundDocument();
    document.regions = document.regions.map((region) =>
      region.id === 'yesterday'
        ? {
            ...region,
            tree: {
              kind: 'stack',
              emphasis: 'standard',
              tone: 'neutral',
              density: 'standard',
              children: [
                {
                  kind: 'text',
                  emphasis: 'standard',
                  tone: 'neutral',
                  role: 'body',
                  text: 'Generic yesterday.',
                },
              ],
            },
          }
        : region,
    );
    const html = render(document);
    expect(html).toContain('data-brief-letter="daily"');
    expect(html).toContain('Generic yesterday.');
    expect(html).not.toContain('>Yesterday</span>');
  });
});

describe('the area pulse letter, brief round 2026-09-22', () => {
  test('renders the week paragraph and the mail lane between the ask and open work', () => {
    const html = render(areaRoundDocument());
    expect(html).toContain('data-brief-letter="area"');
    const order = [
      'data-brief-region="ask"',
      'data-brief-region="week"',
      'data-brief-region="mail"',
      'data-brief-region="open-work"',
    ];
    const positions = order.map((needle) => html.indexOf(needle));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(html).toContain('>Week ahead</span>');
    const marks = html.match(/data-brief-weekday[^>]*>(Wednesday|Friday)<\/span>/g) ?? [];
    expect(marks).toHaveLength(2);
    expect(html).toContain('>Mail</span>');
    expect(html).toContain('Lease: parking clause');
    expect(html).toContain('>Open</button>');
    expect(html).toContain('>Reply</button>');
  });
});

describe('review actions in letter rows', () => {
  function reviewDocument(): BriefDocumentV2 {
    const regions = letterBriefDocumentFixture.regions;
    return {
      ...letterBriefDocumentFixture,
      regions: regions.map((region) =>
        region.id === 'today' && region.tree.kind === 'entity_list'
          ? {
              ...region,
              tree: {
                ...region.tree,
                items: [
                  threadRow('thread-passport', 'Passport renewal: form due', 'Passport Office', {
                    lane: 'today',
                    actions: [
                      {
                        action: 'open_thread',
                        label: 'Open',
                        payload: { account, threadId: 'thread-passport' },
                        style: 'quiet',
                      },
                      {
                        action: 'create_task',
                        label: 'Add task',
                        payload: { title: 'Send the passport form', dueAt: 1_790_000_000_000 },
                        style: 'quiet',
                      },
                      {
                        action: 'draft_reply',
                        label: 'Reply',
                        payload: {
                          account,
                          threadId: 'thread-passport',
                          subject: 'Passport renewal: form due',
                        },
                        style: 'quiet',
                      },
                    ],
                  }),
                ],
              },
            }
          : region,
      ),
    };
  }

  test('create_task marks itself as a review action; open and reply stay direct', () => {
    const html = renderLetter(reviewDocument(), mockContext());
    expect(html).toMatch(
      /data-brief-letter-action-name="create_task" data-brief-letter-action-review="true"/,
    );
    expect(html).not.toMatch(/data-brief-letter-action-name="open_thread" data-brief-letter-action-review/);
    expect(html).not.toMatch(/data-brief-letter-action-name="draft_reply" data-brief-letter-action-review/);
  });

  test('create_task confirms in the shared popover before it dispatches; draft_reply dispatches at once', async () => {
    const calls: string[] = [];
    const context = mockContext({ onAction: (action) => void calls.push(action.action) });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <QueryClientProvider client={queryClient}>
          <BriefLetter document={reviewDocument()} kind="daily" context={context} />
        </QueryClientProvider>,
      );
    });
    const rowButton = (name: string) =>
      renderer.root
        .findAllByType('button')
        .find((button) => button.props['data-brief-letter-action-name'] === name);
    await act(async () => rowButton('draft_reply')?.props.onClick());
    expect(calls).toEqual(['draft_reply']);

    // The review action is a popover trigger: a click opens the confirm step
    // and dispatches nothing. (The popover body mounts in a portal, which
    // needs a DOM; the trigger state is what Radix flips here.)
    expect(rowButton('create_task')?.props['aria-expanded']).toBe(false);
    await act(async () => rowButton('create_task')?.props.onClick({ defaultPrevented: false }));
    expect(calls).toEqual(['draft_reply']);
    expect(rowButton('create_task')?.props['aria-expanded']).toBe(true);
    expect(rowButton('create_task')?.props['data-state']).toBe('open');
    renderer.unmount();
  });

  test('Enter on a row never skips the review step', async () => {
    const calls: string[] = [];
    const context = mockContext({ onAction: (action) => void calls.push(action.action) });
    const document = reviewDocument();
    // Put the review action first so it is the row tap.
    for (const region of document.regions) {
      if (region.id === 'today' && region.tree.kind === 'entity_list') {
        region.tree.items[0]!.actions = [...region.tree.items[0]!.actions].reverse().slice(1);
      }
    }
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <QueryClientProvider client={queryClient}>
          <BriefLetter document={document} kind="daily" context={context} />
        </QueryClientProvider>,
      );
    });
    const row = renderer.root
      .findAllByType('article')
      .find(
        (node) =>
          node.props['data-brief-letter-row'] === true &&
          node.findAll(
            (child) =>
              child.type === 'button' && child.props['data-brief-letter-action-name'] === 'create_task',
          ).length > 0,
      );
    expect(row).toBeDefined();
    const target = {};
    await act(async () =>
      row?.props.onKeyDown({ key: 'Enter', target, currentTarget: target, preventDefault() {} }),
    );
    expect(calls).toEqual([]);
    renderer.unmount();
  });
});
