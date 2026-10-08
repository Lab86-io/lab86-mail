'use client';

// The Brief's "Ready for you" list: the handoffs that wait and the runs at
// work, at the top of the newest edition. It is live (openHandoffs), not part
// of the edition document, so a handoff that lands after 7:00 still appears.
// The list hides when it is empty.

import { useConvex, useConvexAuth, useQuery } from 'convex/react';
import { useMemo } from 'react';
import { ShimmerText } from '@/components/odysseyui/text-shimmer';
import { Button } from '@/components/ui/button';
import { api } from '@/convex/_generated/api';
import { readyForYouAllowLine } from '@/lib/albatross/secure-view';
import {
  type ReadyForYouRow,
  readyForYouRows,
  type StepRunHandoffItem,
} from '@/lib/albatross/step-run-client';
import { openWorkPage, performNextBehaviour } from '@/lib/albatross/step-run-navigation';
import { callTool } from '@/lib/api-client';
import { useClientStore } from '@/lib/client-state';
import { cn } from '@/lib/utils';

/** Handoffs count as waiting; runs at work are named apart. */
export function readyForYouCountLine(rows: readonly ReadyForYouRow[]): string {
  const waiting = rows.filter((row) => !row.working).length;
  const working = rows.length - waiting;
  if (waiting) return waiting === 1 ? 'One step waits for you.' : `${waiting} steps wait for you.`;
  return working === 1 ? 'Albatross works on one step.' : `Albatross works on ${working} steps.`;
}

/**
 * The rows, with one change for an allow_secure handoff: its line is the
 * question ("Albatross needs your answer: use your driver's license number
 * on ny.gov?"), and its one button opens the thread, where the three
 * choices and the identity check live (docs/albatross-secure-store.md).
 */
export function readyForYouRowsWithSecure(items: readonly StepRunHandoffItem[]): ReadyForYouRow[] {
  const runs = new Map(items.map((item) => [item.run.id, item.run]));
  return readyForYouRows(items).map((row) => {
    const next = runs.get(row.runId)?.next;
    if (!next || next.kind !== 'allow_secure' || !next.allow) return row;
    return {
      ...row,
      line: readyForYouAllowLine(next.allow),
      action: { label: 'Answer', behaviour: { kind: 'open_work' } },
    };
  });
}

export function ReadyForYouList({
  items,
  onOpenWork,
  onAct,
  className,
}: {
  items: readonly StepRunHandoffItem[];
  onOpenWork: (workId: string) => void;
  onAct: (row: ReadyForYouRow) => void;
  className?: string;
}) {
  const rows = readyForYouRowsWithSecure(items);
  if (!rows.length) return null;
  return (
    <section
      aria-labelledby="ready-for-you-heading"
      data-ready-for-you
      className={cn('mb-6 w-full', className)}
    >
      <div className="flex flex-wrap items-baseline gap-x-3">
        <h2 id="ready-for-you-heading" className="font-serif text-[15px] font-semibold">
          Ready for you
        </h2>
        <p className="text-[12px] text-[var(--color-text-faint)]">{readyForYouCountLine(rows)}</p>
        <span aria-hidden className="h-px flex-1 bg-[var(--color-border)]" />
      </div>
      <ul className="mt-2 divide-y divide-[var(--color-border)]/70">
        {rows.map((row) => (
          <li
            key={row.runId}
            data-ready-row={row.working ? 'working' : 'handoff'}
            className="flex items-start gap-3 py-3"
          >
            <div className="min-w-0 flex-1">
              <button
                type="button"
                onClick={() => onOpenWork(row.workId)}
                className="text-left text-[13px] font-medium underline-offset-2 hover:underline"
              >
                {row.workTitle}
              </button>
              <p className="mt-0.5 text-[12px] text-[var(--color-text-muted)]">
                {row.working ? (
                  <ShimmerText text={row.stepTitle} duration={1.6} startOnView={false} />
                ) : (
                  row.stepTitle
                )}
              </p>
              <p className="mt-0.5 text-[12.5px] leading-relaxed">{row.line}</p>
            </div>
            {row.action ? (
              <Button type="button" size="sm" className="shrink-0" onClick={() => onAct(row)}>
                {row.action.label}
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The live list. A tree without a Convex client (a server render in a test)
 * renders nothing; the app always has one. The inner component subscribes
 * when the user is signed in.
 */
export function ReadyForYou({ className }: { className?: string }) {
  const client = useConvex();
  if (!client) return null;
  return <ReadyForYouLive className={className} />;
}

function ReadyForYouLive({ className }: { className?: string }) {
  const { isAuthenticated } = useConvexAuth();
  const items = useQuery(api.albatrossStepRuns.openHandoffs, isAuthenticated ? {} : 'skip') as
    | StepRunHandoffItem[]
    | undefined;
  const deps = useMemo(
    () => ({
      getState: () => useClientStore.getState(),
      setState: (patch: Record<string, unknown>) => useClientStore.setState(patch as never),
      callTool: (name: string, args: Record<string, unknown>) => callTool(name, args),
      openWindow: (url: string) => {
        window.open(url, '_blank', 'noopener,noreferrer');
      },
      pushPath: (path: string) => window.history.pushState(window.history.state, '', path),
      dispatch: (eventName: string) => window.dispatchEvent(new Event(eventName)),
    }),
    [],
  );
  if (!items?.length) return null;
  return (
    <ReadyForYouList
      items={items}
      className={className}
      onOpenWork={(workId) => openWorkPage(deps, workId)}
      onAct={(row) => {
        if (!row.action || row.action.behaviour.kind === 'open_work') {
          openWorkPage(deps, row.workId);
          return;
        }
        void performNextBehaviour(row.action.behaviour, deps, {
          resume: () => {
            void fetch(`/api/albatross/work/${encodeURIComponent(row.workId)}/run`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ action: 'resume', runId: row.runId }),
            })
              .then((response) => response.ok)
              .catch(() => false)
              .then((ok) => {
                if (!ok) openWorkPage(deps, row.workId);
              });
          },
        })
          .catch(() => false)
          .then((opened) => {
            if (!opened) openWorkPage(deps, row.workId);
          });
      }}
    />
  );
}
