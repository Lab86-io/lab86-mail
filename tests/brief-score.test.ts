import { describe, expect, test } from 'bun:test';
import {
  assignBriefLane,
  BRIEF_ITEM_BUDGET,
  BRIEF_LANE_CAPS,
  briefScoreSignals,
  budgetForTier,
  DEADLINE_WINDOW_MS,
  scoreBriefCandidate,
  selectBriefItems,
} from '../lib/mail/brief-score';

const NOW = Date.parse('2026-09-03T12:00:00Z');

function signals(overrides: Partial<ReturnType<typeof briefScoreSignals>> = {}) {
  return {
    directToYou: false,
    repliedBefore: false,
    participated: false,
    deadlineWithin48h: false,
    needsReply: false,
    bulkSender: false,
    ...overrides,
  };
}

describe('scoreBriefCandidate', () => {
  test('adds the documented weights', () => {
    expect(scoreBriefCandidate(signals())).toBe(0);
    expect(scoreBriefCandidate(signals({ directToYou: true }))).toBe(3);
    expect(scoreBriefCandidate(signals({ repliedBefore: true }))).toBe(3);
    expect(scoreBriefCandidate(signals({ participated: true }))).toBe(2);
    expect(scoreBriefCandidate(signals({ deadlineWithin48h: true }))).toBe(3);
    expect(scoreBriefCandidate(signals({ needsReply: true }))).toBe(2);
    expect(scoreBriefCandidate(signals({ bulkSender: true }))).toBe(-4);
  });

  test('a bulk sender that is direct to you still nets negative', () => {
    expect(scoreBriefCandidate(signals({ directToYou: true, bulkSender: true }))).toBe(-1);
  });

  test('a full-signal thread reaches the maximum', () => {
    expect(
      scoreBriefCandidate(
        signals({
          directToYou: true,
          repliedBefore: true,
          participated: true,
          deadlineWithin48h: true,
          needsReply: true,
        }),
      ),
    ).toBe(13);
  });
});

describe('briefScoreSignals', () => {
  const base = {
    newestInboundTo: ['jakob@example.test'],
    selfAddresses: ['jakob@example.test'],
    counterparty: 'maya@partner.test',
    sentAllowlist: new Set<string>(),
    outboundCount: 0,
    dueAts: [],
    now: NOW,
  };

  test('detects direct-to-you from the To header, case-insensitive', () => {
    expect(briefScoreSignals({ ...base, newestInboundTo: ['JAKOB@example.test'] }).directToYou).toBe(true);
    expect(briefScoreSignals({ ...base, newestInboundTo: ['other@example.test'] }).directToYou).toBe(false);
  });

  test('detects a replied-to sender by address or domain', () => {
    expect(briefScoreSignals({ ...base, sentAllowlist: new Set(['maya@partner.test']) }).repliedBefore).toBe(
      true,
    );
    expect(briefScoreSignals({ ...base, sentAllowlist: new Set(['partner.test']) }).repliedBefore).toBe(true);
    expect(
      briefScoreSignals({ ...base, counterparty: null, sentAllowlist: new Set(['partner.test']) })
        .repliedBefore,
    ).toBe(false);
  });

  test('participation follows the outbound count', () => {
    expect(briefScoreSignals({ ...base, outboundCount: 2 }).participated).toBe(true);
    expect(briefScoreSignals(base).participated).toBe(false);
  });

  test('deadline window is 48 hours forward, never backward', () => {
    expect(briefScoreSignals({ ...base, dueAts: [NOW + 3_600_000] }).deadlineWithin48h).toBe(true);
    expect(briefScoreSignals({ ...base, dueAts: [NOW + DEADLINE_WINDOW_MS] }).deadlineWithin48h).toBe(false);
    expect(briefScoreSignals({ ...base, dueAts: [NOW - 1] }).deadlineWithin48h).toBe(false);
    expect(briefScoreSignals({ ...base, dueAts: [null, undefined] }).deadlineWithin48h).toBe(false);
  });

  test('needs_reply counts from the primary or the secondary category', () => {
    expect(briefScoreSignals({ ...base, smartPrimary: 'needs_reply' }).needsReply).toBe(true);
    expect(
      briefScoreSignals({ ...base, smartPrimary: 'main', smartSecondary: ['needs_reply'] }).needsReply,
    ).toBe(true);
    expect(briefScoreSignals({ ...base, smartPrimary: 'finance_admin' }).needsReply).toBe(false);
  });

  test('bulk sender follows the reliable list signals only', () => {
    expect(briefScoreSignals({ ...base, bulkReasons: ['unsubscribe'] }).bulkSender).toBe(true);
    expect(briefScoreSignals({ ...base, bulkReasons: ['bulk_or_list'] }).bulkSender).toBe(true);
    expect(briefScoreSignals({ ...base, bulkReasons: ['subject_offer'] }).bulkSender).toBe(false);
    expect(briefScoreSignals({ ...base, automated: true }).bulkSender).toBe(true);
  });
});

describe('assignBriefLane', () => {
  test('reply owed wins, then deadlines, then know', () => {
    expect(assignBriefLane({ replyOwed: true, deadlineWithin48h: true })).toBe('answer');
    expect(assignBriefLane({ replyOwed: false, needsReply: true, deadlineWithin48h: false })).toBe('answer');
    expect(assignBriefLane({ replyOwed: false, deadlineWithin48h: true })).toBe('today');
    expect(assignBriefLane({ replyOwed: false, deadlineWithin48h: false })).toBe('know');
  });
});

describe('budgetForTier', () => {
  test('maps tiers and defaults to pro', () => {
    expect(budgetForTier('free')).toBe(BRIEF_ITEM_BUDGET.free);
    expect(budgetForTier('team')).toBe(BRIEF_ITEM_BUDGET.team);
    expect(budgetForTier(undefined)).toBe(BRIEF_ITEM_BUDGET.pro);
    expect(budgetForTier(null)).toBe(7);
  });
});

describe('selectBriefItems', () => {
  const item = (key: string, lane: 'answer' | 'today' | 'know', score: number, receivedAt = 0) => ({
    key,
    lane,
    score,
    receivedAt,
  });

  test('fills top-K by score inside the budget', () => {
    const picked = selectBriefItems(
      [item('a', 'know', 5), item('b', 'know', 8), item('c', 'today', 3), item('d', 'today', 6)],
      3,
    );
    expect(picked.know.map((entry) => entry.key)).toEqual(['b', 'a']);
    expect(picked.today.map((entry) => entry.key)).toEqual(['d']);
    expect(picked.overflow.map((entry) => entry.key)).toEqual(['c']);
    expect(picked.noise).toEqual([]);
  });

  test('applies lane caps for answer and know before the budget', () => {
    const picked = selectBriefItems(
      [
        item('a1', 'answer', 9),
        item('a2', 'answer', 9),
        item('a3', 'answer', 9),
        item('a4', 'answer', 9),
        item('k1', 'know', 4),
      ],
      9,
    );
    expect(picked.answer).toHaveLength(BRIEF_LANE_CAPS.answer!);
    expect(picked.overflow.map((entry) => entry.key)).toEqual(['a4']);
    expect(picked.know.map((entry) => entry.key)).toEqual(['k1']);
  });

  test('breaks ties by receivedAt descending, then key', () => {
    const picked = selectBriefItems(
      [item('old', 'know', 5, 10), item('new', 'know', 5, 20), item('mid', 'know', 5, 15)],
      2,
    );
    expect(picked.know.map((entry) => entry.key)).toEqual(['new', 'mid']);
    const tied = selectBriefItems([item('b', 'know', 5, 1), item('a', 'know', 5, 1)], 1);
    expect(tied.know.map((entry) => entry.key)).toEqual(['a']);
  });

  test('dedupes by thread key and keeps the best entry', () => {
    const picked = selectBriefItems(
      [item('t', 'know', 2, 5), item('t', 'answer', 6, 1), item('t', 'know', 6, 9)],
      5,
    );
    expect(picked.answer).toEqual([]);
    expect(picked.know).toEqual([item('t', 'know', 6, 9)]);
  });

  test('drops items under the minimum score into noise', () => {
    const picked = selectBriefItems(
      [item('bulk', 'know', -4), item('flat', 'know', 0), item('ok', 'know', 1)],
      5,
    );
    expect(picked.know.map((entry) => entry.key)).toEqual(['ok']);
    expect(picked.noise.map((entry) => entry.key)).toEqual(['flat', 'bulk']);
    const lenient = selectBriefItems([item('flat', 'know', 0)], 5, { minScore: 0 });
    expect(lenient.know).toHaveLength(1);
  });

  test('a zero budget selects nothing', () => {
    const picked = selectBriefItems([item('a', 'answer', 9)], 0);
    expect(picked.answer).toEqual([]);
    expect(picked.overflow).toHaveLength(1);
  });
});
