import { describe, expect, test } from 'bun:test';
import { createCalendarSyncKicker } from '../lib/calendar/sync';

const row = { userId: 'user_1', accountId: 'acct_1' };
const other = { userId: 'user_1', accountId: 'acct_2' };

interface Pending {
  input: { userId: string; accountId: string; force?: boolean; reason?: string };
  resolve: () => void;
  reject: (error: Error) => void;
}

function harness(options: { debounceMs?: number } = {}) {
  let clock = 1_000_000;
  const started: Pending[] = [];
  const errors: string[] = [];
  const kicker = createCalendarSyncKicker({
    sync: (input) =>
      new Promise<void>((resolve, reject) => {
        started.push({ input, resolve, reject });
      }),
    now: () => clock,
    debounceMs: options.debounceMs,
    reportError: (accountId, error) => errors.push(`${accountId}: ${(error as Error).message}`),
  });
  return {
    kicker,
    started,
    errors,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('createCalendarSyncKicker lazy kicks', () => {
  test('runs once per account inside the debounce window', () => {
    const h = harness({ debounceMs: 1_000 });
    h.kicker.kick(row);
    h.kicker.kick(row);
    h.kicker.kick(other);
    expect(h.started.map((p) => p.input)).toEqual([
      { userId: 'user_1', accountId: 'acct_1', reason: 'lazy_kick' },
      { userId: 'user_1', accountId: 'acct_2', reason: 'lazy_kick' },
    ]);
    h.advance(1_000);
    h.kicker.kick(row);
    expect(h.started).toHaveLength(3);
  });

  test('a custom reason is passed through and a failure reopens the window', async () => {
    const h = harness({ debounceMs: 60_000 });
    h.kicker.kick(row, { reason: 'surface_load' });
    expect(h.started[0].input.reason).toBe('surface_load');
    h.started[0].reject(new Error('boom'));
    await settle();
    expect(h.errors).toEqual(['acct_1: boom']);
    h.kicker.kick(row);
    expect(h.started).toHaveLength(2);
  });
});

describe('createCalendarSyncKicker forced kicks', () => {
  test('bypasses the lazy debounce and forces the claim', () => {
    const h = harness({ debounceMs: 60_000 });
    h.kicker.kick(row);
    h.kicker.kick(row, { force: true, reason: 'post_mutation' });
    expect(h.started.map((p) => p.input)).toEqual([
      { userId: 'user_1', accountId: 'acct_1', reason: 'lazy_kick' },
      { userId: 'user_1', accountId: 'acct_1', force: true, reason: 'post_mutation' },
    ]);
    expect(h.kicker.isForcedSyncInFlight(row)).toBe(true);
  });

  test('coalesces forced kicks during a run into one rerun', async () => {
    const h = harness();
    h.kicker.kick(row, { force: true, reason: 'post_mutation' });
    h.kicker.kick(row, { force: true, reason: 'post_mutation' });
    h.kicker.kick(row, { force: true, reason: 'post_mutation' });
    expect(h.started).toHaveLength(1);
    h.started[0].resolve();
    await settle();
    expect(h.started).toHaveLength(2);
    expect(h.started[1].input).toEqual({
      userId: 'user_1',
      accountId: 'acct_1',
      force: true,
      reason: 'post_mutation',
    });
    h.started[1].resolve();
    await settle();
    expect(h.started).toHaveLength(2);
    expect(h.kicker.isForcedSyncInFlight(row)).toBe(false);
  });

  test('a failed forced run still honors a queued rerun', async () => {
    const h = harness();
    h.kicker.kick(row, { force: true, reason: 'post_mutation' });
    h.kicker.kick(row, { force: true, reason: 'post_mutation' });
    h.started[0].reject(new Error('provider timeout'));
    await settle();
    expect(h.errors).toEqual(['acct_1: provider timeout']);
    expect(h.started).toHaveLength(2);
  });

  test('a forced run satisfies the lazy debounce for that account', () => {
    const h = harness({ debounceMs: 60_000 });
    h.kicker.kick(row, { force: true });
    expect(h.started[0].input.reason).toBe('forced_kick');
    h.kicker.kick(row);
    expect(h.started).toHaveLength(1);
    h.kicker.kick(other);
    expect(h.started).toHaveLength(2);
  });
});
