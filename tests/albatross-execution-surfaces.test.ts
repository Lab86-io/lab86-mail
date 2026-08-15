import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LapsePrompt } from '../components/albatross/Forgiveness';
import { GuidedStepPane } from '../components/albatross/GuidedStep';
import { keyedMissedMoves, MissedMovesRecoverySection } from '../components/report/TodaySurface';
import { visibleExecutionNotifications } from '../components/shell/NotificationCenter';

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

  test('the notification projection leaves mail in Mail', () => {
    expect(
      visibleExecutionNotifications([
        { type: 'mail_message', id: 'mail' },
        { type: 'urgent_mail', id: 'urgent' },
        { type: 'work_update', id: 'work' },
        { type: 'daily_checkin', id: 'checkin' },
      ]).map((row) => row.id),
    ).toEqual(['work', 'checkin']);
  });

  test('the keyed missed-move projection rejects legacy and blank keys', () => {
    expect(
      keyedMissedMoves([
        { workId: 'legacy', stepKey: null },
        { workId: 'blank', stepKey: '' },
      ]),
    ).toEqual([]);
  });

  test('an all-unkeyed missed list renders no recovery section or controls', () => {
    const html = renderToStaticMarkup(
      createElement(MissedMovesRecoverySection, {
        moves: [
          {
            workId: 'legacy',
            stepKey: null,
            stepTitle: 'Legacy move',
            scheduledStartAt: null,
          },
          {
            workId: 'blank',
            stepKey: '',
            stepTitle: 'Blank move',
            scheduledStartAt: null,
          },
        ],
      }),
    );

    expect(html).toBe('');
    expect(html).not.toContain('The plan slipped');
    expect(html).not.toContain('Find another time');
  });

  test('guided work and recovery are mounted on every execution surface', () => {
    const detail = readFileSync('components/albatross/WorkDetail.tsx', 'utf8');
    const today = readFileSync('components/report/TodaySurface.tsx', 'utf8');
    const calendar = readFileSync('components/calendar/CalendarSurface.tsx', 'utf8');
    expect(detail).toContain('<GuidedStepPane');
    expect(detail).toContain('<LapsePrompt');
    expect(today).toContain('<LapsePrompt');
    expect(calendar).toContain('<LapsePrompt');
    expect(existsSync('components/albatross/IntentPip.tsx')).toBe(false);
  });

  test('continuous execution cron registrations remain visible and separate', () => {
    const crons = readFileSync('convex/crons.ts', 'utf8');
    for (const name of [
      'Work scheduling conductor',
      'check-in reflection reconciliation',
      'tomorrow planning conductor',
      'evidence reconciliation conductor',
      'passed block recovery',
      'shape-aware Work review',
    ]) {
      expect(crons).toContain(name);
    }
  });
});
