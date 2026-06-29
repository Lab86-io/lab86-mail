import { describe, expect, test } from 'bun:test';
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
