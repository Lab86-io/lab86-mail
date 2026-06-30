import { afterEach, describe, expect, test } from 'bun:test';
import { isAlbatrossEnabled } from '../lib/hosted/controls';
import { isAlbatrossPrimaryView, normalizePrimaryView, resolveInitialPrimaryView } from '../lib/shared/types';

describe('Albatross shell flag', () => {
  const previous = process.env.LAB86_ENABLE_ALBATROSS;

  afterEach(() => {
    if (previous === undefined) delete process.env.LAB86_ENABLE_ALBATROSS;
    else process.env.LAB86_ENABLE_ALBATROSS = previous;
  });

  test('LAB86_ENABLE_ALBATROSS opts into the guarded shell', () => {
    delete process.env.LAB86_ENABLE_ALBATROSS;
    expect(isAlbatrossEnabled()).toBe(false);

    process.env.LAB86_ENABLE_ALBATROSS = '1';
    expect(isAlbatrossEnabled()).toBe(true);

    process.env.LAB86_ENABLE_ALBATROSS = 'true';
    expect(isAlbatrossEnabled()).toBe(true);
  });
});

describe('Albatross primary view guards', () => {
  test('recognizes the hidden Albatross views', () => {
    expect(isAlbatrossPrimaryView('areas')).toBe(true);
    expect(isAlbatrossPrimaryView('intents')).toBe(true);
    expect(isAlbatrossPrimaryView('unassigned')).toBe(true);
    expect(isAlbatrossPrimaryView('mail')).toBe(false);
  });

  test('normalizes persisted views when the flag is disabled', () => {
    expect(normalizePrimaryView('mail', false)).toBe('mail');
    expect(normalizePrimaryView('areas', false)).toBe('daily_report');
    expect(normalizePrimaryView('intents', false)).toBe('daily_report');
    expect(normalizePrimaryView('unknown', false)).toBe('daily_report');
  });

  test('keeps Albatross views reachable when the flag is enabled', () => {
    expect(normalizePrimaryView('areas', true)).toBe('areas');
    expect(normalizePrimaryView('intents', true)).toBe('intents');
    expect(normalizePrimaryView('unassigned', true)).toBe('unassigned');
  });

  test('can boot an enabled Albatross preview into the first Albatross surface', () => {
    expect(resolveInitialPrimaryView('daily_report', true, 'areas')).toBe('areas');
    expect(resolveInitialPrimaryView('mail', true, 'areas')).toBe('mail');
    expect(resolveInitialPrimaryView('daily_report', false, 'areas')).toBe('daily_report');
  });
});
