import { composeEditorialDocument, defaultEditorialPlan, editorialModules } from '../brief/editorial';
import { buildTriageHandoffIndex } from '../brief/triage-index';
import { composeWeeklyReviewDocument } from '../brief/weekly-document';
import { composeBudgetBriefDocument } from '../mail/brief-budget-document';
import { assignBriefLane, budgetForTier, selectBriefItems } from '../mail/brief-score';
import { buildNativeDailyReportArtifact } from '../mail/report-artifact';
import { labelsHaveRole } from '../mail/search/folders';
import { compositionFromReport } from '../shared/brief-composition';
import type { BriefNode } from '../shared/brief-document';
import { emailFromHeader } from '../shared/format';
import { truncateText } from '../shared/text';
import type { DailyReport, DailyReportItem, Thread } from '../shared/types';
import { briefAttention } from './brief';
import {
  correctionForMail,
  hasObligation,
  type JevAssessment,
  type JevBriefDigest,
  type JevCorrection,
  type JevPreferences,
  jevReason,
} from './contract';

/** Items the reader dismissed, resolved, or archived from the brief. */
export interface BriefHiddenItems {
  /** Thread keys as `${account}:${threadId}`. */
  threads?: ReadonlySet<string>;
  /** Task card ids. */
  tasks?: ReadonlySet<string>;
  /** Tracked thread ids the user resolved or dismissed (FEATURES item 8). */
  closedTracked?: ReadonlySet<string>;
  /** The user's own addresses: a newest message from one of them is an answer. */
  selfAddresses?: ReadonlySet<string>;
}

/**
 * Why a live thread no longer needs the edition (FEATURES item 8): it left the
 * inbox, the user read an item that asked for nothing, or the user answered.
 * A "Keep showing" correction (`included`) keeps it. Waiting items stay until
 * the reply comes: reading them or writing last is what waiting means.
 */
export function handledSinceEdition(
  item: DailyReportItem,
  current: Thread,
  options: { included: boolean; waiting: boolean; selfAddresses?: ReadonlySet<string> },
): 'trashed' | 'archived' | 'read' | 'answered' | null {
  if (options.included) return null;
  const labels = current.labels || [];
  if (labelsHaveRole(labels, 'TRASH') || labelsHaveRole(labels, 'SPAM')) return 'trashed';
  if (item.inInbox === true && labels.length > 0 && !labelsHaveRole(labels, 'INBOX')) return 'archived';
  if (options.waiting) return null;
  const obligations = (current.jev ?? item.jev)?.obligations ?? [];
  const owesWork = obligations.some((entry) => entry.kind === 'reply' || entry.kind === 'action');
  if (item.unread === true && current.unread === false && !owesWork) return 'read';
  const from = (emailFromHeader(current.fromAddress) || '').toLowerCase();
  if (
    from &&
    options.selfAddresses?.has(from) &&
    Number(current.lastDate || 0) > Number(item.receivedAt || 0)
  )
    return 'answered';
  return null;
}

/**
 * The Jev fields that projectBriefMail reads from a stored item: it compares
 * `sourceRevision` with the live assessment, and it reads `meaningfulChange`
 * and the kind of each obligation to decide if the item was actionable, if it
 * is only waiting, and which lane it takes. Evidence text, probabilities, and
 * the other fields are read only from the live thread, never from the item.
 */
export function briefJevDigest(assessment: JevAssessment | JevBriefDigest): JevBriefDigest {
  return {
    sourceRevision: assessment.sourceRevision,
    meaningfulChange: assessment.meaningfulChange,
    obligations: assessment.obligations.map((obligation) => ({ kind: obligation.kind })),
  };
}

/** Read projection of the latest edition. Never writes over the historical snapshot.
 *
 * Saved dismissals apply to any latest edition, so the current edition hides
 * them after a reload. Live mail facts apply only in the first 24 hours. */
export function projectBriefMail(
  report: DailyReport,
  threads: Thread[],
  policy: { preferences: JevPreferences; corrections: JevCorrection[] },
  now = Date.now(),
  hidden: BriefHiddenItems = {},
): DailyReport {
  const live = now - report.generatedAt <= 24 * 3600_000;
  const hiddenThreads = hidden.threads ?? new Set<string>();
  const hiddenTasks = hidden.tasks ?? new Set<string>();
  const closedTracked = hidden.closedTracked ?? new Set<string>();
  const isHidden = (item: Pick<DailyReportItem, 'account' | 'threadId' | 'trackedThreadId'>) =>
    hiddenThreads.has(`${item.account}:${item.threadId}`) ||
    Boolean(item.trackedThreadId && closedTracked.has(item.trackedThreadId));
  if (!live) {
    if (!hiddenThreads.size && !hiddenTasks.size && !closedTracked.size) return report;
    const s: Partial<DailyReport['sections']> = report.sections ?? {};
    const touched =
      [
        s.answer,
        s.today,
        s.know,
        s.overflow,
        s.waiting,
        s.replyOwed,
        s.followUpOwed,
        s.timeSensitive,
        s.tracked,
      ]
        .flatMap((items) => items ?? [])
        .some(isHidden) || (s.tasks ?? []).some((task) => hiddenTasks.has(task.cardId));
    if (!touched) return report;
  }
  const byKey = new Map(live ? threads.map((thread) => [`${thread.account}:${thread._id}`, thread]) : []);
  let changed = false;
  const project = (items?: DailyReportItem[], waitingSection = false) =>
    (items || []).flatMap((item) => {
      if (isHidden(item)) {
        changed = true;
        return [];
      }
      const current = byKey.get(`${item.account}:${item.threadId}`);
      if (!current) return [item];
      const assessment = current.jev;
      const correction = correctionForMail(policy.corrections, {
        accountId: item.account,
        threadId: item.threadId,
        sender: assessment?.sender || emailFromHeader(current.fromAddress) || '',
        listId: assessment?.listId,
      });
      const excluded =
        correction?.brief === 'exclude' ||
        (current.smartCategory?.model === 'user_rule' && current.smartCategory.primary === 'noise');
      const included =
        correction?.brief === 'include' ||
        (current.smartCategory?.model === 'user_rule' && current.smartCategory.primary === 'main');
      const bulkExcluded =
        !included &&
        ((assessment?.purpose === 'promotion' && !policy.preferences.briefPromotions) ||
          (assessment?.purpose === 'newsletter' && !policy.preferences.briefNewsletters));
      const wasActionable = Boolean(
        item.jev?.obligations.length ||
          item.jev?.meaningfulChange ||
          item.lane === 'reply_owed' ||
          item.lane === 'follow_up_owed',
      );
      const resolved =
        !included &&
        !item.trackedThreadId &&
        assessment?.status === 'accepted' &&
        wasActionable &&
        !assessment.obligations.length &&
        (!assessment.meaningfulChange || !policy.preferences.briefAccountChanges);
      const handled = handledSinceEdition(item, current, {
        included,
        waiting:
          waitingSection ||
          (hasObligation(assessment ?? item.jev, 'waiting') &&
            !hasObligation(assessment ?? item.jev, 'reply') &&
            !hasObligation(assessment ?? item.jev, 'action')),
        selfAddresses: hidden.selfAddresses,
      });
      if (excluded || bulkExcluded || resolved || handled) {
        changed = true;
        return [];
      }
      if (!assessment || assessment.sourceRevision === item.jev?.sourceRevision) return [item];
      changed = true;
      const reply = hasObligation(assessment, 'reply');
      const action = hasObligation(assessment, 'action');
      const waiting = hasObligation(assessment, 'waiting');
      const reason = jevReason(assessment);
      // Old prose can say "reply" after the owner has replied. Replace that prose
      // with evidence-backed state until the next complete edition is composed.
      return [
        {
          ...item,
          jev: assessment,
          whyItMatters: reason,
          line: reason,
          nextAction: reply
            ? 'Open the request and reply.'
            : action
              ? 'Open the conversation to review the required work.'
              : waiting
                ? 'Check the promised response before following up.'
                : 'Review the latest update.',
          openLoops: assessment.obligations.map((entry) => truncateText(entry.evidence.text, 240)),
          lane: reply
            ? ('reply_owed' as const)
            : waiting
              ? ('follow_up_owed' as const)
              : action || assessment.meaningfulChange
                ? ('time_sensitive' as const)
                : ('fyi' as const),
          surfacedBecause: ['jev', ...assessment.obligations.map((entry) => `jev_${entry.kind}`)],
          receivedAt: current.lastDate,
          unread: current.unread,
        },
      ];
    });
  const sections = {
    ...report.sections,
    answer: project(report.sections.answer),
    today: project(report.sections.today),
    know: project(report.sections.know),
    overflow: project(report.sections.overflow),
    waiting: project(report.sections.waiting, true),
    replyOwed: project(report.sections.replyOwed),
    followUpOwed: project(report.sections.followUpOwed),
    timeSensitive: project(report.sections.timeSensitive),
    tracked: project(report.sections.tracked),
    tasks: (report.sections.tasks ?? []).filter((task) => !hiddenTasks.has(task.cardId)),
  };
  if (sections.tasks.length !== (report.sections.tasks ?? []).length) changed = true;
  const present = new Set(
    [...sections.answer, ...sections.today, ...sections.know, ...sections.overflow, ...sections.waiting].map(
      (item) => `${item.account}:${item.threadId}`,
    ),
  );
  for (const current of live ? threads : []) {
    const key = `${current.account}:${current._id}`;
    if (
      present.has(key) ||
      hiddenThreads.has(key) ||
      !report.accounts.includes(current.account) ||
      current.lastDate <= report.generatedAt ||
      current.lastDate > now ||
      current.jev?.status !== 'accepted'
    )
      continue;
    const assessment = current.jev;
    const attention = briefAttention({
      assessment,
      smart: current.smartCategory,
      preferences: policy.preferences,
      correction: correctionForMail(policy.corrections, {
        accountId: current.account,
        threadId: current._id,
        sender: assessment.sender || emailFromHeader(current.fromAddress) || '',
        listId: assessment.listId,
      }),
      now,
      waitingSince: current.lastDate,
      fallbackReply: false,
      tracked: false,
    });
    if (!attention.eligible) continue;
    present.add(key);
    changed = true;
    sections.overflow.push({
      account: current.account,
      threadId: current._id,
      subject: current.subject,
      people: [current.fromAddress],
      sender: current.fromAddress,
      whyItMatters: jevReason(assessment),
      line: jevReason(assessment),
      nextAction: attention.reply ? 'Open the request and reply.' : 'Review the latest update.',
      unread: current.unread,
      receivedAt: current.lastDate,
      jev: assessment,
      openLoops: assessment.obligations.map((o) => truncateText(o.evidence.text, 240)),
      score: attention.reply || attention.action ? 8 : 5,
      budgetLane: attention.reply ? 'answer' : attention.action || attention.change ? 'today' : 'know',
      lane: attention.reply ? 'reply_owed' : attention.followUp ? 'follow_up_owed' : 'time_sensitive',
    });
  }
  if (!changed) return report;
  const candidates = [
    ...sections.answer,
    ...sections.today,
    ...sections.know,
    ...sections.overflow,
    ...sections.waiting,
  ].filter(
    (item, index, all) =>
      all.findIndex((other) => other.account === item.account && other.threadId === item.threadId) === index,
  );
  const waitingOnly = (item: DailyReportItem) =>
    item.jev
      ? hasObligation(item.jev, 'waiting') &&
        !hasObligation(item.jev, 'reply') &&
        !hasObligation(item.jev, 'action') &&
        !item.jev.meaningfulChange
      : sections.waiting.includes(item);
  sections.waiting = candidates.filter(waitingOnly);
  const pool = candidates.filter((item) => !waitingOnly(item));
  const selection = selectBriefItems(
    pool.map((item) => ({
      key: `${item.account}:${item.threadId}`,
      item,
      score: Math.max(1, item.score || 1),
      receivedAt: item.receivedAt,
      lane: item.jev
        ? assignBriefLane({
            replyOwed: hasObligation(item.jev, 'reply'),
            needsAction: hasObligation(item.jev, 'action'),
            meaningfulChange: item.jev.meaningfulChange && policy.preferences.briefAccountChanges,
            deadlineWithin48h: Boolean(item.dueAt && item.dueAt >= now && item.dueAt < now + 48 * 3600_000),
          })
        : item.budgetLane || 'know',
    })),
    budgetForTier(report.tier),
  );
  for (const lane of ['answer', 'today', 'know', 'overflow'] as const)
    sections[lane] = selection[lane].map((entry) => ({ ...entry.item, budgetLane: entry.lane }));
  const selected = [...sections.answer, ...sections.today, ...sections.know];
  const all = [...selected, ...sections.overflow, ...sections.waiting];
  sections.replyOwed = all.filter((item) => item.lane === 'reply_owed');
  sections.followUpOwed = all.filter((item) => item.lane === 'follow_up_owed');
  sections.timeSensitive = all.filter((item) => item.lane === 'time_sensitive');
  // The written lede stays: a mail update changes only the item lines. The
  // fixed text fills in only for an edition that never had a written lede.
  const writtenLede = report.prose?.lede?.trim() || '';
  const lede =
    writtenLede ||
    (selected.length
      ? 'Your open conversations and meaningful updates, refreshed from the latest mail.'
      : 'No mail highlights remain in this edition. Your mail views show the latest conversation states.');
  const next: DailyReport = {
    ...report,
    sections,
    narrative: writtenLede ? report.narrative || lede : lede,
    prose: {
      ...report.prose,
      lede,
      weekAhead: report.prose?.weekAhead || '',
      model: writtenLede ? report.prose?.model || 'local' : 'local',
    },
    stats: {
      ...report.stats,
      selected: selected.length,
      overflow: sections.overflow.length,
      needsReply: sections.replyOwed.length,
      replyOwed: sections.replyOwed.length,
    },
  };
  next.handoffs = buildTriageHandoffIndex(next);
  const lines = Object.fromEntries(
    selected.map((item) => [`${item.account}:${item.threadId}`, item.line || item.whyItMatters]),
  );
  // Preserve the area pulse lines even when the writer placed them inside a
  // group or chose compact rows. They are not recomputed by a mail refresh.
  const areas: Array<{ areaId: string; name: string; line: string }> = [
    ...(report.editorial?.plan.areas ?? []),
  ];
  const collectAreas = (node: BriefNode) => {
    if (node.kind === 'entity_list') {
      for (const item of node.items) {
        if (item.ref.kind === 'area' && !areas.some((area) => area.areaId === item.ref.id))
          areas.push({
            areaId: item.ref.id,
            name: item.ref.label || 'Area',
            line: item.framing.reason || '',
          });
      }
    }
    if ('children' in node) node.children.forEach(collectAreas);
  };
  report.document?.regions.forEach((region) => {
    collectAreas(region.tree);
  });
  // A weekly review keeps its own layout; its counts follow the live items.
  const letter =
    report.kind === 'weekly'
      ? composeWeeklyReviewDocument(next, report.document?.timezone)
      : composeBudgetBriefDocument({
          report: next,
          timezone: report.document?.timezone,
          prose: { ...next.prose!, lines },
          areas,
        });
  next.document = letter;
  if (report.kind === 'weekly') next.narrative = letter.summary;
  if (report.editorial) {
    const modules = editorialModules(next, letter);
    try {
      next.document = composeEditorialDocument(letter, modules, report.editorial.plan, false);
    } catch {
      const plan = defaultEditorialPlan(modules);
      try {
        next.document = composeEditorialDocument(letter, modules, plan);
        next.editorial = { plan, mode: 'fallback' };
      } catch {
        next.document = letter;
        delete next.editorial;
      }
    }
  }
  next.composition = compositionFromReport(next);
  next.html = buildNativeDailyReportArtifact(next, next.composition);
  return next;
}
