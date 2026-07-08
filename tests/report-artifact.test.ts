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
    expect(html).toContain('.lede-block .lede:first-of-type::first-letter');
    expect(html).toContain('class="icon-btn"');
  });

  test('styles the editorial header/line voice with the second accent', () => {
    const html = buildNativeDailyReportArtifact(sampleReport());
    // Deterministic fallback for standalone rendering.
    expect(html).toContain('--brief-accent-2:#774914');
    // Header texts, tags, and the section rule speak in accent-2 with an
    // accent-1 (or hairline) fallback.
    expect(html).toMatch(/\.section-title\{[^}]*color:var\(--brief-accent-2,var\(--brief-ink\)\)/);
    expect(html).toMatch(
      /\.section-title::after\{[^}]*background:var\(--brief-accent-2,var\(--brief-hairline\)\)/,
    );
    expect(html).toMatch(/\.narrative h3\{[^}]*color:var\(--brief-accent-2,var\(--brief-accent\)\)/);
    expect(html).toMatch(/\.tag\{[^}]*color:var\(--brief-accent-2,var\(--brief-accent\)\)/);
    expect(html).toMatch(/\.caption\{[^}]*color:var\(--brief-accent-2,var\(--brief-muted\)\)/);
    // Accent-1 stays the action/emphasis voice.
    expect(html).toMatch(/\.btn\.primary\{[^}]*background:var\(--brief-accent\)/);
    expect(html).toMatch(/\.lede-block \.lede:first-of-type::first-letter\{[^}]*color:var\(--brief-accent\)/);
  });

  test('never imposes ALL-CAPS labels: no uppercase transform, sentence-case dateline', () => {
    const html = runWithAiRequestContext({ userTimezone: 'America/New_York' }, () =>
      buildNativeDailyReportArtifact(sampleReport()),
    );
    expect(html).not.toContain('text-transform:uppercase');
    expect(html).not.toContain('text-transform: uppercase');
    // The spine dateline stays sentence case ("Jun 10, 2026"), never "JUN 10".
    expect(html).toContain('Jun 10, 2026');
    expect(html).not.toContain('JUN 10');
  });

  test('renders branded source footer with service logos', () => {
    const html = buildNativeDailyReportArtifact({
      ...sampleReport(),
      services: ['gmail', 'github', 'slack'],
    });
    expect(html).toContain('Made for you by');
    expect(html).toContain('Lab86');
    expect(html).not.toContain('With love from');
    expect(html).not.toContain('footer-lab86');
    expect(html).not.toContain('footer-letter');
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

  test('renders markdown-style narrative as structured body copy', () => {
    const html = buildNativeDailyReportArtifact({
      ...sampleReport(),
      narrative:
        '# Focus\n\nThe day has one important thread with **bold context** and `*literal*` markdown.\n\n- Prepare the launch notes',
    });
    expect(html).toContain('<h1>Focus</h1>');
    expect(html).toContain(
      '<p>The day has one important thread with <strong>bold context</strong> and <code>*literal*</code> markdown.</p>',
    );
    expect(html).toContain('<li>Prepare the launch notes</li>');
    expect(html).not.toContain('<code><em>literal</em></code>');
    expect(html).not.toContain('<p class="lede"># Focus');
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

  test('keeps non-destructive quiet actions labeled', () => {
    const html = buildNativeDailyReportArtifact(sampleReport(), {
      version: 1,
      title: 'Quiet action labels',
      services: [],
      blocks: [
        {
          type: 'tool_digest',
          title: 'Tools',
          items: [
            {
              server: 'github',
              title: 'Open PR',
              state: null,
              author: null,
              url: null,
              actions: [
                { action: 'open_view', label: 'Open tasks', payload: { view: 'tasks' }, style: 'quiet' },
              ],
              sourceRefs: [],
            },
          ],
          sourceRefs: [],
        },
      ],
    });
    expect(html).toContain('>Open tasks</button>');
    expect(html).not.toContain('aria-label="Open tasks" title="Open tasks">&#10003;');
  });

  test('rejects custom widgets with external loading escape hatches', () => {
    for (const unsafeHtml of [
      '<style>@import url("https://example.com/x.css")</style>',
      '<div style="background:url(https://example.com/x.png)">x</div>',
      '<img srcset="https://example.com/x.png 1x">',
      '<meta http-equiv="refresh" content="0;url=https://example.com">',
      '<object data="https://example.com/file"></object>',
      '<video poster="https://example.com/poster.png"></video>',
      '<form action="https://example.com/post"></form>',
    ]) {
      const html = buildNativeDailyReportArtifact(sampleReport(), {
        version: 1,
        title: 'Unsafe widget',
        services: [],
        blocks: [
          {
            type: 'custom_widget',
            id: 'unsafe',
            title: 'Unsafe',
            html: unsafeHtml,
            fallbackMarkdown: 'Fallback rendered.',
            allowedActions: [],
            sourceRefs: [],
          },
        ],
      });
      expect(html).toContain('Fallback rendered.');
      expect(html).not.toContain('sandbox="allow-scripts"');
    }
  });

  test('falls back to default date formatting when an invalid timezone is supplied', () => {
    const startAt = Date.parse('2026-06-13T17:00:00.000Z');
    const expectedFallbackDate = new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
    }).format(new Date(startAt));
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
                startAt,
                endAt: startAt + 60 * 60 * 1000,
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
    expect(html).toContain(expectedFallbackDate);
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
