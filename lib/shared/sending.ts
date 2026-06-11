// Undo-send window: how long a send is held (server-side) before it actually
// goes out. 0 = instant, capped at 5 minutes.
export const DEFAULT_UNDO_SEND_SECONDS = 10;
export const MAX_UNDO_SEND_SECONDS = 300;

export const UNDO_SEND_CHOICES = [
  { value: 0, label: 'Instant (off)' },
  { value: 5, label: '5 seconds' },
  { value: 10, label: '10 seconds' },
  { value: 20, label: '20 seconds' },
  { value: 30, label: '30 seconds' },
  { value: 60, label: '1 minute' },
  { value: 120, label: '2 minutes' },
  { value: 300, label: '5 minutes' },
] as const;

export function normalizeUndoSendSeconds(value: unknown): number {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_UNDO_SEND_SECONDS;
  return Math.min(MAX_UNDO_SEND_SECONDS, parsed);
}
