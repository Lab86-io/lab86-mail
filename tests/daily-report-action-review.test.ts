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

  test('covers every reviewed report mutation with action-specific copy and risk', () => {
    expect(dailyReportActionReview('toggle_task', { completed: false })).toEqual({
      message: 'Reopen “this task”?',
      destructive: false,
    });
    expect(dailyReportActionReview('dismiss_thread', {})).toEqual({
      message: 'Remove “this conversation” from future briefs?',
      destructive: true,
    });
    expect(dailyReportActionReview('create_task', { title: 'Prepare slides' })).toEqual({
      message: 'Add “Prepare slides” to your tasks?',
      destructive: false,
    });
    expect(dailyReportActionReview('archive_thread', { subject: 'Old launch thread' })).toEqual({
      message: 'Archive “Old launch thread” and remove it from future briefs?',
      destructive: true,
    });
    expect(dailyReportActionReview('rsvp_event', { status: 'maybe' })).toEqual({
      message: 'Send a “maybe” RSVP for this event?',
      destructive: false,
    });
    expect(dailyReportActionReview('create_event', {})).toEqual({
      message: 'Add “this event” to your calendar?',
      destructive: false,
    });
    expect(dailyReportActionReview('open_url', {})).toEqual({
      message: 'Open this external link in a new tab?',
      destructive: false,
    });
  });

  test('external URLs require host confirmation while trusted in-app navigation does not', () => {
    const messages: string[] = [];
    expect(
      confirmDailyReportAction('open_url', {}, (message) => {
        messages.push(message);
        return false;
      }),
    ).toBeFalse();
    expect(messages).toEqual(['Open this external link in a new tab?']);
    expect(dailyReportActionReview('open_thread', {})).toBeNull();
    expect(confirmDailyReportAction('open_thread', {}, () => false)).toBeTrue();
  });
});
