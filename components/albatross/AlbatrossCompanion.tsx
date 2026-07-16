'use client';

import { useConvexAuth, useQuery } from 'convex/react';
import { ChevronUp, ExternalLink, X } from 'lucide-react';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { OptionList } from '@/components/tool-ui/option-list';
import { Button } from '@/components/ui/button';
import { api } from '@/convex/_generated/api';
import {
  closePipWindow,
  getPipWindow,
  openPipWindow,
  pipSupported,
  subscribePipWindow,
} from '@/lib/albatross/pip-window';
import { useClientStore } from '@/lib/client-state';
import { cn } from '@/lib/utils';

interface PendingQuestionRow {
  question: {
    _id: string;
    prompt: string;
    reason?: string;
    options?: Array<{ id: string; label: string; description?: string }>;
  };
  work: null | { _id: string; title?: string; rawText: string };
  project: null | { _id: string; title: string; areaId?: string };
  routine: null | { _id: string; title: string; areaId?: string };
}

export function AlbatrossCompanion() {
  const { isAuthenticated } = useConvexAuth();
  const rows = useQuery(api.albatrossWorkV2.livePendingQuestions, isAuthenticated ? { limit: 10 } : 'skip') as
    | PendingQuestionRow[]
    | undefined;
  const setPrimaryView = useClientStore((state) => state.setPrimaryView);
  const setSelectedWorkId = useClientStore((state) => state.setSelectedWorkId);
  const setSelectedAreaId = useClientStore((state) => state.setSelectedAreaId);
  const [open, setOpen] = useState(false);
  const [answer, setAnswer] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pipWindow = useSyncExternalStore(subscribePipWindow, getPipWindow, () => null);
  const row = rows?.[0] || null;
  const questionId = row?.question._id;

  useEffect(() => {
    if (!questionId) return;
    setAnswer('');
    setSelected(null);
    setError(null);
    setBusy(false);
  }, [questionId]);

  if (!row) return null;

  const openContext = () => {
    setSelectedWorkId(row.work ? String(row.work._id) : null);
    const areaId = row.routine?.areaId || row.project?.areaId;
    setSelectedAreaId(areaId ? String(areaId) : null);
    setPrimaryView('areas');
  };

  const submit = async () => {
    const option = row.question.options?.find((item) => item.id === selected);
    const value = answer.trim() || option?.label || '';
    if (!value || busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/albatross/work/questions/${encodeURIComponent(row.question._id)}/answer`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            answer: value,
            answeredOptionId: selected || undefined,
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          }),
        },
      );
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Could not save that answer.');
      setAnswer('');
      setSelected(null);
      setOpen(false);
      closePipWindow();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save that answer.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <aside className="pointer-events-none fixed bottom-20 right-6 z-50 w-[min(380px,calc(100vw-3rem))]">
        <div className="pointer-events-auto overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)]/96 shadow-[var(--shadow-pop)] backdrop-blur">
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            className="flex w-full items-center gap-3 px-3.5 py-3 text-left"
            aria-expanded={open}
          >
            <span className="size-2 shrink-0 rounded-full bg-[var(--color-warning)]" aria-hidden />
            <span className="min-w-0 flex-1">
              <span className="block text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--color-text-faint)]">
                Albatross needs one thing
              </span>
              <span className="mt-0.5 block truncate text-[12.5px] font-medium">{row.question.prompt}</span>
            </span>
            <ChevronUp className={cn('size-4 transition-transform', !open && 'rotate-180')} />
          </button>
          {open ? (
            <div className="border-t border-[var(--color-border)] px-3.5 pb-3.5 pt-3">
              <button
                type="button"
                className="text-[11px] text-[var(--color-text-muted)] hover:underline"
                onClick={openContext}
              >
                {row.work?.title ||
                  row.work?.rawText ||
                  row.project?.title ||
                  row.routine?.title ||
                  'Open context'}{' '}
                <ExternalLink className="ml-1 inline size-3" />
              </button>
              {row.question.options?.length ? (
                <OptionList
                  id={`companion-question-${row.question._id}`}
                  options={row.question.options}
                  selectionMode="single"
                  value={selected}
                  onChange={(value) => setSelected(typeof value === 'string' ? value : null)}
                  density="compact"
                  hideActions
                  className="mt-2 !min-w-0 !max-w-none"
                />
              ) : null}
              <div className="mt-2.5 flex gap-2">
                <input
                  value={answer}
                  onChange={(event) => setAnswer(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void submit();
                  }}
                  aria-label="Answer Albatross in your own words"
                  placeholder="Answer in your own words"
                  className="min-w-0 flex-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-2 text-[12px] outline-none focus:border-[var(--color-accent)]"
                />
                <Button
                  size="sm"
                  disabled={busy || (!answer.trim() && !selected)}
                  onClick={() => void submit()}
                >
                  {busy ? '…' : 'Answer'}
                </Button>
              </div>
              <div className="mt-2 flex items-center justify-between">
                {pipSupported() ? (
                  <button
                    type="button"
                    onClick={() => void openPipWindow()}
                    className="text-[10.5px] text-[var(--color-text-faint)] hover:text-[var(--color-text)]"
                  >
                    Keep in picture-in-picture
                  </button>
                ) : (
                  <span />
                )}
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  aria-label="Close question"
                  className="text-[var(--color-text-faint)] hover:text-[var(--color-text)]"
                >
                  <X className="size-3.5" />
                </button>
              </div>
              {error ? <p className="mt-2 text-[11px] text-[var(--color-danger)]">{error}</p> : null}
            </div>
          ) : null}
        </div>
      </aside>
      {pipWindow
        ? createPortal(
            <div className="flex min-h-screen flex-col bg-[var(--color-bg-elevated)] p-4 font-sans text-[var(--color-text)]">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--color-text-faint)]">
                    Albatross needs one thing
                  </p>
                  <p className="mt-1 text-[13px] font-medium leading-snug">{row.question.prompt}</p>
                </div>
                <button type="button" aria-label="Close picture-in-picture" onClick={closePipWindow}>
                  <X className="size-3.5 text-[var(--color-text-faint)]" />
                </button>
              </div>
              {row.question.options?.length ? (
                <OptionList
                  id={`companion-pip-question-${row.question._id}`}
                  options={row.question.options}
                  selectionMode="single"
                  value={selected}
                  onChange={(value) => setSelected(typeof value === 'string' ? value : null)}
                  density="compact"
                  hideActions
                  className="mt-3 !min-w-0 !max-w-none"
                />
              ) : null}
              <div className="mt-3 flex gap-2">
                <input
                  value={answer}
                  onChange={(event) => setAnswer(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void submit();
                  }}
                  aria-label="Answer Albatross in your own words"
                  placeholder="Answer in your own words"
                  className="min-w-0 flex-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-2 text-[12px] outline-none"
                />
                <Button
                  size="sm"
                  disabled={busy || (!answer.trim() && !selected)}
                  onClick={() => void submit()}
                >
                  {busy ? '…' : 'Answer'}
                </Button>
              </div>
              {error ? <p className="mt-2 text-[11px] text-[var(--color-danger)]">{error}</p> : null}
            </div>,
            pipWindow.document.body,
          )
        : null}
    </>
  );
}
