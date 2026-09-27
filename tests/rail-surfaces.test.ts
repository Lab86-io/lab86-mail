import { expect, test } from 'bun:test';
import { railSurfaces } from '../lib/shell/rail-surfaces';

test('the board shows in the rail only when the Settings switch is on', () => {
  expect(railSurfaces({ boardEnabled: false }).map((s) => s.view)).toEqual([
    'today',
    'albatrosses',
    'chat',
    'mail',
    'calendar',
    'files',
  ]);
  const on = railSurfaces({ boardEnabled: true });
  expect(on.at(-1)).toEqual({ view: 'tasks', label: 'Board' });
  expect(on).toHaveLength(7);
});
