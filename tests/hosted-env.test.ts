import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
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
  const keys = [
    'NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY',
    'CLERK_SECRET_KEY',
    'NEXT_PUBLIC_CONVEX_URL',
    'CONVEX_URL',
    'NYLAS_API_KEY',
    'NYLAS_CLIENT_ID',
    'STRIPE_SECRET_KEY',
    'STRIPE_PRO_PRICE_ID',
  ];
  const saved: Record<string, string | undefined> = {};
  const set = (k: string, v: string | undefined) => {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  };
  beforeEach(() => {
    for (const k of keys) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of keys) set(k, saved[k]);
  });

  test('each detector flips on exactly its required env vars', () => {
    // All cleared in beforeEach → everything is unconfigured.
    expect(isClerkConfigured()).toBe(false);
    expect(isConvexConfigured()).toBe(false);
    expect(isNylasConfigured()).toBe(false);
    expect(isStripeConfigured()).toBe(false);

    set('NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY', 'pk_test');
    expect(isClerkConfigured()).toBe(false); // needs the secret too
    set('CLERK_SECRET_KEY', 'sk_test');
    expect(isClerkConfigured()).toBe(true);

    set('CONVEX_URL', 'https://convex.test');
    expect(isConvexConfigured()).toBe(true);
    expect(convexUrl()).toBe('https://convex.test');

    set('NYLAS_API_KEY', 'k');
    set('NYLAS_CLIENT_ID', 'c');
    expect(isNylasConfigured()).toBe(true);

    set('STRIPE_SECRET_KEY', 's');
    set('STRIPE_PRO_PRICE_ID', 'p');
    expect(isStripeConfigured()).toBe(true);
  });

  test('convexUrl / convexInternalSecret default to empty strings', () => {
    expect(convexUrl()).toBe('');
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
