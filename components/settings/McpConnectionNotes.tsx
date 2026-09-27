'use client';

import {
  type McpConnectionHealthFields,
  mcpNeedsReconnect,
  mcpSyncProblem,
} from '@/lib/mcp/connection-health';

// The two notes under a connected tool in Settings (AI-7). "Reconnect" shows
// only when the saved sign-in failed. A sync problem on a working connection
// is a quiet note, because the next sync tries again by itself.

interface McpConnectionNoteRow extends McpConnectionHealthFields {
  server: string;
  authKind?: 'token' | 'oauth';
}

export function McpReconnectNote({ connection }: { connection: McpConnectionNoteRow }) {
  if (!mcpNeedsReconnect(connection)) return null;
  const oauth = connection.authKind === 'oauth';
  return (
    <div
      data-mcp-reconnect
      title={connection.error || undefined}
      className="mt-1 text-[11px] font-medium text-[var(--color-danger)]"
    >
      Reconnect needed. The saved sign-in no longer works.{' '}
      {oauth ? (
        <a
          href={`/api/mcp/oauth/start?server=${encodeURIComponent(connection.server)}`}
          className="underline"
        >
          Reconnect
        </a>
      ) : (
        'Add a new token below.'
      )}
    </div>
  );
}

export function McpSyncProblemNote({ connection }: { connection: McpConnectionNoteRow }) {
  const problem = mcpSyncProblem(connection);
  if (!problem) return null;
  return (
    <div
      data-mcp-sync-problem={problem.partial ? 'partial' : 'failed'}
      title={problem.message}
      className="mt-1 line-clamp-2 break-words text-[11px] text-[var(--color-text-muted)]"
    >
      {problem.partial ? 'Part of the last sync had a problem' : 'Last sync had a problem'}:{' '}
      {problem.message.replace(/[.\s]+$/, '')}. It will try again.
    </div>
  );
}
