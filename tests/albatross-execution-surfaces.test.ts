import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LapsePrompt } from '../components/albatross/Forgiveness';
import { GuidedStepPane } from '../components/albatross/GuidedStep';
import {
  guideStepsWithOptimisticCompletion,
  type WorkDetailData,
  WorkDetailRecovery,
  workDetailRecoveryPrompt,
} from '../components/albatross/WorkDetail';
import { visibleExecutionNotifications } from '../components/shell/NotificationCenter';
import { CONTINUOUS_EXECUTION_CRON_NAMES } from '../convex/crons';

const repoRoot = join(import.meta.dir, '..');
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
  test('guided execution renders the current step, progress, context, and official URL', () => {
    const html = renderToStaticMarkup(
      createElement(GuidedStepPane, {
        steps: [
          {
            id: 'open-form',
            title: 'Open the official renewal form',
            detail: 'Use the government portal and stop before payment.',
            url: 'https://example.gov/renew',
            knows: ['Your appointment date'],
            needsYou: ['Review the legal declaration'],
            done: false,
          },
          {
            id: 'save-receipt',
            title: 'Save the receipt',
            knows: [],
            needsYou: [],
            done: false,
          },
        ],
        activeId: 'open-form',
        onComplete: () => undefined,
        onDiscuss: () => undefined,
      }),
    );

    expect(html).toContain('Guided work');
    expect(html).toContain('Open the official renewal form');
    expect(html).toContain('Use the government portal');
    expect(html).toContain('https://example.gov/renew');
    expect(html).toContain('Mark this step done');
    expect(html).toContain('Discuss this');
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
        createElement(WorkDetailRecovery, {
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
        createElement(WorkDetailRecovery, {
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
    const today = read('components/report/TodaySurface.tsx');
    const detail = read('components/albatross/WorkDetail.tsx');
    const calendar = read('components/calendar/CalendarSurface.tsx');
    // Today shows the day, the mail, and one next move. Recovery lives in the Work detail.
    expect(today).not.toContain('LapsePrompt');
    expect(today).not.toContain('missedMoves');
    expect(detail).toContain('<LapsePrompt');
    // Missed moves live only in the Work detail. The calendar grid has no banner.
    expect(calendar).not.toContain('LapsePrompt');
    expect(calendar).toContain('<SyncLine');
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
