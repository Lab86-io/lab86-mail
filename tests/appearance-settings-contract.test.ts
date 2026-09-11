import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { persistedClientState, useClientStore } from '../lib/client-state';

const source = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

describe('Appearance and rail integration', () => {
  const initial = useClientStore.getState();
  afterEach(() => useClientStore.setState(initial, true));

  test('rail header owns Notifications beside collapse; footer keeps Settings and Profile', () => {
    const rail = source('components/shell/Rail.tsx');
    const footer = rail.slice(rail.indexOf('<SidebarFooter>'), rail.indexOf('</SidebarFooter>'));
    expect(footer).toContain('aria-label="Settings"');
    expect(footer).not.toContain('<NotificationCenter');
    expect(footer).toContain('title="Profile"');
    expect(footer.indexOf('aria-label="Settings"')).toBeLessThan(footer.indexOf('title="Profile"'));
    const header = rail.slice(rail.indexOf('<SidebarHeader'), rail.indexOf('</SidebarHeader>'));
    expect(header).toContain('<NotificationCenter');
    expect(header).toContain('data-rail-utilities');
    expect(header).toContain('group-data-[collapsible=icon]:flex-col');
    expect(header.indexOf('<NotificationCenter')).toBeLessThan(header.indexOf('<SidebarTrigger'));
    expect(header).toContain('group-data-[collapsible=icon]:order-first');
    expect(footer).not.toContain('<AccountScopePopover');
    expect(footer).not.toContain('<ThemePanel');
  });

  test('Settings owns inline Appearance while both destinations hydrate the existing theme', () => {
    const settings = source('app/settings/page.tsx');
    expect(settings).toContain('<ThemePanel inline />');
    expect(settings).toContain('appearance: () =>');
    expect(settings).toContain('useApplyThemeExtras();');
    expect(source('components/shell/Rail.tsx')).toContain('useApplyThemeExtras();');
  });

  test('moving presentation preserves every persisted appearance choice and does not alter other preferences', () => {
    const preferences = {
      accentHue: 33,
      accentChroma: 0.09,
      accent2Hue: 170,
      accent2Chroma: 0.06,
      accent3Hue: 290,
      accent3Chroma: 0.11,
      bgHue: 41,
      surfaceTint: 0.25,
      depthSpread: 1.15,
      washOpacity: 0.2,
      bgWashOpacity: 0.35,
      grainOpacity: 0.08,
      grainScale: 160,
      appFont: 'news' as const,
    };
    useClientStore.setState({ ...preferences, capacity: 'low', query: 'from:alex' });
    useClientStore.getState().setPrimaryView('notifications');
    const persisted = persistedClientState(useClientStore.getState());
    expect(persisted).toMatchObject(preferences);
    expect(persisted.query).toBe('from:alex');
    expect(persisted.capacity).toBe('low');
  });
});
