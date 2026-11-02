import { afterEach, describe, expect, test } from 'bun:test';
import {
  isDeckV2AuthoringEnabled,
  isDeckV2AuthoringEnabledOnClient,
  isThemedOfficeChromeEnabled,
} from '../lib/documents/editor-flags';
import { setProcessEnv } from './tools/env';

const keys = [
  'OFFICE_THEMED_CHROME',
  'DECK_V2_AUTHORING',
  'NEXT_PUBLIC_DECK_V2_AUTHORING',
  'LAB86_DEVELOPMENT_MODE',
  'NODE_ENV',
] as const;
const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));

describe('editor rollout flags', () => {
  afterEach(() => {
    for (const key of keys) {
      setProcessEnv(key, saved[key]);
    }
  });
  test('default on in development and off elsewhere, with explicit values always winning', () => {
    setProcessEnv('NODE_ENV', 'production');
    delete process.env.LAB86_DEVELOPMENT_MODE;
    delete process.env.OFFICE_THEMED_CHROME;
    delete process.env.DECK_V2_AUTHORING;
    expect(isThemedOfficeChromeEnabled()).toBe(false);
    expect(isDeckV2AuthoringEnabled()).toBe(false);
    setProcessEnv('NODE_ENV', 'development');
    expect(isThemedOfficeChromeEnabled()).toBe(true);
    setProcessEnv('NODE_ENV', 'production');
    process.env.LAB86_DEVELOPMENT_MODE = 'true';
    expect(isDeckV2AuthoringEnabled()).toBe(true);
    process.env.DECK_V2_AUTHORING = 'false';
    expect(isDeckV2AuthoringEnabled()).toBe(false);
    process.env.LAB86_DEVELOPMENT_MODE = 'false';
    process.env.OFFICE_THEMED_CHROME = 'true';
    expect(isThemedOfficeChromeEnabled()).toBe(true);
  });
  test('the server flag takes all or a comma list of user ids', () => {
    setProcessEnv('NODE_ENV', 'production');
    delete process.env.LAB86_DEVELOPMENT_MODE;
    process.env.DECK_V2_AUTHORING = 'all';
    expect(isDeckV2AuthoringEnabled()).toBe(true);
    expect(isDeckV2AuthoringEnabled('user_a')).toBe(true);
    process.env.DECK_V2_AUTHORING = ' user_a , user_b ';
    expect(isDeckV2AuthoringEnabled('user_a')).toBe(true);
    expect(isDeckV2AuthoringEnabled('user_b')).toBe(true);
    expect(isDeckV2AuthoringEnabled('user_c')).toBe(false);
    expect(isDeckV2AuthoringEnabled()).toBe(false);
    expect(isDeckV2AuthoringEnabled(null)).toBe(false);
    process.env.DECK_V2_AUTHORING = 'TRUE';
    expect(isDeckV2AuthoringEnabled('user_c')).toBe(true);
    process.env.DECK_V2_AUTHORING = 'no';
    expect(isDeckV2AuthoringEnabled('user_a')).toBe(false);
    // A list does not depend on the development default.
    process.env.LAB86_DEVELOPMENT_MODE = 'true';
    process.env.DECK_V2_AUTHORING = 'user_a';
    expect(isDeckV2AuthoringEnabled('user_c')).toBe(false);
  });
  test('the client flag follows the public variable, else development', () => {
    delete process.env.NEXT_PUBLIC_DECK_V2_AUTHORING;
    setProcessEnv('NODE_ENV', 'development');
    expect(isDeckV2AuthoringEnabledOnClient()).toBe(true);
    setProcessEnv('NODE_ENV', 'production');
    expect(isDeckV2AuthoringEnabledOnClient()).toBe(false);
    process.env.NEXT_PUBLIC_DECK_V2_AUTHORING = 'yes';
    expect(isDeckV2AuthoringEnabledOnClient()).toBe(true);
    process.env.NEXT_PUBLIC_DECK_V2_AUTHORING = 'all';
    expect(isDeckV2AuthoringEnabledOnClient()).toBe(true);
    process.env.NEXT_PUBLIC_DECK_V2_AUTHORING = '0';
    expect(isDeckV2AuthoringEnabledOnClient()).toBe(false);
    // An id list stays on the server: the browser never has one.
    process.env.NEXT_PUBLIC_DECK_V2_AUTHORING = 'user_a';
    expect(isDeckV2AuthoringEnabledOnClient()).toBe(false);
  });
});
