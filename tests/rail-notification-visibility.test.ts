import { describe, expect, test } from 'bun:test';
import { showRailNotificationCenter } from '../lib/notifications/rail-visibility';

describe('showRailNotificationCenter', () => {
  test('keeps the notification control out of the collapsed desktop rail', () => {
    expect(showRailNotificationCenter({ albatrossEnabled: true, railCollapsed: true })).toBe(false);
  });

  test('shows the notification control in the expanded Albatross rail', () => {
    expect(showRailNotificationCenter({ albatrossEnabled: true, railCollapsed: false })).toBe(true);
  });

  test('keeps the notification control hidden when Albatross is disabled', () => {
    expect(showRailNotificationCenter({ albatrossEnabled: false, railCollapsed: false })).toBe(false);
  });
});
