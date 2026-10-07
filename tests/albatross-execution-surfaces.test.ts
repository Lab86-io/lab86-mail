import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LapsePrompt } from '../components/albatross/Forgiveness';
import { PlanIntro } from '../components/albatross/thread/PlanIntro';
import { visibleExecutionNotifications } from '../components/shell/NotificationCenter';
import { CONTINUOUS_EXECUTION_CRON_NAMES } from '../convex/crons';
import { planStepRows } from '../lib/albatross/thread-view';
import {
  guideStepsWithOptimisticCompletion,
  type WorkDetailData,
  workDetailRecoveryPrompt,
} from '../lib/albatross/work-view';

const repoRoot = join(import.meta.dir, '..');

/** The thread mounts LapsePrompt from the same prompt helper. */
function RecoveryForTest({
  detail,
  workId,
  nowMs,
}: {
  detail: WorkDetailData;
  workId: string;
  nowMs: number;
}) {
  const prompt = workDetailRecoveryPrompt(detail, workId, nowMs);
  return prompt ? createElement(LapsePrompt, prompt) : null;
}
const read = (relative: string) => readFileSync(join(repoRoot, relative), 'utf8');

function workDetail(endAt: number, workState = 'active'): WorkDetailData {
  return {
    work: {
      _id: 'passport',
      title: 'Renew passport',
      rawText: 'Renew my passport',
      status: 'ready',
      workState,
      updatedAt: 1,
    },
    plan: null,
    project: null,
    questions: [],
    areaLinks: [],
    execution: {
      currentStep: {
        key: 'official-form',
        kind: 'task',
        title: 'Complete the passport form',
        detail: null,
        url: null,
        done: false,
        cardId: null,
      },
      guideSteps: [],
      remainingSteps: 1,
      totalSteps: 4,
      scheduledStartAt: 1_786_700_000_000,
      scheduledEndAt: endAt,
    },
    contract: null,
    evidence: [],
    application: null,
  };
}

describe('the execution loop owns the visible product surfaces', () => {
  test('the thread plan block renders the steps, the current one with Handle it, and the offline one as yours', () => {
    const steps: WorkDetailData['execution']['guideSteps'] = [
      {
        key: 'open-form',
        kind: 'task',
        title: 'Open the official renewal form',
        detail: 'Use the government portal and stop before payment.',
        url: 'https://example.gov/renew',
        done: false,
        cardId: null,
        stepMode: 'agent_does',
        runnable: true,
      },
      {
        key: 'save-receipt',
        kind: 'physical',
        title: 'Save the receipt',
        detail: null,
        url: null,
        done: false,
        cardId: null,
        stepMode: 'you_do_offline',
      },
    ];
    const html = renderToStaticMarkup(
      createElement(PlanIntro, {
        outcome: 'Renew the passport',
        steps: planStepRows(steps, { runnerEnabled: true }),
        state: 'ready',
        onHandle: () => undefined,
      }),
    );

    expect(html).toContain('What Albatross understood');
    expect(html).toContain('Open the official renewal form');
    expect(html).toContain('Save the receipt');
    expect(html).toContain('Handle it');
    expect(html).toContain('Yours, offline');
  });

  test('guided execution checks a step locally before the server projection refreshes', () => {
    const steps: WorkDetailData['execution']['guideSteps'] = [
      {
        key: 'one',
        kind: 'task',
        title: 'First step',
        detail: null,
        url: null,
        done: false,
        cardId: null,
      },
      {
        key: 'two',
        kind: 'task',
        title: 'Second step',
        detail: null,
        url: null,
        done: false,
        cardId: null,
      },
    ];

    const optimistic = guideStepsWithOptimisticCompletion(steps, new Set(['one']));
    expect(optimistic.map((step) => step.done)).toEqual([true, false]);
    expect(steps.map((step) => step.done)).toEqual([false, false]);
  });

  test('missed work renders keyed recovery controls', () => {
    const html = renderToStaticMarkup(
      createElement(LapsePrompt, {
        workId: 'passport',
        stepKey: 'official-form',
        stepTitle: 'Complete the passport form',
        plannedAt: 1_786_700_000_000,
      }),
    );

    expect(html).toContain('Complete the passport form');
    expect(html).toContain('Nothing is lost');
    expect(html).toContain('Find another time');
    expect(html).toContain('Make it smaller');
  });

  test('Work Detail surfaces recovery only after an open block has passed', () => {
    const nowMs = 1_786_700_100_000;
    const elapsed = workDetail(nowMs - 1);
    expect(workDetailRecoveryPrompt(elapsed, 'passport', nowMs)).toEqual({
      workId: 'passport',
      stepKey: 'official-form',
      stepTitle: 'Complete the passport form',
      plannedAt: 1_786_700_000_000,
    });
    expect(
      renderToStaticMarkup(
        createElement(RecoveryForTest, {
          detail: elapsed,
          workId: 'passport',
          nowMs,
        }),
      ),
    ).toContain('Complete the passport form');

    expect(workDetailRecoveryPrompt(workDetail(nowMs + 1), 'passport', nowMs)).toBeNull();
    expect(workDetailRecoveryPrompt(workDetail(nowMs - 1, 'done'), 'passport', nowMs)).toBeNull();
    expect(
      renderToStaticMarkup(
        createElement(RecoveryForTest, {
          detail: workDetail(nowMs - 1, 'archived'),
          workId: 'passport',
          nowMs,
        }),
      ),
    ).toBe('');
  });

  test('the notification projection leaves mail in Mail', () => {
    expect(
      visibleExecutionNotifications([
        { type: 'mail_message', id: 'mail' },
        { type: 'urgent_mail', id: 'urgent' },
        { type: 'work_update', id: 'work' },
        { type: 'daily_checkin', id: 'checkin' },
        // The wake has its own nudge in the shell. The bell does not repeat it.
        { type: 'work_wake', id: 'wake' },
      ]).map((row) => row.id),
    ).toEqual(['work', 'checkin']);
  });

  test('guided work and recovery are mounted on every execution surface', () => {
    const today = read('components/report/Today.tsx');
    const detail = read('components/albatross/WorkThread.tsx');
    const calendar = read('components/calendar/CalendarSurface.tsx');
    // Today shows the day, the mail, and one next move. Recovery lives in the Work thread.
    expect(today).not.toContain('LapsePrompt');
    expect(today).not.toContain('missedMoves');
    expect(detail).toContain('<LapsePrompt');
    // Missed moves live only in the Work thread. The calendar grid has no banner.
    expect(calendar).not.toContain('LapsePrompt');
    expect(calendar).toContain('<SyncStatus');
    expect(calendar).toContain('<SyncStatus');
    expect(existsSync(join(repoRoot, 'components/albatross/IntentPip.tsx'))).toBe(false);
  });

  test('continuous execution cron registrations remain visible and separate', () => {
    expect(Object.values(CONTINUOUS_EXECUTION_CRON_NAMES)).toEqual([
      'Work scheduling conductor',
      'check-in reflection reconciliation',
      'tomorrow planning conductor',
      'evidence reconciliation conductor',
      'step mail watch conductor',
      'passed block recovery',
      'shape-aware Work review',
      'horizon wake',
    ]);
  });
});
