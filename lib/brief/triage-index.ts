import { recommendationFor } from '../mail/thread-handoff';
import type { BriefActionV2, BriefSourceRefV2 } from '../shared/brief-document';
import { parseTriageHandoffs, type TriageHandoffV1 } from '../shared/triage-handoff';
import type {
  DailyReport,
  DailyReportCalendarItem,
  DailyReportItem,
  DailyReportMcpItem,
  DailyReportTaskItem,
} from '../shared/types';

type AtomicHandoff = TriageHandoffV1 & { mergeKeys: string[] };

const PRIORITY_SCORE: Record<TriageHandoffV1['priority'], number> = {
  critical: 4,
  high: 3,
  normal: 2,
  low: 1,
};

const LANE_SCORE: Record<TriageHandoffV1['lane'], number> = {
  needs_you: 5,
  waiting: 4,
  upcoming: 3,
  focus: 2,
  context: 1,
};

const PROVENANCE_LABELS: Record<string, string> = {
  reply_owed: 'The newest message is inbound and still needs a response.',
  follow_up_owed: 'You sent the latest message and are still waiting for a response.',
  category_personal: 'The provider classified this as a personal conversation.',
  important: 'The provider marked this conversation important.',
  new_sender: 'This is a new sender.',
  known_contact: 'You have corresponded with this person before.',
  due_soon: 'This conversation contains a near-term commitment.',
  tracked: 'You are tracking this conversation until it is resolved.',
};

export function buildTriageHandoffIndex(report: DailyReport): TriageHandoffV1[] {
  const generatedAt = report.generatedAt || Date.now();
  const records: AtomicHandoff[] = [
    ...mailHandoffs(report, generatedAt),
    ...(report.sections.tasks || []).flatMap((task) =>
      task.completedAt ? [] : [taskHandoff(task, generatedAt)],
    ),
    ...(report.sections.calendar || []).flatMap((event) =>
      event.endAt < generatedAt ? [] : [eventHandoff(event, generatedAt)],
    ),
    ...areaAndWorkHandoffs(report, generatedAt),
    ...(report.sections.mcp || []).map((item) => connectedHandoff(item, generatedAt)),
  ];
  return parseTriageHandoffs(mergeRelatedHandoffs(records).sort(compareHandoffs).slice(0, 96));
}

export function triageHandoffForMailItem(
  item: DailyReportItem,
  lane: 'reply_owed' | 'follow_up_owed' | 'tracked' | 'time_sensitive' | 'new_person',
  generatedAt: number,
): TriageHandoffV1 {
  const ref = threadRef(item);
  const person = clean(item.people?.[0]);
  const subject = clean(item.subject) || 'Untitled conversation';
  const recommendation =
    recommendationFor({
      candidate: item.nextAction,
      lane: item.lane || (item.trackedThreadId ? 'tracked' : undefined),
      people: item.people,
      subject: item.subject,
      openLoops: item.openLoops,
    }) || `Open “${subject}” and decide the next step.`;
  const protectedRecord = lane === 'reply_owed' || lane === 'follow_up_owed' || lane === 'tracked';
  const situation = person ? `${person} · ${subject}` : subject;
  const assessment =
    clean(item.whyItMatters) || `This conversation is waiting for a decision about ${subject}.`;
  const sourceKey = boundedSourceKey(`mail:${item.account.toLowerCase()}:${item.threadId}`);
  const evidence = [
    { label: 'Source conversation', ref },
    ...(item.surfacedBecause || []).flatMap((code) => {
      const label = PROVENANCE_LABELS[code];
      return label ? [{ label }] : [];
    }),
  ];
  const timing = timingEvidence(item, generatedAt);
  if (timing) evidence.push({ label: timing });

  return {
    version: 1,
    id: handoffId(sourceKey),
    source: 'mail',
    sourceKey,
    kind: 'conversation',
    lane: lane === 'follow_up_owed' ? 'waiting' : 'needs_you',
    status: lane === 'follow_up_owed' ? 'waiting' : 'open',
    priority: lane === 'reply_owed' || lane === 'time_sensitive' ? 'high' : 'normal',
    protected: protectedRecord,
    situation,
    background: uniqueStrings(item.openLoops || []).slice(0, 3),
    assessment,
    recommendation,
    evidence: uniqueEvidence(evidence).slice(0, 4),
    primaryRef: ref,
    relatedRefs: [],
    items: [
      {
        sourceKey,
        ref,
        situation,
        assessment,
        recommendation,
        dueAt: item.dueAt,
      },
    ],
    actions: [
      {
        action: 'open_thread',
        label: 'Open thread',
        payload: { account: item.account, threadId: item.threadId },
        style: 'primary',
      },
      ...(protectedRecord
        ? ([
            {
              action: 'resolve_thread',
              label: 'Done',
              payload: {
                account: item.account,
                threadId: item.threadId,
                subject: item.subject,
                receivedAt: item.receivedAt ?? null,
                trackedThreadId: item.trackedThreadId,
              },
              style: 'quiet',
            },
            {
              action: 'dismiss_thread',
              label: 'Remove',
              payload: {
                account: item.account,
                threadId: item.threadId,
                subject: item.subject,
                receivedAt: item.receivedAt ?? null,
              },
              style: 'quiet',
            },
          ] satisfies BriefActionV2[])
        : []),
    ],
    dueAt: item.dueAt,
    generatedAt,
  };
}

function mailHandoffs(report: DailyReport, generatedAt: number): AtomicHandoff[] {
  const ordered = [
    ...(report.sections.replyOwed || []).map((item) => [item, 'reply_owed'] as const),
    ...(report.sections.followUpOwed || []).map((item) => [item, 'follow_up_owed'] as const),
    ...(report.sections.tracked || []).map((item) => [item, 'tracked'] as const),
    ...(report.sections.timeSensitive || []).map((item) => [item, 'time_sensitive'] as const),
    ...(report.sections.newPeople || []).map((item) => [item, 'new_person'] as const),
  ];
  return ordered.map(([item, lane]) => {
    const record = triageHandoffForMailItem(item, lane, generatedAt);
    return { ...record, mergeKeys: refMergeKeys(record.primaryRef) };
  });
}

function taskHandoff(task: DailyReportTaskItem, generatedAt: number): AtomicHandoff {
  const ref: BriefSourceRefV2 = { kind: 'task', id: task.cardId, label: clean(task.title) || 'Task' };
  const due = task.dueAt ? timeLabel(task.dueAt) : null;
  const overdue = Boolean(task.dueAt && task.dueAt < generatedAt);
  const dueSoon = Boolean(task.dueAt && task.dueAt <= generatedAt + 86_400_000);
  const situation = clean(task.title) || 'Untitled task';
  const assessment = overdue
    ? `This task is overdue${due ? ` since ${due}` : ''}.`
    : due
      ? `This task is due ${due}.`
      : task.priority === 'high'
        ? 'This task is marked high priority.'
        : clean(task.description) || 'This task is still open.';
  const recommendation = overdue
    ? `Finish “${situation}” now or reset its due date.`
    : due
      ? `Complete “${situation}” by ${due}.`
      : `Choose the next concrete step for “${situation}”.`;
  const relatedRefs = taskRelatedRefs(task);
  const sourceKey = boundedSourceKey(`task:${task.cardId}`);
  const background = uniqueStrings([
    clean(task.description),
    [clean(task.boardTitle), clean(task.columnName)].filter(Boolean).join(' · '),
    task.sourceTitle ? `Linked from ${clean(task.sourceTitle)}.` : '',
  ]).slice(0, 3);
  return {
    version: 1,
    id: handoffId(sourceKey),
    source: 'tasks',
    sourceKey,
    kind: 'task',
    lane: overdue || dueSoon || task.priority === 'high' ? 'needs_you' : 'focus',
    status: 'open',
    priority: overdue ? 'critical' : dueSoon || task.priority === 'high' ? 'high' : 'normal',
    protected: overdue || dueSoon || task.priority === 'high',
    situation,
    background,
    assessment,
    recommendation,
    evidence: uniqueEvidence([
      { label: 'Source task', ref },
      ...(due ? [{ label: `Due ${due}.` }] : []),
      ...(task.priority ? [{ label: `${capitalize(task.priority)} priority.` }] : []),
      ...relatedRefs.map((related) => ({ label: related.label || 'Linked source', ref: related })),
    ]).slice(0, 4),
    primaryRef: ref,
    relatedRefs,
    items: [
      {
        sourceKey,
        ref,
        situation,
        assessment,
        recommendation,
        dueAt: task.dueAt,
      },
    ],
    actions: [
      {
        action: 'toggle_task',
        label: 'Complete',
        payload: { cardId: task.cardId, completed: true, title: task.title },
        style: 'primary',
      },
      {
        action: 'dismiss_task',
        label: 'Remove',
        payload: { cardId: task.cardId, title: task.title },
        style: 'quiet',
      },
    ],
    dueAt: task.dueAt,
    generatedAt,
    mergeKeys: uniqueStrings([...refMergeKeys(ref), ...relatedRefs.flatMap(refMergeKeys)]),
  };
}

function eventHandoff(event: DailyReportCalendarItem, generatedAt: number): AtomicHandoff {
  const ref: BriefSourceRefV2 = {
    kind: 'event',
    id: event.eventId,
    account: event.account,
    label: clean(event.title) || 'Calendar event',
  };
  const situation = clean(event.title) || 'Untitled event';
  const starts = timeLabel(event.startAt);
  const imminent = event.startAt <= generatedAt + 86_400_000;
  const assessment = `${event.allDay ? 'All day' : `Starts ${starts}`}${
    event.location ? ` at ${clean(event.location)}` : ''
  }.`;
  const recommendation = `Prepare for “${situation}” before ${starts}.`;
  const sourceKey = boundedSourceKey(`event:${event.account.toLowerCase()}:${event.eventId}`);
  return {
    version: 1,
    id: handoffId(sourceKey),
    source: 'calendar',
    sourceKey,
    kind: 'event',
    lane: imminent ? 'needs_you' : 'upcoming',
    status: 'scheduled',
    priority: imminent ? 'high' : 'normal',
    protected: imminent,
    situation,
    background: uniqueStrings([clean(event.description), clean(event.location)]).slice(0, 3),
    assessment,
    recommendation,
    evidence: uniqueEvidence([{ label: 'Source event', ref }, { label: `Scheduled for ${starts}.` }]).slice(
      0,
      4,
    ),
    primaryRef: ref,
    relatedRefs: [],
    items: [
      {
        sourceKey,
        ref,
        situation,
        assessment,
        recommendation,
        startsAt: event.startAt,
      },
    ],
    actions: [
      {
        action: 'open_event',
        label: 'Open event',
        payload: { account: event.account, eventId: event.eventId },
        style: 'primary',
      },
    ],
    startsAt: event.startAt,
    generatedAt,
    mergeKeys: refMergeKeys(ref),
  };
}

function areaAndWorkHandoffs(report: DailyReport, generatedAt: number): AtomicHandoff[] {
  const context = report.sections.albatross;
  if (!context) return [];
  const records: AtomicHandoff[] = [];

  for (const area of context.includedAreas || []) {
    records.push(
      areaHandoff({
        areaId: area.areaId,
        name: area.name,
        assessment: area.reason,
        recommendation: `Open ${area.name} and choose the next move for today.`,
        protected: false,
        generatedAt,
      }),
    );
  }
  for (const area of context.askBeforeCentering || []) {
    records.push(
      areaHandoff({
        areaId: area.areaId,
        name: area.name,
        assessment: `${area.name} is asking for permission before it becomes a focus.`,
        recommendation: `Decide: ${clean(area.prompt)}`,
        protected: true,
        generatedAt,
      }),
    );
  }
  for (const intent of context.activeIntents || []) {
    records.push(
      workHandoff({
        id: intent.id,
        title: intent.text,
        areaId: intent.areaId,
        status: intent.status,
        workType: 'intent',
        generatedAt,
      }),
    );
  }
  for (const project of context.activeProjects || []) {
    records.push(
      workHandoff({
        id: project.id,
        title: project.title,
        areaId: project.areaId,
        status: project.status,
        outcome: project.outcome,
        workType: 'project',
        generatedAt,
      }),
    );
  }
  for (const item of context.contextReview || []) {
    records.push(
      workHandoff({
        id: item.id,
        title: item.title,
        areaId: item.areaId,
        status: item.reason,
        workType: 'context',
        generatedAt,
      }),
    );
  }
  return records;
}

function areaHandoff(input: {
  areaId: string;
  name: string;
  assessment: string;
  recommendation: string;
  protected: boolean;
  generatedAt: number;
}): AtomicHandoff {
  const ref: BriefSourceRefV2 = { kind: 'area', id: input.areaId, label: input.name };
  const sourceKey = boundedSourceKey(`area:${input.areaId}`);
  const assessment = clean(input.assessment) || `${input.name} is active in today's context.`;
  const recommendation =
    clean(input.recommendation) || `Open ${input.name} and choose the next move for today.`;
  return {
    version: 1,
    id: handoffId(sourceKey),
    source: 'areas',
    sourceKey,
    kind: 'area',
    lane: input.protected ? 'needs_you' : 'context',
    status: 'open',
    priority: input.protected ? 'high' : 'normal',
    protected: input.protected,
    situation: input.name,
    background: [],
    assessment,
    recommendation,
    evidence: [{ label: 'Source area', ref }],
    primaryRef: ref,
    relatedRefs: [],
    items: [
      {
        sourceKey,
        ref,
        situation: input.name,
        assessment,
        recommendation,
      },
    ],
    actions: [
      {
        action: 'open_area',
        label: 'Open area',
        payload: { areaId: input.areaId },
        style: 'primary',
      },
    ],
    generatedAt: input.generatedAt,
    mergeKeys: refMergeKeys(ref),
  };
}

function workHandoff(input: {
  id: string;
  title: string;
  areaId?: string;
  status?: string;
  outcome?: string;
  workType: 'intent' | 'project' | 'context';
  generatedAt: number;
}): AtomicHandoff {
  const title = clean(input.title) || 'Open work';
  const ref: BriefSourceRefV2 = { kind: 'work', id: input.id, label: title };
  const areaRef: BriefSourceRefV2 | undefined = input.areaId ? { kind: 'area', id: input.areaId } : undefined;
  const sourceKey = boundedSourceKey(`work:${input.workType}:${input.id}`);
  const assessment =
    clean(input.outcome) ||
    (input.status
      ? `${capitalize(input.workType)} status: ${clean(input.status)}.`
      : `This ${input.workType} is active.`);
  const recommendation =
    input.workType === 'context'
      ? `Review “${title}” and place it in the right area.`
      : `Choose the next concrete move for “${title}”.`;
  return {
    version: 1,
    id: handoffId(sourceKey),
    source: 'work',
    sourceKey,
    kind: 'work',
    lane: input.workType === 'context' ? 'needs_you' : 'focus',
    status: 'open',
    priority: input.workType === 'context' ? 'high' : 'normal',
    protected: input.workType === 'context',
    situation: title,
    background: uniqueStrings([clean(input.outcome), clean(input.status)]).slice(0, 3),
    assessment,
    recommendation,
    evidence: uniqueEvidence([
      { label: `Source ${input.workType}`, ref },
      ...(areaRef ? [{ label: 'Related area', ref: areaRef }] : []),
    ]),
    primaryRef: ref,
    relatedRefs: areaRef ? [areaRef] : [],
    items: [{ sourceKey, ref, situation: title, assessment, recommendation }],
    actions: [
      {
        action: 'open_work',
        label: 'Open work',
        payload: { workId: input.id, ...(input.areaId ? { areaId: input.areaId } : {}) },
        style: 'primary',
      },
    ],
    generatedAt: input.generatedAt,
    mergeKeys: uniqueStrings([...refMergeKeys(ref), ...(areaRef ? refMergeKeys(areaRef) : [])]),
  };
}

function connectedHandoff(item: DailyReportMcpItem, generatedAt: number): AtomicHandoff {
  const externalId =
    clean(item.externalId).slice(0, 240) ||
    (item.url ? `url-${stableHash(item.url)}` : stableHash(`${item.server}:${item.title}`));
  const ref: BriefSourceRefV2 = {
    kind: 'mcp',
    id: externalId,
    label: clean(item.title) || 'Connected item',
  };
  const situation = clean(item.title) || 'Connected item';
  const sourceName = capitalize(item.server);
  const assessment = [
    item.state
      ? `${capitalize(clean(item.state))} ${clean(item.kind)} in ${sourceName}.`
      : `${capitalize(clean(item.kind))} in ${sourceName}.`,
    item.author ? `From ${clean(item.author)}.` : '',
  ]
    .filter(Boolean)
    .join(' ');
  const recommendation = `Review “${situation}” in ${sourceName} and decide the next step.`;
  const sourceKey = boundedSourceKey(`connected:${item.server}:${externalId}`);
  const url = safeHttpsUrl(item.url);
  return {
    version: 1,
    id: handoffId(sourceKey),
    source: item.server,
    sourceKey,
    kind: 'connected',
    lane: 'focus',
    status: item.state === 'waiting' ? 'waiting' : 'open',
    priority: 'normal',
    protected: false,
    situation,
    background: uniqueStrings([
      item.author ? `From ${clean(item.author)}.` : '',
      item.updatedAt ? `Updated ${timeLabel(item.updatedAt)}.` : '',
    ]),
    assessment,
    recommendation,
    evidence: [{ label: `Source ${sourceName}`, ref }],
    primaryRef: ref,
    relatedRefs: [],
    items: [{ sourceKey, ref, situation, assessment, recommendation }],
    actions: url
      ? [
          {
            action: 'open_url',
            label: `Open in ${sourceName}`,
            payload: { url },
            style: 'primary',
          },
        ]
      : [],
    generatedAt,
    mergeKeys: refMergeKeys(ref),
  };
}

function safeHttpsUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function mergeRelatedHandoffs(records: AtomicHandoff[]): TriageHandoffV1[] {
  const parent = records.map((_, index) => index);
  const find = (index: number): number => {
    let current = index;
    while (parent[current] !== current) current = parent[current];
    while (parent[index] !== index) {
      const next = parent[index];
      parent[index] = current;
      index = next;
    }
    return current;
  };
  const union = (left: number, right: number) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent[rightRoot] = leftRoot;
  };
  const ownerByKey = new Map<string, number>();
  records.forEach((record, index) => {
    for (const key of uniqueStrings([record.sourceKey, ...record.mergeKeys])) {
      const owner = ownerByKey.get(key);
      if (owner === undefined) ownerByKey.set(key, index);
      else union(owner, index);
    }
  });
  const groups = new Map<number, AtomicHandoff[]>();
  records.forEach((record, index) => {
    const root = find(index);
    groups.set(root, [...(groups.get(root) || []), record]);
  });
  return [...groups.values()].map(mergeGroup);
}

function mergeGroup(group: AtomicHandoff[]): TriageHandoffV1 {
  const ordered = [...group].sort(compareHandoffs);
  const primary = ordered[0];
  const items = uniqueBy(
    ordered.flatMap((record) => record.items),
    (item) => item.sourceKey,
  ).slice(0, 8);
  const allRefs = uniqueRefs(ordered.flatMap((record) => [record.primaryRef, ...record.relatedRefs]));
  const primaryRef = primary.primaryRef;
  const relatedRefs = allRefs.filter((ref) => refKey(ref) !== refKey(primaryRef)).slice(0, 8);
  const isComposite = items.length > 1;
  const sourceKeys = items.map((item) => item.sourceKey).sort();
  const sourceKey = isComposite ? `composite:${stableHash(sourceKeys.join('|'))}` : primary.sourceKey;
  const recommendations = uniqueStrings(items.map((item) => item.recommendation));
  const sharedArea = allRefs.find((ref) => ref.kind === 'area' && ref.label);

  return {
    version: 1,
    id: handoffId(sourceKey),
    source: isComposite ? 'multi' : primary.source,
    sourceKey,
    kind: isComposite ? 'composite' : primary.kind,
    lane: ordered.sort((a, b) => LANE_SCORE[b.lane] - LANE_SCORE[a.lane])[0].lane,
    status: ordered.some((record) => record.status === 'open')
      ? 'open'
      : ordered.some((record) => record.status === 'waiting')
        ? 'waiting'
        : 'scheduled',
    priority: ordered.sort((a, b) => PRIORITY_SCORE[b.priority] - PRIORITY_SCORE[a.priority])[0].priority,
    protected: ordered.some((record) => record.protected),
    situation: isComposite
      ? sharedArea
        ? `${sharedArea.label}: ${items.length} related items`
        : `${primary.situation} + ${items.length - 1} related ${items.length === 2 ? 'item' : 'items'}`
      : primary.situation,
    background: uniqueStrings([
      ...primary.background,
      ...items.filter((item) => item.sourceKey !== primary.sourceKey).map((item) => item.situation),
      ...ordered.flatMap((record) => record.background),
    ]).slice(0, 3),
    assessment: uniqueStrings(ordered.map((record) => record.assessment))
      .join(' ')
      .slice(0, 500),
    recommendation: recommendations.slice(0, 2).join(' Then ').slice(0, 500),
    evidence: uniqueEvidence(ordered.flatMap((record) => record.evidence)).slice(0, 4),
    primaryRef,
    relatedRefs,
    items,
    actions: uniqueActions(ordered.flatMap((record) => record.actions)).slice(0, 8),
    dueAt: earliestTime(ordered.map((record) => record.dueAt)),
    startsAt: earliestTime(ordered.map((record) => record.startsAt)),
    generatedAt: primary.generatedAt,
  };
}

function taskRelatedRefs(task: DailyReportTaskItem): BriefSourceRefV2[] {
  const source = task.source || {};
  const account = clean(task.sourceAccountId) || clean(source.accountId) || undefined;
  const threadId = clean(task.sourceThreadId) || clean(source.threadId);
  const eventId = clean(task.sourceCalendarEventId) || clean(source.eventId) || clean(source.providerEventId);
  const refs: BriefSourceRefV2[] = [];
  if (threadId) refs.push({ kind: 'thread', id: threadId, ...(account ? { account } : {}) });
  if (eventId) refs.push({ kind: 'event', id: eventId, ...(account ? { account } : {}) });
  return refs;
}

function compareHandoffs(left: TriageHandoffV1, right: TriageHandoffV1): number {
  if (left.protected !== right.protected) return left.protected ? -1 : 1;
  const priority = PRIORITY_SCORE[right.priority] - PRIORITY_SCORE[left.priority];
  if (priority) return priority;
  const leftTime = left.dueAt ?? left.startsAt ?? Number.POSITIVE_INFINITY;
  const rightTime = right.dueAt ?? right.startsAt ?? Number.POSITIVE_INFINITY;
  if (leftTime !== rightTime) return leftTime - rightTime;
  return left.id.localeCompare(right.id);
}

function refMergeKeys(ref: BriefSourceRefV2): string[] {
  if ((ref.kind === 'thread' || ref.kind === 'event') && !ref.account) return [];
  return [`ref:${refKey(ref)}`];
}

function refKey(ref: BriefSourceRefV2): string {
  return JSON.stringify([ref.kind, (ref.account || '').toLowerCase(), ref.id]);
}

function uniqueRefs(refs: BriefSourceRefV2[]): BriefSourceRefV2[] {
  return uniqueBy(refs, refKey);
}

function uniqueEvidence(
  evidence: Array<{ label: string; ref?: BriefSourceRefV2 }>,
): Array<{ label: string; ref?: BriefSourceRefV2 }> {
  return uniqueBy(
    evidence.filter((entry) => clean(entry.label)),
    (entry) => `${clean(entry.label).toLowerCase()}:${entry.ref ? refKey(entry.ref) : ''}`,
  );
}

function uniqueActions(actions: BriefActionV2[]): BriefActionV2[] {
  const byTarget = new Map<string, BriefActionV2>();
  for (const action of actions) {
    const key = actionTargetKey(action);
    const current = byTarget.get(key);
    if (!current || JSON.stringify(action.payload).length > JSON.stringify(current.payload).length) {
      byTarget.set(key, action);
    }
  }
  return [...byTarget.values()];
}

function actionTargetKey(action: BriefActionV2): string {
  const payload = action.payload;
  switch (action.action) {
    case 'open_thread':
    case 'resolve_thread':
    case 'dismiss_thread':
    case 'archive_thread':
    case 'draft_reply':
      return `${action.action}:${payload.account}:${payload.threadId}`;
    case 'toggle_task':
    case 'dismiss_task':
      return `${action.action}:${payload.cardId}`;
    case 'open_event':
      return `${action.action}:${payload.account}:${payload.eventId}`;
    case 'rsvp_event':
      return `${action.action}:${payload.account}:${payload.eventId}:${payload.status}`;
    case 'open_area':
      return `${action.action}:${payload.areaId}`;
    case 'open_work':
      return `${action.action}:${payload.workId}`;
    case 'open_url':
      return `${action.action}:${payload.url}`;
    default:
      return `${action.action}:${JSON.stringify(payload)}`;
  }
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

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.map(clean).filter(Boolean))];
}

function threadRef(item: DailyReportItem): BriefSourceRefV2 {
  return {
    kind: 'thread',
    id: item.threadId,
    account: item.account,
    label: clean(item.subject) || 'Conversation',
  };
}

function timingEvidence(item: DailyReportItem, generatedAt: number): string | null {
  if (item.dueAt) return `Due ${timeLabel(item.dueAt)}.`;
  if (!item.receivedAt) return null;
  const days = Math.max(0, Math.floor((generatedAt - item.receivedAt) / 86_400_000));
  if (days === 0) return 'The latest message arrived today.';
  if (days === 1) return 'The latest message arrived yesterday.';
  return `The latest message arrived ${days} days ago.`;
}

function timeLabel(value: number): string {
  return new Date(value).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
    timeZoneName: 'short',
  });
}

function earliestTime(values: Array<number | null | undefined>): number | undefined {
  const candidates = values.filter((value): value is number => typeof value === 'number');
  return candidates.length ? Math.min(...candidates) : undefined;
}

function handoffId(sourceKey: string): string {
  return `triage-${stableHash(sourceKey)}`;
}

function boundedSourceKey(value: string): string {
  return value.length <= 500 ? value : `source:${stableHash(value)}`;
}

function stableHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function capitalize(value: string): string {
  const cleaned = clean(value);
  return cleaned ? cleaned.slice(0, 1).toUpperCase() + cleaned.slice(1) : '';
}

function clean(value: unknown): string {
  return String(value ?? '')
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}
