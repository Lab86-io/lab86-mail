import { buildTriageHandoffIndex } from '../brief/triage-index';
import { composeBudgetBriefDocument } from '../mail/brief-budget-document';
import { assignBriefLane, budgetForTier, selectBriefItems } from '../mail/brief-score';
import { buildNativeDailyReportArtifact } from '../mail/report-artifact';
import { compositionFromReport } from '../shared/brief-composition';
import { emailFromHeader } from '../shared/format';
import type { DailyReport, DailyReportItem, Thread } from '../shared/types';
import { briefAttention } from './brief';
import {
  correctionForMail,
  hasObligation,
  type JevCorrection,
  type JevPreferences,
  jevReason,
} from './contract';

/** Read projection of the latest edition. Never writes over the historical snapshot. */
export function projectBriefMail(
  report: DailyReport,
  threads: Thread[],
  policy: { preferences: JevPreferences; corrections: JevCorrection[] },
  now = Date.now(),
): DailyReport {
  if (now - report.generatedAt > 24 * 3600_000) return report;
  const byKey = new Map(threads.map((thread) => [`${thread.account}:${thread._id}`, thread]));
  let changed = false;
  const project = (items?: DailyReportItem[]) =>
    (items || []).flatMap((item) => {
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
      if (excluded || bulkExcluded || resolved) {
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
          openLoops: assessment.obligations.map((entry) => entry.evidence.text.slice(0, 240)),
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
    replyOwed: project(report.sections.replyOwed),
    followUpOwed: project(report.sections.followUpOwed),
    timeSensitive: project(report.sections.timeSensitive),
    tracked: project(report.sections.tracked),
  };
  const present = new Set(
    [...sections.answer, ...sections.today, ...sections.know, ...sections.overflow].map(
      (item) => `${item.account}:${item.threadId}`,
    ),
  );
  for (const current of threads) {
    const key = `${current.account}:${current._id}`;
    if (
      present.has(key) ||
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
      openLoops: assessment.obligations.map((o) => o.evidence.text.slice(0, 240)),
      score: attention.reply || attention.action ? 8 : 5,
      budgetLane: attention.reply ? 'answer' : attention.action || attention.change ? 'today' : 'know',
      lane: attention.reply ? 'reply_owed' : attention.followUp ? 'follow_up_owed' : 'time_sensitive',
    });
  }
  if (!changed) return report;
  const pool = [...sections.answer, ...sections.today, ...sections.know, ...sections.overflow];
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
  const all = [...selected, ...sections.overflow];
  sections.replyOwed = all.filter((item) => item.lane === 'reply_owed');
  sections.followUpOwed = all.filter((item) => item.lane === 'follow_up_owed');
  sections.timeSensitive = all.filter((item) => item.lane === 'time_sensitive');
  const lede = selected.length
    ? 'Your open conversations and meaningful updates, refreshed from the latest mail.'
    : 'No mail highlights remain in this edition. Your mail views show the latest conversation states.';
  const next: DailyReport = {
    ...report,
    sections,
    narrative: lede,
    prose: { lede, weekAhead: report.prose?.weekAhead || '', model: 'local' },
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
  next.document = composeBudgetBriefDocument({
    report: next,
    timezone: report.document?.timezone,
    prose: { lede, weekAhead: next.prose!.weekAhead, lines },
  });
  const areas = report.document?.regions.filter((region) => region.id === 'areas') || [];
  next.document.regions.push(...areas);
  next.composition = compositionFromReport(next);
  next.html = buildNativeDailyReportArtifact(next, next.composition);
  return next;
}
