/**
 * The rail's top-level surfaces, in the order a person meets them: the day,
 * the things being carried, then the systems those things run on. The board
 * and Files are optional; each shows only when Settings, Advanced turns it on.
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

export function railSurfaces({
  boardEnabled,
  filesEnabled = true,
}: {
  boardEnabled: boolean;
  filesEnabled?: boolean;
}) {
  const base = filesEnabled ? BASE : BASE.filter((surface) => surface.view !== 'files');
  return boardEnabled ? [...base, { view: 'tasks' as const, label: 'Board' }] : base;
}
