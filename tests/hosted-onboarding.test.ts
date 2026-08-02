import { describe, expect, test } from 'bun:test';
import { shouldExitWelcome, shouldOfferWelcome } from '../components/hosted/onboarding-state';

describe('hosted onboarding offer', () => {
  test('does not interrupt returning users with connected accounts', () => {
    expect(
      shouldOfferWelcome({
        dismissed: false,
        hasAccounts: true,
        isLoading: false,
        isError: false,
      }),
    ).toBe(false);
    expect(shouldExitWelcome({ hasAccounts: true, isLoading: false })).toBe(true);
  });

  test('persists a user-controlled skip without requiring a mailbox', () => {
    expect(
      shouldOfferWelcome({
        dismissed: true,
        hasAccounts: false,
        isLoading: false,
        isError: false,
      }),
    ).toBe(false);
  });

  test('offers setup only on a settled first run with no account or dismissal', () => {
    expect(
      shouldOfferWelcome({
        dismissed: false,
        hasAccounts: false,
        isLoading: false,
        isError: false,
      }),
    ).toBe(true);
    expect(
      shouldOfferWelcome({
        dismissed: false,
        hasAccounts: false,
        isLoading: true,
        isError: false,
      }),
    ).toBe(false);
    expect(
      shouldOfferWelcome({
        dismissed: false,
        hasAccounts: false,
        isLoading: false,
        isError: true,
      }),
    ).toBe(false);
  });
});
