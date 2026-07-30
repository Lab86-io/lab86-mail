import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { issueConsumeToken, verifyConsumeToken } from '../lib/mail/one-time-code-token';

const KEYS = ['LAB86_OTP_CONSUME_SECRET', 'LAB86_NOTIFICATION_LINK_SECRET'] as const;
const original = new Map(KEYS.map((key) => [key, process.env[key]]));

beforeEach(() => {
  process.env.LAB86_OTP_CONSUME_SECRET = 'test-consume-secret';
  // `delete`, not `= undefined`: assigning undefined to process.env stores the
  // string "undefined", which is truthy and would leave the fallback secret
  // looking configured in every test below.
  delete process.env.LAB86_NOTIFICATION_LINK_SECRET;
});

afterEach(() => {
  for (const key of KEYS) {
    const value = original.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('consume tokens', () => {
  test('round-trips the user it was issued for', () => {
    const token = issueConsumeToken('user-1');
    expect(token).toBeTruthy();
    expect(verifyConsumeToken(token as string)).toEqual({ ok: true, userId: 'user-1' });
  });

  test('survives a user id with characters that need encoding', () => {
    const token = issueConsumeToken('user|with.dots');
    expect(verifyConsumeToken(token as string).userId).toBe('user|with.dots');
  });

  test('refuses a token re-pointed at another user', () => {
    const mine = (issueConsumeToken('user-1') as string).split('.');
    const theirs = (issueConsumeToken('user-2') as string).split('.');
    // Swap in the other user's identity but keep this token's signature: the
    // attack that would let one account clean up another's mailbox.
    const forged = [mine[0], theirs[1], mine[2], mine[3]].join('.');
    expect(verifyConsumeToken(forged)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  test('refuses a tampered expiry, so a stolen token cannot be extended', () => {
    const token = issueConsumeToken('user-1') as string;
    const parts = token.split('.');
    parts[2] = String(Number(parts[2]) + 86_400_000);
    expect(verifyConsumeToken(parts.join('.'))).toEqual({ ok: false, reason: 'bad_signature' });
  });

  test('refuses an expired token', () => {
    const token = issueConsumeToken('user-1', Date.now() - 60 * 60_000) as string;
    expect(verifyConsumeToken(token)).toEqual({ ok: false, reason: 'expired' });
  });

  test('refuses anything malformed', () => {
    expect(verifyConsumeToken('').ok).toBe(false);
    expect(verifyConsumeToken('v1.user.123').ok).toBe(false);
    expect(verifyConsumeToken('v2.user.123.sig').ok).toBe(false);
  });

  test('falls back to the notification link secret so existing deploys work', () => {
    delete process.env.LAB86_OTP_CONSUME_SECRET;
    process.env.LAB86_NOTIFICATION_LINK_SECRET = 'fallback-secret';
    const token = issueConsumeToken('user-1');
    expect(verifyConsumeToken(token as string).userId).toBe('user-1');
  });

  test('issues nothing when no secret is configured, rather than an unsigned token', () => {
    delete process.env.LAB86_OTP_CONSUME_SECRET;
    delete process.env.LAB86_NOTIFICATION_LINK_SECRET;
    expect(issueConsumeToken('user-1')).toBeNull();
    expect(verifyConsumeToken('anything')).toEqual({ ok: false, reason: 'not_configured' });
  });
});
