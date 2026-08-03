'use client';

import { useConvexAuth, useQuery } from 'convex/react';
import { LoaderCircle } from 'lucide-react';
import { useState } from 'react';
import { AlbatrossMark } from '@/components/albatross/AlbatrossMark';
import { Button } from '@/components/ui/button';
import { api } from '@/convex/_generated/api';
import { callTool } from '@/lib/api-client';
import { cn } from '@/lib/utils';

interface OperationRow {
  _id: string;
  agent: 'user' | 'ai';
  tool: string;
  surface: string;
  summary: string;
  target?: { kind?: string; id?: string; accountId?: string } | null;
  inverse?: { kind: string } | null;
  status: 'applied' | 'undoing' | 'undone' | 'undo_failed';
  error?: string;
  createdAt: number;
}

const SURFACE_LABEL: Record<string, string> = {
  mail: 'Mail',
  calendar: 'Calendar',
  tasks: 'Tasks',
  albatross: 'Albatross',
};

const STATUS_NOTE: Record<OperationRow['status'], string | null> = {
  applied: null,
  undoing: 'Undoing…',
  undone: 'Undone',
  undo_failed: 'Could not be undone',
};

function whoActed(row: OperationRow): string {
  return row.agent === 'ai' ? 'Albatross did this' : 'You did this';
}

function whenActed(ms: number): string {
  const date = new Date(ms);
  const today = new Date().toDateString() === date.toDateString();
  return today
    ? date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    : date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/**
 * Activity.
 *
 * Because Albatross can act on somebody's behalf, this page is not a settings
 * screen — it is the trust surface. What happened, who did it, which surface it
 * touched, and whether it can still be taken back.
 */
export function ActivitySurface() {
  const { isAuthenticated } = useConvexAuth();
  const rows = useQuery(api.operations.liveRecent, isAuthenticated ? { limit: 100 } : 'skip') as
    | OperationRow[]
    | undefined;
  const [undoing, setUndoing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const undo = async (operationId: string) => {
    setUndoing(operationId);
    setError(null);
    try {
      await callTool('undo_operation', { operationId });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'This change can no longer be undone.');
    } finally {
      setUndoing(null);
    }
  };

  if (rows === undefined) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-[12.5px] text-[var(--color-text-muted)]">
        <LoaderCircle className="size-4 animate-spin" /> Loading
      </div>
    );
  }

  return (
    <section className="flex h-full min-h-0 flex-col">
      <header className="border-b border-[var(--color-border)] px-5 py-3">
        <h1 className="font-serif text-[17px] font-semibold tracking-tight">Activity</h1>
        <p className="mt-0.5 text-[12px] text-[var(--color-text-faint)]">
          Everything Albatross and you have changed, and what can still be taken back.
        </p>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-16 pt-5">
        <div className="mx-auto max-w-3xl">
          {error ? (
            <p className="mb-3 rounded-lg border border-[var(--color-danger)]/25 bg-[var(--color-danger-soft)] px-3 py-2 text-[12px] text-[var(--color-danger)]">
              {error}
            </p>
          ) : null}

          {rows.length === 0 ? (
            <div className="mx-auto max-w-md py-20 text-center">
              <AlbatrossMark className="mx-auto size-10 text-[var(--color-text-faint)]" />
              <h2 className="mt-4 font-serif text-[19px] font-semibold">Nothing has happened yet</h2>
              <p className="mt-2 text-[13px] leading-relaxed text-[var(--color-text-muted)]">
                When Albatross sends something, books something, or changes something on your behalf, it is
                written down here first.
              </p>
            </div>
          ) : (
            <ul className="divide-y divide-[var(--color-border)]/60 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)]">
              {rows.map((row) => (
                <li key={row._id} className="flex items-start gap-3 px-4 py-3.5">
                  <span
                    aria-hidden
                    className={cn(
                      'mt-1.5 size-1.5 shrink-0 rounded-full',
                      row.agent === 'ai' ? 'bg-[var(--color-accent)]' : 'bg-[var(--color-border-strong)]',
                    )}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="text-[13.5px] font-medium">{row.summary}</p>
                    <p className="mt-0.5 text-[12px] text-[var(--color-text-muted)]">
                      {whoActed(row)} · {SURFACE_LABEL[row.surface] || row.surface} ·{' '}
                      {whenActed(row.createdAt)}
                      {row.target?.accountId ? ` · ${row.target.accountId}` : ''}
                    </p>
                    {STATUS_NOTE[row.status] ? (
                      <p
                        className={cn(
                          'mt-0.5 text-[11.5px]',
                          row.status === 'undo_failed'
                            ? 'text-[var(--color-danger)]'
                            : 'text-[var(--color-text-faint)]',
                        )}
                      >
                        {STATUS_NOTE[row.status]}
                        {row.error ? ` — ${row.error}` : ''}
                      </p>
                    ) : null}
                  </div>
                  {/* Only offer the button when an inverse actually exists. A
                      dead undo is worse than none. */}
                  {row.inverse && row.status === 'applied' ? (
                    <Button
                      type="button"
                      size="xs"
                      variant="outline"
                      disabled={undoing === row._id}
                      onClick={() => void undo(row._id)}
                    >
                      {undoing === row._id ? 'Undoing…' : 'Undo'}
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}
