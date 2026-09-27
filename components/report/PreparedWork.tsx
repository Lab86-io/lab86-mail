'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { contentRequest } from '@/components/settings/ContentSettings';
import { Button } from '@/components/ui/button';
import type { PreparedDraft } from '@/lib/content/contract';

export interface PreparationView {
  _id: string;
  revision: number;
  draft?: PreparedDraft;
  workId?: string;
  userNotes: string;
  userFiles?: PreparedDraft['files'];
  needsRefresh: boolean;
  preparedAt?: number;
  updatedAt: number;
  error?: string;
  sources: Array<{
    _id: string;
    title: string;
    url?: string;
    source: string;
    modifiedAt: number;
    partial: boolean;
  }>;
}
function downloadFile(file: PreparedDraft['files'][number]) {
  const url = URL.createObjectURL(
    new Blob([file.content], {
      type: file.name.endsWith('.csv') ? 'text/csv;charset=utf-8' : 'text/plain;charset=utf-8',
    }),
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = file.name;
  link.hidden = true;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function PreparedWorkCard({
  item,
  busy,
  onChange,
}: {
  item: PreparationView;
  busy: boolean;
  onChange: (body: any) => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  const [notes, setNotes] = useState(item.userNotes);
  const [files, setFiles] = useState(item.userFiles || item.draft?.files || []);
  const [dirty, setDirty] = useState(false);
  const [filesDirty, setFilesDirty] = useState(false);
  const draft = item.draft;
  useEffect(() => {
    if (!dirty) {
      setNotes(item.userNotes);
      setFiles(item.userFiles || item.draft?.files || []);
    }
  }, [item.userNotes, item.userFiles, item.draft, dirty]);
  const action = async (operation: string, extra = {}) => {
    try {
      await onChange({ operation, id: item._id, revision: item.revision, ...extra });
      if (operation === 'edit') {
        setDirty(false);
        setFilesDirty(false);
      }
    } catch {
      /* Parent renders the error while local edits remain. */
    }
  };
  return (
    <article className="border-t border-[var(--color-border)] py-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-[15px] font-medium">{draft?.title || 'Researching a useful next step…'}</h3>
        {draft ? (
          <span className="text-[11px] capitalize text-[var(--color-text-muted)]">
            {item.workId ? 'For existing work' : draft.shape}
          </span>
        ) : null}
      </div>
      {draft ? <p className="mt-2 text-[13px] leading-relaxed">{draft.situation}</p> : null}
      <p className="mt-2 text-[11px] text-[var(--color-text-muted)]">
        {item.needsRefresh
          ? 'Sources changed · refresh before adopting'
          : item.preparedAt
            ? `Prepared ${new Date(item.preparedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
            : 'Preparing in the background'}
        {item.userFiles ? ' · Your file edits are saved' : ''}
      </p>
      {item.error ? (
        <p role="status" className="mt-2 text-xs text-[var(--color-text-muted)]">
          {item.error}
        </p>
      ) : null}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={!draft}
          onClick={() => setOpen(!open)}
          aria-expanded={open}
        >
          {open ? 'Close review' : 'Review draft'}
        </Button>
        <Button
          size="sm"
          disabled={busy || !draft || item.needsRefresh || dirty}
          onClick={() => action('adopt')}
        >
          {item.workId ? 'Add to work' : 'Adopt'}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => action('dismiss')}>
          Dismiss
        </Button>
        {item.needsRefresh || item.error ? (
          <Button size="sm" variant="ghost" disabled={busy || dirty} onClick={() => action('refresh')}>
            Refresh preparation
          </Button>
        ) : null}
      </div>
      {open && draft ? (
        <div className="mt-4 space-y-4 text-[13px] leading-relaxed">
          {(
            [
              ['Relevant trail', draft.background],
              ['My read', draft.assessment],
              ['Your move', draft.recommendation],
            ] as const
          ).map(([label, text]) => (
            <div key={label}>
              <h4 className="font-medium">{label}</h4>
              <p className="mt-1 whitespace-pre-wrap text-[var(--color-text-muted)]">{text}</p>
            </div>
          ))}
          {draft.questions.length ? (
            <div>
              <h4 className="font-medium">Questions to settle</h4>
              <ul className="mt-1 list-disc space-y-1 pl-4">
                {draft.questions.map((q) => (
                  <li key={q}>{q}</li>
                ))}
              </ul>
            </div>
          ) : null}
          <label className="block space-y-2">
            <span className="font-medium">Your answers and notes</span>
            <textarea
              value={notes}
              maxLength={10_000}
              onChange={(event) => {
                setNotes(event.target.value);
                setDirty(true);
              }}
              className="min-h-24 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-3"
            />
          </label>
          {files.map((file, i) => (
            <div key={file.name} className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <label htmlFor={`draft-${item._id}-${i}`} className="font-medium">
                  {file.name}
                </label>
                <Button size="sm" variant="ghost" onClick={() => downloadFile(file)}>
                  Download
                </Button>
              </div>
              <textarea
                id={`draft-${item._id}-${i}`}
                value={file.content}
                maxLength={30_000}
                onChange={(event) => {
                  setFiles(
                    files.map((f, index) => (index === i ? { ...f, content: event.target.value } : f)),
                  );
                  setDirty(true);
                  setFilesDirty(true);
                }}
                className="min-h-48 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-3 font-mono text-xs"
              />
            </div>
          ))}
          <Button
            size="sm"
            variant="outline"
            disabled={busy || !dirty}
            onClick={() => action('edit', { notes, ...(filesDirty ? { files } : {}) })}
          >
            Save edits
          </Button>
          {dirty ? (
            <p role="status" className="text-xs text-[var(--color-text-muted)]">
              Save your edits before adopting or refreshing.
            </p>
          ) : null}
          <div>
            <h4 className="font-medium">Sources</h4>
            <ul className="mt-2 space-y-2">
              {draft.evidence.map((e) => {
                const source = item.sources.find((s) => s._id === e.sourceId);
                return (
                  <li key={`${e.sourceId}-${e.quote}`}>
                    <span className="text-xs">
                      {source?.url ? (
                        <a className="underline" href={source.url} target="_blank" rel="noreferrer">
                          {source.title}
                        </a>
                      ) : (
                        source?.title || 'Source'
                      )}
                      {source?.partial ? ' · partial content' : ''}
                    </span>
                    <blockquote className="mt-1 border-l-2 border-[var(--color-border)] pl-3 text-xs text-[var(--color-text-muted)]">
                      {e.quote}
                    </blockquote>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      ) : null}
    </article>
  );
}
export function PreparedWork() {
  const client = useQueryClient();
  const state = useQuery({
    queryKey: ['brief-preparations'],
    queryFn: () => contentRequest('brief'),
    refetchInterval: 30_000,
  });
  const change = useMutation({
    mutationFn: (body: unknown) => contentRequest('brief', body),
    // The section shows its own error line.
    meta: { errorToast: false },
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['brief-preparations'] });
      await client.invalidateQueries({ queryKey: ['albatross'] });
    },
  });
  if (!state.data?.items?.length && !state.error && !change.isSuccess && !change.error) return null;
  return (
    <section aria-labelledby="prepared-work-heading" className="mx-auto mt-8 w-full max-w-[620px] px-1">
      <h2 id="prepared-work-heading" className="text-[17px] font-semibold">
        Prepared for you
      </h2>
      <p className="mb-3 mt-1 text-xs text-[var(--color-text-muted)]">
        Research and draft files, updated as sources change. These stay in your Brief until you adopt them.
      </p>
      {state.error || change.error ? (
        <p role="alert" className="mb-3 text-sm text-[var(--color-danger)]">
          {(state.error || change.error)?.message}
        </p>
      ) : null}
      {(state.data?.items || []).map((item: PreparationView) => (
        <PreparedWorkCard
          key={item._id}
          item={item}
          busy={change.isPending}
          onChange={(body) => change.mutateAsync(body)}
        />
      ))}
      {change.isSuccess ? (
        <p role="status" className="text-xs text-[var(--color-text-muted)]">
          {change.data?.result?.workId ? (
            <a
              className="underline"
              href={`/?view=albatrosses&work=${encodeURIComponent(change.data.result.workId)}`}
            >
              Saved to your work. Open Albatross.
            </a>
          ) : (
            'Saved.'
          )}
        </p>
      ) : null}
    </section>
  );
}
