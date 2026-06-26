import { describe, expect, test } from 'bun:test';
import { APP_VERSION } from '../lib/version';

describe('APP_VERSION', () => {
  test('matches package.json version', async () => {
    const pkg = await import('../package.json');
    expect(APP_VERSION).toBe(pkg.version);
    expect(APP_VERSION).toMatch(
      /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
    );
  });
});
