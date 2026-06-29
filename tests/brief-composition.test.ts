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
