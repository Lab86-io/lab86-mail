import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { submitLapseRecovery } from '../components/albatross/Forgiveness';
import {
  isStale,
  LAPSE_REASONS,
  type LapseReason,
  lapseHeadline,
  RECOVERY_LABEL,
  type Recovery,
  recoveriesFor,
  recoveryAcknowledgement,
  recoveryWorkState,
  reEntryDaysAway,
  reEntryLine,
  reviewBatch,
  reviewHeadline,
  STALE_AFTER_DAYS,
  shouldOfferReEntry,
  shrinkSuggestion,
  type WorkShape,
} from '../lib/albatross/forgiveness';
import { isClosed, WORK_STATE_LABEL, WORK_STATE_ORDER, workStateKey } from '../lib/albatross/work-state';

const DAY = 24 * 3_600_000;
const NOW = new Date(2026, 7, 3, 12, 0).getTime();

describe('nothing in forgiveness blames the user', () => {
  // This is the whole point of the round. If any of these strings appear, the
  // product has quietly become a task manager that is polite about it.
  const BANNED = ['overdue', 'behind', 'late', 'missed', 'failed', 'failure', 'should have', 'streak'];

  const allCopy = [
    lapseHeadline(null),
    lapseHeadline('Complete the passport application'),
    shrinkSuggestion(null),
    shrinkSuggestion('Complete the passport application'),
    reviewHeadline(1),
    reviewHeadline(4),
    ...LAPSE_REASONS.map((item) => item.label),
    ...Object.values(RECOVERY_LABEL),
    ...(['move', 'shrink', 'wait', 'delegate', 'pause', 'release', 'rebuild'] as Recovery[]).map(
      recoveryAcknowledgement,
    ),
    ...[3, 10, 20, 40].map(reEntryLine),
  ];

  test('no copy uses the vocabulary of debt', () => {
    for (const line of allCopy) {
      for (const word of BANNED) {
        expect(line.toLowerCase()).not.toContain(word);
      }
    }
  });

  test('the lapse headline is about the plan, not the person', () => {
    expect(lapseHeadline(null)).toBe('That block passed. What should happen now?');
    expect(lapseHeadline('Book the appointment')).toContain('did not happen');
  });

  test('the shrink suggestion is a real smaller step, not encouragement', () => {
    const suggestion = shrinkSuggestion('Complete the entire passport application');
    expect(suggestion).toContain('five minutes');
    expect(suggestion.toLowerCase()).not.toContain('you can do it');
  });
});

describe('recoveries follow from the reason', () => {
  test('a step that was too large offers making it smaller first', () => {
    expect(recoveriesFor('step_too_large')[0]).toBe('shrink');
  });

  test('being blocked offers waiting, not trying harder', () => {
    expect(recoveriesFor('blocked')).toContain('wait');
    expect(recoveriesFor('blocked')).not.toContain('shrink');
  });

  test('caring less offers putting it down', () => {
    expect(recoveriesFor('matters_less_now')).toContain('release');
  });

  test('no reason still offers a way out', () => {
    expect(recoveriesFor(null).length).toBeGreaterThan(0);
  });

  test('every offered recovery has a label and an acknowledgement', () => {
    const reasons: Array<LapseReason | null> = [null, ...LAPSE_REASONS.map((item) => item.kind)];
    for (const reason of reasons) {
      for (const recovery of recoveriesFor(reason)) {
        expect(RECOVERY_LABEL[recovery]).toBeTruthy();
        expect(recoveryAcknowledgement(recovery)).toBeTruthy();
      }
    }
  });

  test('waiting, pausing, and releasing change authoritative Work state', () => {
    expect(recoveryWorkState('wait')).toBe('waiting');
    expect(recoveryWorkState('pause')).toBe('paused');
    expect(recoveryWorkState('release')).toBe('released');
    expect(recoveryWorkState('move')).toBeNull();
  });
});

describe('keyed lapse recovery requests', () => {
  test('sends the displayed step key and complete recovery context', async () => {
    let request: { url: string; body: Record<string, unknown> } | undefined;
    await submitLapseRecovery(
      {
        workId: 'passport/work',
        stepKey: 'official-site',
        recovery: 'shrink',
        timezone: 'America/New_York',
        stepTitle: 'Complete the official form',
        plannedAt: 1_786_700_000_000,
        reasonKind: 'step_too_large',
      },
      async (url, init) => {
        request = { url, body: JSON.parse(String(init.body)) };
        return Response.json({ ok: true });
      },
    );

    expect(request).toEqual({
      url: '/api/albatross/work/passport%2Fwork/recover',
      body: {
        recovery: 'shrink',
        stepKey: 'official-site',
        timezone: 'America/New_York',
        stepTitle: 'Complete the official form',
        plannedAt: 1_786_700_000_000,
        reasonKind: 'step_too_large',
      },
    });
  });

  test('surfaces non-OK and non-JSON responses', async () => {
    await expect(
      submitLapseRecovery(
        {
          workId: 'work-1',
          stepKey: 'step-1',
          recovery: 'move',
          timezone: 'UTC',
        },
        async () => new Response('<h1>bad gateway</h1>', { status: 502 }),
      ),
    ).rejects.toThrow('Could not save that.');
  });
});

describe('release is an ending, not a hiding place', () => {
  test('released is its own state, above archived', () => {
    expect(workStateKey({ workState: 'released' })).toBe('released');
    expect(WORK_STATE_LABEL.released).toBe('Put down');
    expect(WORK_STATE_LABEL.archived).toBe('Archived');
    expect(WORK_STATE_ORDER).toContain('released');
  });

  test('a released Albatross is closed, so it never nags', () => {
    expect(isClosed({ workState: 'released' })).toBe(true);
    expect(workStateKey({ workState: 'released', openQuestions: 2 })).toBe('unresolved');
  });

  test('the schema keeps release separate from archive', () => {
    // Collapsing them would make "you put twelve things down on purpose"
    // unreportable, which is the reason release exists as an ending at all.
    const schema = readFileSync('convex/schema.ts', 'utf8');
    expect(schema).toContain("v.literal('released')");
    expect(schema).toContain('releaseReason');
    expect(schema).toContain('releaseProposedBy');
  });
});

describe('staleness is per shape, not a flat ninety days', () => {
  const work = (over: Partial<Parameters<typeof isStale>[0]>) => ({
    shape: over.shape ?? ('project' as WorkShape),
    workState: 'workState' in over ? over.workState : 'active',
    updatedAt: over.updatedAt ?? NOW,
    reviewAt: over.reviewAt ?? null,
  });

  test('a small errand is asked about sooner than a long project', () => {
    expect(STALE_AFTER_DAYS.quick).toBeLessThan(STALE_AFTER_DAYS.project);
    expect(STALE_AFTER_DAYS.project).toBeLessThan(STALE_AFTER_DAYS.practice);
    expect(isStale(work({ shape: 'quick', updatedAt: NOW - 20 * DAY }), NOW)).toBe(true);
    expect(isStale(work({ shape: 'project', updatedAt: NOW - 20 * DAY }), NOW)).toBe(false);
  });

  test('waiting is an active state, never neglect', () => {
    // A government office taking eight weeks is not the user failing to act.
    expect(isStale(work({ workState: 'waiting', updatedAt: NOW - 300 * DAY }), NOW)).toBe(false);
    expect(isStale(work({ workState: 'blocked', updatedAt: NOW - 300 * DAY }), NOW)).toBe(false);
  });

  test('anything already ended is never asked about again', () => {
    for (const state of ['released', 'done', 'archived']) {
      expect(isStale(work({ workState: state, updatedAt: NOW - 400 * DAY }), NOW)).toBe(false);
    }
  });

  test('dormant Work sits still on purpose and is never reviewed', () => {
    const sleeping = {
      ...work({ shape: 'quick', updatedAt: NOW - 200 * DAY }),
      horizon: { kind: 'later' as const, notBefore: NOW + DAY },
    };
    const someday = {
      ...work({ shape: 'quick', updatedAt: NOW - 200 * DAY }),
      horizon: { kind: 'someday' as const },
    };
    const woken = {
      ...work({ shape: 'quick', updatedAt: NOW - 200 * DAY }),
      horizon: { kind: 'now' as const, notBefore: NOW - 2 * DAY, wokeAt: NOW - 2 * DAY },
    };
    expect(isStale(sleeping, NOW)).toBe(false);
    expect(isStale(someday, NOW)).toBe(false);
    expect(isStale(woken, NOW)).toBe(true);
    expect(reviewBatch([sleeping, someday, woken], NOW)).toEqual([woken]);
  });

  test('a pause-until date is honoured exactly', () => {
    const paused = work({ updatedAt: NOW - 300 * DAY, reviewAt: NOW + 5 * DAY });
    expect(isStale(paused, NOW)).toBe(false);
    expect(isStale({ ...paused, reviewAt: NOW - DAY }, NOW)).toBe(true);
  });
});

describe('the review is batched', () => {
  test('it asks about several at once, oldest first, and caps the ask', () => {
    const rows = Array.from({ length: 9 }, (_, index) => ({
      _id: `w${index}`,
      shape: 'quick' as WorkShape,
      workState: 'active',
      updatedAt: NOW - (100 - index) * DAY,
      reviewAt: null,
    }));
    const batch = reviewBatch(rows, NOW);
    expect(batch).toHaveLength(5);
    expect(batch[0]._id).toBe('w0');
    expect(batch[0].updatedAt).toBeLessThan(batch[4].updatedAt);
  });

  test('a quiet list produces no prompt at all', () => {
    expect(reviewBatch([{ workState: 'active', updatedAt: NOW }], NOW)).toEqual([]);
  });
});

describe('coming back after time away', () => {
  test('a few days away is not an event', () => {
    expect(shouldOfferReEntry(NOW - 3 * DAY, NOW)).toBe(false);
    expect(shouldOfferReEntry(null, NOW)).toBe(false);
  });

  test('a week or more is', () => {
    expect(shouldOfferReEntry(NOW - 8 * DAY, NOW)).toBe(true);
    expect(reEntryDaysAway(NOW - 30 * DAY, NOW)).toBe(30);
  });

  test('the greeting never counts what piled up', () => {
    for (const days of [7, 14, 30, 120]) {
      const line = reEntryLine(days);
      expect(line).toContain('Welcome back');
      expect(line).not.toMatch(/\d/);
    }
  });
});

describe('the surfaces use it', () => {
  test('the Albatross page offers putting it down', () => {
    const detail = readFileSync('components/albatross/WorkDetail.tsx', 'utf8');
    expect(detail).toContain('ReleaseSheet');
    expect(detail).toContain('Put it down');
  });

  test('the Work page carries the review, and Today does not', () => {
    const list = readFileSync('components/albatross/AlbatrossesSurface.tsx', 'utf8');
    const today = readFileSync('components/report/TodaySurface.tsx', 'utf8');
    expect(list).toContain('<ReviewBatch');
    expect(list.indexOf('<ReviewBatch')).toBeLessThan(list.indexOf('visibleGroups.map'));
    expect(today).not.toContain('ReviewBatch');
    expect(today).not.toContain('ReEntry');
  });

  test('the lapse record survives account deletion policy', () => {
    // A user-owned table that the cascade misses is a data-retention bug.
    expect(readFileSync('convex/accounts.ts', 'utf8')).toContain("'albatrossLapses'");
  });
});
