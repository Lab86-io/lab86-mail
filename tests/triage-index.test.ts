import { describe, expect, test } from 'bun:test';
import {
  buildTriageHandoffIndex,
  triageHandoffForMailItem,
  withDocumentSuggestion,
} from '../lib/brief/triage-index';
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

  test('groups Xcode Cloud build updates into one source-preserving episode', () => {
    const report = reportFixture();
    report.sections.mcp = Array.from({ length: 4 }, (_, index) => ({
      server: 'github' as const,
      externalId: `xcode-build-${index + 1}`,
      kind: 'Xcode Cloud build',
      title: `Xcode Cloud build ${index + 1} ${index === 3 ? 'succeeded' : 'completed'}`,
      state: index === 3 ? 'succeeded' : 'completed',
      url: `https://example.test/builds/${index + 1}`,
    }));

    const builds = buildTriageHandoffIndex(report).filter((handoff) =>
      handoff.items.some((item) => item.sourceKey.includes('xcode-build-')),
    );
    expect(builds).toHaveLength(1);
    expect(builds[0]?.items).toHaveLength(4);
    expect(builds[0]?.relatedRefs).toHaveLength(3);
    expect(builds[0]?.actions).toHaveLength(4);
  });

  test.each([
    {
      recommendation: 'Draft a launch memo for the review.',
      kind: 'doc',
      label: 'Create document',
      titleWord: 'document',
    },
    {
      recommendation: 'Build a budget forecast spreadsheet for the review.',
      kind: 'sheet',
      label: 'Create spreadsheet',
      titleWord: 'spreadsheet',
    },
    {
      recommendation: 'Prepare a presentation deck for the review.',
      kind: 'deck',
      label: 'Create presentation',
      titleWord: 'presentation',
    },
  ] as const)('adds a grounded $kind creation move to a deliverable handoff', ({
    recommendation,
    kind,
    label,
    titleWord,
  }) => {
    const report = reportFixture();
    report.sections.replyOwed[0].nextAction = recommendation;
    report.sections.tracked = [];
    const handoff = buildTriageHandoffIndex(report).find((record) =>
      record.items.some((item) => item.sourceKey === 'mail:jakob@example.com:thread-1'),
    );
    const action = handoff?.actions.find((entry) => entry.action === 'create_document');

    expect(action).toMatchObject({
      action: 'create_document',
      label,
      payload: {
        kind,
        instructions: expect.stringContaining(recommendation),
        sourceContext: expect.stringContaining('Recommendation:'),
        sourceRefs: expect.arrayContaining([expect.objectContaining({ kind: 'thread', id: 'thread-1' })]),
      },
      style: 'primary',
    });
    expect(action?.payload.title).toContain(titleWord);
  });

  test('requires explicit creation language and prioritizes creation in a full action list', () => {
    const base = triageHandoffForMailItem(threadItem(), 'reply_owed', NOW);
    const usageOnly = withDocumentSuggestion({
      ...base,
      recommendation: 'Send the report to the review group.',
      assessment: 'The existing report is ready to share.',
    });
    expect(usageOnly.actions.some((action) => action.action === 'create_document')).toBe(false);
    const existingFinancialModel = withDocumentSuggestion({
      ...base,
      recommendation: 'Share the financial model with the review group.',
      assessment: 'The existing workbook is ready to use.',
    });
    expect(existingFinancialModel.actions.some((action) => action.action === 'create_document')).toBe(false);

    const full = withDocumentSuggestion({
      ...base,
      recommendation: 'Draft a launch memo for the review group.',
      assessment: 'A written decision is required.',
      actions: Array.from({ length: 8 }, (_, index) => ({
        action: 'open_url' as const,
        label: `Open source ${index + 1}`,
        payload: { url: `https://example.test/source/${index + 1}` },
        style: 'secondary' as const,
      })),
    });
    expect(full.actions).toHaveLength(8);
    expect(full.actions[0]).toMatchObject({
      action: 'create_document',
      payload: { kind: 'doc' },
    });
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
