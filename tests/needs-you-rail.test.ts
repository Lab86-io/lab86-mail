import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { railNeedsYouBadge } from '../components/needs-you/RailNeedsYouRow';

test('the rail row says what needs the user now, else how many are open, else nothing', () => {
  expect(railNeedsYouBadge({ now: 2, open: 10 })).toEqual({ text: '2 now', now: true });
  expect(railNeedsYouBadge({ now: 0, open: 10 })).toEqual({ text: '10 open', now: false });
  expect(railNeedsYouBadge({ now: 0, open: 0 })).toBeNull();
});

test('the rail shows Needs you first, above the surfaces, and it opens the Needs you page', () => {
  const rail = readFileSync('components/shell/Rail.tsx', 'utf8');
  const row = rail.indexOf('<RailNeedsYouRow');
  const surfaces = rail.indexOf('{SURFACES.map(');
  expect(row).toBeGreaterThan(-1);
  expect(row).toBeLessThan(surfaces);
  expect(rail.slice(row, surfaces)).toContain("setPrimaryView('notifications')");
});

test('count-only callers skip the current-move read; the hook skips it and its timer when asked', () => {
  for (const file of [
    'components/needs-you/RailNeedsYouRow.tsx',
    'components/shell/NotificationCenter.tsx',
    'components/needs-you/NeedsYouArrivals.tsx',
  ])
    expect(readFileSync(file, 'utf8')).toContain('useNeedsYou({ execution: false })');
  expect(readFileSync('components/needs-you/useNeedsYou.ts', 'utf8')).toContain('useNotifications(options)');
  const hook = readFileSync('components/notifications/useNotifications.ts', 'utf8');
  expect(hook).toContain("isAuthenticated && withExecution ? { nowMs } : 'skip'");
  expect(hook).toContain('if (!isAuthenticated || !withExecution) return;');
});
