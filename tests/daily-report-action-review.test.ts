import { describe, expect, test } from 'bun:test';
import { confirmDailyReportAction, dailyReportActionReview } from '@/lib/daily-report-action-review';

describe('daily report action review policy', () => {
  test('uses one review message for artifact and structured task mutations', () => {
    expect(dailyReportActionReview('toggle_task', { title: 'Ship parity', completed: true })).toEqual({
      message: 'Mark “Ship parity” complete?',
      destructive: false,
    });
    expect(dailyReportActionReview('dismiss_task', { title: 'Ship parity' })).toEqual({
      message: 'Remove “Ship parity” from future briefs?',
      destructive: true,
    });
  });

  test('requires the caller confirmation for reviewed mutations', () => {
    const messages: string[] = [];
    const accepted = confirmDailyReportAction('resolve_thread', { subject: 'Contract review' }, (message) => {
      messages.push(message);
      return false;
    });
    expect(accepted).toBeFalse();
    expect(messages).toEqual(['Mark “Contract review” resolved and remove it from future briefs?']);
  });

  test('read-only and unknown actions do not invent a mutation confirmation', () => {
    expect(dailyReportActionReview('open_thread', {})).toBeNull();
    expect(confirmDailyReportAction('open_thread', {}, () => false)).toBeTrue();
  });
});
