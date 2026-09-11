import { describe, expect, test } from 'bun:test';
import { SETTINGS_GROUPS, SETTINGS_TAB_META, settingsNavGroups } from '../lib/albatross/settings-nav';
import { SETTINGS_TABS } from '../lib/albatross/teach-ui';

describe('settings navigation groups', () => {
  test('every tab sits in exactly one group with a short description', () => {
    const groups = settingsNavGroups();
    const placed = groups.flatMap((group) => group.items.map((item) => item.id));
    expect(placed.sort()).toEqual(SETTINGS_TABS.map((tab) => tab.id).sort());
    expect(new Set(placed).size).toBe(placed.length);
    for (const tab of SETTINGS_TABS) {
      const meta = SETTINGS_TAB_META[tab.id];
      expect(SETTINGS_GROUPS.some((group) => group.id === meta.group)).toBe(true);
      expect(meta.description.length).toBeGreaterThan(8);
      expect(meta.description.length).toBeLessThan(60);
      expect(meta.description.endsWith('.')).toBe(true);
    }
  });

  test('groups keep the SETTINGS_TABS order and no group is empty', () => {
    const order = new Map(SETTINGS_TABS.map((tab, index) => [tab.id, index]));
    for (const group of settingsNavGroups()) {
      expect(group.items.length).toBeGreaterThan(0);
      const indexes = group.items.map((item) => order.get(item.id) ?? -1);
      expect([...indexes].sort((a, b) => a - b)).toEqual(indexes);
    }
  });

  test('labels stay sentence case, never all-caps', () => {
    for (const group of SETTINGS_GROUPS) {
      expect(group.label).not.toBe(group.label.toUpperCase());
    }
  });
});
