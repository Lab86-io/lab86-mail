'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ArrowUpRight, Loader2, RefreshCw } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { CommandPalette } from '@/components/palette/CommandPalette';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useClientStore } from '@/lib/client-state';
import { type NarrativeEntry, safeNarrativeUrl } from '@/lib/narrative/core';

async function request(path: string, body?: unknown, signal?: AbortSignal) {
  const response = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Narrative request failed');
  return result;
}
function useNarrativeCommand() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: unknown) => request('/api/narrative', body),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['narrative'] });
      void client.invalidateQueries({ queryKey: ['global-search', 'narrative'] });
    },
  });
}
const field =
  'rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-3 py-2 text-[13px] focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]';

export function NarrativeSettings() {
  const state = useQuery({
    queryKey: ['narrative', 'status'],
    queryFn: ({ signal }) => request('/api/narrative?op=status', undefined, signal),
    refetchInterval: 8000,
  });
  const command = useNarrativeCommand();
  const [sources, setSources] = useState<string[] | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [erase, setErase] = useState(false);
  const selected = sources ?? state.data?.settings?.sources ?? [];
  if (state.isPending) return <p role="status">Loading narrative settings…</p>;
  if (state.error)
    return (
      <p role="alert">
        {state.error.message}{' '}
        <button type="button" onClick={() => void state.refetch()}>
          Retry
        </button>
      </p>
    );
  if (!state.data?.available)
    return <p>Narrative memory is in a staging pilot and is not enabled for this account.</p>;
  const settings = state.data.settings;
  return (
    <section className="space-y-5 text-[13px]">
      <div>
        <h2 className="font-serif text-xl">Narrative</h2>
        <p className="mt-2 text-[var(--color-text-muted)]">
          A source-linked account of what mattered, what changed, and what is still open. Shared by your
          brief, chats, search, and Albatrosses.
        </p>
      </div>
      <p>
        No sources are included until you choose them. Enabling memory starts with the last 30 days and
        follows new changes. Connected-source content is sent to your selected AI provider when a narrative
        run needs it.
      </p>
      <fieldset className="space-y-2">
        <legend className="mb-2 font-medium">Sources you allow narrative memory to use</legend>
        {state.data.sources.map((source: any) => (
          <label
            key={source.id}
            className="flex items-start gap-3 rounded-lg border border-[var(--color-border)] p-3"
          >
            <input
              type="checkbox"
              checked={selected.includes(source.id)}
              onChange={(event) =>
                setSources(
                  event.target.checked
                    ? [...selected, source.id]
                    : selected.filter((id: string) => id !== source.id),
                )
              }
              className="mt-1 accent-[var(--color-accent)]"
            />
            <span>
              <span className="block">{source.label}</span>
              <span className="text-xs text-[var(--color-text-muted)]">
                {source.status}
                {source.lastSyncedAt
                  ? ` · last synced ${new Date(source.lastSyncedAt).toLocaleString()}`
                  : ''}
              </span>
            </span>
          </label>
        ))}
      </fieldset>
      <label className="block space-y-2">
        <span className="block font-medium">Narrative model</span>
        <select
          className={field}
          value={model ?? settings.model}
          onChange={(event) => setModel(event.target.value)}
        >
          <option value="z-ai/glm-5.3-flash">GLM-5.3-Flash · OpenRouter</option>
          <option value="current">Current AI model · subject to narrative budget</option>
        </select>
      </label>
      <p className="text-xs text-[var(--color-text-muted)]">
        Runs are capped at 24 per day, two research passes, and a conservative $0.50 maximum model-cost
        estimate per run. If the model or a source is unavailable, the evidence-based fallback remains
        readable. Full provider archives are not copied.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={command.isPending || !selected.length}
          onClick={() =>
            command.mutate(
              {
                action: 'configure',
                enabled: true,
                sources: selected,
                timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                model: model ?? settings.model,
              },
              {
                onSuccess: () => {
                  setSources(null);
                  setModel(null);
                },
              },
            )
          }
        >
          {settings.enabled ? 'Save sources' : 'Enable narrative memory'}
        </Button>
        {settings.enabled ? (
          <Button
            variant="outline"
            disabled={command.isPending}
            onClick={() =>
              command.mutate({
                action: 'configure',
                enabled: false,
                sources: [],
                timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                model: model ?? settings.model,
              })
            }
          >
            Turn off and remove memory
          </Button>
        ) : null}
        <Button variant="ghost" asChild>
          <Link href="/narrative">
            Read your narrative <ArrowUpRight className="size-3.5" />
          </Link>
        </Button>
      </div>
      {settings.lastError ? (
        <p role="status" className="text-[var(--color-text-muted)]">
          Last run: {settings.lastError}
        </p>
      ) : null}
      <div className="border-t border-[var(--color-border)] pt-4">
        <p>
          Forget narrative memory, including generated chapters. Original emails, meetings, files, Work, and
          existing chat transcripts and saved Work artifacts are unchanged. Previously generated answers are
          not rewritten. You can enable collection again later.
        </p>
        {!erase ? (
          <Button variant="ghost" onClick={() => setErase(true)}>
            Forget all narrative memory…
          </Button>
        ) : (
          <div className="mt-2 flex gap-2">
            <Button
              variant="destructive"
              disabled={command.isPending}
              onClick={() =>
                command.mutate(
                  { action: 'erase', confirmation: 'forget narrative' },
                  {
                    onSuccess: () => {
                      setErase(false);
                      setSources(null);
                    },
                  },
                )
              }
            >
              Confirm: forget narrative
            </Button>
            <Button variant="ghost" onClick={() => setErase(false)}>
              Cancel
            </Button>
          </div>
        )}
      </div>
      {command.error ? <p role="alert">{command.error.message}</p> : null}
      {command.isSuccess ? (
        <p role="status">Saved. Changes apply to future memory reads immediately.</p>
      ) : null}
    </section>
  );
}

function ObservationCard({ entry, onChange }: { entry: NarrativeEntry; onChange: () => void }) {
  const command = useNarrativeCommand();
  const [editing, setEditing] = useState(false),
    [confirmForget, setConfirmForget] = useState(false),
    [text, setText] = useState(entry.text);
  const link = safeNarrativeUrl(entry.url);
  const editor = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (editing) editor.current?.focus();
  }, [editing]);
  return (
    <article className="space-y-2 border-l-2 border-[var(--color-border)] pl-4">
      <div className="flex flex-wrap items-baseline gap-2">
        <h3 className="font-medium">{entry.title}</h3>
        <span className="text-[11px] text-[var(--color-text-muted)]">
          {entry.trust}
          {entry.corrected ? ' · corrected by you' : ''}
          {entry.pinned ? ' · kept in focus' : ''}
        </span>
      </div>
      <p className="text-xs text-[var(--color-text-muted)]">
        Happened {new Date(entry.occurredAt).toLocaleString()} · learned{' '}
        {new Date(entry.observedAt).toLocaleString()}
      </p>
      {editing ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            command.mutate(
              { action: 'edit', id: entry._id, text },
              {
                onSuccess: () => {
                  setEditing(false);
                  onChange();
                },
              },
            );
          }}
          className="space-y-2"
        >
          <label className="block">
            <span className="sr-only">Correct this observation</span>
            <textarea
              ref={editor}
              className={`${field} min-h-28 w-full`}
              value={text}
              onChange={(event) => setText(event.target.value)}
              maxLength={4000}
              required
            />
          </label>
          <Button size="sm" disabled={command.isPending}>
            Save correction
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(false)}>
            Cancel
          </Button>
        </form>
      ) : (
        <p className="whitespace-pre-line leading-relaxed">{entry.text}</p>
      )}
      <div className="flex flex-wrap gap-3 text-xs text-[var(--color-text-muted)]">
        {link ? (
          <a href={link} target="_blank" rel="noreferrer">
            Open original source ↗
          </a>
        ) : null}
        <button type="button" onClick={() => setEditing(true)}>
          Correct
        </button>
        <button
          type="button"
          disabled={command.isPending}
          onClick={() =>
            command.mutate({ action: 'edit', id: entry._id, pinned: !entry.pinned }, { onSuccess: onChange })
          }
        >
          {entry.pinned ? 'Remove from focus' : 'Keep in focus'}
        </button>
        <button type="button" onClick={() => setConfirmForget(true)}>
          Forget…
        </button>
      </div>
      {confirmForget ? (
        <div className="rounded-lg bg-[var(--color-bg-muted)] p-3">
          <p>Remove this observation and its derived chapters? This item will not be imported again.</p>
          <Button
            variant="destructive"
            size="sm"
            disabled={command.isPending}
            onClick={() => command.mutate({ action: 'forget', id: entry._id }, { onSuccess: onChange })}
          >
            Forget observation
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setConfirmForget(false)}>
            Cancel
          </Button>
        </div>
      ) : null}
      {command.error ? <p role="alert">{command.error.message}</p> : null}
    </article>
  );
}

export function NarrativeSearchButton() {
  return (
    <button
      type="button"
      className={`${field} ml-auto`}
      aria-label="Search everything (slash)"
      aria-keyshortcuts="/"
      onClick={() => useClientStore.getState().setPaletteOpen(true)}
    >
      Search <kbd className="ml-2 text-xs">/</kbd>
    </button>
  );
}

export function NarrativePage() {
  const params = useSearchParams();
  const router = useRouter();
  const linkedId = params.get('id');
  const [id, setId] = useState<string | null>(linkedId);
  useEffect(() => setId(linkedId), [linkedId]);
  const [query, setQuery] = useState(''),
    [debounced, setDebounced] = useState(''),
    [level, setLevel] = useState('');
  const command = useNarrativeCommand();
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query), 200);
    return () => clearTimeout(timer);
  }, [query]);
  const entries = useQuery({
    queryKey: ['narrative', 'entries', debounced, level],
    queryFn: ({ signal }) =>
      request(
        `/api/narrative?q=${encodeURIComponent(debounced)}${level ? `&level=${level}` : ''}`,
        undefined,
        signal,
      ),
    refetchInterval: 8000,
  });
  const detail = useQuery({
    queryKey: ['narrative', 'entry', id],
    queryFn: ({ signal }) =>
      request(`/api/narrative?id=${encodeURIComponent(id!)}&sources=true`, undefined, signal),
    enabled: Boolean(id),
    refetchInterval: 8000,
  });
  return (
    <main className="min-h-dvh bg-[var(--color-bg)] text-[var(--color-text)]">
      <header className="border-b border-[var(--color-border)] px-5 py-4">
        <div className="mx-auto flex max-w-5xl items-center gap-4">
          <Link href="/?view=today" aria-label="Back to Today">
            <ArrowLeft className="size-4" />
          </Link>
          <h1 className="font-serif text-xl">Narrative</h1>
          <NarrativeSearchButton />
          <Link className="text-xs" href="/settings?tab=narrative">
            Sources & privacy
          </Link>
        </div>
      </header>
      <div className="mx-auto max-w-5xl px-5 py-8">
        <p className="max-w-2xl text-sm text-[var(--color-text-muted)]">
          The thread of what mattered and what moved. A partial, revisable account grounded in the sources you
          chose—not a judgment about your life.
        </p>
        {entries.data?.available === false || entries.data?.enabled === false ? (
          <div className="mt-8 max-w-xl space-y-4">
            <h2 className="font-serif text-2xl">Your history starts with your permission.</h2>
            <p>
              Choose the sources you want Albatross to remember. You can inspect the evidence, correct the
              account, and forget it.
            </p>
            <Button asChild>
              <Link href="/settings?tab=narrative">Choose narrative sources</Link>
            </Button>
          </div>
        ) : (
          <>
            <div className="my-6 flex flex-wrap items-center gap-3">
              <Input
                aria-label="Search your narrative"
                placeholder="A person, a decision, something you were working on…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="min-w-48 flex-1"
              />
              <select
                aria-label="Narrative depth"
                className={field}
                value={level}
                onChange={(event) => setLevel(event.target.value)}
              >
                <option value="">All depths</option>
                <option value="thread">Ongoing threads</option>
                <option value="day">Days</option>
                <option value="week">Weeks</option>
                <option value="month">Months</option>
                <option value="observation">Evidence</option>
              </select>
              <Button
                variant="outline"
                disabled={command.isPending}
                onClick={() => command.mutate({ action: 'refresh' })}
              >
                <RefreshCw className="size-3.5" /> Refresh
              </Button>
            </div>
            {command.isSuccess ? (
              <p role="status" className="mb-4 text-xs">
                Refresh requested. Existing history stays available while the new account is prepared.
              </p>
            ) : null}
            <div className="grid gap-8 md:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)]">
              <section aria-label="Narrative entries" className="space-y-1">
                {entries.isPending ? (
                  <p role="status">
                    <Loader2 className="inline size-4 animate-spin" /> Reading history…
                  </p>
                ) : null}
                {entries.error ? <p role="alert">{entries.error.message}</p> : null}
                {entries.data?.entries?.length === 0 ? (
                  <p className="py-8 text-sm text-[var(--color-text-muted)]">
                    {query
                      ? 'No matching account yet. Try another phrase or search your original sources.'
                      : 'No history collected yet. Refresh to begin; check Sources & privacy for connection or model issues.'}
                  </p>
                ) : null}
                {(entries.data?.entries || []).map((entry: NarrativeEntry) => (
                  <button
                    type="button"
                    key={entry._id}
                    aria-pressed={id === entry._id}
                    onClick={() => {
                      setId(entry._id);
                      router.replace(`/narrative?id=${encodeURIComponent(entry._id)}`, { scroll: false });
                    }}
                    className={`block w-full rounded-lg p-3 text-left focus-visible:outline-2 focus-visible:outline-[var(--color-accent)] ${id === entry._id ? 'bg-[var(--color-accent-soft)]' : 'hover:bg-[var(--color-bg-muted)]'}`}
                  >
                    <span className="text-[11px] text-[var(--color-text-muted)]">
                      {entry.level} · {new Date(entry.occurredAt).toLocaleDateString()}
                    </span>
                    <span className="mt-1 block font-medium text-sm">{entry.title}</span>
                    <span className="mt-1 line-clamp-2 block text-xs leading-relaxed text-[var(--color-text-muted)]">
                      {entry.text}
                    </span>
                  </button>
                ))}
              </section>
              <section aria-label="Narrative detail" className="min-w-0 text-sm">
                {!id ? (
                  <p className="py-8 text-[var(--color-text-muted)]">
                    Choose a chapter or observation to read its account and supporting evidence.
                  </p>
                ) : detail.isPending ? (
                  <p role="status">Opening sources…</p>
                ) : detail.error ? (
                  <p role="alert">{detail.error.message}</p>
                ) : !detail.data?.entry ? (
                  <p>This account was removed or its sources changed. Choose another entry.</p>
                ) : (
                  <div className="space-y-6">
                    <h2 className="font-serif text-2xl">{detail.data.entry.title}</h2>
                    {detail.data.entry.level !== 'observation' ? (
                      <>
                        <p className="whitespace-pre-line leading-7">{detail.data.entry.text}</p>
                        <p className="text-xs text-[var(--color-text-muted)]">
                          {detail.data.entry.model
                            ? `Written with ${detail.data.entry.model}. `
                            : 'Source-backed fallback. '}
                          {detail.data.entry.coverage}
                        </p>
                        <h3 className="font-medium">What this account is based on</h3>
                      </>
                    ) : null}
                    {(detail.data.sources || []).map(
                      (entry: NarrativeEntry & { detail?: any; sourceAvailable?: boolean }) => (
                        <div key={entry._id} className="space-y-2">
                          <ObservationCard
                            entry={entry}
                            onChange={() => {
                              void detail.refetch();
                              void entries.refetch();
                            }}
                          />
                          {entry.detail ? (
                            <details className="pl-4 text-xs">
                              <summary className="cursor-pointer text-[var(--color-text-muted)]">
                                Read source detail
                              </summary>
                              <pre className="mt-2 whitespace-pre-wrap font-sans leading-6">
                                {entry.detail.text}
                                {entry.detail.messages
                                  ?.map(
                                    (m: any) =>
                                      `\n\n${m.from} · ${new Date(m.at).toLocaleString()}\n${m.text}`,
                                  )
                                  .join('')}
                              </pre>
                            </details>
                          ) : null}
                        </div>
                      ),
                    )}
                  </div>
                )}
              </section>
            </div>
          </>
        )}
        {command.error ? <p role="alert">{command.error.message}</p> : null}
      </div>
      <CommandPalette />
    </main>
  );
}
