import { describe, expect, test } from 'bun:test';
import { buildNativeDailyReportArtifact } from '../lib/mail/report-artifact';
import {
  compositionFromReport,
  extractBriefCompositionJson,
  parseBriefComposition,
} from '../lib/shared/brief-composition';
import type { DailyReport } from '../lib/shared/types';

describe('BriefComposition', () => {
  test('derives a deterministic composition from structured report data', () => {
    const composition = compositionFromReport(reportFixture());
    expect(composition.version).toBe(1);
    expect(composition.blocks.map((block) => block.type)).toEqual([
      'lede',
      'needs_you',
      'task_digest',
      'week_ahead',
    ]);
    expect(composition.blocks.find((block) => block.type === 'needs_you')).toMatchObject({
      items: [
        {
          account: 'me@example.test',
          threadId: 'thread_1',
          actions: expect.arrayContaining([
            expect.objectContaining({ action: 'open_thread' }),
            expect.objectContaining({ action: 'resolve_thread' }),
          ]),
        },
      ],
    });
    expect(composition.blocks.find((block) => block.type === 'task_digest')).toMatchObject({
      tasks: [expect.objectContaining({ dueAt: null, meta: '' })],
    });
  });

  test('splits long deterministic ledes into editorial paragraphs', () => {
    const report = {
      ...reportFixture(),
      narrative:
        'Alex needs a decision before the launch review. The calendar has a tight review window in the afternoon. The prep task is the highest-leverage thing to finish before then.',
    };
    const lede = compositionFromReport(report).blocks.find((block) => block.type === 'lede');
    expect(lede).toMatchObject({
      type: 'lede',
      paragraphs: expect.arrayContaining([
        expect.stringContaining('Alex needs a decision'),
        expect.stringContaining('prep task'),
      ]),
    });
  });

  test('keeps markdown deterministic ledes inside schema limits', () => {
    const longBody = Array.from(
      { length: 80 },
      (_, index) => `Sentence ${index + 1} ties the mail thread to the calendar prep and the active task.`,
    ).join(' ');
    const report = {
      ...reportFixture(),
      narrative: `# Today\n\n${longBody}\n\n- Confirm the launch decision.\n- Prep the review notes.`,
    };
    const composition = compositionFromReport(report);
    const lede = composition.blocks.find((block) => block.type === 'lede');

    if (!lede || lede.type !== 'lede') throw new Error('missing lede');
    expect(lede.paragraphs.length).toBeLessThanOrEqual(4);
    expect(lede.paragraphs.every((paragraph) => paragraph.length <= 1200)).toBe(true);
    expect(buildNativeDailyReportArtifact(report, composition)).toContain('<h1>Today</h1>');
  });

  test('derives connected tool actions when MCP items have URLs', () => {
    const composition = compositionFromReport({
      ...reportFixture(),
      sections: {
        ...reportFixture().sections,
        mcp: [
          {
            server: 'github',
            externalId: 'gh-pr-42',
            kind: 'pull_request',
            title: 'Review launch PR',
            state: 'open',
            author: 'Alex',
            url: 'https://github.com/acme/project/pull/42',
            updatedAt: Date.parse('2026-06-10T10:00:00.000Z'),
          },
        ],
      },
    });

    expect(composition.blocks.find((block) => block.type === 'tool_digest')).toEqual({
      type: 'tool_digest',
      title: 'Across your tools',
      items: [
        {
          server: 'github',
          title: 'Review launch PR',
          state: 'open',
          author: 'Alex',
          url: 'https://github.com/acme/project/pull/42',
          sourceRefs: [{ kind: 'mcp', id: 'gh-pr-42', label: 'Review launch PR' }],
          actions: [{ action: 'open_view', label: 'Open tools', payload: { view: 'mail' }, style: 'quiet' }],
        },
      ],
      sourceRefs: [{ kind: 'mcp', id: 'gh-pr-42', label: 'Review launch PR' }],
    });
  });

  test('extracts and validates model-authored composition JSON', () => {
    const raw = `Here you go:\n\n\`\`\`json\n${JSON.stringify({
      version: 1,
      title: 'Daily Brief',
      services: ['gmail'],
      blocks: [
        {
          type: 'chart',
          variant: 'bar',
          title: 'Open loops by area',
          data: [{ label: 'Launch', value: 3 }],
          sourceRefs: [{ kind: 'derived', id: 'chart:open-loops' }],
        },
      ],
    })}\n\`\`\``;
    const composition = parseBriefComposition(extractBriefCompositionJson(raw));
    expect(composition.blocks[0]).toMatchObject({ type: 'chart', title: 'Open loops by area' });
  });

  test('repairs malformed optional source refs and actions from model output', () => {
    const composition = parseBriefComposition({
      version: 1,
      title: 'Daily Brief',
      services: ['gmail'],
      blocks: [
        {
          type: 'needs_you',
          title: 'Needs you',
          items: [
            {
              account: 'me@example.test',
              threadId: 'thread_1',
              subject: 'Launch review',
              person: 'Alex',
              reason: 'Needs a decision.',
              sourceRefs: [{ kind: 'email', threadId: 'thread_1' }, { kind: 'thread' }],
              actions: [
                { action: 'open_thread', payload: { account: 'me@example.test', threadId: 'thread_1' } },
                { action: 'reply' },
              ],
            },
          ],
          sourceRefs: [{ kind: 'mail', id: 'thread_1' }],
        },
        {
          type: 'chart',
          title: 'Workload',
          data: [{ label: 'Launch', value: 2 }],
          sourceRefs: [{ kind: 'unknown' }],
        },
      ],
    });

    const needs = composition.blocks.find((block) => block.type === 'needs_you');
    expect(needs).toMatchObject({
      items: [
        {
          sourceRefs: [{ kind: 'thread', id: 'thread_1' }],
          actions: [{ action: 'open_thread', label: 'Open' }],
        },
      ],
      sourceRefs: [{ kind: 'thread', id: 'thread_1' }],
    });
    expect(composition.blocks[1]).toMatchObject({
      type: 'chart',
      sourceRefs: [{ kind: 'derived', id: 'block:chart:1' }],
    });
  });

  test('repairs overlong model-authored lede paragraphs', () => {
    const overlong = Array.from(
      { length: 80 },
      (_, index) => `Observation ${index + 1} connects a thread, a meeting, and the task queue.`,
    ).join(' ');
    const composition = parseBriefComposition({
      version: 1,
      title: 'Daily Brief',
      services: ['gmail'],
      blocks: [{ type: 'lede', paragraphs: [`# Today\n\n${overlong}`], sourceRefs: [] }],
    });
    const lede = composition.blocks[0];

    if (lede.type !== 'lede') throw new Error('missing lede');
    expect(lede.paragraphs.length).toBeGreaterThan(1);
    expect(lede.paragraphs.length).toBeLessThanOrEqual(4);
    expect(lede.paragraphs.every((paragraph) => paragraph.length <= 1200)).toBe(true);
    expect(lede.paragraphs[0]).toStartWith('# Today');
  });

  test('repairs string ledes with oversized tokens', () => {
    const longToken = 'x'.repeat(1305);
    const composition = parseBriefComposition({
      version: 1,
      title: 'Daily Brief',
      services: ['gmail'],
      blocks: [{ type: 'lede', paragraphs: `Brief ${longToken} tail`, sourceRefs: [] }],
    });
    const lede = composition.blocks[0];

    if (lede.type !== 'lede') throw new Error('missing lede');
    expect(lede.paragraphs.length).toBeGreaterThan(1);
    expect(lede.paragraphs.every((paragraph) => paragraph.length <= 1200)).toBe(true);
    expect(lede.paragraphs.join(' ')).toContain('tail');
  });

  test('drops RSVP actions without a real calendar id', () => {
    const composition = parseBriefComposition({
      version: 1,
      title: 'Daily Brief',
      services: ['calendar'],
      blocks: [
        {
          type: 'week_ahead',
          title: 'The week ahead',
          events: [
            {
              account: 'me@example.test',
              eventId: 'event_1',
              calendarId: null,
              title: 'Launch review',
              startAt: Date.parse('2026-06-11T15:00:00.000Z'),
              endAt: Date.parse('2026-06-11T16:00:00.000Z'),
              sourceRefs: [{ kind: 'event', id: 'event_1', account: 'me@example.test' }],
              actions: [
                {
                  action: 'rsvp_event',
                  label: 'RSVP',
                  payload: { account: 'me@example.test', eventId: 'event_1', status: 'yes' },
                },
              ],
            },
          ],
          sourceRefs: [{ kind: 'event', id: 'event_1', account: 'me@example.test' }],
        },
      ],
    });
    const week = composition.blocks[0];

    if (week.type !== 'week_ahead') throw new Error('missing week block');
    expect(week.events[0].actions).toEqual([]);
  });

  test('repairs broad model schema drift without losing creative blocks', () => {
    const composition = parseBriefComposition({
      version: 1,
      title: 'Daily Brief',
      services: ['gmail'],
      blocks: [
        {
          type: 'timeline',
          title: 'Thread to meeting path',
          items: [
            {
              label: 'Message arrived',
              sourceRefs: [
                { kind: 'message-ish', messageId: 'msg_1', account: 'me@example.test' },
                { kind: 'todo', cardId: 'task_1', title: 'Prep launch notes' },
                { kind: 'calendar', eventId: 'event_1', title: 'Launch review' },
                { kind: 'account', id: 'me@example.test' },
                { kind: 'mystery', id: 'inferred-group' },
                'bad',
              ],
            },
          ],
          sourceRefs: 'bad',
        },
        {
          type: 'prep_checklist',
          title: 'Prep',
          items: [
            { label: 'Open the thread', action: { action: 'open_thread', payload: {} } },
            { label: 'Resolve the thread', action: { action: 'resolve_thread', payload: {} } },
            { label: 'Dismiss the thread', action: { action: 'dismiss_thread', payload: {} } },
            { label: 'Complete the task', action: { action: 'toggle_task', payload: {} } },
            { label: 'Dismiss the task', action: { action: 'dismiss_task', payload: {} } },
            { label: 'Create follow-up', action: { action: 'create_task', payload: {} } },
            { label: 'Draft response', action: { action: 'draft_reply', payload: {} } },
            { label: 'Archive noise', action: { action: 'archive_thread', payload: {} } },
            {
              label: 'RSVP',
              action: {
                action: 'rsvp_event',
                payload: {
                  account: 'me@example.test',
                  calendarId: 'cal_1',
                  eventId: 'event_1',
                  status: 'yes',
                },
              },
            },
            { label: 'Create focus hold', action: { action: 'create_event', payload: {} } },
            { label: 'Ignore bad action', action: { action: 'reply', payload: {} } },
          ],
          sourceRefs: [{ kind: 'derived', id: 'prep' }],
        },
        {
          type: 'custom_widget',
          id: 'focus_widget',
          title: 'Focus widget',
          html: '<button>Open</button>',
          fallbackMarkdown: 'Open mail.',
          allowedActions: ['open_view', 'reply', 42],
          sourceRefs: [{ kind: 'derived', id: 'widget:focus' }],
        },
        {
          type: 'custom_widget',
          id: 'quiet_widget',
          title: 'Quiet widget',
          html: '<button>Quiet</button>',
          fallbackMarkdown: 'Quiet.',
          allowedActions: 'open_view',
          sourceRefs: [{ kind: 'derived', id: 'widget:quiet' }],
        },
      ],
    });

    expect(composition.blocks[0]).toMatchObject({
      type: 'timeline',
      sourceRefs: [],
      items: [
        {
          sourceRefs: [
            { kind: 'message', id: 'msg_1' },
            { kind: 'task', id: 'task_1' },
            { kind: 'event', id: 'event_1' },
            { kind: 'account', id: 'me@example.test' },
            { kind: 'derived', id: 'inferred-group' },
          ],
        },
      ],
    });
    expect(composition.blocks[1]).toMatchObject({
      type: 'prep_checklist',
      items: [
        { action: { action: 'open_thread', label: 'Open' } },
        { action: { action: 'resolve_thread', label: 'Done' } },
        { action: { action: 'dismiss_thread', label: 'Remove' } },
        { action: { action: 'toggle_task', label: 'Complete' } },
        { action: { action: 'dismiss_task', label: 'Remove' } },
        { action: { action: 'create_task', label: 'Create task' } },
        { action: { action: 'draft_reply', label: 'Draft reply' } },
        { action: { action: 'archive_thread', label: 'Archive' } },
        { action: { action: 'rsvp_event', label: 'RSVP' } },
        { action: { action: 'create_event', label: 'Create event' } },
        { label: 'Ignore bad action' },
      ],
    });
    if (composition.blocks[1].type !== 'prep_checklist') throw new Error('missing prep checklist');
    expect(composition.blocks[1].items[10]).not.toHaveProperty('action');
    expect(composition.blocks[2]).toMatchObject({
      type: 'custom_widget',
      allowedActions: ['open_view'],
    });
    expect(composition.blocks[3]).toMatchObject({
      type: 'custom_widget',
      allowedActions: [],
    });
  });

  test('renders allowed custom widgets and falls back for unsafe widgets', () => {
    const safeHtml =
      '<button>Open</button><script>window.parent.postMessage({source:"lab86-brief-widget",action:"open_view",payload:{view:"mail"}},"*")</script>';
    const safe = buildNativeDailyReportArtifact(reportFixture(), {
      version: 1,
      title: 'Daily Brief',
      services: ['gmail'],
      blocks: [
        {
          type: 'custom_widget',
          id: 'safe_widget',
          title: 'Interactive triage',
          html: safeHtml,
          fallbackMarkdown: 'Open mail.',
          allowedActions: ['open_view'],
          sourceRefs: [{ kind: 'derived', id: 'widget:safe' }],
        },
      ],
    });
    expect(safe).toContain('sandbox="allow-scripts"');
    expect(safe).toContain('data-widget-actions');
    expect(safe).toContain('lab86-brief-widget');

    const unsafe = buildNativeDailyReportArtifact(reportFixture(), {
      version: 1,
      title: 'Daily Brief',
      services: ['gmail'],
      blocks: [
        {
          type: 'custom_widget',
          id: 'unsafe_widget',
          title: 'Unsafe triage',
          html: '<script>fetch("https://example.com")</script>',
          fallbackMarkdown: 'Static fallback.',
          allowedActions: [],
          sourceRefs: [{ kind: 'derived', id: 'widget:unsafe' }],
        },
      ],
    });
    expect(unsafe).not.toContain('sandbox="allow-scripts"');
    expect(unsafe).toContain('Static fallback.');
  });
});

function reportFixture(): DailyReport {
  return {
    _id: 'report_composition',
    kind: 'manual',
    generatedAt: Date.parse('2026-06-10T12:00:00.000Z'),
    status: 'ready',
    accounts: ['me@example.test'],
    title: 'Brief',
    narrative: 'Alex needs a decision before the launch review.',
    sections: {
      replyOwed: [
        {
          account: 'me@example.test',
          threadId: 'thread_1',
          subject: 'Launch review',
          people: ['Alex'],
          unread: true,
          receivedAt: Date.parse('2026-06-09T12:00:00.000Z'),
          whyItMatters: 'Needs a final go/no-go.',
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
          cardId: 'task_1',
          boardId: 'board',
          columnId: 'column',
          title: 'Prep launch notes',
          scope: 'week',
        },
      ],
      calendar: [
        {
          account: 'me@example.test',
          eventId: 'event_1',
          title: 'Launch review',
          startAt: Date.parse('2026-06-11T15:00:00.000Z'),
          endAt: Date.parse('2026-06-11T16:00:00.000Z'),
          scope: 'week',
        },
      ],
    },
    stats: {
      scannedThreads: 1,
      trackedThreads: 0,
      needsReply: 1,
      replyOwed: 1,
      dueSoon: 0,
      bulkTailCount: 0,
      unread: 1,
    },
  };
}
