import { describe, expect, test } from 'bun:test';
import {
  SETTINGS_GROUPS,
  SETTINGS_TAB_META,
  settingsNavGroups,
  settingsTabScrollLeft,
} from '../lib/albatross/settings-nav';
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

describe('the phone tab bar follows the active tab', () => {
  // A 390px phone: the bar starts at x=0, is 390 wide, and scrolls to 1200.
  const bar = { clientWidth: 390, scrollWidth: 1200, stripLeft: 0 };

  test('a tab past the right edge scrolls to the middle of the bar', () => {
    // Daily Brief at x=700 (on screen), 90 wide, with the bar at its start.
    expect(settingsTabScrollLeft({ ...bar, scrollLeft: 0, tabLeft: 700, tabWidth: 90 })).toBe(550);
  });

  test('the ends clamp: the first tab goes to 0 and the last to the full scroll', () => {
    expect(settingsTabScrollLeft({ ...bar, scrollLeft: 400, tabLeft: -380, tabWidth: 100 })).toBe(0);
    expect(settingsTabScrollLeft({ ...bar, scrollLeft: 0, tabLeft: 1150, tabWidth: 50 })).toBe(810);
  });

  test('a scrolled bar counts its offset, and a tab already centered stays put', () => {
    // The bar is scrolled 300; the tab shows at x=150 and is centered.
    expect(settingsTabScrollLeft({ ...bar, scrollLeft: 300, tabLeft: 150, tabWidth: 90 })).toBeNull();
    expect(settingsTabScrollLeft({ ...bar, scrollLeft: 300, tabLeft: 400, tabWidth: 90 })).toBe(550);
    // The bar may sit away from the left edge of the screen.
    expect(settingsTabScrollLeft({ ...bar, stripLeft: 20, scrollLeft: 0, tabLeft: 720, tabWidth: 90 })).toBe(
      550,
    );
  });

  test('the vertical rail from md up does not scroll', () => {
    expect(
      settingsTabScrollLeft({
        scrollLeft: 0,
        clientWidth: 210,
        scrollWidth: 210,
        stripLeft: 0,
        tabLeft: 0,
        tabWidth: 210,
      }),
    ).toBeNull();
  });
});
