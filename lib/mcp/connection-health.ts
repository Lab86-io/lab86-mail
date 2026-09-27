// One connection health state for connected tools (AI-7), in line with the
// mailbox health state (SYNC-2). `status` says only whether the connection
// itself works:
//   - `connected`: the saved sign-in works.
//   - `error`: the user must reconnect (the sign-in expired or was rejected).
//   - `disconnected`: the user removed the connection.
// A failed or partial sync never changes `status`. It goes in
// `lastSyncError` and `lastSyncErrorAt`. `lastSyncOkAt` is the last time a
// sync reached the source and saved its items; a partial sync counts.

export type McpConnectionStatus = 'connected' | 'disconnected' | 'error';

/** What one sync run learned about the connection itself. */
export type McpConnectionOutcome = 'ok' | 'reconnect';

export interface McpConnectionHealthFields {
  status: McpConnectionStatus | string;
  error?: string;
  lastSyncError?: string;
  lastSyncErrorAt?: number;
  lastSyncOkAt?: number;
}

export interface McpSyncProblem {
  message: string;
  at: number | null;
  /** The same run also saved items, so only part of the sync failed. */
  partial: boolean;
}

/** True only when the user must sign in to the source again. */
export function mcpNeedsReconnect(row: Pick<McpConnectionHealthFields, 'status'>): boolean {
  return row.status === 'error';
}

/** The problem from the last sync of a working connection, or null. */
export function mcpSyncProblem(row: McpConnectionHealthFields): McpSyncProblem | null {
  if (row.status !== 'connected') return null;
  const message = row.lastSyncError?.trim();
  if (!message) return null;
  const at = typeof row.lastSyncErrorAt === 'number' ? row.lastSyncErrorAt : null;
  const partial = at !== null && typeof row.lastSyncOkAt === 'number' && row.lastSyncOkAt >= at;
  return { message, at, partial };
}

/**
 * True when an error text from before AI-7 says the sign-in failed. The
 * migration keeps these rows in the reconnect state; the next good sync
 * moves them back to `connected`.
 */
export function isMcpReconnectMessage(text: unknown): boolean {
  return (
    typeof text === 'string' &&
    /\breconnect\b|auth rejected|missing or unreadable credentials|sign-in expired/i.test(text)
  );
}
