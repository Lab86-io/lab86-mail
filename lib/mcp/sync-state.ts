import type { McpConnectionOutcome } from './connection-health';

export function mcpSyncStateFields(
  input: {
    userId: string;
    connectionId: string;
    server: string;
    status: 'idle' | 'syncing' | 'ready' | 'error';
    lastSyncedAt?: number;
    lastCursor?: string;
    itemCount?: number;
    accountEmail?: string;
    workspaceName?: string;
    error?: string;
  },
  updatedAt: number,
) {
  return {
    userId: input.userId,
    connectionId: input.connectionId,
    server: input.server,
    status: input.status,
    lastSyncedAt: input.lastSyncedAt,
    lastCursor: input.lastCursor,
    itemCount: input.itemCount,
    ...(input.accountEmail !== undefined ? { accountEmail: input.accountEmail } : {}),
    ...(input.workspaceName !== undefined ? { workspaceName: input.workspaceName } : {}),
    error: input.error,
    updatedAt,
  };
}

const MAX_SYNC_ERROR_LENGTH = 300;

/**
 * The patch that one sync result makes to its connection row (AI-7). Only
 * the connection outcome changes `status`: `ok` (the source answered, maybe
 * only in part) sets `connected`, and `reconnect` (the sign-in failed) sets
 * `error`. A sync problem goes in `lastSyncError`. Without an outcome, a
 * `ready` sync counts as `ok`, and a failed sync keeps the current status.
 * A disconnected row never comes back from a sync that finished late.
 */
export function mcpConnectionSyncPatch(
  connection: { status: string; lastSyncedAt?: number },
  input: {
    status: 'idle' | 'syncing' | 'ready' | 'error';
    lastSyncedAt?: number;
    error?: string;
    outcome?: McpConnectionOutcome;
  },
  ts: number,
): Record<string, unknown> | null {
  if (connection.status === 'disconnected') return null;
  const patch: Record<string, unknown> = { updatedAt: ts };
  if (input.lastSyncedAt !== undefined) patch.lastSyncedAt = input.lastSyncedAt;
  if (input.status !== 'ready' && input.status !== 'error') return patch;

  const outcome = input.outcome ?? (input.status === 'ready' ? 'ok' : undefined);
  const nextStatus = outcome === 'ok' ? 'connected' : outcome === 'reconnect' ? 'error' : connection.status;
  const problem =
    input.status === 'error' ? (input.error?.trim() || 'sync failed').slice(0, MAX_SYNC_ERROR_LENGTH) : null;

  patch.status = nextStatus;
  if (outcome === 'ok') patch.lastSyncOkAt = ts;
  if (problem) {
    patch.lastSyncError = problem;
    patch.lastSyncErrorAt = ts;
  } else {
    patch.lastSyncError = undefined;
    patch.lastSyncErrorAt = undefined;
  }
  if (nextStatus === 'connected') patch.error = undefined;
  else if (outcome === 'reconnect') patch.error = problem ?? 'Reconnect needed.';
  return patch;
}
