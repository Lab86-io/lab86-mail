import { describe, expect, test } from 'bun:test';
import './tools/harness';
import {
  buildDataPrompt,
  extractHtml,
  gatherBriefExtras,
  HTML_ARTIFACT_BRIEF,
  settleMonthArtifactReport,
  settleMonthHtmlArtifactReport,
  toBriefEvent,
  toBriefTask,
} from '../lib/mail/agent-report';
import type { DailyReport, DailyReportCalendarItem, DailyReportTaskItem } from '../lib/shared/types';
import { withToolContext } from './tools/harness';

describe('toBriefTask', () => {
  test('passes through the richer fields the agent acts on', () => {
    const task: DailyReportTaskItem = {
      cardId: 'card_1',
      boardId: 'b1',
      columnId: 'c1',
      boardTitle: 'Work',
      columnName: 'Today',
      title: 'Ship the brief',
      description: 'with tests',
      dueAt: 1_700_000_000_000,
      priority: 'high',
      labels: ['eng', 'p0'],
      assignees: ['me@example.test'],
      sourceTitle: 'thread',
      sourceUrl: 'https://example.test/t',
      scope: 'week',
    };
    expect(toBriefTask(task)).toEqual({
      cardId: 'card_1',
      boardTitle: 'Work',
      columnName: 'Today',
      title: 'Ship the brief',
      description: 'with tests',
      dueAt: 1_700_000_000_000,
      priority: 'high',
      labels: ['eng', 'p0'],
      assignees: ['me@example.test'],
      completed: false,
      sourceUrl: 'https://example.test/t',
      sourceTitle: 'thread',
    });
  });

  test('defaults optional fields so the agent never sees undefined', () => {
    const task: DailyReportTaskItem = {
      cardId: 'card_2',
      boardId: 'b1',
      columnId: 'c1',
      title: 'Minimal',
      scope: 'week',
    };
    const shaped = toBriefTask(task);
    expect(shaped.description).toBeNull();
    expect(shaped.dueAt).toBeNull();
    expect(shaped.labels).toEqual([]);
    expect(shaped.assignees).toEqual([]);
    expect(shaped.sourceUrl).toBeNull();
    expect(shaped.completed).toBe(false);
  });
});

describe('toBriefEvent', () => {
  test('exposes calendarId (needed for rsvp_event) and the richer fields', () => {
    const event: DailyReportCalendarItem = {
      account: 'me@example.test',
      eventId: 'evt_1',
      calendarId: 'cal_1',
      calendarName: 'Primary',
      title: 'Sync',
      startAt: 1_700_000_000_000,
      endAt: 1_700_003_600_000,
      allDay: false,
      location: 'Room 4',
      description: 'agenda',
      htmlLink: 'https://example.test/e',
      scope: 'week',
    };
    expect(toBriefEvent(event)).toEqual({
      account: 'me@example.test',
      eventId: 'evt_1',
      calendarId: 'cal_1',
      canRsvp: true,
      calendarName: 'Primary',
      title: 'Sync',
      startAt: 1_700_000_000_000,
      endAt: 1_700_003_600_000,
      allDay: false,
      location: 'Room 4',
      description: 'agenda',
      htmlLink: 'https://example.test/e',
    });
  });

  test('nulls missing optional fields and defaults allDay', () => {
    const event: DailyReportCalendarItem = {
      account: 'me@example.test',
      eventId: 'evt_2',
      title: 'Bare',
      startAt: 1,
      endAt: 2,
      scope: 'month',
    };
    const shaped = toBriefEvent(event);
    expect(shaped.calendarId).toBeNull();
    expect(shaped.canRsvp).toBe(false);
    expect(shaped.calendarName).toBeNull();
    expect(shaped.location).toBeNull();
    expect(shaped.description).toBeNull();
    expect(shaped.htmlLink).toBeNull();
    expect(shaped.allDay).toBe(false);
  });
});

describe('daily brief service metadata', () => {
  test('gatherBriefExtras falls back to mail and includes calendar/task sources', async () => {
    const empty = reportFixture();
    await expect(gatherBriefExtras(empty)).resolves.toMatchObject({
      digests: [],
      voiceSamples: [],
      services: ['mail'],
    });

    const withSources = reportFixture({
      sections: {
        ...empty.sections,
        calendar: [
          {
            account: 'me@example.test',
            eventId: 'evt_3',
            title: 'Review',
            startAt: 1,
            endAt: 2,
            scope: 'week',
          },
        ],
        tasks: [
          {
            cardId: 'card_3',
            boardId: 'board',
            columnId: 'column',
            title: 'Prep agenda',
            scope: 'week',
          },
        ],
      },
    });
    const extras = await gatherBriefExtras(withSources);
    expect(extras.services).toEqual(['calendar', 'tasks']);
  });

  test('buildDataPrompt serializes logo-bearing service definitions', async () => {
    const report = reportFixture({
      services: ['gmail'],
      sections: {
        ...reportFixture().sections,
        mcp: [
          {
            server: 'github',
            kind: 'pull_request',
            title: 'Review auth fix',
          },
        ],
      },
    });

    const prompt = await withToolContext(() =>
      Promise.resolve(
        buildDataPrompt(report, {
          digests: [],
          voiceSamples: ['Sounds good, thanks for moving this forward.'],
          services: ['slack'],
        }),
      ),
    );
    const json = prompt.match(/```json\n([\s\S]*?)\n```/)?.[1] || '{}';
    const data = JSON.parse(json);
    expect(data.services.map((service: any) => service.id)).toEqual(['gmail', 'slack', 'github']);
    expect(data.services.map((service: any) => service.label)).toEqual(['Gmail', 'Slack', 'GitHub']);
    expect(data.services.every((service: any) => service.logoSvg.includes('footer-logo'))).toBe(true);
  });

  test('HTML artifact prompt requires system theme, typography, and art masthead', () => {
    expect(HTML_ARTIFACT_BRIEF).toContain('MASTHEAD (signature element');
    expect(HTML_ARTIFACT_BRIEF).toContain('Claude Artifact');
    expect(HTML_ARTIFACT_BRIEF).toContain('CLAUDE ARTIFACT DESIGN SKILL');
    expect(HTML_ARTIFACT_BRIEF).toContain('REQUIRED VISUAL MODULES');
    expect(HTML_ARTIFACT_BRIEF).toContain('TIMELINE STANDARD');
    expect(HTML_ARTIFACT_BRIEF).toContain('ACTION DESIGN');
    expect(HTML_ARTIFACT_BRIEF).toContain('STYLIZED LEDE SYSTEM');
    expect(HTML_ARTIFACT_BRIEF).toContain('internal lede treatment library');
    expect(HTML_ARTIFACT_BRIEF).toContain('Illuminated brief');
    expect(HTML_ARTIFACT_BRIEF).toContain('LIGHT AND DARK MODE REQUIREMENTS');
    expect(HTML_ARTIFACT_BRIEF).toContain('prefers-color-scheme: dark');
    expect(HTML_ARTIFACT_BRIEF).toContain('AI SLOP BAN LIST');
    expect(HTML_ARTIFACT_BRIEF).toContain('twenty tells');
    expect(HTML_ARTIFACT_BRIEF).toContain('The {data.weekday} Brief');
    expect(HTML_ARTIFACT_BRIEF).toContain('newspaper spine');
    expect(HTML_ARTIFACT_BRIEF).toContain('SYSTEM THEME IS MANDATORY');
    expect(HTML_ARTIFACT_BRIEF).toContain('SYSTEM TYPOGRAPHY IS MANDATORY');
    expect(HTML_ARTIFACT_BRIEF).toContain('var(--brief-font-display)');
    expect(HTML_ARTIFACT_BRIEF).toContain('data.art.imageUrl');
    expect(HTML_ARTIFACT_BRIEF).toContain('required art header');
    expect(HTML_ARTIFACT_BRIEF).toContain('CONTENT STRUCTURE');
    expect(HTML_ARTIFACT_BRIEF).toContain('mostly bordered cards');
    expect(HTML_ARTIFACT_BRIEF).toContain('Charts/diagrams that decorate');
  });
});

describe('settleMonthArtifactReport', () => {
  test('keeps a successful week AI artifact when month AI composition fails', () => {
    const phase1 = reportFixture({
      composition: briefComposition('Week AI'),
      html: '<html>week ai</html>',
      artifactStatus: 'enriching',
      artifactSource: 'ai',
    });
    const full = reportFixture({ narrative: 'Full month deterministic data.' });

    const settled = settleMonthArtifactReport({
      phase1,
      full,
      composition: null,
      failure: { stage: 'month_artifact', message: 'invalid JSON from model', at: 123 },
    });

    expect(settled.artifactSource).toBe('ai');
    expect(settled.artifactStatus).toBe('rendered');
    expect(settled.html).toBe('<html>week ai</html>');
    expect(settled.artifactErrors).toEqual([
      { stage: 'month_artifact', message: 'invalid JSON from model', at: 123 },
    ]);
  });

  test('records deterministic artifact failures when no AI artifact succeeded', () => {
    const phase1 = reportFixture({
      composition: briefComposition('Week fallback'),
      html: '<html>fallback</html>',
      artifactStatus: 'enriching',
      artifactSource: 'deterministic',
      artifactErrors: [{ stage: 'week_artifact', message: 'week schema failed', at: 100 }],
    });
    const full = reportFixture({ narrative: 'Full month deterministic data.' });

    const settled = settleMonthArtifactReport({
      phase1,
      full,
      composition: null,
      failure: { stage: 'month_artifact', message: 'month schema failed', at: 200 },
    });

    expect(settled.artifactSource).toBe('deterministic');
    expect(settled.artifactStatus).toBe('rendered');
    expect(settled.html).toContain('<!doctype html>');
    expect(settled.artifactErrors).toEqual([
      { stage: 'week_artifact', message: 'week schema failed', at: 100 },
      { stage: 'month_artifact', message: 'month schema failed', at: 200 },
    ]);
  });
});

describe('settleMonthHtmlArtifactReport', () => {
  test('uses model-authored full HTML when month composition succeeds', () => {
    const phase1 = reportFixture({
      html: '<!doctype html><html><body>week</body></html>',
      artifactStatus: 'enriching',
      artifactSource: 'ai',
    });
    const full = reportFixture({
      composition: briefComposition('Native fallback'),
      narrative: 'Full month data.',
    });

    const settled = settleMonthHtmlArtifactReport({
      phase1,
      full,
      html: '<!doctype html><html><body>month</body></html>',
    });

    expect(settled.artifactSource).toBe('ai');
    expect(settled.artifactStatus).toBe('rendered');
    expect(settled.html).toBe('<!doctype html><html><body>month</body></html>');
    expect(settled.composition).toBeUndefined();
  });

  test('keeps a successful week HTML artifact when month HTML fails', () => {
    const phase1 = reportFixture({
      html: '<!doctype html><html><body>week</body></html>',
      artifactStatus: 'enriching',
      artifactSource: 'ai',
    });

    const settled = settleMonthHtmlArtifactReport({
      phase1,
      full: reportFixture(),
      html: null,
      failure: { stage: 'month_artifact', message: 'missing html', at: 456 },
    });

    expect(settled.artifactSource).toBe('ai');
    expect(settled.artifactStatus).toBe('rendered');
    expect(settled.html).toBe('<!doctype html><html><body>week</body></html>');
    expect(settled.artifactErrors).toEqual([{ stage: 'month_artifact', message: 'missing html', at: 456 }]);
  });
});

describe('extractHtml', () => {
  test('extracts a fenced HTML document and trims trailing prose', () => {
    const body = 'ok '.repeat(80);
    expect(
      extractHtml(`note\n\`\`\`html\n<!doctype html><html><body>${body}</body></html>\n\`\`\`\nextra`),
    ).toBe(`<!doctype html><html><body>${body}</body></html>`);
  });

  test('rejects non-doc fragments', () => {
    expect(extractHtml('<div>not enough</div>')).toBeNull();
  });

  test('rejects incomplete HTML documents', () => {
    expect(extractHtml(`<!doctype html><html><body>${'ok '.repeat(80)}</body>`)).toBeNull();
  });
});

function briefComposition(title: string) {
  return {
    version: 1 as const,
    title,
    services: [],
    blocks: [{ type: 'lede' as const, paragraphs: ['A composed report.'], sourceRefs: [] }],
  };
}

function reportFixture(overrides: Partial<DailyReport> = {}): DailyReport {
  return {
    _id: 'report_agent_shape',
    kind: 'manual',
    generatedAt: Date.parse('2026-06-10T12:00:00.000Z'),
    status: 'ready',
    accounts: [],
    title: 'Brief',
    narrative: 'Brief narrative.',
    sections: {
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
    },
    stats: {
      scannedThreads: 0,
      trackedThreads: 0,
      needsReply: 0,
      replyOwed: 0,
      dueSoon: 0,
      bulkTailCount: 0,
      unread: 0,
    },
    ...overrides,
  };
}
