import { afterEach, describe, expect, test } from 'bun:test';
import { isDevelopmentRuntime } from '../lib/hosted/controls';
import { setProcessEnv } from './tools/env';

const keys = [
  'NODE_ENV',
  'LAB86_DEVELOPMENT_MODE',
  'LAB86_MAIL_REQUIRE_BASIC_AUTH',
  'RAILWAY_ENVIRONMENT_NAME',
] as const;
const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of keys) setProcessEnv(key, saved[key]);
});

describe('isolated development runtime', () => {
  test('local development suppresses scheduled work without a hosted environment', () => {
    setProcessEnv('NODE_ENV', 'development');
    delete process.env.LAB86_DEVELOPMENT_MODE;
    delete process.env.RAILWAY_ENVIRONMENT_NAME;
    expect(isDevelopmentRuntime()).toBe(true);
  });

  test('a local production build must opt in explicitly', () => {
    setProcessEnv('NODE_ENV', 'production');
    delete process.env.LAB86_DEVELOPMENT_MODE;
    expect(isDevelopmentRuntime()).toBe(false);
    process.env.LAB86_DEVELOPMENT_MODE = 'true';
    expect(isDevelopmentRuntime()).toBe(true);
    process.env.LAB86_DEVELOPMENT_MODE = 'false';
    expect(isDevelopmentRuntime()).toBe(false);
  });

  test('legacy environment names and browser challenges do not enable experimental features', () => {
    setProcessEnv('NODE_ENV', 'production');
    delete process.env.LAB86_DEVELOPMENT_MODE;
    process.env.LAB86_MAIL_REQUIRE_BASIC_AUTH = '1';
    for (const name of ['staging', 'development', 'production']) {
      process.env.RAILWAY_ENVIRONMENT_NAME = name;
      expect(isDevelopmentRuntime()).toBe(false);
    }
  });
});
