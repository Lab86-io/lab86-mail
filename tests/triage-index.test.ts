import { describe, expect, test } from 'bun:test';
import { buildTriageHandoffIndex, triageHandoffForMailItem } from '../lib/brief/triage-index';
import { enforceDailyBriefHandoffCoverage } from '../lib/mail/daily-brief-handoff';
import { compositionFromReport } from '../lib/shared/brief-composition';
import type { BriefDocumentV2 } from '../lib/shared/brief-document';
import type { DailyReport, DailyReportItem } from '../lib/shared/types';

const NOW = Date.parse('2026-07-24T12:00:00Z');

describe('canonical SBAR triage index', () => {
  test('adapts every active source and merges only explicitly linked items', () => {
    const handoffs = buildTriageHandoffIndex(reportFixture());

    expect(handoffs).toHaveLength(4);

    const linkedMailTask = handoffs.find((handoff) =>
      handoff.items.some((item) => item.sourceKey === 'task:task-1'),
    );
    expect(linkedMailTask).toMatchObject({
      kind: 'composite',
      source: 'multi',
      protected: true,
      priority: 'critical',
    });
    expect(linkedMailTask?.items.map((item) => item.sourceKey).sort()).toEqual([
      'mail:jakob@example.com:thread-1',
      'task:task-1',
    ]);
    expect(linkedMailTask?.actions.map((action) => action.action)).toContain('open_thread');
    expect(linkedMailTask?.actions.map((action) => action.action)).toContain('toggle_task');

    const areaWork = handoffs.find((handoff) =>
      handoff.items.some((item) => item.sourceKey === 'work:project:project-1'),
    );
    expect(areaWork?.kind).toBe('composite');
    expect(areaWork?.items.map((item) => item.sourceKey).sort()).toEqual([
      'area:area-lab86',
      'work:project:project-1',
    ]);

    const calendar = handoffs.find((handoff) => handoff.kind === 'event');
    expect(calendar).toMatchObject({ source: 'calendar', protected: true, status: 'scheduled' });

    const connected = handoffs.find((handoff) => handoff.kind === 'connected');
    expect(connected?.actions).toEqual([
      {
        action: 'open_url',
        label: 'Open in Github',
        payload: { url: 'https://github.com/lab86/mail/pull/86' },
        style: 'primary',
      },
    ]);
  });

  test('deduplicates one source across lanes without losing richer lifecycle actions', () => {
    const handoffs = buildTriageHandoffIndex(reportFixture());
    const mailTask = handoffs.find((handoff) =>
      handoff.items.some((item) => item.sourceKey === 'mail:jakob@example.com:thread-1'),
    );

    expect(
      mailTask?.items.filter((item) => item.sourceKey === 'mail:jakob@example.com:thread-1'),
    ).toHaveLength(1);
    expect(mailTask?.actions.filter((action) => action.action === 'resolve_thread')).toHaveLength(1);
    expect(
      mailTask?.actions.find((action) => action.action === 'resolve_thread')?.payload.trackedThreadId,
    ).toBe('tracked-1');
  });

  test('clamps the fully composed mail situation so long names and subjects survive parsing', () => {
    const handoff = triageHandoffForMailItem(
      {
        ...threadItem(),
        people: ['M'.repeat(250)],
        subject: 'S'.repeat(400),
      },
      'reply_owed',
      NOW,
    );

    expect(handoff.situation).toStartWith(`${'M'.repeat(250)} · `);
    expect(handoff.situation).toHaveLength(500);
  });

  test('makes deterministic and model-authored briefs project the same merged index', () => {
    const report = reportFixture();
    report.handoffs = buildTriageHandoffIndex(report);

    const composition = compositionFromReport(report);
    expect(composition.blocks.map((block) => block.type)).toEqual(['lede', 'handoff_digest']);
    const digest = composition.blocks.find((block) => block.type === 'handoff_digest');
    expect(digest?.items).toHaveLength(4);
    expect(digest?.items.find((item) => item.sourceRefs.length > 1)?.recommendations).toHaveLength(2);

    const repaired = enforceDailyBriefHandoffCoverage(emptyDocument(), report);
    const entityRegion = repaired.regions.find((region) => region.id === 'needs-you-required');
    expect(entityRegion?.tree.kind).toBe('group');
    if (!entityRegion || entityRegion.tree.kind !== 'group') {
      throw new Error('Expected required handoff group');
    }
    const entityList = entityRegion.tree.children.find((node) => node.kind === 'entity_list');
    expect(entityList?.kind).toBe('entity_list');
    if (!entityList || entityList.kind !== 'entity_list') {
      throw new Error('Expected handoff entity list');
    }
    expect(entityList.items).toHaveLength(3);
    expect(
      entityList.items.some(
        (item) => item.handoff?.itemCount === 2 && item.handoff.recommendations.length === 2,
      ),
    ).toBe(true);
  });

  test('never turns a non-HTTPS connected URL into an executable brief action', () => {
    const report = reportFixture();
    if (report.sections.mcp?.[0]) {
      report.sections.mcp[0].url = 'http://github.example.test/pull/86';
    }
    const connected = buildTriageHandoffIndex(report).find((handoff) => handoff.kind === 'connected');
    expect(connected?.actions).toEqual([]);
  });

  test('retains only exact connected and work navigation proposals', () => {
    const report = reportFixture();
    report.handoffs = buildTriageHandoffIndex(report);
    const connected = report.handoffs.find((handoff) => handoff.kind === 'connected');
    const areaWork = report.handoffs.find((handoff) =>
      handoff.items.some((item) => item.sourceKey === 'work:project:project-1'),
    );
    if (!connected || !areaWork) throw new Error('Expected connected and work handoffs');
    const document: BriefDocumentV2 = {
      ...emptyDocument(),
      regions: [
        {
          id: 'authored',
          summary: 'Authored actions',
          tree: {
            kind: 'entity_list',
            emphasis: 'standard',
            tone: 'neutral',
            variant: 'rows',
            items: [
              {
                ref: connected.primaryRef,
                framing: {},
                actions: [
                  {
                    action: 'open_url',
                    label: 'Exact connected URL',
                    payload: { url: 'https://github.com/lab86/mail/pull/86' },
                    style: 'primary',
                  },
                  {
                    action: 'open_url',
                    label: 'Different URL',
                    payload: { url: 'https://example.test/not-grounded' },
                    style: 'primary',
                  },
                  {
                    action: 'open_url',
                    label: 'Insecure URL',
                    payload: { url: 'http://github.com/lab86/mail/pull/86' },
                    style: 'primary',
                  },
                ],
              },
              {
                ref: areaWork.items.find((item) => item.ref.kind === 'work')!.ref,
                framing: {},
                actions: [
                  {
                    action: 'open_work',
                    label: 'Exact work',
                    payload: { workId: 'project-1', areaId: 'area-lab86' },
                    style: 'primary',
                  },
                  {
                    action: 'open_work',
                    label: 'Wrong work',
                    payload: { workId: 'project-other', areaId: 'area-lab86' },
                    style: 'primary',
                  },
                ],
              },
            ],
          },
        },
      ],
    };

    const repaired = enforceDailyBriefHandoffCoverage(document, report);
    const json = JSON.stringify(repaired);
    expect(json.match(/https:\/\/github\.com\/lab86\/mail\/pull\/86/g)).toHaveLength(1);
    expect(json).not.toContain('not-grounded');
    expect(json).not.toContain('http://github.com');
    expect(json.match(/"workId":"project-1"/g)).toHaveLength(1);
    expect(json).not.toContain('project-other');
  });

  test('paginates a busy deterministic fallback without dropping indexed handoffs', () => {
    const report = reportFixture();
    const seed = buildTriageHandoffIndex(report)[0];
    report.handoffs = Array.from({ length: 25 }, (_, index) => ({
      ...seed,
      id: `triage-busy-${index}`,
      sourceKey: `busy:${index}`,
      primaryRef: { kind: 'task' as const, id: `task-${index}`, label: `Task ${index}` },
      relatedRefs: [],
      items: [
        {
          ...seed.items[0],
          sourceKey: `busy:${index}`,
          ref: { kind: 'task' as const, id: `task-${index}`, label: `Task ${index}` },
        },
      ],
    }));

    const digestBlocks = compositionFromReport(report).blocks.filter(
      (block) => block.type === 'handoff_digest',
    );
    expect(digestBlocks).toHaveLength(2);
    expect(digestBlocks.map((block) => block.items.length)).toEqual([20, 5]);

    const repaired = enforceDailyBriefHandoffCoverage(emptyDocument(), report);
    const required = repaired.regions.find((region) => region.id === 'needs-you-required');
    if (!required || required.tree.kind !== 'group') {
      throw new Error('Expected paginated required handoffs');
    }
    const counts = required.tree.children.flatMap((node) =>
      node.kind === 'entity_list' ? [node.items.length] : [],
    );
    expect(counts).toEqual([24, 1]);
  });
});

function emptyDocument(): BriefDocumentV2 {
  return {
    version: 2,
    title: 'Daily Brief',
    summary: 'Summary',
    generatedAt: NOW,
    regions: [
      {
        id: 'lead',
        summary: 'Lead',
        tree: {
          kind: 'text',
          emphasis: 'standard',
          tone: 'neutral',
          role: 'lede',
          text: 'Start here.',
        },
      },
    ],
  };
}

function reportFixture(): DailyReport {
  const thread = threadItem();
  return {
    _id: 'report-triage',
    kind: 'morning',
    generatedAt: NOW,
    accounts: ['jakob@example.com'],
    title: 'Morning Daily Report',
    narrative: 'A linked day.',
    sections: {
      replyOwed: [thread],
      followUpOwed: [],
      newPeople: [],
      timeSensitive: [],
      tracked: [{ ...thread, trackedThreadId: 'tracked-1', surfacedBecause: ['tracked'] }],
      fyi: [],
      bulkTail: [],
      tasks: [
        {
          cardId: 'task-1',
          boardId: 'board-1',
          columnId: 'today',
          title: 'Confirm launch date',
          dueAt: NOW - 60_000,
          sourceThreadId: 'thread-1',
          sourceAccountId: 'jakob@example.com',
          scope: 'week',
        },
      ],
      calendar: [
        {
          account: 'jakob@example.com',
          eventId: 'event-1',
          title: 'Launch review',
          startAt: NOW + 3_600_000,
          endAt: NOW + 7_200_000,
          scope: 'week',
        },
      ],
      mcp: [
        {
          server: 'github',
          externalId: 'pull-86',
          kind: 'pull request',
          title: 'Review SBAR index',
          state: 'open',
          url: 'https://github.com/lab86/mail/pull/86',
        },
      ],
      albatross: {
        includedAreas: [],
        askBeforeCentering: [
          {
            areaId: 'area-lab86',
            name: 'Lab86',
            prompt: 'Should Lab86 take the focus block?',
          },
        ],
        activeIntents: [],
        activeProjects: [
          {
            id: 'project-1',
            title: 'Ship action-first briefs',
            areaId: 'area-lab86',
            status: 'active',
          },
        ],
        contextReview: [],
        completions: [],
      },
    },
    stats: {
      scannedThreads: 1,
      trackedThreads: 1,
      needsReply: 1,
      replyOwed: 1,
      dueSoon: 0,
      bulkTailCount: 0,
      unread: 0,
    },
  };
}

function threadItem(): DailyReportItem {
  return {
    account: 'jakob@example.com',
    threadId: 'thread-1',
    subject: 'July launch',
    people: ['Maya'],
    whyItMatters: 'The launch date is still open.',
    nextAction: 'Confirm the July 31 launch date with Maya.',
    openLoops: ['Launch date'],
    surfacedBecause: ['reply_owed'],
    lane: 'reply_owed',
    receivedAt: NOW - 86_400_000,
    unread: false,
  };
}
