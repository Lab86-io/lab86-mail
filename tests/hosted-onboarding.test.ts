import { describe, expect, test } from 'bun:test';
import { shouldExitWelcome, shouldRedirectToWelcome } from '../components/hosted/onboarding-state';

describe('hosted onboarding routing', () => {
  test('does not interrupt returning users with connected accounts', () => {
    expect(
      shouldRedirectToWelcome({
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
      shouldRedirectToWelcome({
        dismissed: true,
        hasAccounts: false,
        isLoading: false,
        isError: false,
      }),
    ).toBe(false);
  });

  test('redirects only a settled first run with no account or dismissal', () => {
    expect(
      shouldRedirectToWelcome({
        dismissed: false,
        hasAccounts: false,
        isLoading: false,
        isError: false,
      }),
    ).toBe(true);
    expect(
      shouldRedirectToWelcome({
        dismissed: false,
        hasAccounts: false,
        isLoading: true,
        isError: false,
      }),
    ).toBe(false);
    expect(
      shouldRedirectToWelcome({
        dismissed: false,
        hasAccounts: false,
        isLoading: false,
        isError: true,
      }),
    ).toBe(false);
  });
});
