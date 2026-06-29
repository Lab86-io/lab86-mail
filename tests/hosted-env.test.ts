import { afterEach, describe, expect, test } from 'bun:test';
import {
  aiCreditDefaults,
  convexInternalSecret,
  convexUrl,
  hostedPublicUrl,
  isClerkConfigured,
  isConvexConfigured,
  isNylasConfigured,
  isStripeConfigured,
  nylasRedirectUri,
} from '../lib/hosted/env';

describe('hosted env detectors', () => {
  test('the configured-* checks return booleans', () => {
    for (const fn of [isClerkConfigured, isConvexConfigured, isNylasConfigured, isStripeConfigured]) {
      expect(typeof fn()).toBe('boolean');
    }
  });

  test('convexUrl / convexInternalSecret return strings', () => {
    expect(typeof convexUrl()).toBe('string');
    expect(typeof convexInternalSecret()).toBe('string');
  });
});

describe('hostedPublicUrl + nylasRedirectUri', () => {
  const saved: Record<string, string | undefined> = {};
  const setEnv = (k: string, v: string | undefined) => {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  };
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test('strips a trailing slash and derives the nylas callback', () => {
    setEnv('LAB86_MAIL_PUBLIC_URL', 'https://mail.example.test/');
    setEnv('NYLAS_REDIRECT_URI', undefined);
    expect(hostedPublicUrl()).toBe('https://mail.example.test');
    expect(nylasRedirectUri()).toBe('https://mail.example.test/api/nylas/callback');
  });

  test('an explicit redirect uri wins', () => {
    setEnv('NYLAS_REDIRECT_URI', 'https://custom.example.test/cb');
    expect(nylasRedirectUri()).toBe('https://custom.example.test/cb');
  });
});

describe('aiCreditDefaults', () => {
  const saved = {
    free: process.env.LAB86_AI_FREE_MONTHLY_CREDITS,
    pro: process.env.LAB86_AI_PRO_MONTHLY_CREDITS,
  };
  afterEach(() => {
    if (saved.free === undefined) delete process.env.LAB86_AI_FREE_MONTHLY_CREDITS;
    else process.env.LAB86_AI_FREE_MONTHLY_CREDITS = saved.free;
    if (saved.pro === undefined) delete process.env.LAB86_AI_PRO_MONTHLY_CREDITS;
    else process.env.LAB86_AI_PRO_MONTHLY_CREDITS = saved.pro;
  });

  test('parses numbers from the environment', () => {
    process.env.LAB86_AI_FREE_MONTHLY_CREDITS = '25';
    process.env.LAB86_AI_PRO_MONTHLY_CREDITS = '1000';
    expect(aiCreditDefaults()).toEqual({ freeMonthlyCredits: 25, proMonthlyCredits: 1000 });
  });

  test('falls back to defaults for missing or non-numeric values', () => {
    delete process.env.LAB86_AI_FREE_MONTHLY_CREDITS;
    process.env.LAB86_AI_PRO_MONTHLY_CREDITS = 'not-a-number';
    expect(aiCreditDefaults()).toEqual({ freeMonthlyCredits: 0, proMonthlyCredits: 500 });
  });
});
