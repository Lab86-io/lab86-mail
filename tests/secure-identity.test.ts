import { describe, expect, test } from 'bun:test';
import { IDENTITY_CHECK, identityRecentlyChecked } from '../lib/secure/identity';

// The identity check before a saved value goes somewhere new
// (docs/albatross-secure-store.md): Clerk's own reverification rule, read
// from the session token, for the web cookie and the native token alike.

describe('identityRecentlyChecked', () => {
  test('a signed-out request is never checked', async () => {
    expect(await identityRecentlyChecked(async () => ({ userId: null, has: () => true }))).toBe(false);
  });

  test('it asks Clerk for a first-factor check in the last 10 minutes', async () => {
    const asked: unknown[] = [];
    const checked = await identityRecentlyChecked(async () => ({
      userId: 'user_1',
      has: (input) => {
        asked.push(input);
        return true;
      },
    }));
    expect(checked).toBe(true);
    expect(asked).toEqual([{ reverification: { level: 'first_factor', afterMinutes: 10 } }]);
    expect(IDENTITY_CHECK).toEqual({ level: 'first_factor', afterMinutes: 10 });
  });

  test('an old check, or a token Clerk cannot read, is not a check', async () => {
    expect(await identityRecentlyChecked(async () => ({ userId: 'user_1', has: () => false }))).toBe(false);
    expect(
      await identityRecentlyChecked(async () => ({
        userId: 'user_1',
        has: () => {
          throw new Error('malformed fva');
        },
      })),
    ).toBe(false);
  });
});
