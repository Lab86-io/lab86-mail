'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';

interface ProposedChild {
  title: string;
  rawText: string;
}

async function postSplit(workId: string, body: Record<string, unknown>) {
  const response = await fetch(`/api/albatross/work/${encodeURIComponent(workId)}/split`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const parsed = await response.json().catch(() => null);
  if (!response.ok || !parsed?.ok) throw new Error(parsed?.error || 'The split failed.');
  return parsed;
}

/**
 * The split proposal, in place. One Work that bundles several outcomes reads
 * as one blob everywhere: in the list, in proof matching, in guided work. The
 * sheet shows the proposed children, lets the user drop any of them, and
 * commits the rest. The parent is released with provenance, never deleted.
 */
export function SplitSheet({
  workId,
  onDone,
  onCancel,
}: {
  workId: string;
  onDone: (workIds: string[]) => void;
  onCancel: () => void;
}) {
  const [items, setItems] = useState<ProposedChild[] | null>(null);
  const [excluded, setExcluded] = useState<ReadonlySet<number>>(() => new Set());
  const [committing, setCommitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setItems(null);
    setExcluded(new Set());
    setError(null);
    postSplit(workId, { mode: 'propose' })
      .then((result) => {
        if (!cancelled) setItems(result.items || []);
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : 'The split failed.');
      });
    return () => {
      cancelled = true;
    };
  }, [workId]);

  const included = (items || []).filter((_, index) => !excluded.has(index));

  const commit = async () => {
    if (committing || included.length < 2) return;
    setCommitting(true);
    setError(null);
    try {
      const result = await postSplit(workId, {
        mode: 'commit',
        items: included,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
      onDone(result.workIds || []);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The split failed.');
      setCommitting(false);
    }
  };

  return (
    <section className="mt-6 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-4">
      <h2 className="text-[13.5px] font-medium">Split this work</h2>
      <p className="mt-0.5 text-[11.5px] text-[var(--color-text-muted)]">
        Each part becomes its own Albatross with its own plan and its own proof. This one is released
        with a record of the split.
      </p>

      {error ? (
        <p className="mt-3 text-[12px] text-[var(--color-danger)]">{error}</p>
      ) : items === null ? (
        <p className="mt-3 text-[12px] text-[var(--color-text-muted)]">Finding the seams…</p>
      ) : (
        <ul className="mt-3 space-y-1.5">
          {items.map((item, index) => {
            const off = excluded.has(index);
            return (
              <li key={item.title}>
                <label
                  className={
                    'flex cursor-pointer items-start gap-2.5 rounded-lg border border-[var(--color-border)] px-3 py-2 transition-colors hover:border-[var(--color-border-strong)]' +
                    (off ? ' opacity-50' : '')
                  }
                >
                  <input
                    type="checkbox"
                    checked={!off}
                    onChange={() =>
                      setExcluded((current) => {
                        const next = new Set(current);
                        if (next.has(index)) next.delete(index);
                        else next.add(index);
                        return next;
                      })
                    }
                    className="mt-0.5 accent-[var(--color-accent)]"
                  />
                  <span className="min-w-0">
                    <span className="block text-[12.5px] font-medium">{item.title}</span>
                    <span className="mt-0.5 line-clamp-2 block text-[11.5px] leading-relaxed text-[var(--color-text-muted)]">
                      {item.rawText}
                    </span>
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      )}

      <div className="mt-3 flex items-center justify-between gap-3 border-t border-[var(--color-border)]/70 pt-3">
        <span className="text-[11.5px] text-[var(--color-text-muted)]">
          {items === null && !error
            ? ''
            : included.length < 2
              ? 'Keep at least 2 parts to split.'
              : `${included.length} Works will be created.`}
        </span>
        <div className="flex gap-1.5">
          <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
            Never mind
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={committing || included.length < 2}
            onClick={() => void commit()}
          >
            {committing ? 'Splitting…' : `Create ${Math.max(included.length, 2)} Works`}
          </Button>
        </div>
      </div>
    </section>
  );
}
