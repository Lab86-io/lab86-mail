import { describe, expect, test } from 'bun:test';
import { runWithAiRequestContext } from '../lib/ai/context';
import { buildNativeDailyReportArtifact } from '../lib/mail/report-artifact';

function sampleReport(sections?: any): any {
  return {
    _id: 'r1',
    kind: 'manual',
    generatedAt: Date.parse('2026-06-10T08:00:00.000Z'),
    status: 'ready',
    accounts: ['me@example.test'],
    title: 'Brief',
    narrative: 'The day ahead.',
    sections: sections ?? {
      replyOwed: [
        {
          account: 'me@example.test',
          threadId: 't1',
          subject: '<b>Q3</b> plan',
          people: ['Alex'],
          whyItMatters: 'Needs your sign-off',
          unread: true,
          receivedAt: Date.parse('2026-06-08T08:00:00.000Z'),
          trackedThreadId: 'tr1',
        },
      ],
      followUpOwed: [],
      newPeople: [],
      timeSensitive: [],
      tracked: [],
      fyi: [],
      bulkTail: [],
      tasks: [
        {
          cardId: 'c1',
          boardId: 'b',
          columnId: 'col',
          boardTitle: 'Work',
          columnName: 'Today',
          title: 'Ship it',
          dueAt: Date.parse('2026-06-12T08:00:00.000Z'),
          scope: 'week',
        },
      ],
      calendar: [
        {
          account: 'me@example.test',
          eventId: 'e1',
          title: 'Sync',
          startAt: Date.parse('2026-06-10T15:00:00.000Z'),
          endAt: Date.parse('2026-06-10T15:30:00.000Z'),
          location: 'Room 4',
          scope: 'week',
        },
      ],
    },
    stats: {},
  };
}

describe('buildNativeDailyReportArtifact', () => {
  test('renders a complete, self-contained HTML document', () => {
    const html = buildNativeDailyReportArtifact(sampleReport());
    expect(html.startsWith('<!doctype html')).toBe(true);
    expect(html.toLowerCase()).toContain('</html>');
    expect(html).toContain('<style>');
    expect(html).toContain('<script>');
  });

  test('renders branded source footer with service logos', () => {
    const html = buildNativeDailyReportArtifact({
      ...sampleReport(),
      services: ['gmail', 'github', 'slack'],
    });
    expect(html).toContain('Made for you by');
    expect(html).toContain('With love from');
    expect(html).toContain('aria-label="Gmail"');
    expect(html).toContain('aria-label="GitHub"');
    expect(html).toContain('aria-label="Slack"');
  });

  test('derives footer services from calendar, tasks, and connected tools', () => {
    const html = buildNativeDailyReportArtifact(
      sampleReport({
        ...sampleReport().sections,
        mcp: [{ server: 'github', kind: 'pull_request', title: 'Review #42' }],
      }),
    );
    expect(html).toContain('aria-label="Calendar"');
    expect(html).toContain('aria-label="Tasks"');
    expect(html).toContain('aria-label="GitHub"');
  });

  test('falls back to mail in the footer when no services can be inferred', () => {
    const html = buildNativeDailyReportArtifact(
      sampleReport({
        replyOwed: [],
        followUpOwed: [],
        newPeople: [],
        timeSensitive: [],
        tracked: [],
        fyi: [],
        bulkTail: [],
        tasks: [],
        calendar: [],
        mcp: [],
      }),
    );
    expect(html).toContain('aria-label="Mail"');
  });

  test('wires the full host interaction protocol on every item', () => {
    const html = buildNativeDailyReportArtifact(sampleReport());
    // postMessage bridge
    expect(html).toContain('lab86-daily-report');
    // needs-you controls + anchors for optimistic removal
    expect(html).toContain('data-thread-key=');
    expect(html).toContain('data-received-at=');
    expect(html).toContain('open_thread');
    expect(html).toContain('resolve_thread');
    expect(html).toContain('dismiss_thread');
    // task controls
    expect(html).toContain('data-card-id=');
    expect(html).toContain('toggle_task');
    expect(html).toContain('dismiss_task');
    // calendar
    expect(html).toContain('open_event');
    expect(html).toContain('open_view');
  });

  test('escapes hostile content rather than emitting raw markup', () => {
    const html = buildNativeDailyReportArtifact(sampleReport());
    expect(html).not.toContain('<b>Q3</b>');
    expect(html).toContain('&lt;b&gt;Q3&lt;/b&gt;');
  });

  test('falls back to graceful empty states when every section is bare', () => {
    const html = buildNativeDailyReportArtifact(
      sampleReport({
        replyOwed: [],
        followUpOwed: [],
        newPeople: [],
        timeSensitive: [],
        tracked: [],
        fyi: [],
        bulkTail: [],
        tasks: [],
        calendar: [],
      }),
    );
    expect(html).toContain('No open thread needs you right now.');
    expect(html).toContain('No active task context is waiting.');
    expect(html).toContain('No calendar context is scheduled for the next week.');
  });

  test('renders rich composition blocks and fallback action controls', () => {
    const html = buildNativeDailyReportArtifact(sampleReport(), {
      version: 1,
      title: 'Rich Brief',
      services: ['github', 'slack'],
      blocks: [
        {
          type: 'lede',
          title: 'Opening note',
          paragraphs: ['A focused day with one sharp decision.'],
          sourceRefs: [],
        },
        {
          type: 'needs_you',
          title: 'Needs you',
          items: [
            {
              account: 'me@example.test',
              threadId: 'thread_custom',
              subject: 'Decision & plan',
              person: '',
              reason: '',
              receivedAt: null,
              actions: [],
              sourceRefs: [],
            },
          ],
          sourceRefs: [],
        },
        {
          type: 'task_digest',
          title: 'Tasks',
          tasks: [
            {
              cardId: 'task_custom',
              title: 'Prepare graph',
              dueAt: Date.parse('2026-06-12T12:00:00.000Z'),
              actions: [],
              sourceRefs: [],
            },
          ],
          sourceRefs: [],
        },
        {
          type: 'week_ahead',
          title: 'The week ahead',
          events: [
            {
              account: 'me@example.test',
              eventId: 'all_day',
              title: 'Offsite',
              startAt: Date.parse('2026-06-13T00:00:00.000Z'),
              endAt: Date.parse('2026-06-14T00:00:00.000Z'),
              allDay: true,
              actions: [],
              sourceRefs: [],
            },
            {
              account: 'me@example.test',
              eventId: 'timed',
              title: 'Launch review',
              startAt: Date.parse('2026-06-13T17:00:00.000Z'),
              endAt: Date.parse('2026-06-13T18:00:00.000Z'),
              location: null,
              actions: [],
              sourceRefs: [],
            },
          ],
          sourceRefs: [],
        },
        {
          type: 'tool_digest',
          title: 'Across your tools',
          items: [
            {
              server: 'github',
              title: 'Review PR',
              state: null,
              author: null,
              url: null,
              actions: [],
              sourceRefs: [],
            },
            {
              server: 'slack',
              title: 'Launch channel',
              state: 'open',
              author: 'Alex',
              url: 'https://slack.com/example',
              reason: 'Team is waiting.',
              actions: [{ action: 'open_view', label: 'Open', payload: { view: 'mail' }, style: 'primary' }],
              sourceRefs: [],
            },
          ],
          sourceRefs: [],
        },
        {
          type: 'chart',
          variant: 'bar',
          title: 'Open loops',
          description: 'Work split by source.',
          data: [
            { label: 'Mail', value: 0 },
            { label: 'GitHub', value: 4 },
          ],
          sourceRefs: [{ kind: 'derived', id: 'chart' }],
        },
        {
          type: 'timeline',
          title: 'Decision trail',
          items: [
            { label: 'Kickoff', at: null, detail: 'No timestamp yet.', sourceRefs: [] },
            { label: 'Review', at: Date.parse('2026-06-14T14:00:00.000Z'), sourceRefs: [] },
          ],
          sourceRefs: [],
        },
        {
          type: 'prep_checklist',
          title: 'Prep',
          items: [
            { label: 'Write notes', sourceRefs: [] },
            {
              label: 'Send update',
              detail: 'Include owners.',
              action: {
                action: 'draft_reply',
                label: 'Draft',
                payload: { threadId: 'thread_custom' },
                style: 'secondary',
              },
              sourceRefs: [],
            },
          ],
          sourceRefs: [],
        },
      ],
    });

    expect(html).toContain('Opening note');
    expect(html).toContain('Mail - Decision &amp; plan');
    expect(html).toContain('Review this thread when you have a moment.');
    expect(html).toContain('aria-label="Done"');
    expect(html).toContain('aria-label="Remove"');
    expect(html).toContain('Due Jun 12');
    expect(html).toContain('Offsite');
    expect(html).toContain('Launch review');
    expect(html).toContain('No timestamp yet.');
    expect(html).toContain('Open loops');
    expect(html).toContain('width:2%');
    expect(html).toContain('width:100%');
    expect(html).toContain('Team is waiting.');
    expect(html).toContain('Send update');
    expect(html).toContain('draft_reply');
  });

  test('falls back to default date formatting when an invalid timezone is supplied', () => {
    const html = runWithAiRequestContext({ userTimezone: 'Invalid/Zone' }, () =>
      buildNativeDailyReportArtifact(sampleReport(), {
        version: 1,
        title: 'Invalid timezone',
        services: [],
        blocks: [
          {
            type: 'week_ahead',
            title: 'The week ahead',
            events: [
              {
                account: 'me@example.test',
                eventId: 'event_invalid_tz',
                title: 'Fallback time',
                startAt: Date.parse('2026-06-13T17:00:00.000Z'),
                endAt: Date.parse('2026-06-13T18:00:00.000Z'),
                actions: [],
                sourceRefs: [],
              },
            ],
            sourceRefs: [],
          },
        ],
      }),
    );
    expect(html).toContain('Fallback time');
    expect(html).toContain('Jun 13');
  });

  test('tolerates a report with no sections object at all', () => {
    const html = buildNativeDailyReportArtifact({
      _id: 'r2',
      kind: 'manual',
      generatedAt: Date.parse('2026-06-10T08:00:00.000Z'),
      status: 'ready',
      accounts: [],
      title: 'Empty',
      narrative: '',
      stats: {},
    } as any);
    expect(html.startsWith('<!doctype html')).toBe(true);
  });
});
