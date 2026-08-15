'use client';

import { useConvexAuth, useQuery } from 'convex/react';
import { X } from 'lucide-react';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { OptionList } from '@/components/tool-ui/option-list';
import { Button } from '@/components/ui/button';
import { api } from '@/convex/_generated/api';
import { closePipWindow, getPipWindow, subscribePipWindow } from '@/lib/albatross/pip-window';
import { useClientStore } from '@/lib/client-state';

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

interface CompanionWorkRow {
  _id: string;
  title?: string | null;
  rawText: string;
  status: string;
  agentState?: string | null;
  nextStep?: string | null;
  updatedAt: number;
}

export function AlbatrossCompanion() {
  const { isAuthenticated } = useConvexAuth();
  const rows = useQuery(api.albatrossWorkV2.livePendingQuestions, isAuthenticated ? { limit: 10 } : 'skip') as
    | PendingQuestionRow[]
    | undefined;
  const work = useQuery(api.albatrossWorkV2.allWork, isAuthenticated ? { limit: 20 } : 'skip') as
    | CompanionWorkRow[]
    | undefined;
  const setPrimaryView = useClientStore((state) => state.setPrimaryView);
  const setSelectedWorkId = useClientStore((state) => state.setSelectedWorkId);
  const setSelectedAreaId = useClientStore((state) => state.setSelectedAreaId);
  const [_open, setOpen] = useState(false);
  const [answer, setAnswer] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const pipWindow = useSyncExternalStore(subscribePipWindow, getPipWindow, () => null);
  const row = rows?.[0] || null;
  const companionWork =
    work?.find((item) => ['researching', 'applying'].includes(item.agentState || '')) ||
    work?.find(
      (item) =>
        ['captured', 'planning', 'ready', 'applied'].includes(item.status) &&
        nowMs - item.updatedAt < 5 * 60_000,
    ) ||
    null;
  const questionId = row?.question._id;

  useEffect(() => {
    const timer = globalThis.setInterval(() => setNowMs(Date.now()), 30_000);
    return () => globalThis.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!questionId) return;
    setAnswer('');
    setSelected(null);
    setError(null);
    setBusy(false);
  }, [questionId]);

  if (!row && !companionWork) return null;

  const openContext = (workId?: string | null, areaId?: string | null) => {
    setSelectedWorkId(workId || null);
    setSelectedAreaId(areaId || null);
    setPrimaryView('albatrosses');
    closePipWindow();
  };

  if (!row && companionWork) {
    if (!pipWindow) return null;
    const planning = ['researching', 'applying'].includes(companionWork.agentState || '');
    return createPortal(
      <div className="flex min-h-screen flex-col justify-between bg-[var(--color-bg-elevated)] p-4 font-sans text-[var(--color-text)]">
        <div>
          <p className="text-[11px] text-[var(--color-text-faint)]">
            {planning ? 'Albatross is building the way through' : 'The next move is ready'}
          </p>
          <p className="mt-1 text-[13px] font-medium leading-snug">
            {companionWork.nextStep || companionWork.title || companionWork.rawText}
          </p>
        </div>
        <div className="mt-3 flex items-center justify-between gap-2">
          <Button size="sm" onClick={() => openContext(companionWork._id)}>
            {planning ? 'Watch in Albatross' : 'Open guided work'}
          </Button>
          <button
            type="button"
            className="text-[11.5px] text-[var(--color-text-faint)] hover:text-[var(--color-text)]"
            onClick={closePipWindow}
          >
            Close
          </button>
        </div>
      </div>,
      pipWindow.document.body,
    );
  }

  const _openContext = () => {
    const areaId = row!.routine?.areaId || row!.project?.areaId;
    openContext(row!.work ? String(row!.work._id) : null, areaId ? String(areaId) : null);
  };

  if (!row) return null;

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
      {pipWindow
        ? createPortal(
            <div className="flex min-h-screen flex-col bg-[var(--color-bg-elevated)] p-4 font-sans text-[var(--color-text)]">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-[10px] font-semibold text-[var(--color-text-faint)]">
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
