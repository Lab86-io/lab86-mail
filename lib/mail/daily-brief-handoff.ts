import { buildTriageHandoffIndex, triageHandoffForMailItem } from '../brief/triage-index';
import type {
  BriefActionV2,
  BriefDocumentV2,
  BriefEntityHandoffV1,
  BriefNode,
  BriefRegion,
  BriefSourceRefV2,
} from '../shared/brief-document';
import { parseTriageHandoffs, type TriageHandoffV1 } from '../shared/triage-handoff';
import type { DailyReport, DailyReportItem } from '../shared/types';

export function handoffForReportItem(item: DailyReportItem, generatedAt: number): BriefEntityHandoffV1 {
  const lane =
    item.lane === 'follow_up_owed'
      ? 'follow_up_owed'
      : item.trackedThreadId || item.lane === 'tracked'
        ? 'tracked'
        : 'reply_owed';
  return briefHandoffForTriage(triageHandoffForMailItem(item, lane, generatedAt));
}

export function briefHandoffForTriage(record: TriageHandoffV1): BriefEntityHandoffV1 {
  const recommendations = uniqueBy(
    record.items.map((item) => ({ label: item.recommendation, ref: item.ref })),
    (item) => `${item.label}:${refKey(item.ref)}`,
  ).slice(0, 4);
  return {
    handoffId: record.id,
    itemCount: record.items.length,
    situation: record.situation,
    background: record.background,
    assessment: record.assessment,
    recommendation: record.recommendation,
    recommendations: recommendations.length > 1 ? recommendations : [],
    evidence: record.evidence,
  };
}

export function enforceDailyBriefHandoffCoverage(
  document: BriefDocumentV2,
  report: DailyReport,
): BriefDocumentV2 {
  const index = canonicalIndex(report);
  if (!index.length) return document;

  const seen = new Set<string>();
  const regions = document.regions.map((region) => ({
    ...region,
    tree: patchNode(region.tree, index, seen),
  }));
  const missing = index.filter((record) => record.protected && !seen.has(record.id));

  if (missing.length) {
    const needsYou = deterministicNeedsYouRegion(missing);
    if (regions.length < 12) regions.push(needsYou);
    else regions[regions.length - 1] = needsYou;
  }

  return { ...document, regions };
}

function patchNode(node: BriefNode, index: TriageHandoffV1[], seen: Set<string>): BriefNode {
  if ('children' in node) {
    return {
      ...node,
      children: node.children.map((child) => patchNode(child, index, seen)),
    } as BriefNode;
  }
  if (node.kind !== 'entity_list') return node;

  return {
    ...node,
    items: node.items.flatMap((entity) => {
      const matches = matchingRecords(index, entity.ref);
      // An under-specified ref is unsafe when it can mean more than one
      // indexed source. Protected records are restored with exact refs below.
      if (matches.length > 1) return [];
      const record = matches[0];
      if (!record) return [entity];
      if (seen.has(record.id)) return [];
      seen.add(record.id);
      const handoff = briefHandoffForTriage(record);
      return [
        {
          ...entity,
          ref: record.primaryRef,
          framing: {
            ...entity.framing,
            lane: record.lane,
            reason: handoff.assessment,
            prep: handoff.recommendation,
          },
          // The indexed SBAR is authoritative. The model chooses placement and
          // editorial form, but cannot silently rewrite evidence or next moves.
          handoff,
          actions: repairedActions(entity.actions, record),
        },
      ];
    }),
  };
}

function repairedActions(authored: BriefActionV2[], record: TriageHandoffV1): BriefActionV2[] {
  const proposals = authored.filter((action) => validProposal(action, record));
  return uniqueBy(
    [...record.actions, ...proposals],
    (action) => `${action.action}:${JSON.stringify(action.payload)}`,
  ).slice(0, 8);
}

function validProposal(action: BriefActionV2, record: TriageHandoffV1): boolean {
  if (action.action === 'create_task') {
    return typeof action.payload.title === 'string' && action.payload.title.trim().length > 0;
  }
  if (action.action === 'draft_reply') {
    return (
      typeof action.payload.body === 'string' &&
      action.payload.body.trim().length > 0 &&
      record.items.some(
        (item) =>
          item.ref.kind === 'thread' &&
          action.payload.account === item.ref.account &&
          action.payload.threadId === item.ref.id,
      )
    );
  }
  if (action.action === 'rsvp_event') {
    return (
      typeof action.payload.calendarId === 'string' &&
      action.payload.calendarId.length > 0 &&
      ['yes', 'no', 'maybe'].includes(String(action.payload.status)) &&
      record.items.some(
        (item) =>
          item.ref.kind === 'event' &&
          action.payload.account === item.ref.account &&
          action.payload.eventId === item.ref.id,
      )
    );
  }
  return false;
}

function deterministicNeedsYouRegion(records: TriageHandoffV1[]): BriefRegion {
  return {
    id: 'needs-you-required',
    intent: 'Protected, source-grounded handoffs that cannot be omitted.',
    summary: `${records.length} protected ${
      records.length === 1 ? 'handoff needs' : 'handoffs need'
    } your attention.`,
    tree: {
      kind: 'group',
      emphasis: 'primary',
      tone: 'urgent',
      title: 'Needs you',
      kicker: 'Required follow-through',
      surface: 'elevated',
      collapsible: false,
      children: chunks(records, 24).map((batch, index) => ({
        kind: 'entity_list',
        emphasis: 'primary',
        tone: 'urgent',
        title: index === 0 ? 'Action handoffs' : 'More action handoffs',
        variant: 'rows',
        items: batch.map((record) => {
          const handoff = briefHandoffForTriage(record);
          return {
            ref: record.primaryRef,
            framing: {
              lane: record.lane,
              reason: handoff.assessment,
              prep: handoff.recommendation,
            },
            handoff,
            actions: record.actions,
          };
        }),
      })),
    },
  };
}

function canonicalIndex(report: DailyReport): TriageHandoffV1[] {
  const stored = parseTriageHandoffs(report.handoffs);
  return stored.length ? stored : buildTriageHandoffIndex(report);
}

function matchingRecords(index: TriageHandoffV1[], ref: BriefSourceRefV2): TriageHandoffV1[] {
  const exact = index.filter((record) =>
    [record.primaryRef, ...record.relatedRefs, ...record.items.map((item) => item.ref)].some(
      (candidate) => refKey(candidate) === refKey(ref),
    ),
  );
  if (exact.length || ref.account) return uniqueBy(exact, (record) => record.id);
  return uniqueBy(
    index.filter((record) =>
      [record.primaryRef, ...record.relatedRefs, ...record.items.map((item) => item.ref)].some(
        (candidate) => candidate.kind === ref.kind && candidate.id === ref.id,
      ),
    ),
    (record) => record.id,
  );
}

function refKey(ref: BriefSourceRefV2): string {
  return JSON.stringify([ref.kind, (ref.account || '').toLowerCase(), ref.id]);
}

function uniqueBy<T>(values: T[], key: (value: T) => string): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const candidate = key(value);
    if (seen.has(candidate)) return false;
    seen.add(candidate);
    return true;
  });
}

function chunks<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}
