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

/** Days as datelines. A record of actions reads by the day they happened. */
function groupByDay(rows: OperationRow[]): Array<{ key: string; label: string; rows: OperationRow[] }> {
  const today = new Date().toDateString();
  const yesterday = new Date(Date.now() - 86_400_000).toDateString();
  const buckets = new Map<string, OperationRow[]>();
  for (const row of rows) {
    const key = new Date(row.createdAt).toDateString();
    const bucket = buckets.get(key);
    if (bucket) bucket.push(row);
    else buckets.set(key, [row]);
  }
  return [...buckets.entries()].map(([key, group]) => ({
    key,
    label:
      key === today
        ? 'Today'
        : key === yesterday
          ? 'Yesterday'
          : new Date(key).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }),
    rows: group,
  }));
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
      {/* The header shares the measure of the ledger below it. */}
      <header className="border-b border-[var(--color-border)] px-5 py-3">
        <div className="mx-auto max-w-3xl">
          <h1 className="font-serif text-[17px] font-semibold tracking-tight">Activity</h1>
          <p className="mt-0.5 text-[12px] text-[var(--color-text-faint)]">
            Everything Albatross and you have changed, and what can still be taken back.
          </p>
        </div>
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
            <div className="relative">
              {/* One spine down the page. Activity is a record, and a record
                  reads as a column of time rather than a stack of cards. */}
              <span
                aria-hidden
                className="absolute bottom-2 left-[7px] top-2 w-px bg-[var(--color-border)]"
              />
              {groupByDay(rows).map((day) => (
                <div key={day.key} className="relative">
                  <div className="flex items-center gap-2 py-3 pl-6">
                    <span
                      aria-hidden
                      className="absolute left-0 size-[15px] rounded-full border-2 border-[var(--color-bg)] bg-[var(--color-border-strong)]"
                    />
                    <h2 className="font-serif text-[14px] font-semibold">{day.label}</h2>
                    <span aria-hidden className="h-px flex-1 bg-[var(--color-border)]" />
                  </div>
                  <ul className="pl-6">
                    {day.rows.map((row) => (
                      <li key={row._id} className="relative flex items-start gap-3 py-3">
                        <span
                          aria-hidden
                          className={cn(
                            'absolute -left-6 top-[18px] size-[9px] rounded-full border-2 border-[var(--color-bg)]',
                            row.agent === 'ai'
                              ? 'bg-[var(--color-accent)]'
                              : 'bg-[var(--color-border-strong)]',
                          )}
                        />
                        <div className="min-w-0 flex-1">
                          <p className="text-[13.5px] font-medium">{row.summary}</p>
                          <p className="mt-0.5 text-[12px] text-[var(--color-text-muted)]">
                            {whoActed(row)} · {SURFACE_LABEL[row.surface] || row.surface} ·{' '}
                            <span className="font-mono tabular-nums">{whenActed(row.createdAt)}</span>
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
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
