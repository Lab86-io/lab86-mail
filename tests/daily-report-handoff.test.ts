import { describe, expect, test } from 'bun:test';
import { enforceDailyBriefHandoffCoverage, handoffForReportItem } from '../lib/mail/daily-brief-handoff';
import {
  deterministicRecommendation,
  isActionableReportItem,
  normalizeRecommendation,
  recommendationFor,
} from '../lib/mail/thread-handoff';
import type { BriefDocumentV2, BriefNode } from '../lib/shared/brief-document';
import type { DailyReport, DailyReportItem } from '../lib/shared/types';

describe('Daily Brief handoff recommendations', () => {
  test('rejects generic lane labels while retaining specific recommendations', () => {
    expect(normalizeRecommendation('Reply')).toBeUndefined();
    expect(normalizeRecommendation(' Follow-up. ')).toBeUndefined();
    expect(normalizeRecommendation('Confirm the July 31 delivery date.')).toBe(
      'Confirm the July 31 delivery date.',
    );
  });

  test('builds a person and subject-aware reply fallback', () => {
    expect(
      deterministicRecommendation({
        lane: 'reply_owed',
        people: ['Maya Chen <maya@example.com>'],
        subject: 'Re: July launch',
        openLoops: ['Reply owed'],
      }),
    ).toBe('Reply to Maya Chen about “July launch”.');
  });

  test('uses a real open loop in follow-up and tracked fallbacks', () => {
    expect(
      deterministicRecommendation({
        lane: 'follow_up_owed',
        people: ['Ben'],
        subject: 'Agreement',
        openLoops: ['Unsigned agreement'],
      }),
    ).toBe('Follow up with Ben about “Agreement”; ask about Unsigned agreement.');
    expect(
      recommendationFor({
        candidate: 'Review',
        lane: 'tracked',
        people: ['Ari'],
        subject: 'Launch sequence',
        openLoops: ['Name the blocking dependency'],
      }),
    ).toBe('Review “Launch sequence” with Ari and close the loop on Name the blocking dependency.');
  });

  test('does not manufacture recommendations for non-actionable lanes', () => {
    expect(deterministicRecommendation({ lane: 'fyi', subject: 'Newsletter' })).toBeUndefined();
    expect(isActionableReportItem({ lane: 'fyi' })).toBe(false);
    expect(isActionableReportItem({ lane: 'fyi', trackedThreadId: 'tracked-1' })).toBe(true);
  });

  test('builds a bounded evidence-backed handoff from canonical report data', () => {
    const handoff = handoffForReportItem(replyItem(), Date.parse('2026-07-24T12:00:00Z'));
    expect(handoff).toEqual({
      handoffId: expect.any(String),
      itemCount: 1,
      situation: 'Maya · July launch',
      background: ['Confirm delivery date'],
      assessment: 'Maya needs the delivery date before planning can continue.',
      recommendation: 'Confirm the July 31 delivery date.',
      recommendations: [],
      evidence: [
        {
          label: 'Source conversation',
          ref: { kind: 'thread', id: 'thread-1', account: 'jakob@example.com', label: 'July launch' },
        },
        { label: 'The newest message is inbound and still needs a response.' },
        { label: 'The provider marked this conversation important.' },
        { label: 'The latest message arrived 3 days ago.' },
      ],
    });
  });

  test('appends omitted protected threads and repairs unsafe actions deterministically', () => {
    const report = reportWithProtectedThreads();
    const repaired = enforceDailyBriefHandoffCoverage(emptyDocument(), report);
    const entities = entityItems(repaired);

    expect(entities).toHaveLength(2);
    expect(entities.map((item) => item.ref.id)).toEqual(['thread-1', 'thread-2']);
    expect(entities.every((item) => item.handoff?.recommendation)).toBe(true);
    expect(entities.every((item) => item.actions.some((action) => action.action === 'open_thread'))).toBe(
      true,
    );
  });

  test('deduplicates protected refs and discards mismatched or empty draft actions', () => {
    const report = reportWithProtectedThreads();
    const item = replyItem();
    const authored = entityListNode([
      protectedEntity(item, [
        {
          action: 'draft_reply',
          label: 'Bad draft',
          payload: { account: item.account, threadId: item.threadId, body: '' },
          style: 'primary',
        },
        {
          action: 'open_thread',
          label: 'Wrong thread',
          payload: { account: item.account, threadId: 'other-thread' },
          style: 'quiet',
        },
      ]),
      {
        ...protectedEntity(item, []),
        ref: { kind: 'thread' as const, id: item.threadId, label: item.subject },
      },
    ]);
    const document: BriefDocumentV2 = {
      ...emptyDocument(),
      regions: [{ id: 'authored', summary: 'Authored', tree: authored }],
    };
    const repaired = enforceDailyBriefHandoffCoverage(document, report);
    const entities = entityItems(repaired);
    const maya = entities.filter((entity) => entity.ref.id === item.threadId);

    expect(maya).toHaveLength(1);
    expect(maya[0].actions.map((action) => action.action)).toEqual([
      'open_thread',
      'resolve_thread',
      'dismiss_thread',
    ]);
    expect(maya[0].actions.some((action) => action.action === 'draft_reply')).toBe(false);
    expect(
      maya[0].actions.every(
        (action) =>
          !['open_thread', 'resolve_thread', 'dismiss_thread'].includes(action.action) ||
          action.payload.threadId === item.threadId,
      ),
    ).toBe(true);
  });

  test('keeps an ambiguous unqualified entity unchanged and restores exact protected handoffs', () => {
    const first = replyItem();
    const second = { ...replyItem(), account: 'other@example.com' };
    const report = reportWithProtectedThreads();
    report.sections.replyOwed = [first, second];
    report.sections.tracked = [];
    const ambiguous = {
      ref: { kind: 'thread' as const, id: first.threadId, label: first.subject },
      framing: { reason: 'Authored without an account.' },
      actions: [],
    };
    const document: BriefDocumentV2 = {
      ...emptyDocument(),
      regions: [{ id: 'authored', summary: 'Authored', tree: entityListNode([ambiguous as any]) }],
    };

    const entities = entityItems(enforceDailyBriefHandoffCoverage(document, report));
    expect(entities).toHaveLength(3);
    expect(entities[0]).toEqual(ambiguous);
    expect(
      entities
        .filter((entity) => entity.handoff)
        .map((entity) => entity.ref.account)
        .sort(),
    ).toEqual(['jakob@example.com', 'other@example.com']);
  });

  test('uses an account-qualified ref for one exact handoff without duplicating it', () => {
    const first = replyItem();
    const second = { ...replyItem(), account: 'other@example.com' };
    const report = reportWithProtectedThreads();
    report.sections.replyOwed = [first, second];
    report.sections.tracked = [];
    const document: BriefDocumentV2 = {
      ...emptyDocument(),
      regions: [
        {
          id: 'authored',
          summary: 'Authored',
          tree: entityListNode([protectedEntity(first, [])]),
        },
      ],
    };

    const entities = entityItems(enforceDailyBriefHandoffCoverage(document, report));
    expect(entities).toHaveLength(2);
    expect(entities.filter((entity) => entity.ref.account === first.account)).toHaveLength(1);
    expect(entities.filter((entity) => entity.ref.account === second.account)).toHaveLength(1);
  });

  test('keeps existing final-region content when protected coverage fills a capped document', () => {
    const document: BriefDocumentV2 = {
      ...emptyDocument(),
      regions: Array.from({ length: 12 }, (_, index) => ({
        id: `region-${index}`,
        summary: `Original summary ${index}`,
        tree: {
          kind: 'text' as const,
          emphasis: 'standard' as const,
          tone: 'neutral' as const,
          role: 'body' as const,
          text: `Original content ${index}`,
        },
      })),
    };

    const repaired = enforceDailyBriefHandoffCoverage(document, reportWithProtectedThreads());
    expect(repaired.regions).toHaveLength(12);
    expect(JSON.stringify(repaired.regions[11].tree)).toContain('Original content 11');
    expect(JSON.stringify(repaired.regions[11].tree)).toContain('Required follow-through');
    expect(repaired.regions[11].summary).toContain('Original summary 11');
    expect(entityItems(repaired)).toHaveLength(2);
  });

  test('accepts only grounded review-gated drafts and returns an unchanged document without an index', () => {
    const report = reportWithProtectedThreads();
    const item = replyItem();
    const document: BriefDocumentV2 = {
      ...emptyDocument(),
      regions: [
        {
          id: 'authored',
          summary: 'Authored',
          tree: entityListNode([
            protectedEntity(item, [
              {
                action: 'draft_reply',
                label: 'Review draft',
                payload: {
                  account: item.account,
                  threadId: item.threadId,
                  body: 'July 31 works on my side.',
                },
                style: 'primary',
              },
              {
                action: 'draft_reply',
                label: 'Wrong account',
                payload: {
                  account: 'wrong@example.com',
                  threadId: item.threadId,
                  body: 'Unsafe.',
                },
                style: 'primary',
              },
            ]),
          ]),
        },
      ],
    };

    const repaired = enforceDailyBriefHandoffCoverage(document, report);
    const drafts = entityItems(repaired)
      .find((entity) => entity.ref.id === item.threadId)
      ?.actions.filter((action: any) => action.action === 'draft_reply');
    expect(drafts).toHaveLength(1);
    expect(drafts[0].payload.body).toBe('July 31 works on my side.');

    const emptyReport = reportWithProtectedThreads();
    emptyReport.sections.replyOwed = [];
    emptyReport.sections.tracked = [];
    const untouched = emptyDocument();
    expect(enforceDailyBriefHandoffCoverage(untouched, emptyReport)).toBe(untouched);
  });
});

function replyItem(): DailyReportItem {
  return {
    account: 'jakob@example.com',
    threadId: 'thread-1',
    subject: 'July launch',
    people: ['Maya'],
    whyItMatters: 'Maya needs the delivery date before planning can continue.',
    nextAction: 'Confirm the July 31 delivery date.',
    openLoops: ['Confirm delivery date'],
    surfacedBecause: ['reply_owed', 'important'],
    lane: 'reply_owed',
    receivedAt: Date.parse('2026-07-21T12:00:00Z'),
    unread: false,
  };
}

function trackedItem(): DailyReportItem {
  return {
    account: 'jakob@example.com',
    threadId: 'thread-2',
    subject: 'Partner agreement',
    people: ['Ben'],
    whyItMatters: 'The agreement is still unsigned.',
    nextAction: 'Ask Ben whether legal has approved the agreement.',
    openLoops: ['Legal approval'],
    surfacedBecause: ['tracked'],
    lane: 'tracked',
    trackedThreadId: 'tracked-2',
    unread: false,
  };
}

function reportWithProtectedThreads(): DailyReport {
  const reply = replyItem();
  return {
    _id: 'report-1',
    kind: 'morning',
    generatedAt: Date.parse('2026-07-24T12:00:00Z'),
    accounts: ['jakob@example.com'],
    title: 'Morning Daily Report',
    narrative: 'Two conversations need attention.',
    sections: {
      replyOwed: [reply],
      followUpOwed: [],
      newPeople: [],
      timeSensitive: [],
      tracked: [trackedItem(), { ...reply, trackedThreadId: 'tracked-1' }],
      fyi: [],
      bulkTail: [],
    },
    stats: {
      scannedThreads: 2,
      trackedThreads: 2,
      needsReply: 1,
      replyOwed: 1,
      dueSoon: 0,
      bulkTailCount: 0,
      unread: 0,
    },
  };
}

function emptyDocument(): BriefDocumentV2 {
  return {
    version: 2,
    title: 'Daily Brief',
    summary: 'Summary',
    generatedAt: Date.parse('2026-07-24T12:00:00Z'),
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

function protectedEntity(item: DailyReportItem, actions: any[]) {
  return {
    ref: { kind: 'thread' as const, id: item.threadId, account: item.account, label: item.subject },
    framing: { lane: item.lane, reason: item.whyItMatters, prep: item.nextAction },
    actions,
  };
}

function entityListNode(items: ReturnType<typeof protectedEntity>[]): BriefNode {
  return {
    kind: 'entity_list',
    emphasis: 'standard',
    tone: 'neutral',
    variant: 'rows',
    items,
  };
}

function entityItems(document: BriefDocumentV2): any[] {
  const output: any[] = [];
  const visit = (node: BriefNode) => {
    if (node.kind === 'entity_list') output.push(...node.items);
    if ('children' in node) node.children.forEach(visit);
  };
  for (const region of document.regions) visit(region.tree);
  return output;
}
