import { afterEach, describe, expect, test } from 'bun:test';
import { migratePersistedClientState } from '../lib/client-state';
import { isAlbatrossEnabled } from '../lib/hosted/controls';
import {
  hasPersistedPrimaryViewValue,
  isAlbatrossPrimaryView,
  normalizePrimaryView,
  persistedPrimaryViewFromStorage,
  resolveInitialPrimaryView,
} from '../lib/shared/types';

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
  test('migrates the removed Plans destination to Areas without dropping Work selection', () => {
    const persisted = migratePersistedClientState({ primaryView: 'intents', selectedWorkId: 'work_123' });
    expect(persisted.primaryView).toBe('areas');
    expect(persisted.selectedWorkId).toBe('work_123');
  });
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

  test('keeps current Albatross views reachable and folds legacy Plans into Areas', () => {
    expect(normalizePrimaryView('areas', true)).toBe('areas');
    expect(normalizePrimaryView('intents', true)).toBe('areas');
    expect(normalizePrimaryView('unassigned', true)).toBe('unassigned');
  });

  test('can boot an enabled Albatross preview into the first Albatross surface when no view is saved', () => {
    expect(resolveInitialPrimaryView('daily_report', true, 'areas', false)).toBe('areas');
    expect(resolveInitialPrimaryView('daily_report', false, 'areas', false)).toBe('daily_report');
  });

  test('keeps the saved primary view authoritative after hydration', () => {
    expect(resolveInitialPrimaryView('daily_report', true, 'areas', true)).toBe('daily_report');
    expect(resolveInitialPrimaryView('mail', true, 'areas', true)).toBe('mail');
  });

  test('invalid persisted primary views do not suppress an explicit boot surface', () => {
    const raw = JSON.stringify({ state: { primaryView: 'missing_surface' } });
    const hasSavedPrimaryView = hasPersistedPrimaryViewValue(raw);

    expect(hasSavedPrimaryView).toBe(false);
    expect(persistedPrimaryViewFromStorage(raw)).toBeNull();
    expect(persistedPrimaryViewFromStorage(null)).toBeNull();
    expect(persistedPrimaryViewFromStorage('{not-json')).toBeNull();
    expect(resolveInitialPrimaryView('daily_report', true, 'areas', hasSavedPrimaryView)).toBe('areas');
  });

  test('saved Albatross views remain valid persisted preferences while hidden by the flag', () => {
    const raw = JSON.stringify({ state: { primaryView: 'areas' } });

    expect(hasPersistedPrimaryViewValue(raw)).toBe(true);
    expect(persistedPrimaryViewFromStorage(raw)).toBe('areas');
    expect(resolveInitialPrimaryView('areas', true, 'mail', true)).toBe('areas');
    expect(resolveInitialPrimaryView('areas', false, 'mail', true)).toBe('daily_report');
  });
});
