import { describe, expect, test } from 'bun:test';
import { pickAccountForGrant } from '../lib/mail/grant-account';

const row = (status: string, createdAt: number, tag: string) => ({ status, createdAt, tag });

describe('pickAccountForGrant', () => {
  test('returns nothing when a grant maps to no account', () => {
    expect(pickAccountForGrant([])).toBeNull();
  });

  test('returns the only row unchanged, whatever its status', () => {
    const only = row('revoked', 1, 'only');
    expect(pickAccountForGrant([only])).toBe(only);
  });

  test('a live connection beats a stale leftover, even a newer one', () => {
    // The failure this guards: a disconnected duplicate shadowing the account
    // that is actually receiving mail.
    const live = row('connected', 100, 'live');
    const staleButNewer = row('revoked', 999, 'stale');
    expect(pickAccountForGrant([staleButNewer, live])).toBe(live);
  });

  test('among live connections the newest authorization wins', () => {
    const older = row('connected', 100, 'older');
    const newer = row('connected', 200, 'newer');
    expect(pickAccountForGrant([older, newer])).toBe(newer);
    expect(pickAccountForGrant([newer, older])).toBe(newer);
  });

  test('falls back to the newest when nothing is connected', () => {
    const a = row('revoked', 100, 'a');
    const b = row('error', 200, 'b');
    expect(pickAccountForGrant([a, b])).toBe(b);
  });

  test('tolerates rows with no createdAt rather than throwing', () => {
    const undated = { status: 'connected' };
    const dated = { status: 'connected', createdAt: 5 };
    expect(pickAccountForGrant([undated, dated])).toBe(dated);
  });

  test('never throws on ambiguity — the whole point', () => {
    const many = Array.from({ length: 5 }, (_, i) => row('connected', i, `r${i}`));
    expect(() => pickAccountForGrant(many)).not.toThrow();
    expect(pickAccountForGrant(many)?.tag).toBe('r4');
  });
});
