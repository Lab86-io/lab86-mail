import { describe, expect, test } from 'bun:test';
import { migratePersistedClientState } from '../lib/client-state';
import {
  areaIdFromSearch,
  hasPersistedPrimaryViewValue,
  isPrimaryView,
  LEGACY_PRIMARY_VIEWS,
  migratePrimaryView,
  normalizePrimaryView,
  PRIMARY_VIEWS,
  persistedPrimaryViewFromStorage,
  primaryViewFromSearch,
  resolveInitialPrimaryView,
  workIdFromSearch,
} from '../lib/shared/types';

describe('the Albatross surfaces', () => {
  test('are the ones the rail offers, plus the optional board', () => {
    expect([...PRIMARY_VIEWS]).toEqual([
      'today',
      'albatrosses',
      'mail',
      'calendar',
      'files',
      'areas',
      'activity',
      'tasks',
    ]);
  });

  test('no longer include a view that renders a different product', () => {
    expect(isPrimaryView('daily_report')).toBe(false);
    expect(isPrimaryView('intents')).toBe(false);
    expect(isPrimaryView('unassigned')).toBe(false);
  });
});

describe('legacy views map forward', () => {
  // A saved URL or a persisted store value must never render a blank pane, and
  // must never quietly land the user on a different surface. Areas used to fall
  // back to the Daily Report with no message at all.
  test('every legacy name resolves to a real surface', () => {
    for (const [legacy, target] of Object.entries(LEGACY_PRIMARY_VIEWS)) {
      expect(migratePrimaryView(legacy)).toBe(target);
      expect(isPrimaryView(target)).toBe(true);
    }
  });

  test('the named replacements are the ones we intend', () => {
    expect(normalizePrimaryView('daily_report')).toBe('today');
    expect(normalizePrimaryView('intents')).toBe('albatrosses');
    expect(normalizePrimaryView('unassigned')).toBe('albatrosses');
    expect(normalizePrimaryView('inbox')).toBe('mail');
  });

  test('an unknown value lands on Today rather than nothing', () => {
    expect(normalizePrimaryView('missing_surface')).toBe('today');
    expect(normalizePrimaryView(undefined)).toBe('today');
    expect(migratePrimaryView('missing_surface')).toBeNull();
  });

  test('the persisted store migrates without dropping the open Albatross', () => {
    const persisted = migratePersistedClientState({
      primaryView: 'intents',
      selectedWorkId: 'work_123',
    });
    expect(persisted.primaryView).toBe('albatrosses');
    expect(persisted.selectedWorkId).toBe('work_123');
  });

  test('a persisted Daily Report becomes Today', () => {
    expect(migratePersistedClientState({ primaryView: 'daily_report' }).primaryView).toBe('today');
  });
});

describe('persisted view resolution', () => {
  test('an invalid persisted view does not suppress the boot surface', () => {
    const raw = JSON.stringify({ state: { primaryView: 'missing_surface' } });
    expect(hasPersistedPrimaryViewValue(raw)).toBe(false);
    expect(persistedPrimaryViewFromStorage(raw)).toBeNull();
    expect(persistedPrimaryViewFromStorage(null)).toBeNull();
    expect(persistedPrimaryViewFromStorage('{not-json')).toBeNull();
    expect(resolveInitialPrimaryView('missing_surface', 'today', false)).toBe('today');
  });

  test('a legacy persisted view still counts as saved, and migrates', () => {
    const raw = JSON.stringify({ state: { primaryView: 'daily_report' } });
    expect(hasPersistedPrimaryViewValue(raw)).toBe(true);
    expect(persistedPrimaryViewFromStorage(raw)).toBe('today');
  });

  test('the saved view stays authoritative after hydration', () => {
    expect(resolveInitialPrimaryView('mail', 'today', true)).toBe('mail');
    expect(resolveInitialPrimaryView('albatrosses', 'today', true)).toBe('albatrosses');
  });
});

describe('deep links', () => {
  test('accept a surface and ignore unknown values', () => {
    expect(primaryViewFromSearch('?view=files')).toBe('files');
    expect(primaryViewFromSearch('?view=albatrosses')).toBe('albatrosses');
    expect(primaryViewFromSearch('?view=daily_report')).toBe('today');
    expect(primaryViewFromSearch('?view=missing_surface')).toBeNull();
    expect(primaryViewFromSearch('?setup=areas')).toBeNull();
  });

  test('address one Albatross or one Area directly', () => {
    expect(workIdFromSearch('?work=abc123')).toBe('abc123');
    expect(workIdFromSearch('?view=albatrosses')).toBeNull();
    expect(areaIdFromSearch('?area=area_9')).toBe('area_9');
    expect(areaIdFromSearch('?view=areas')).toBeNull();
  });
});
