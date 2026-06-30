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
