import { describe, expect, test } from 'bun:test';
import { areaIndexStatusSummary } from '../lib/albatross/area-home';

// What the Area page says about its own indexing. This is one of the few
// places the machinery is legitimately visible — a mailbox that failed to
// sync is a fact about the user's setup, not a score about their life — so it
// has to be accurate and it has to stay out of the vocabulary of blame.

describe('areaIndexStatusSummary', () => {
  test('says nothing when there is nothing to report', () => {
    expect(areaIndexStatusSummary(null)).toBeNull();
    expect(areaIndexStatusSummary(undefined)).toBeNull();
  });

  test('a run in flight reads as active, with progress when it has any', () => {
    expect(areaIndexStatusSummary({ latestRun: { status: 'queued' } })).toEqual({
      label: 'Area check queued',
      tone: 'active',
    });
    expect(areaIndexStatusSummary({ latestRun: { status: 'running' } })?.label).toBe('Checking areas now');
    expect(areaIndexStatusSummary({ latestRun: { status: 'running', scanned: 1234 } })?.label).toContain(
      '1,234 scanned',
    );
  });

  test('a failed run offers a retry rather than an apology', () => {
    const summary = areaIndexStatusSummary({ latestRun: { status: 'error' } });
    expect(summary).toEqual({ label: 'Area check needs retry', tone: 'warning' });
    expect(summary?.label.toLowerCase()).not.toContain('failed');
  });

  test('mailbox trouble is counted plainly, singular and plural', () => {
    expect(areaIndexStatusSummary({ mail: { errored: 1 } })).toEqual({
      label: '1 mailbox sync error',
      tone: 'warning',
    });
    expect(areaIndexStatusSummary({ mail: { errored: 3 } })?.label).toBe('3 mailbox sync errors');
  });

  test('a mailbox error outranks a healthy index', () => {
    // Reporting "ready" while a mailbox is broken would mean the Area is
    // quietly missing mail the user assumes it can see.
    const summary = areaIndexStatusSummary({ mail: { total: 4, errored: 1 } });
    expect(summary?.tone).toBe('warning');
  });

  test('a healthy index says so, and an empty one says it is waiting', () => {
    expect(areaIndexStatusSummary({ mail: { total: 2 } })).toEqual({
      label: 'Mail index ready',
      tone: 'done',
    });
    expect(areaIndexStatusSummary({ mail: { total: 0 } })).toEqual({
      label: 'Waiting for mailbox index',
      tone: 'quiet',
    });
  });

  test('nonsense counts never produce negative or fractional claims', () => {
    const summary = areaIndexStatusSummary({ mail: { errored: -5, total: 2.7 } });
    expect(summary?.label).not.toContain('-');
    expect(summary?.label).not.toContain('.');
  });
});
