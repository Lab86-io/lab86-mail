/**
 * The rail's top-level surfaces, in the order a person meets them: the day,
 * the things being carried, then the systems those things run on. The board
 * is optional; it shows only when the user turns it on in Settings.
 */
export type RailSurfaceView = 'today' | 'albatrosses' | 'chat' | 'mail' | 'calendar' | 'files' | 'tasks';

const BASE: Array<{ view: RailSurfaceView; label: string }> = [
  { view: 'today', label: 'Today' },
  { view: 'albatrosses', label: 'Albatrosses' },
  { view: 'chat', label: 'Chat' },
  { view: 'mail', label: 'Mail' },
  { view: 'calendar', label: 'Calendar' },
  { view: 'files', label: 'Files' },
];

export function railSurfaces({ boardEnabled }: { boardEnabled: boolean }) {
  return boardEnabled ? [...BASE, { view: 'tasks' as const, label: 'Board' }] : BASE;
}
