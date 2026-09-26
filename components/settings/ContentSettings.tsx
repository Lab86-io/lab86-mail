'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';

export async function contentRequest(view = 'settings', body?: unknown) {
  const response = await fetch(
    `/api/content?view=${view}`,
    body
      ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      : { cache: 'no-store' },
  );
  const data = await response.json().catch(() => null);
  if (!response.ok || !data) throw new Error(data?.error || 'Content could not load.');
  return data;
}
const sourceNames: Record<string, string> = {
  __mail: 'Mail library',
  __mcp: 'Connected tools',
  __document: 'Albatross documents',
};
export function ContentSettings() {
  const client = useQueryClient();
  const state = useQuery({
    queryKey: ['content-settings'],
    queryFn: () => contentRequest(),
    refetchInterval: 15_000,
  });
  const change = useMutation({
    mutationFn: (body: unknown) => contentRequest('settings', body),
    onSuccess: () => client.invalidateQueries({ queryKey: ['content-settings'] }),
  });
  return (
    <section aria-labelledby="content-heading" className="space-y-3">
      <h3 id="content-heading" className="text-sm font-medium">
        Connected content and prepared work
      </h3>
      <p className="text-xs leading-relaxed text-[var(--color-text-muted)]">
        Keep source content searchable, classify changes with mail sorting, and let your writing model
        research and prepare drafts in the Brief. Prepared work stays there until you adopt it. History fills
        in progressively; provider limits and partially read files are shown below.
      </p>
      {state.error || change.error ? (
        <p role="alert" className="text-sm text-[var(--color-danger)]">
          {(state.error || change.error)?.message}
        </p>
      ) : null}
      {state.isLoading ? (
        <p role="status" className="text-sm">
          Loading content coverage…
        </p>
      ) : null}
      {state.data ? (
        <>
          <div className="divide-y divide-[var(--color-border)] rounded-[var(--radius-control)] border border-[var(--color-border)]">
            {(
              [
                { key: 'enabled', title: 'Sync and index connected content' },
                { key: 'prepare', title: 'Prepare work in the Brief' },
              ] as const
            ).map(({ key, title }) => (
              <label
                key={key}
                htmlFor={`content-${key}`}
                className="flex items-center justify-between gap-4 p-3 text-sm"
              >
                {title}
                <Switch
                  id={`content-${key}`}
                  aria-label={title}
                  checked={state.data.preferences[key]}
                  disabled={change.isPending}
                  onCheckedChange={(checked) =>
                    change.mutate({ operation: 'preferences', ...state.data.preferences, [key]: checked })
                  }
                />
              </label>
            ))}
          </div>
          <p className="text-xs text-[var(--color-text-muted)]">
            Recent {state.data.sampleSize} sources: {state.data.counts.classified} classified ·{' '}
            {state.data.counts.pending} pending · {state.data.counts.semantic} searchable by meaning ·{' '}
            {state.data.counts.partial} partially read.
          </p>
          <ul className="divide-y divide-[var(--color-border)] text-xs">
            {state.data.connections
              .filter((row: any) => row.connectionId !== '__cycle')
              .map((row: any) => (
                <li key={row.connectionId} className="space-y-1 py-2">
                  <div className="flex flex-wrap justify-between gap-2">
                    <span>{row.displayName || sourceNames[row.connectionId] || row.connectionId}</span>
                    <span>{row.status.replaceAll('_', ' ')}</span>
                  </div>
                  <p className="text-[var(--color-text-muted)]">
                    {row.indexed} indexed updates · Last checked {new Date(row.updatedAt).toLocaleString()}
                    {row.skipped ? ` · ${row.skipped} skipped or partial reads` : ''}
                  </p>
                  {row.error ? <p className="text-[var(--color-danger)]">{row.error}</p> : null}
                </li>
              ))}
          </ul>
        </>
      ) : null}
      <Button
        variant="outline"
        size="sm"
        disabled={change.isPending || state.data?.preferences.enabled === false}
        onClick={() => change.mutate({ operation: 'sync' })}
      >
        Sync now
      </Button>
      {change.isSuccess ? (
        <p role="status" className="text-xs text-[var(--color-text-muted)]">
          Saved. Background processing is queued.
        </p>
      ) : null}
    </section>
  );
}
