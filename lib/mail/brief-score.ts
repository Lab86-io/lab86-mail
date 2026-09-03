// Deterministic brief scoring. This module runs before any model call and has
// no I/O. It decides which mail threads earn a place in the Daily Brief and in
// which lane they sit. Decided by Jakob on 2026-09-03 (refinement round, Wave C).

export type BriefPlanTier = 'free' | 'pro' | 'team';

// Mail items per edition, by plan tier. Calendar events in the `today` lane do
// not count against this budget.
export const BRIEF_ITEM_BUDGET: Record<BriefPlanTier, number> = { free: 5, pro: 7, team: 9 };

export type BriefLane = 'answer' | 'today' | 'know';

export const BRIEF_LANES: readonly BriefLane[] = ['answer', 'today', 'know'] as const;

// Per-lane caps. `today` has no cap of its own; the budget bounds it.
export const BRIEF_LANE_CAPS: Partial<Record<BriefLane, number>> = { answer: 3, know: 3 };

// Weights from the refinement doc. `needsReply` maps the doc's llmCategory rule
// onto the real Smart Category enum: `needs_reply` is the only reply-shaped
// value that exists, and the deadline signal covers commitments.
export const BRIEF_SCORE_WEIGHTS = {
  directToYou: 3,
  repliedBefore: 3,
  participated: 2,
  deadlineWithin48h: 3,
  needsReply: 2,
  bulkSender: -4,
} as const;

export const DEADLINE_WINDOW_MS = 48 * 60 * 60 * 1000;

export interface BriefScoreSignals {
  // The newest inbound message names one of the user's addresses in To.
  directToYou: boolean;
  // The user has sent mail to this sender (or the sender's domain) before.
  repliedBefore: boolean;
  // The thread holds at least one message from the user.
  participated: boolean;
  // A due date sits inside the next 48 hours.
  deadlineWithin48h: boolean;
  // The classifier put `needs_reply` in the primary or secondary category.
  needsReply: boolean;
  // A list or bulk sender signal (unsubscribe header, list id).
  bulkSender: boolean;
}

export function scoreBriefCandidate(signals: BriefScoreSignals): number {
  let score = 0;
  if (signals.directToYou) score += BRIEF_SCORE_WEIGHTS.directToYou;
  if (signals.repliedBefore) score += BRIEF_SCORE_WEIGHTS.repliedBefore;
  if (signals.participated) score += BRIEF_SCORE_WEIGHTS.participated;
  if (signals.deadlineWithin48h) score += BRIEF_SCORE_WEIGHTS.deadlineWithin48h;
  if (signals.needsReply) score += BRIEF_SCORE_WEIGHTS.needsReply;
  if (signals.bulkSender) score += BRIEF_SCORE_WEIGHTS.bulkSender;
  return score;
}

export interface BriefSignalInput {
  // Lower-cased addresses the newest inbound message was sent To (not Cc).
  newestInboundTo: string[];
  // Lower-cased addresses that belong to the user.
  selfAddresses: Iterable<string>;
  // Lower-cased address of the person the user talks to in this thread.
  counterparty: string | null | undefined;
  // Lower-cased addresses and domains the user has written to before.
  sentAllowlist: Set<string>;
  // Count of messages in the thread that the user sent.
  outboundCount: number;
  // Every due date attached to the thread (commitments, tracked due date).
  dueAts: Array<number | null | undefined>;
  now: number;
  smartPrimary?: string | null;
  smartSecondary?: string[] | null;
  bulkReasons?: string[] | null;
  // The floor's automated verdict (no-reply sender, Gmail promotions, updates,
  // social, or a one-way blast). Counts as a bulk sender.
  automated?: boolean;
}

// Pure derivation of the six signals from plain values. The generator maps
// its thread, message, floor, and classifier state into this shape.
export function briefScoreSignals(input: BriefSignalInput): BriefScoreSignals {
  const self = new Set([...input.selfAddresses].map((value) => value.toLowerCase()));
  const directToYou = input.newestInboundTo.some((address) => self.has(address.toLowerCase()));
  const counterparty = (input.counterparty || '').toLowerCase();
  const domain = counterparty.split('@')[1] || '';
  const repliedBefore =
    Boolean(counterparty) &&
    (input.sentAllowlist.has(counterparty) || (Boolean(domain) && input.sentAllowlist.has(domain)));
  const participated = input.outboundCount > 0;
  const deadlineWithin48h = input.dueAts.some(
    (dueAt) => typeof dueAt === 'number' && dueAt >= input.now && dueAt < input.now + DEADLINE_WINDOW_MS,
  );
  const needsReply =
    input.smartPrimary === 'needs_reply' || Boolean(input.smartSecondary?.includes('needs_reply'));
  const bulkReasons = input.bulkReasons || [];
  const bulkSender =
    Boolean(input.automated) || bulkReasons.includes('unsubscribe') || bulkReasons.includes('bulk_or_list');
  return { directToYou, repliedBefore, participated, deadlineWithin48h, needsReply, bulkSender };
}

// The lane is a deterministic function of the floor and the signals. The
// model never moves an item between lanes.
export function assignBriefLane(input: {
  replyOwed: boolean;
  deadlineWithin48h: boolean;
  needsReply?: boolean;
}): BriefLane {
  if (input.replyOwed || input.needsReply) return 'answer';
  if (input.deadlineWithin48h) return 'today';
  return 'know';
}

export interface BriefItemCandidate {
  // Stable thread key, `${account}:${threadId}`.
  key: string;
  lane: BriefLane;
  score: number;
  receivedAt: number | null | undefined;
}

export interface BriefSelection<T extends BriefItemCandidate> {
  answer: T[];
  today: T[];
  know: T[];
  // Candidates that scored high enough but found no room.
  overflow: T[];
  // Candidates under the minimum score. The count feeds `stats.noise`.
  noise: T[];
}

export function budgetForTier(tier: BriefPlanTier | null | undefined): number {
  return BRIEF_ITEM_BUDGET[tier || 'pro'] ?? BRIEF_ITEM_BUDGET.pro;
}

// Top-K selection. Order: score descending, then receivedAt descending, then
// key ascending so the result is stable. One entry per thread key (the best
// score wins). Lane caps apply before the shared budget.
export function selectBriefItems<T extends BriefItemCandidate>(
  candidates: T[],
  budget: number,
  options: { minScore?: number } = {},
): BriefSelection<T> {
  const minScore = options.minScore ?? 1;
  const byKey = new Map<string, T>();
  for (const candidate of candidates) {
    const existing = byKey.get(candidate.key);
    if (!existing || compareCandidates(candidate, existing) < 0) byKey.set(candidate.key, candidate);
  }
  const ordered = [...byKey.values()].sort(compareCandidates);
  const selection: BriefSelection<T> = { answer: [], today: [], know: [], overflow: [], noise: [] };
  let used = 0;
  for (const candidate of ordered) {
    if (candidate.score < minScore) {
      selection.noise.push(candidate);
      continue;
    }
    const cap = BRIEF_LANE_CAPS[candidate.lane];
    const lane = selection[candidate.lane];
    if (used >= budget || (cap !== undefined && lane.length >= cap)) {
      selection.overflow.push(candidate);
      continue;
    }
    lane.push(candidate);
    used += 1;
  }
  return selection;
}

function compareCandidates(a: BriefItemCandidate, b: BriefItemCandidate): number {
  if (b.score !== a.score) return b.score - a.score;
  const aReceived = a.receivedAt ?? 0;
  const bReceived = b.receivedAt ?? 0;
  if (bReceived !== aReceived) return bReceived - aReceived;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}
