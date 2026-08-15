import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LapsePrompt } from '../components/albatross/Forgiveness';
import { GuidedStepPane } from '../components/albatross/GuidedStep';
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
    expect(html).toContain('Move it');
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
});
