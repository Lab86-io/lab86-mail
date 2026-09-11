import { SETTINGS_TABS, type SettingsTabId } from './teach-ui';

/* The settings rail groups the tabs by who they serve. SETTINGS_TABS stays the
 * source of ids and labels and of the deep-link contract; this file adds the
 * one-line purpose under each label and the group each tab sits in. */

export type SettingsGroupId = 'workspace' | 'behavior' | 'you';

export interface SettingsGroup {
  id: SettingsGroupId;
  label: string;
}

export const SETTINGS_GROUPS: ReadonlyArray<SettingsGroup> = [
  { id: 'workspace', label: 'Workspace' },
  { id: 'behavior', label: 'Behavior' },
  { id: 'you', label: 'You' },
];

export interface SettingsTabMeta {
  group: SettingsGroupId;
  /** One line, under the label. What the tab changes. */
  description: string;
}

export const SETTINGS_TAB_META: Record<SettingsTabId, SettingsTabMeta> = {
  mailboxes: { group: 'workspace', description: 'Accounts, sync, and the search index.' },
  connections: { group: 'workspace', description: 'Tools that feed the brief and search.' },
  areas: { group: 'workspace', description: 'Where your mail and work belong.' },
  sending: { group: 'behavior', description: 'The undo window after Send.' },
  notifications: { group: 'behavior', description: 'Check-ins, push, and email fallback.' },
  ai: { group: 'behavior', description: 'Models, keys, and your plan.' },
  narrative: { group: 'behavior', description: 'How the brief reads.' },
  appearance: { group: 'you', description: 'Palette, type, and corners.' },
  shortcuts: { group: 'you', description: 'Every key that moves you.' },
  advanced: { group: 'you', description: 'Optional surfaces, off by default.' },
  account: { group: 'you', description: 'Sign-in, sessions, and deletion.' },
};

export interface SettingsNavItem {
  id: SettingsTabId;
  label: string;
  description: string;
}

/** The rail, in group order, each group in SETTINGS_TABS order. */
export function settingsNavGroups(): ReadonlyArray<SettingsGroup & { items: SettingsNavItem[] }> {
  return SETTINGS_GROUPS.map((group) => ({
    ...group,
    items: SETTINGS_TABS.filter((tab) => SETTINGS_TAB_META[tab.id].group === group.id).map((tab) => ({
      id: tab.id,
      label: tab.label,
      description: SETTINGS_TAB_META[tab.id].description,
    })),
  }));
}
