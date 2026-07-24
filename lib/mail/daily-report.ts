import { randomUUID } from 'node:crypto';
import { describeProvider } from '../ai/client';
import { contextFirstName, getAiRequestContext } from '../ai/context';
import { generateTextForCurrentUser, hasAiForCurrentUser } from '../ai/gateway';
import {
  type AlbatrossDailyReportContext,
  loadLiveAlbatrossDailyReportContext,
  prioritizeHandoffsForIntent,
} from '../albatross/daily-report';
import { buildTriageHandoffIndex } from '../brief/triage-index';
import { api, convexQuery } from '../hosted/convex';
import { bulkSignals, isHumanLike, isNoReplyLike } from '../mail/smart-categories';
import { getNylasThread, listNylasAccounts, searchNylasThreads } from '../nylas/provider';
import { emailFromHeader, shortFrom, stripEmoji } from '../shared/format';
import type {
  DailyReport,
  DailyReportCalendarItem,
  DailyReportItem,
  DailyReportMcpItem,
  DailyReportTaskItem,
  Message,
  ReportLane,
  SmartCategory,
  SmartCategoryId,
  Thread,
  ThreadInsight,
  TrackedThread,
} from '../shared/types';
import {
  type DailyReportThreadDismissal,
  dailyReportThreadKey,
  listDismissedDailyReportTaskIds,
  listDismissedDailyReportThreads,
} from '../store/daily-report-dismissals';
import { saveDailyReport } from '../store/daily-reports';
import { listMemories } from '../store/memories';
import { getThreadMessages, upsertMessage as upsertMessageRecord } from '../store/messages';
import { listSmartLabels } from '../store/smart-labels';
import { listSmartRules } from '../store/smart-rules';
import { insightId, upsertThreadInsight } from '../store/thread-insights';
import { getThread, upsertThread } from '../store/threads';
import { listTrackedThreads, updateTrackedThread, upsertTrackedThread } from '../store/tracked-threads';
import { classifyThreadsBatched } from '../tools/ai';
import { briefServiceFromProvider } from './brief-services';
import {
  deterministicRecommendation,
  normalizeRecommendation,
  recommendationFor,
  recommendationForInsight,
} from './thread-handoff';

// The user's own addresses. Used to decide message direction (inbound vs outbound)
// for reply/follow-up detection and to keep him out of the "people" list. The
// runtime also unions in the live connected accounts; the RIT address is included
// here because it can show up as a sender.

// Candidate gathering, category-aware and keyword-free. We trust Gmail's own
// Primary/Important categorization to find human mail rather than guessing at
// job-specific keywords. The human-leaning passes are intentionally NOT
// time-boxed: a year-old human thread still owed a reply matters more than
// today's promotions, and these `human` passes are protected from truncation
// when the candidate list is bounded. Breadth passes stay recent — we only
// need fresh automated mail to populate the bulk tail.
const RECENT_QUERIES: Array<{ q: string; max: number; human?: boolean }> = [
  { q: 'in:inbox (category:primary OR is:important) -in:trash -in:spam', max: 200, human: true },
  { q: 'is:starred -in:trash -in:spam', max: 100, human: true },
  { q: 'in:inbox is:unread (category:primary OR is:important) -in:trash -in:spam', max: 100, human: true },
  { q: 'in:inbox newer_than:30d -category:promotions -category:social -category:forums', max: 80 },
  { q: 'in:inbox newer_than:14d', max: 40 },
];

// Outbound pass — surfaces threads where the user sent last (for follow-up-owed)
// and seeds the "prior correspondent" allowlist. Not time-boxed either, so an
// old thread the user is still waiting on is not silently dropped.
const SENT_QUERY = { q: 'in:sent -in:trash -in:spam', max: 200 };

const CANDIDATE_LIMIT = 320;
const TIME_SENSITIVE_WINDOW = 14 * 86400_000;
const REPORT_LANE_LIMITS: Record<Exclude<ReportLane, 'bulk'>, number> = {
  reply_owed: 5,
  follow_up_owed: 5,
  new_people: 3,
  time_sensitive: 3,
  tracked: 5,
  fyi: 3,
};
const BULK_TAIL_LIMIT = 8;
const WEEK_CONTEXT_WINDOW = 7 * 86400_000;
const MONTH_CONTEXT_WINDOW = 30 * 86400_000;
const FUTURE_CONTEXT_WINDOW = 14 * 86400_000;

// Lane priority for the clamp: the floor decides a minimum lane and the LLM may
// only raise it, never demote below the floor.
const LANE_PRIORITY: Record<ReportLane, number> = {
  reply_owed: 6,
  follow_up_owed: 5,
  new_people: 4,
  time_sensitive: 3,
  tracked: 2,
  fyi: 1,
  bulk: 0,
};

function laneMax(a: ReportLane, b: ReportLane): ReportLane {
  return LANE_PRIORITY[a] >= LANE_PRIORITY[b] ? a : b;
}

function parseLane(value: unknown): ReportLane | null {
  const v = String(value || '')
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  return (LANE_PRIORITY as Record<string, number>)[v] !== undefined ? (v as ReportLane) : null;
}

// How wide to cast the candidate net. 'week' is the fast first pass (just the
// last several days, fewer candidates, less enrichment) so a brief appears
// quickly; 'full' is the broader month sweep run afterward in the background.
function scopeProfile(scope: 'week' | 'full' = 'full') {
  if (scope === 'week') {
    return {
      queries: [
        {
          q: 'in:inbox (category:primary OR is:important) newer_than:7d -in:trash -in:spam',
          max: 120,
          human: true,
        },
        { q: 'is:starred newer_than:14d -in:trash -in:spam', max: 60, human: true },
        { q: 'in:inbox is:unread newer_than:7d -in:trash -in:spam', max: 80, human: true },
        { q: 'in:inbox newer_than:7d -category:promotions -category:social -category:forums', max: 60 },
      ] as typeof RECENT_QUERIES,
      sentMax: 100,
      candidateLimit: 90,
      enrichCap: 15,
    };
  }
  return { queries: RECENT_QUERIES, sentMax: SENT_QUERY.max, candidateLimit: CANDIDATE_LIMIT, enrichCap: 30 };
}

export async function generateDailyReport(input: {
  kind: DailyReport['kind'];
  accounts?: string[];
  userId?: string | null;
  now?: number;
  maxRecentPerAccount?: number;
  includeCalendar?: boolean;
  // 'week' = fast first pass; 'full' = broad month sweep (default).
  scope?: 'week' | 'full';
  // Reuse an edition id so a later pass overwrites the same report in place.
  reportId?: string;
  // Skip the progressive partial saves (used by the silent background pass so
  // it doesn't churn an already-rendered edition back to a "generating" state).
  silent?: boolean;
  isFirstOpenOfMonth?: boolean;
}) {
  const now = input.now || Date.now();
  const profile = scopeProfile(input.scope);
  const connected = await listNylasAccounts(input.userId).catch(() => []);
  const authed = connected.filter((account) => account.authed);
  const selectedAccounts = new Set((input.accounts ?? []).map((value) => String(value).toLowerCase()));
  const selectedAuthed = selectedAccounts.size
    ? authed.filter(
        (account) =>
          selectedAccounts.has(String(account.accountId).toLowerCase()) ||
          selectedAccounts.has(String(account.email || '').toLowerCase()),
      )
    : authed;
  const accounts = selectedAuthed.map((account) => account.accountId);
  const accountIdSet = new Set(accounts.map((value) => String(value).toLowerCase()));
  const serviceIds = [
    ...new Set(selectedAuthed.map((account) => briefServiceFromProvider(account.provider))),
  ];
  const errors: string[] = [];
  if (!accounts.length) errors.push('No connected Nylas mail accounts found for this user.');
  const [rules, customLabels, tracked] = await Promise.all([
    listSmartRules(),
    listSmartLabels(),
    listTrackedThreads({ limit: 1000 }),
  ]);
  const trackedByKey = new Map(tracked.map((item) => [`${item.account}:${item.threadId}`, item]));
  // "Self" is the set of EMAIL ADDRESSES on this user's connected accounts.
  // `accounts` above are opaque accountIds used for transport, while sender
  // checks downstream compare against addresses.
  const self = new Set<string>(
    selectedAuthed.map((account) => String(account.email || '').toLowerCase()).filter(Boolean),
  );
  // Callers may still pass raw emails in input.accounts; honor them for
  // self-detection even though transport lookups use accountIds.
  for (const value of input.accounts ?? []) {
    const email = String(value).toLowerCase();
    if (email.includes('@')) self.add(email);
  }

  // ---- Candidate gathering -------------------------------------------------
  const candidates = new Map<string, Thread>();
  const sentAllowlist = new Set<string>();
  // Human-leaning candidates (and tracked ones) are never dropped when the
  // list is bounded, so old unanswered humans outrank fresh automated mail.
  const humanKeys = new Set<string>();
  for (const account of accounts) {
    for (const { q, max, human } of profile.queries) {
      try {
        const cap = Math.min(max, input.maxRecentPerAccount ?? max);
        for (const thread of await searchAccountThreads(account, q, cap, input.userId)) {
          const key = `${thread.account}:${thread._id}`;
          candidates.set(key, thread);
          if (human) humanKeys.add(key);
        }
      } catch (err: any) {
        errors.push(`${account}: ${err?.message || 'search failed'}`);
      }
    }
    try {
      for (const thread of await searchAccountThreads(account, SENT_QUERY.q, profile.sentMax, input.userId)) {
        candidates.set(`${thread.account}:${thread._id}`, thread);
        collectSentRecipientsFromRaw(thread, self, sentAllowlist);
      }
    } catch (err: any) {
      errors.push(`${account}: ${err?.message || 'sent scan failed'}`);
    }
  }

  // Always include unresolved tracked threads.
  for (const item of tracked) {
    if (item.status === 'resolved' || item.status === 'dismissed') continue;
    const trackedAccount = String(item.account).toLowerCase();
    if (selectedAccounts.size && !accountIdSet.has(trackedAccount) && !selectedAccounts.has(trackedAccount)) {
      continue;
    }
    const existing = await getThread(item.account, item.threadId);
    if (existing) {
      const key = `${existing.account}:${existing._id}`;
      candidates.set(key, existing);
      humanKeys.add(key);
    }
  }

  const [calendarContext, taskContext, memoryContext, mcpContext, albatrossContext] = await Promise.all([
    input.includeCalendar !== false ? loadCalendarContext(input.userId, now) : Promise.resolve([]),
    loadTaskContext(input.userId, now),
    loadMemoryContext(),
    loadMcpContext(input.userId),
    loadLiveAlbatrossDailyReportContext({
      userId: input.userId,
      now,
      isFirstOpenOfMonth: input.isFirstOpenOfMonth,
    }),
  ]);

  const byDateDesc = (a: Thread, b: Thread) => Number(b.lastDate || 0) - Number(a.lastDate || 0);
  const all = [...candidates.values()];
  // Human/tracked candidates first (newest-first within the group), then the
  // rest. Slicing to CANDIDATE_LIMIT therefore truncates automated mail, never
  // a real person — regardless of how old the human thread is.
  const prioritized = [
    ...all.filter((t) => humanKeys.has(`${t.account}:${t._id}`)).sort(byDateDesc),
    ...all.filter((t) => !humanKeys.has(`${t.account}:${t._id}`)).sort(byDateDesc),
  ];
  const bounded = dedupeCandidates(prioritized, trackedByKey).slice(0, profile.candidateLimit);

  // ---- Load messages + harvest prior correspondents ------------------------
  const messagesByKey = new Map<string, Message[]>();
  for (const thread of bounded) {
    const key = `${thread.account}:${thread._id}`;
    const messages = await loadThreadMessages(thread.account, thread._id, input.userId);
    messagesByKey.set(key, messages);
    // Reliable allowlist: anyone the user has actually emailed in these threads.
    for (const message of messages) {
      const fromEmail = (emailFromHeader(message.from) || '').toLowerCase();
      if (!fromEmail || !self.has(fromEmail)) continue;
      for (const field of [message.to, message.cc]) {
        for (const part of String(field || '').split(',')) {
          const email = emailFromHeader(part)?.toLowerCase();
          if (!email || self.has(email)) continue;
          sentAllowlist.add(email);
          const domain = email.split('@')[1];
          if (domain) sentAllowlist.add(domain);
        }
      }
    }
  }

  // ---- Tier 1: batched smart classification (local-first) ------------------
  const smartList = await classifyThreadsBatched(
    bounded.map((thread) => ({
      id: thread._id,
      account: thread.account,
      fromAddress: thread.fromAddress,
      subject: thread.subject,
      snippet: thread.snippet,
      labels: thread.labels,
      unread: thread.unread,
      date: thread.lastDate,
    })),
    { rules, customLabels },
  ).catch(() => [] as Array<{ id: string; model: string } & SmartCategory>);
  const smartByKey = new Map<string, SmartCategory>();
  for (const verdict of smartList) {
    const { id, ...rest } = verdict;
    smartByKey.set(id, rest as SmartCategory);
  }

  // ---- Stage 1: deterministic safety floor for every candidate -------------
  const floors = new Map<string, FloorSignals>();
  for (const thread of bounded) {
    const key = `${thread.account}:${thread._id}`;
    floors.set(
      key,
      computeFloor(thread, messagesByKey.get(key) || [], now, {
        self,
        sentAllowlist,
        tracked: trackedByKey.has(key),
        smart: smartByKey.get(thread._id) || null,
      }),
    );
  }

  // ---- Stage 2: pick the threads worth an LLM narrative (promote-only) -----
  const enrichCap = Math.min(Number(process.env.LAB86_MAIL_REPORT_MAX_ENRICH || 30), profile.enrichCap);
  const aiAvailable = await hasAiForCurrentUser();
  const enrichKeys = new Set<string>(
    bounded
      .filter((thread) => {
        const key = `${thread.account}:${thread._id}`;
        const floor = floors.get(key)!;
        const smart = smartByKey.get(thread._id);
        return (
          aiAvailable &&
          (floor.protected ||
            trackedByKey.has(key) ||
            Boolean(smart?.isHumanLike) ||
            smart?.primary === 'review')
        );
      })
      .sort((a, b) => {
        const fa = floors.get(`${a.account}:${a._id}`)!;
        const fb = floors.get(`${b.account}:${b._id}`)!;
        return LANE_PRIORITY[fb.lane] - LANE_PRIORITY[fa.lane];
      })
      .slice(0, enrichCap)
      .map((thread) => `${thread.account}:${thread._id}`),
  );

  // ---- Build insights ------------------------------------------------------
  // The edition gets a fixed id up front so partial saves update one document
  // the UI can poll, instead of a new report appearing only at the very end.
  const reportId = input.reportId ?? randomUUID();
  const lastDateByKey = new Map<string, number>();
  for (const thread of bounded) {
    const key = `${thread.account}:${thread._id}`;
    const messages = messagesByKey.get(key) || [];
    const newest = messages[messages.length - 1];
    lastDateByKey.set(key, Number(newest?.date || thread.lastDate || 0));
  }
  const savePartial = async (
    stage: string,
    done: number,
    total: number,
    partialInsights: ThreadInsight[],
  ) => {
    // The background month pass runs silent so it never reverts an already-
    // rendered edition to a "generating" state.
    if (input.silent) return;
    try {
      const partial = await composeReport({
        kind: input.kind,
        now,
        accounts,
        services: serviceIds,
        insights: partialInsights,
        tracked,
        lastDateByKey,
        calendarContext,
        taskContext,
        memoryContext,
        albatrossContext,
        errors,
        reportId,
        status: 'partial',
        progress: { stage, done, total },
        skipNarrative: true,
      });
      await saveDailyReport(partial);
    } catch {
      // Partial saves are progress UX only — never let them sink the report.
    }
  };
  await savePartial('Scanning last week', 1, bounded.length + 4, []);
  await savePartial('Adding relevant month context', 2, bounded.length + 4, []);

  const insights: ThreadInsight[] = [];
  let lastPartialSaveAt = Date.now();
  for (const thread of bounded) {
    const key = `${thread.account}:${thread._id}`;
    const messages = messagesByKey.get(key) || [];
    const smart = smartByKey.get(thread._id) || null;
    const floor = floors.get(key)!;
    const trackedItem = trackedByKey.get(key);
    const insight = await buildThreadInsight(thread, messages, smart, floor, Boolean(trackedItem), now, {
      calendarContext: calendarContext.map(calendarContextLine),
      memoryContext,
      enrich: enrichKeys.has(key),
      self,
    });
    insights.push(insight);
    // Stream the edition as it forms: lanes fill in while the slow enriched
    // threads are still being analyzed.
    if (Date.now() - lastPartialSaveAt > 1_500 || insights.length === bounded.length) {
      lastPartialSaveAt = Date.now();
      await savePartial('Analyzing conversations', insights.length + 2, bounded.length + 4, insights);
    }
    await upsertThread(thread.account, { ...thread, smartCategory: smart }).catch(() => undefined);
    await upsertThreadInsight(insight).catch(() => undefined);
    if (
      trackedItem &&
      trackedItem.source === 'report' &&
      !insight.suggestedTrack &&
      !insight.needsReply &&
      !insight.waitingOnSomeone &&
      !insight.commitments.some((c) => c.dueAt && c.dueAt >= now)
    ) {
      await updateTrackedThread(trackedItem._id, {
        status: 'dismissed',
        reason: `Auto-dismissed by report: ${insight.reason}`,
      }).catch(() => undefined);
    }
    if (insight.suggestedTrack && !trackedItem) {
      await upsertTrackedThread({
        account: thread.account,
        threadId: thread._id,
        subject: thread.subject,
        participants: insight.people,
        status: insight.waitingOnSomeone
          ? 'waiting'
          : insight.commitments.some((c) => c.dueAt)
            ? 'due_soon'
            : 'open',
        reason: insight.reason,
        openLoops: insight.openLoops,
        nextAction:
          insight.nextAction ||
          deterministicRecommendation({
            lane: insight.lane,
            people: insight.people,
            subject: insight.subject,
            openLoops: insight.openLoops,
          }),
        dueAt: insight.commitments.find((c) => c.dueAt)?.dueAt || null,
        importance: insight.needsReply || insight.commitments.length ? 1 : 2,
        source: 'report',
      }).catch(() => undefined);
    }
  }

  const refreshedTracked = await listTrackedThreads({ limit: 500 });
  await savePartial('Writing the narrative', bounded.length + 3, bounded.length + 4, insights);
  const report = await composeReport({
    kind: input.kind,
    now,
    accounts,
    services: serviceIds,
    insights,
    tracked: refreshedTracked.filter((item) => {
      const trackedAccount = String(item.account).toLowerCase();
      return accountIdSet.has(trackedAccount) || selectedAccounts.has(trackedAccount);
    }),
    lastDateByKey,
    calendarContext,
    taskContext,
    memoryContext,
    mcpContext,
    albatrossContext,
    errors,
    reportId,
  });
  // Silent callers (the background month pass) persist the composed artifact
  // themselves; saving the bare structured doc here would wipe the rendered
  // edition mid-pass.
  if (!input.silent) await saveDailyReport(report);
  return report;
}

async function searchAccountThreads(account: string, query: string, max: number, userId?: string | null) {
  const result = await searchNylasThreads({ userId, account, query, max });
  const threads = (result?.items || []).filter((item) => item._id);
  for (const thread of threads) await upsertThread(account, thread).catch(() => undefined);
  return threads as Thread[];
}

// Best-effort recipient extraction from a sent search item. Compact search
// results may not carry recipients, in which case the in-thread harvest fills
// the allowlist reliably.
function collectSentRecipientsFromRaw(thread: Thread, self: Set<string>, out: Set<string>) {
  const raw = thread as unknown as Record<string, unknown>;
  const fields = [raw.to, raw.To, raw.cc, raw.Cc, raw.recipients, (raw as any).headers?.to];
  for (const field of fields) {
    if (!field) continue;
    for (const part of String(field).split(/[,;]/)) {
      const email = emailFromHeader(part)?.toLowerCase();
      if (!email || self.has(email)) continue;
      out.add(email);
      const domain = email.split('@')[1];
      if (domain) out.add(domain);
    }
  }
}

async function loadThreadMessages(account: string, threadId: string, userId?: string | null) {
  const cached = await getThreadMessages(account, threadId);
  if (cached.length) return cached.sort((a, b) => Number(a.date || 0) - Number(b.date || 0));
  const thread = await getNylasThread({ userId, account, threadId }).catch(() => null);
  const messages = (thread?.messages || [])
    .filter((message) => message._id)
    .sort((a, b) => Number(a.date || 0) - Number(b.date || 0));
  for (const message of messages) await upsertMessageRecord(message).catch(() => undefined);
  return messages;
}

// Collapse duplicate automated notifications (same sender domain + subject,
// newest wins). Human / personal / important / tracked threads are NEVER
// collapsed — the never-hide guarantee applies before anything else.
function dedupeCandidates(sorted: Thread[], trackedByKey: Map<string, TrackedThread>): Thread[] {
  const seen = new Set<string>();
  const out: Thread[] = [];
  for (const thread of sorted) {
    const labels = thread.labels || [];
    const humanish =
      isHumanLike(thread) || labels.includes('CATEGORY_PERSONAL') || labels.includes('IMPORTANT');
    const isTracked = trackedByKey.has(`${thread.account}:${thread._id}`);
    if (humanish || isTracked) {
      out.push(thread);
      continue;
    }
    const domain = (emailFromHeader(thread.fromAddress) || thread.fromAddress || '').split('@')[1] || '';
    const dedupeKey = `${thread.account}:${domain}::${subjectClause(thread.subject).toLowerCase()}`;
    if (seen.has(dedupeKey)) continue; // sorted newest-first, so the newest is kept
    seen.add(dedupeKey);
    out.push(thread);
  }
  return out;
}

// ---- Stage 1: the deterministic safety floor -------------------------------

interface FloorSignals {
  replyOwed: boolean;
  followUpOwed: boolean;
  isPersonal: boolean;
  isImportant: boolean;
  isHuman: boolean;
  isNewSender: boolean;
  isPriorCorrespondent: boolean;
  automated: boolean;
  bulkReasons: string[];
  commitments: ThreadInsight['commitments'];
  timeSensitive: boolean;
  protected: boolean;
  lane: ReportLane;
  demotionReason: string | null;
}

function unionLabels(thread: Thread, messages: Message[]): string[] {
  const set = new Set<string>(thread.labels || []);
  const newest = messages[messages.length - 1];
  for (const label of newest?.labels || []) set.add(label);
  return [...set];
}

// replyOwed   = newest message is inbound from a non-no-reply human (not the user).
// followUpOwed = newest message is from the user, an earlier inbound human exists,
//                and it has been at least 3 days.
function computeOwed(messages: Message[], now: number, self: Set<string>) {
  const sorted = [...messages].sort((a, b) => Number(a.date || 0) - Number(b.date || 0));
  const newest = sorted[sorted.length - 1];
  let replyOwed = false;
  let followUpOwed = false;
  if (newest) {
    const fromEmail = emailFromHeader(newest.from) || '';
    const fromSelf = Boolean(fromEmail) && self.has(fromEmail);
    const noReply = isNoReplyLike(newest.from);
    if (!fromSelf && !noReply && fromEmail) {
      replyOwed = true;
    } else if (fromSelf) {
      const earlierInboundHuman = sorted.slice(0, -1).some((m) => {
        const email = emailFromHeader(m.from) || '';
        return Boolean(email) && !self.has(email) && !isNoReplyLike(m.from);
      });
      const ageDays = (now - Number(newest.date || 0)) / 86400_000;
      if (earlierInboundHuman && ageDays >= 3) followUpOwed = true;
    }
  }
  return { replyOwed, followUpOwed };
}

function computeFloor(
  thread: Thread,
  messages: Message[],
  now: number,
  ctx: { self: Set<string>; sentAllowlist: Set<string>; tracked: boolean; smart: SmartCategory | null },
): FloorSignals {
  const labels = unionLabels(thread, messages);
  const isPersonal = labels.includes('CATEGORY_PERSONAL');
  const isImportant = labels.includes('IMPORTANT');
  const isPromoCat = labels.includes('CATEGORY_PROMOTIONS');
  const isUpdatesCat = labels.includes('CATEGORY_UPDATES');
  const isSocialCat = labels.includes('CATEGORY_SOCIAL');

  // Explicit user corrections (from the report's controls) win over everything.
  // They flow in as a user_rule smart verdict so the report self-corrects.
  const userForcedNoise = ctx.smart?.model === 'user_rule' && ctx.smart?.primary === 'noise';
  const userForcedMain = ctx.smart?.model === 'user_rule' && ctx.smart?.primary === 'main';

  const from = thread.fromAddress || messages[messages.length - 1]?.from || '';
  const senderAddr = (emailFromHeader(from) || '').toLowerCase();
  const senderIsSelf = Boolean(senderAddr) && ctx.self.has(senderAddr);
  const noReply = isNoReplyLike(from);

  const { replyOwed, followUpOwed } = computeOwed(messages, now, ctx.self);

  // Reliable bulk signals only (list-id / unsubscribe). Subject-keyword signals
  // like "offer"/"sale" are intentionally excluded so a real person isn't
  // treated as automated.
  const bulkReasons = bulkSignals({
    fromAddress: thread.fromAddress,
    subject: thread.subject,
    snippet: thread.snippet,
    labels,
  });
  const listSignals = bulkReasons.includes('unsubscribe') || bulkReasons.includes('bulk_or_list');

  // An automated "series": many inbound messages, all the same subject, that
  // the user has never once answered. This catches dunning bots / drip
  // notifications that wear a CATEGORY_PERSONAL costume (e.g. EliseAI leasing
  // reminders from a human-looking "Camden") — distinct from a real
  // conversation (which gets a reply) or a fresh cold intro (a single message).
  const outboundCount = messages.filter((m) => {
    const email = emailFromHeader(m.from) || '';
    return Boolean(email) && ctx.self.has(email);
  }).length;
  const inboundSubjects = messages
    .filter((m) => {
      const email = emailFromHeader(m.from) || '';
      return Boolean(email) && !ctx.self.has(email);
    })
    .map((m) => subjectClause(m.subject).toLowerCase());
  const oneWayBlast =
    outboundCount === 0 && inboundSubjects.length >= 4 && new Set(inboundSubjects).size <= 2;

  // Gmail's own personal/important categorization beats keyword heuristics.
  const gmailHuman = isPersonal || isImportant;
  const automated = userForcedNoise
    ? true
    : userForcedMain
      ? false
      : oneWayBlast || (!gmailHuman && (noReply || isPromoCat || isUpdatesCat || isSocialCat || listSignals));

  // Counterparty = the most recent inbound, non-no-reply sender. We judge
  // "humanness" with isHumanLike — which already folds in Gmail's personal
  // signal plus the role-address / bulk / publisher blocklists — rather than
  // merely "not a no-reply address". Otherwise marketing from hello@/team@ that
  // isn't strictly no-reply would masquerade as a person and earn a reply lane.
  const inboundMsgs = messages.filter((m) => {
    const email = emailFromHeader(m.from) || '';
    return Boolean(email) && !ctx.self.has(email) && !isNoReplyLike(m.from);
  });
  const counterpartyMsg = inboundMsgs[inboundMsgs.length - 1];
  const counterparty = (
    emailFromHeader(counterpartyMsg?.from) ||
    (senderIsSelf ? '' : senderAddr) ||
    ''
  ).toLowerCase();
  const counterpartyDomain = counterparty.split('@')[1] || '';

  // isHumanLike sees the *unioned* labels, so a CATEGORY_PERSONAL that only the
  // newest message carries still counts (e.g. a job offer whose subject word
  // "offer" would otherwise trip the bulk heuristic).
  const threadSenderHuman = !senderIsSelf && isHumanLike({ ...thread, labels });
  const counterpartyHuman = counterpartyMsg
    ? isHumanLike({
        fromAddress: counterpartyMsg.from,
        subject: counterpartyMsg.subject,
        snippet: counterpartyMsg.snippet,
        labels: counterpartyMsg.labels,
      })
    : false;
  const isHuman = !userForcedNoise && (userForcedMain || threadSenderHuman || counterpartyHuman);

  const isPriorCorrespondent =
    Boolean(counterparty) &&
    (ctx.sentAllowlist.has(counterparty) ||
      (Boolean(counterpartyDomain) && ctx.sentAllowlist.has(counterpartyDomain)));
  const isNewSender = isHuman && ctx.sentAllowlist.size > 0 && Boolean(counterparty) && !isPriorCorrespondent;

  // Commitments / due dates only count for non-automated human-or-personal
  // mail. This kills the rent-notice false positive where a weekday word
  // tripped date extraction — automated notices never get a due date.
  const allowCommitments = !automated && (isHuman || isPersonal);
  const commitments = allowCommitments ? extractCommitments(threadText(thread, messages, 18_000), now) : [];
  const timeSensitive = commitments.some(
    (c) => c.dueAt && c.dueAt >= now && c.dueAt < now + TIME_SENSITIVE_WINDOW,
  );

  const isProtected =
    !userForcedNoise &&
    isHuman &&
    !automated &&
    (replyOwed ||
      followUpOwed ||
      isPersonal ||
      isImportant ||
      isNewSender ||
      isPriorCorrespondent ||
      ctx.tracked ||
      userForcedMain);

  let lane: ReportLane;
  if (!isProtected) lane = 'bulk';
  else if (replyOwed) lane = 'reply_owed';
  else if (followUpOwed) lane = 'follow_up_owed';
  else if (isNewSender) lane = 'new_people';
  else if (timeSensitive) lane = 'time_sensitive';
  else if (ctx.tracked) lane = 'tracked';
  else lane = 'fyi';

  let demotionReason: string | null = null;
  if (!isProtected) {
    if (userForcedNoise) demotionReason = 'You marked this sender as not relevant';
    else if (oneWayBlast) demotionReason = 'Repeated one-way notifications (never answered)';
    else if (noReply) demotionReason = 'No-reply / automated sender';
    else if (isPromoCat) demotionReason = 'Gmail Promotions';
    else if (isUpdatesCat) demotionReason = 'Gmail Updates / notification';
    else if (isSocialCat) demotionReason = 'Gmail Social';
    else if (listSignals) demotionReason = 'Bulk / mailing list';
    else if (!isHuman) demotionReason = 'Not a direct human conversation';
    else demotionReason = 'No pending action detected';
  }

  return {
    replyOwed,
    followUpOwed,
    isPersonal,
    isImportant,
    isHuman,
    isNewSender,
    isPriorCorrespondent,
    automated,
    bulkReasons,
    commitments,
    timeSensitive,
    protected: isProtected,
    lane,
    demotionReason,
  };
}

function surfacedBecauseFor(floor: FloorSignals, now: number): string[] {
  const out: string[] = [];
  if (floor.replyOwed) out.push('reply_owed');
  if (floor.followUpOwed) out.push('follow_up_owed');
  if (floor.isPersonal) out.push('category_personal');
  if (floor.isImportant) out.push('important');
  if (floor.isNewSender) out.push('new_sender');
  if (floor.isPriorCorrespondent && !floor.isNewSender) out.push('known_contact');
  if (floor.commitments.some((c) => c.dueAt && c.dueAt >= now)) out.push('due_soon');
  return [...new Set(out)];
}

// ---- Stage 2: ungated, promote-only LLM enrichment -------------------------

async function buildThreadInsight(
  thread: Thread,
  messages: Message[],
  smart: SmartCategory | null,
  floor: FloorSignals,
  _tracked: boolean,
  now: number,
  context: { calendarContext: string[]; memoryContext: string[]; enrich: boolean; self: Set<string> },
): Promise<ThreadInsight> {
  const people = extractPeople(thread, messages, context.self);
  const commitments = floor.commitments;
  const surfacedBecause = surfacedBecauseFor(floor, now);
  const baseOpenLoops = [
    ...commitments.map((c) => c.text),
    ...(floor.replyOwed ? ['Reply owed'] : []),
    ...(floor.followUpOwed ? ['Follow-up owed'] : []),
  ].slice(0, 4);

  let summary = stripEmoji(thread.snippet || thread.subject);
  let reason = localReason({
    people,
    subject: thread.subject,
    commitments,
    needsReply: floor.replyOwed,
    waitingOnSomeone: floor.followUpOwed,
    smart,
    now,
  });
  let openLoops = baseOpenLoops;
  let nextAction = deterministicRecommendation({
    lane: floor.lane,
    people,
    subject: thread.subject,
    openLoops: baseOpenLoops,
  });
  let lane = floor.lane;
  let model = 'local';

  if (context.enrich && (await hasAiForCurrentUser())) {
    try {
      const { text: aiText } = await generateTextForCurrentUser({
        feature: 'daily_report_insight',
        speed: 'primary',
        system:
          'You are a deep personal email analyst for the user. Use the full thread, calendar, and memory context. Never demote a thread that is from a real person, is in Gmail\'s personal or important category, or owes a reply — you may only raise its priority. Do not elevate promotions, rewards, newsletters, or one-way notifications. No emoji. Return only JSON: {"summary":"...","openLoops":["..."],"reason":"...","nextAction":"...","importance":1|2|3,"suggestedLane":"reply_owed|follow_up_owed|new_people|time_sensitive|tracked|fyi|bulk"}.',
        prompt: [
          `Now: ${new Date(now).toString()}`,
          `Floor lane (minimum — you may only raise it): ${floor.lane}`,
          `Floor signals: replyOwed=${floor.replyOwed} followUpOwed=${floor.followUpOwed} personal=${floor.isPersonal} important=${floor.isImportant} newSender=${floor.isNewSender} priorContact=${floor.isPriorCorrespondent}`,
          `Smart category: ${smart?.primary || 'unknown'}; reason: ${smart?.reason || ''}`,
          `Calendar context:\n${context.calendarContext.join('\n') || '(none)'}`,
          `Memory context:\n${context.memoryContext.join('\n') || '(none)'}`,
          '',
          threadText(thread, messages, 18_000),
        ].join('\n\n'),
      });
      const parsed = parseJson(aiText);
      if (parsed) {
        summary = stripEmoji(String(parsed.summary || summary)).slice(0, 500);
        reason = stripEmoji(String(parsed.reason || reason)).slice(0, 280);
        if (Array.isArray(parsed.openLoops) && parsed.openLoops.length) {
          openLoops = parsed.openLoops
            .map((v: unknown) => stripEmoji(String(v)))
            .filter(Boolean)
            .slice(0, 5);
        }
        // Clamp: the LLM can only promote above the deterministic floor lane.
        lane = laneMax(floor.lane, parseLane(parsed.suggestedLane) || floor.lane);
        nextAction = recommendationFor({
          candidate: normalizeRecommendation(parsed.nextAction),
          lane,
          people,
          subject: thread.subject,
          openLoops,
        });
        model = describeProvider().primary || 'primary';
      }
    } catch (err) {
      // Enrichment is best-effort — the deterministic floor values still
      // produce a briefing — but the failure should be visible in logs.
      console.warn('Daily report AI enrichment failed:', err);
    }
  }

  const demotionReason = lane === 'bulk' ? floor.demotionReason : null;

  return {
    _id: insightId(thread.account, thread._id),
    account: thread.account,
    threadId: thread._id,
    subject: stripEmoji(thread.subject),
    summary,
    people,
    commitments,
    openLoops,
    // Actionable flags reflect the protected floor, not the raw signal: an
    // automated one-way blast can be "reply owed" mechanically but must not be
    // tracked or block auto-dismissal of stale tracked records.
    needsReply: floor.replyOwed && floor.protected,
    waitingOnSomeone: floor.followUpOwed && floor.protected,
    suggestedTrack: floor.protected,
    suggestedCategory: (smart?.primary as SmartCategoryId) || 'review',
    reason,
    nextAction:
      nextAction ||
      deterministicRecommendation({
        lane,
        people,
        subject: thread.subject,
        openLoops,
      }),
    replyOwed: floor.replyOwed,
    followUpOwed: floor.followUpOwed,
    isNewSender: floor.isNewSender,
    isPersonal: floor.isPersonal,
    isImportant: floor.isImportant,
    isPriorCorrespondent: floor.isPriorCorrespondent,
    floorProtected: floor.protected,
    lane,
    surfacedBecause,
    demotionReason,
    generatedAt: now,
    model,
  };
}

// ---- Stage 3: demote-don't-drop assembly -----------------------------------

async function composeReport(input: {
  kind: DailyReport['kind'];
  now: number;
  accounts: string[];
  services?: string[];
  insights: ThreadInsight[];
  tracked: Awaited<ReturnType<typeof listTrackedThreads>>;
  lastDateByKey: Map<string, number>;
  calendarContext: DailyReportCalendarItem[];
  taskContext: DailyReportTaskItem[];
  memoryContext: string[];
  mcpContext?: DailyReportMcpItem[];
  albatrossContext: AlbatrossDailyReportContext;
  errors: string[];
  reportId?: string;
  status?: DailyReport['status'];
  progress?: DailyReport['progress'];
  // Partial editions skip the LLM narrative — it is written once at the end.
  skipNarrative?: boolean;
}) {
  const trackedKeys = new Map(input.tracked.map((item) => [`${item.account}:${item.threadId}`, item]));
  const threadDismissals = new Map(
    (await listDismissedDailyReportThreads().catch(() => [] as DailyReportThreadDismissal[])).map(
      (dismissal) => [dailyReportThreadKey(dismissal.account, dismissal.threadId), dismissal],
    ),
  );
  const reportTasks = input.taskContext.slice(0, 24);
  const reportCalendar = input.calendarContext.slice(0, 24);
  const hiddenByUser = (item: DailyReportItem) => {
    const dismissal = threadDismissals.get(dailyReportThreadKey(item.account, item.threadId));
    if (!dismissal) return false;
    const current = item.receivedAt ?? 0;
    const clearedThrough =
      typeof dismissal.receivedAt === 'number' ? dismissal.receivedAt : dismissal.dismissedAt;
    return current <= clearedThrough;
  };
  const toItem = (insight: ThreadInsight): DailyReportItem => {
    const tracked = trackedKeys.get(`${insight.account}:${insight.threadId}`);
    return {
      account: insight.account,
      threadId: insight.threadId,
      subject: stripEmoji(insight.subject),
      people: insight.people,
      whyItMatters: stripEmoji(insight.reason || insight.summary),
      nextAction: recommendationForInsight(insight, tracked),
      openLoops: insight.openLoops.slice(0, 3),
      // Bulk-tail items never carry a due date — automated notices are not
      // time-boxed actions, and stale tracked records must not leak one in.
      dueAt:
        insight.lane === 'bulk'
          ? null
          : insight.commitments.find((c) => c.dueAt)?.dueAt || tracked?.dueAt || null,
      unread: false,
      trackedThreadId: tracked?._id,
      surfacedBecause: insight.surfacedBecause,
      demotionReason: insight.demotionReason ?? null,
      isNewSender: insight.isNewSender,
      lane: insight.lane,
      receivedAt: input.lastDateByKey.get(`${insight.account}:${insight.threadId}`) || null,
    };
  };

  const activeTrackedKeys = new Set(
    input.tracked
      .filter((item) => item.status !== 'resolved' && item.status !== 'dismissed')
      .map((item) => `${item.account}:${item.threadId}`),
  );

  const byLane = (lane: Exclude<ReportLane, 'bulk'>) =>
    input.insights
      .filter((insight) => insight.lane === lane)
      .map(toItem)
      .filter((item) => !hiddenByUser(item))
      .slice(0, REPORT_LANE_LIMITS[lane]);

  const replyOwed = byLane('reply_owed');
  const followUpOwed = byLane('follow_up_owed');
  const newPeople = byLane('new_people');
  const timeSensitive = byLane('time_sensitive');
  const fyi = byLane('fyi');
  // Tracked threads are shown in their own section; never double-list them here.
  const bulkTail = input.insights
    .filter(
      (insight) =>
        insight.lane === 'bulk' && !activeTrackedKeys.has(`${insight.account}:${insight.threadId}`),
    )
    .map(toItem)
    .filter((item) => !hiddenByUser(item))
    .slice(0, BULK_TAIL_LIMIT);

  // Tracked section comes from the tracked-thread store (active only). Every
  // lane:'tracked' insight is represented here because that lane is only set
  // when an active tracked record exists.
  const trackedItems = input.tracked
    .filter((item) => item.status !== 'resolved' && item.status !== 'dismissed')
    .slice(0, REPORT_LANE_LIMITS.tracked)
    .map((item) => ({
      account: item.account,
      threadId: item.threadId,
      subject: stripEmoji(item.subject),
      people: item.participants.map(stripEmoji),
      whyItMatters: trackedReason(item, input.now),
      nextAction: recommendationFor({
        candidate: item.nextAction,
        lane: 'tracked',
        people: item.participants,
        subject: item.subject,
        openLoops: item.openLoops,
      }),
      openLoops: item.openLoops.map(stripEmoji).slice(0, 3),
      dueAt: item.dueAt,
      unread: false,
      trackedThreadId: item._id,
      surfacedBecause: ['tracked'],
      lane: 'tracked' as ReportLane,
      receivedAt: input.lastDateByKey.get(`${item.account}:${item.threadId}`) || null,
    }));
  const visibleTrackedItems = trackedItems.filter((item) => !hiddenByUser(item));

  let narrative = '';
  const sections: DailyReport['sections'] = {
    replyOwed,
    followUpOwed,
    newPeople,
    timeSensitive,
    tracked: visibleTrackedItems,
    fyi,
    bulkTail,
    tasks: reportTasks,
    calendar: reportCalendar,
    mcp: input.mcpContext ?? [],
    albatross: input.albatrossContext,
    noiseSummary:
      'Bulk, subscribed, platform, and promo mail is collapsed into the tail below. Real people are never hidden there.',
  };
  const stats: DailyReport['stats'] = {
    scannedThreads: input.insights.length,
    trackedThreads: visibleTrackedItems.length,
    needsReply: replyOwed.length,
    replyOwed: replyOwed.length,
    dueSoon: timeSensitive.length,
    bulkTailCount: bulkTail.length,
    unread: 0,
    openTasks: reportTasks.filter((task) => !task.completedAt).length,
    completedTasks: reportTasks.filter((task) => task.completedAt).length,
    calendarEvents: reportCalendar.length,
    albatrossActiveIntents: input.albatrossContext.activeIntents.length,
    albatrossActiveProjects: input.albatrossContext.activeProjects.length,
    albatrossQuestions: input.albatrossContext.askBeforeCentering.length,
  };
  const reportId = input.reportId ?? randomUUID();
  const title = `${
    input.kind === 'evening' ? 'Evening' : input.kind === 'morning' ? 'Morning' : 'Manual'
  } Daily Report`;
  const handoffs = prioritizeHandoffsForIntent(
    buildTriageHandoffIndex({
      _id: reportId,
      kind: input.kind,
      generatedAt: input.now,
      accounts: input.accounts,
      title,
      narrative,
      sections,
      stats,
    }),
    input.albatrossContext.dailyAlignment?.tomorrowIntent,
  );
  narrative = localHandoffNarrative(input.kind, handoffs);
  let model = 'local';

  if (!input.skipNarrative && (await hasAiForCurrentUser())) {
    try {
      const { text } = await generateTextForCurrentUser({
        feature: 'daily_report_narrative',
        speed: 'primary',
        system: `Write ${contextFirstName() || 'the user'} a warm, narrative Daily Report from the supplied canonical SBAR handoff index — like a sharp chief of staff briefing them over coffee. Lead with the through-line of the day and rank the already-deduplicated handoffs; do not rebuild triage from raw source categories, split merged handoffs, or omit protected handoffs. When an explicit next-day intent is supplied, treat it as the user's authoritative attention signal: connect matching evidence, recommendations, and response drafts to it while retaining unrelated protected handoffs. Name people, tasks, projects, events, and tools when useful. Areas asking before centering must remain explicit questions. Use flowing prose in 2-3 short paragraphs, concrete and investigative. No emoji, greeting, bullet lists, clinical SBAR labels, or low-value noise. Around 170-230 words.`,
        prompt: [
          `Kind: ${input.kind}`,
          `Now: ${new Date(input.now).toString()}`,
          `Canonical handoffs: ${JSON.stringify(
            handoffs.slice(0, 64).map((handoff) => ({
              id: handoff.id,
              protected: handoff.protected,
              lane: handoff.lane,
              situation: handoff.situation,
              assessment: handoff.assessment,
              recommendations: handoff.items.map((item) => item.recommendation),
            })),
          )}`,
          `Memory context: ${input.memoryContext.join(' | ') || 'none'}`,
          `Daily alignment: ${JSON.stringify(input.albatrossContext.dailyAlignment ?? null)}`,
        ].join('\n\n'),
      });
      narrative = stripEmoji(text.trim()) || narrative;
      model = describeProvider().primary || 'primary';
    } catch {}
  }

  const report: DailyReport = {
    _id: reportId,
    kind: input.kind,
    generatedAt: input.now,
    status: input.status ?? 'ready',
    progress: input.progress,
    accounts: input.accounts,
    services: input.services,
    title,
    narrative: stripEmoji(narrative),
    handoffs,
    sections,
    stats,
    model,
    errors: input.errors,
  };
  return report;
}

function localHandoffNarrative(
  kind: DailyReport['kind'],
  handoffs: NonNullable<DailyReport['handoffs']>,
): string {
  const opener =
    kind === 'evening'
      ? "Tonight's wrap-up:"
      : kind === 'morning'
        ? "This morning's brief:"
        : "Here's where things stand:";
  if (!handoffs.length) return `${opener} a quiet day — no open handoff needs your attention.`;
  const protectedCount = handoffs.filter((handoff) => handoff.protected).length;
  const lead = handoffs[0];
  const countLine = protectedCount
    ? `${protectedCount} ${protectedCount === 1 ? 'handoff needs' : 'handoffs need'} you`
    : `${handoffs.length} ${handoffs.length === 1 ? 'handoff is' : 'handoffs are'} worth keeping in view`;
  return `${opener} ${countLine}. Start with ${lead.situation}: ${lead.recommendation}`;
}

function contextScope(ts: number, now: number): 'week' | 'month' {
  return ts >= now - WEEK_CONTEXT_WINDOW && ts <= now + WEEK_CONTEXT_WINDOW ? 'week' : 'month';
}

function calendarContextLine(event: DailyReportCalendarItem) {
  const start = new Date(event.startAt).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: event.allDay ? undefined : 'numeric',
    minute: event.allDay ? undefined : '2-digit',
  });
  return `${event.title} at ${start}${event.location ? `, ${event.location}` : ''}`;
}

// Items from the user's brief-enabled connected-tool connections.
// Best-effort: a connector hiccup must never break the brief.
async function loadMcpContext(userId: string | null | undefined): Promise<DailyReportMcpItem[]> {
  if (!userId) return [];
  try {
    const rows = await convexQuery<any[]>((api as any).mcp.listItemsForBrief, { userId, limit: 25 });
    return (rows || []).map((row) => ({
      server: row.server,
      kind: row.kind,
      title: row.title,
      state: row.state ?? null,
      author: row.author ?? null,
      url: row.url ?? null,
      updatedAt: row.updatedAtSource ?? null,
    }));
  } catch {
    return [];
  }
}

async function loadTaskContext(
  userId: string | null | undefined,
  now: number,
): Promise<DailyReportTaskItem[]> {
  if (!userId) return [];
  try {
    const dismissedTaskIds = await listDismissedDailyReportTaskIds().catch(() => new Set<string>());
    const rows = await convexQuery<any[]>((api as any).boards.listReportCards, {
      userId,
      since: now - MONTH_CONTEXT_WINDOW,
      endAt: now + FUTURE_CONTEXT_WINDOW,
      limit: 500,
    });
    return rows
      .filter((card) => !dismissedTaskIds.has(String(card.cardId)))
      .map((card) => {
        const source = card.source || {};
        const sourceUrl = source.url || source.htmlLink;
        const sourceTitle =
          source.title || (source.threadId ? 'Email thread' : source.eventId ? 'Calendar event' : undefined);
        return {
          cardId: String(card.cardId),
          boardId: String(card.boardId),
          columnId: String(card.columnId),
          boardTitle: card.boardTitle,
          columnName: card.columnName,
          title: stripEmoji(String(card.title || 'Untitled task')),
          description: card.description ? stripEmoji(String(card.description)).slice(0, 500) : undefined,
          dueAt: card.dueAt ?? null,
          completedAt: card.completedAt ?? null,
          priority: card.priority,
          labels: card.labels || [],
          assignees: card.assignees || [],
          sourceTitle,
          sourceUrl,
          source,
          sourceThreadId: card.sourceThreadId,
          sourceCalendarEventId: card.sourceCalendarEventId,
          sourceAccountId: card.sourceAccountId,
          scope: contextScope(card.dueAt || card.updatedAt || card.createdAt || now, now),
        } satisfies DailyReportTaskItem;
      })
      .sort((a, b) => {
        const aDone = a.completedAt ? 1 : 0;
        const bDone = b.completedAt ? 1 : 0;
        if (aDone !== bDone) return aDone - bDone;
        if (a.scope !== b.scope) return a.scope === 'week' ? -1 : 1;
        const aDue = a.dueAt ?? Number.POSITIVE_INFINITY;
        const bDue = b.dueAt ?? Number.POSITIVE_INFINITY;
        if (aDue !== bDue) return aDue - bDue;
        return a.title.localeCompare(b.title);
      });
  } catch (err) {
    console.warn('Daily report task context failed:', err);
    return [];
  }
}

// The UTC instant of the most recent local midnight in `tz`. Uses the tz offset
// at `at` (accurate except across a DST flip mid-day, which is acceptable here).
function startOfLocalDay(at: number, tz: string): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(new Date(at));
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
    const asIfUtc = Date.UTC(
      get('year'),
      get('month') - 1,
      get('day'),
      get('hour') === 24 ? 0 : get('hour'),
      get('minute'),
      get('second'),
    );
    const offset = asIfUtc - at; // local wall-clock minus real UTC
    const localMidnight = asIfUtc - (asIfUtc % 86_400_000);
    return localMidnight - offset;
  } catch {
    return at - (at % 86_400_000);
  }
}

async function loadCalendarContext(
  userId: string | null | undefined,
  now: number,
): Promise<DailyReportCalendarItem[]> {
  if (!userId) return [];
  try {
    // The brief is forward-looking: calendar matters for what's AHEAD, not the
    // past. Window = start of today → +7 days, anchored to the USER's local
    // midnight (not UTC) so the window isn't shifted for non-UTC users.
    const tz = getAiRequestContext().userTimezone || 'UTC';
    const startOfToday = startOfLocalDay(now, tz);
    const rows = await convexQuery<any[]>((api as any).calendarData.listEvents, {
      userId,
      startAt: startOfToday,
      endAt: startOfToday + 8 * 86_400_000,
      limit: 500,
    });
    return rows
      .map((event) => ({
        account: event.accountId,
        eventId: event.providerEventId,
        calendarId: event.providerCalendarId,
        calendarName: event.calendarName,
        title: stripEmoji(String(event.title || 'Untitled event')),
        startAt: Number(event.startAt),
        endAt: Number(event.endAt),
        allDay: Boolean(event.allDay),
        location: event.location ? stripEmoji(String(event.location)) : undefined,
        htmlLink: event.htmlLink,
        description: event.description ? stripEmoji(String(event.description)).slice(0, 500) : undefined,
        scope: contextScope(Number(event.startAt), now),
      }))
      .sort((a, b) => {
        if (a.scope !== b.scope) return a.scope === 'week' ? -1 : 1;
        return a.startAt - b.startAt;
      });
  } catch (err) {
    console.warn('Daily report calendar context failed:', err);
    return [];
  }
}

async function loadMemoryContext() {
  const memories = await listMemories().catch(() => []);
  return memories.slice(0, 80).map((memory) => `${memory.email}: ${stripEmoji(memory.notes).slice(0, 600)}`);
}

function threadText(thread: Thread, messages: Message[], maxChars: number) {
  const msgText = messages
    .slice(-8)
    .map(
      (m, index) =>
        `Message ${index + 1}\nFrom: ${m.from}\nTo: ${m.to}\nDate: ${new Date(Number(m.date || 0)).toString()}\nSubject: ${m.subject}\n\n${m.textBody || m.snippet || ''}`,
    )
    .join('\n\n');
  return [`Thread: ${thread.subject}`, `From: ${thread.fromAddress}`, `Snippet: ${thread.snippet}`, msgText]
    .join('\n\n')
    .slice(0, maxChars);
}

function extractPeople(thread: Thread, messages: Message[], self: Set<string>) {
  const values = [
    thread.fromAddress,
    ...messages.flatMap((message) => [message.from, message.to, message.cc]),
  ];
  const names = new Set<string>();
  for (const value of values) {
    for (const part of String(value || '').split(',')) {
      const email = emailFromHeader(part)?.toLowerCase();
      if (email && self.has(email)) continue;
      const label = shortFrom(part);
      if (label) names.add(label);
    }
  }
  return [...names].slice(0, 5);
}

// ---- Local (no-AI) briefing copy -------------------------------------------
// When the AI analyst isn't available (or a thread is below the enrichment
// cap), these pure helpers compose a real briefing line from concrete signals
// so the report still reads like a human wrote it. All deterministic.

function personName(raw: string): string {
  const clean = stripEmoji(shortFrom(raw || '')).trim();
  if (!clean) return '';
  if (clean.includes('@') && !/\s/.test(clean)) {
    const local = clean
      .split('@')[0]
      .replace(/[._-]+/g, ' ')
      .trim();
    return local ? local.replace(/\b\w/g, (c) => c.toUpperCase()) : clean;
  }
  return clean;
}

function subjectClause(subject: string): string {
  return stripEmoji(String(subject || ''))
    .replace(/^(re|fwd|fw):\s*/i, '')
    .trim()
    .slice(0, 80)
    .replace(/[\s,;:.-]+$/, '');
}

function relativeDue(dueAt: number, now: number): string {
  const date = new Date(dueAt);
  const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(date);
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diffDays = Math.round((startOfDay(date) - startOfDay(new Date(now))) / 86400_000);
  if (diffDays <= 0) return `today at ${time}`;
  if (diffDays === 1) return `tomorrow at ${time}`;
  if (diffDays < 7)
    return `${new Intl.DateTimeFormat(undefined, { weekday: 'long' }).format(date)} at ${time}`;
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date);
}

function localReason(input: {
  people: string[];
  subject: string;
  commitments: ThreadInsight['commitments'];
  needsReply: boolean;
  waitingOnSomeone: boolean;
  smart: SmartCategory | null;
  now: number;
}): string {
  const who = personName(input.people[0] || '');
  const about = subjectClause(input.subject);
  const due = input.commitments.find((c) => c.dueAt && (c.dueAt as number) >= input.now);

  let line: string;
  if (input.needsReply) {
    if (who && about) line = `${who} is waiting on a reply about ${about}.`;
    else if (who) line = `${who} is waiting on a reply.`;
    else if (about) line = `A reply is needed about ${about}.`;
    else line = 'This thread is waiting on a reply.';
  } else if (input.waitingOnSomeone) {
    if (who && about) line = `You replied to ${who} about ${about} — no response yet.`;
    else if (who) line = `You replied to ${who} — no response yet.`;
    else if (about) line = `Awaiting a response about ${about}.`;
    else line = 'Awaiting a response — consider a nudge.';
  } else if (due?.dueAt) {
    const when = relativeDue(due.dueAt, input.now);
    if (who) line = `${who}: due ${when}${about ? ` — ${about}` : ''}.`;
    else line = `Due ${when}${about ? ` — ${about}` : ''}.`;
  } else {
    switch (input.smart?.primary) {
      case 'finance_admin':
        line = about
          ? `Admin or finance item worth a check: ${about}.`
          : 'Admin or finance item worth a quick check.';
        break;
      case 'orders':
        line = about ? `Order or shipping update: ${about}.` : 'Order or shipping update to confirm.';
        break;
      case 'codes':
        line = 'Verification or access code.';
        break;
      case 'review':
        line = about ? `Flagged for a closer look: ${about}.` : 'Flagged for a closer look.';
        break;
      default:
        if (who) line = `Active conversation with ${who}${about ? ` about ${about}` : ''}.`;
        else if (about) line = `Active thread: ${about}.`;
        else line = 'Active conversation worth tracking.';
    }
  }
  return stripEmoji(line).slice(0, 280);
}

// Generic reasons we'd rather replace with a composed line for tracked items.
const GENERIC_REASON =
  /^(unread|read)\b|direct conversation from a person|recent or tracked thread|^important thread/i;

function trackedReason(item: TrackedThread, now: number): string {
  const reason = stripEmoji(item.reason || '');
  if (reason && !GENERIC_REASON.test(reason)) return reason.slice(0, 280);
  const who = personName(item.participants[0] || '');
  const about = subjectClause(item.subject);
  if (item.dueAt && item.dueAt >= now) {
    const when = relativeDue(item.dueAt, now);
    return stripEmoji(`${who ? `${who}: ` : ''}due ${when}${about ? ` — ${about}` : ''}.`).slice(0, 280);
  }
  if (item.nextAction) {
    return stripEmoji(`Next: ${item.nextAction}${who ? ` (with ${who})` : ''}.`).slice(0, 280);
  }
  if (item.status === 'waiting') {
    return stripEmoji(
      who
        ? `Waiting on ${who}${about ? ` about ${about}` : ''}.`
        : `Waiting on a reply${about ? ` about ${about}` : ''}.`,
    ).slice(0, 280);
  }
  return stripEmoji(
    who ? `Tracking ${who}${about ? ` — ${about}` : ''}.` : `Tracking: ${about || 'open thread'}.`,
  ).slice(0, 280);
}

function extractCommitments(text: string, now: number) {
  const commitments: ThreadInsight['commitments'] = [];
  const lines = text
    .split(/\n+/)
    .filter((line) =>
      /\b(call|interview|offer|deadline|due|sign|send|meet|meeting|tuesday|monday|wednesday|thursday|friday|tomorrow|today)\b/i.test(
        line,
      ),
    );
  for (const line of lines.slice(0, 8)) {
    commitments.push({
      text: line.trim().slice(0, 220),
      dueAt: inferDueAt(line, now),
      confidence: 0.58,
    });
  }
  return commitments;
}

function inferDueAt(text: string, now: number) {
  const lower = text.toLowerCase();
  const timeMatch = lower.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/);
  const base = new Date(now);
  if (lower.includes('tomorrow')) base.setDate(base.getDate() + 1);
  const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const weekday = weekdays.findIndex((day) => lower.includes(day));
  if (weekday >= 0) {
    const diff = (weekday - base.getDay() + 7) % 7 || 7;
    base.setDate(base.getDate() + diff);
  }
  if (timeMatch) {
    let hour = Number(timeMatch[1]);
    const minute = Number(timeMatch[2] || 0);
    const ampm = timeMatch[3];
    if (ampm === 'pm' && hour < 12) hour += 12;
    if (ampm === 'am' && hour === 12) hour = 0;
    base.setHours(hour, minute, 0, 0);
    return base.getTime();
  }
  if (weekday >= 0 || lower.includes('tomorrow') || lower.includes('today')) {
    base.setHours(17, 0, 0, 0);
    return base.getTime();
  }
  return null;
}

function parseJson(text: string) {
  try {
    const match = text.match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : null;
  } catch {
    return null;
  }
}
