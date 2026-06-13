import { CalendarClock } from 'lucide-react';
import type { Metadata } from 'next';
import { api, convexQuery } from '@/lib/hosted/convex';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Shared board · Lab86', robots: { index: false } };

// Public read-only board view. The token in the URL is the only credential;
// the query exposes board content and nothing else (no members, no mail).
export default async function PublicBoardPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const board = await convexQuery<any>((api as any).boards.getPublicBoard, { token }).catch(() => null);

  if (!board) {
    return (
      <main className="grid min-h-dvh place-items-center bg-[var(--color-bg)] px-6">
        <div className="text-center">
          <h1 className="font-display text-[20px] font-semibold text-[var(--color-text)]">
            This board link isn’t active
          </h1>
          <p className="mt-2 text-[13.5px] text-[var(--color-text-muted)]">
            The link may have been disabled by the board’s owner.
          </p>
        </div>
      </main>
    );
  }

  const cardsByColumn = new Map<string, any[]>();
  for (const card of board.cards) {
    const group = cardsByColumn.get(card.columnId) || [];
    group.push(card);
    cardsByColumn.set(card.columnId, group);
  }

  return (
    <main className="min-h-dvh bg-[var(--color-bg)] px-6 py-8">
      <header className="mx-auto mb-6 max-w-6xl">
        <p className="text-[11px] uppercase tracking-[0.12em] text-[var(--color-text-faint)]">
          Shared board · read-only
        </p>
        <h1 className="font-display text-[24px] font-semibold tracking-tight text-[var(--color-text)]">
          {board.title}
        </h1>
      </header>
      <div className="mx-auto flex max-w-6xl gap-4 overflow-x-auto pb-4">
        {board.columns.map((column: any) => (
          <section
            key={column.columnId}
            className="w-72 shrink-0 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] shadow-[var(--shadow-soft)]"
          >
            <h2 className="border-b border-[var(--color-border)] px-3 py-2 text-[12px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-muted)]">
              {column.name}
              <span className="ml-2 font-normal tabular-nums text-[var(--color-text-faint)]">
                {(cardsByColumn.get(column.columnId) || []).length}
              </span>
            </h2>
            <ul className="space-y-2 p-2">
              {(cardsByColumn.get(column.columnId) || []).map((card: any) => (
                <li
                  key={card.cardId}
                  className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2"
                >
                  <p className="text-[13px] font-medium leading-snug text-[var(--color-text)]">
                    {card.title}
                  </p>
                  {card.dueAt ? (
                    <p className="mt-1 inline-flex items-center gap-1 text-[10.5px] text-[var(--color-text-faint)]">
                      <CalendarClock className="size-3" />
                      {new Date(card.dueAt).toLocaleDateString(undefined, {
                        month: 'short',
                        day: 'numeric',
                      })}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </main>
  );
}
