'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

export interface DailyCheckinData {
  _id: string;
  localDate: string;
  status: string;
  responseText?: string | null;
  tomorrowIntentText?: string | null;
  reflectionReconcileStatus?: 'pending' | 'processing' | 'ready' | 'failed' | null;
  tomorrowPlanStatus?: 'pending' | 'planning' | 'ready' | 'needs_input' | 'failed' | null;
  candidateItems: Array<{
    kind: 'work' | 'project' | 'task' | 'event' | 'artifact';
    id: string;
    title: string;
    suggestedState?: string;
  }>;
}

export function dailyCheckinSectionPayload(
  checkin: DailyCheckinData,
  promptKind: 'reflection' | 'tomorrow',
  responseText: string,
  selected: ReadonlySet<string>,
  timezone: string,
) {
  return {
    promptKind,
    responseText: responseText.trim(),
    ...(promptKind === 'reflection'
      ? {
          completed: checkin.candidateItems
            .filter((item) => selected.has(`${item.kind}:${item.id}`))
            .map((item) => ({ kind: item.kind, id: item.id })),
        }
      : {}),
    timezone,
  };
}

/** Retained for older callers while the endpoint accepts both request shapes. */
export function dailyCheckinAnswerPayload(
  checkin: DailyCheckinData,
  selected: ReadonlySet<string>,
  responseText: string,
  tomorrowIntentText: string,
  timezone: string,
) {
  return {
    responseText: responseText.trim(),
    tomorrowIntentText: tomorrowIntentText.trim(),
    completed: checkin.candidateItems
      .filter((item) => selected.has(`${item.kind}:${item.id}`))
      .map((item) => ({ kind: item.kind, id: item.id })),
    timezone,
  };
}

export function dailyCheckinResponseError(responseOK: boolean, body: { error?: unknown }): string | null {
  if (responseOK) return null;
  return typeof body.error === 'string' && body.error ? body.error : 'Could not save this answer.';
}

type SaveState = 'idle' | 'saving' | 'saved';

export function DailyCheckin({
  checkin,
  open,
  onOpenChange,
}: {
  checkin: DailyCheckinData | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [text, setText] = useState('');
  const [tomorrowText, setTomorrowText] = useState('');
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [reflectionState, setReflectionState] = useState<SaveState>('idle');
  const [tomorrowState, setTomorrowState] = useState<SaveState>('idle');
  const [reflectionError, setReflectionError] = useState<string | null>(null);
  const [tomorrowError, setTomorrowError] = useState<string | null>(null);
  const checkinId = checkin?._id;
  const savedReflection = checkin?.responseText;
  const savedTomorrow = checkin?.tomorrowIntentText;

  useEffect(() => {
    if (!checkinId) return;
    setText(savedReflection || '');
    setTomorrowText(savedTomorrow || '');
    setReflectionState(savedReflection?.trim() ? 'saved' : 'idle');
    setTomorrowState(savedTomorrow?.trim() ? 'saved' : 'idle');
    setReflectionError(null);
    setTomorrowError(null);
    setSelected(new Set());
  }, [checkinId, savedReflection, savedTomorrow]);

  const toggle = (key: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    setReflectionState('idle');
  };

  const save = async (promptKind: 'reflection' | 'tomorrow') => {
    if (!checkin) return;
    const isReflection = promptKind === 'reflection';
    const value = isReflection ? text : tomorrowText;
    if (!value.trim() && !(isReflection && selected.size)) return;
    const setState = isReflection ? setReflectionState : setTomorrowState;
    const setError = isReflection ? setReflectionError : setTomorrowError;
    setState('saving');
    setError(null);
    try {
      const response = await fetch(`/api/albatross/checkin/${encodeURIComponent(checkin._id)}/answer`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(
          dailyCheckinSectionPayload(
            checkin,
            promptKind,
            value,
            selected,
            Intl.DateTimeFormat().resolvedOptions().timeZone,
          ),
        ),
      });
      const body = await response.json().catch(() => ({}));
      const responseError = dailyCheckinResponseError(response.ok, body);
      if (responseError) throw new Error(responseError);
      setState('saved');
      if (isReflection) setSelected(new Set());
    } catch (cause) {
      setState('idle');
      setError(cause instanceof Error ? cause.message : 'Could not save this answer.');
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88vh] max-w-xl overflow-y-auto">
        <DialogTitle className="font-serif text-2xl">Daily check-in</DialogTitle>
        <DialogDescription>
          Save either answer when it is ready. Albatross finishes the slower interpretation in the background.
        </DialogDescription>
        {!checkin ? (
          <p className="py-6 text-[12.5px] text-[var(--color-text-muted)]">Preparing today’s check-in…</p>
        ) : (
          <div className="space-y-4">
            <section className="rounded-xl border border-[var(--color-border)] p-4">
              <label htmlFor="today-reflection" className="text-[13.5px] font-medium">
                What did you actually get done today?
              </label>
              <p className="mt-0.5 text-[11.5px] text-[var(--color-text-muted)]">
                Tell Albatross what moved. Suggestions are evidence, not assumptions.
              </p>
              <textarea
                id="today-reflection"
                value={text}
                onChange={(event) => {
                  setText(event.target.value);
                  setReflectionState('idle');
                }}
                rows={4}
                autoFocus
                placeholder="I shipped…, made progress on…, and didn’t get to…"
                className="mt-3 w-full resize-y rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] p-3 text-[13px] leading-relaxed outline-none focus:border-[var(--color-accent)]"
              />
              {checkin.candidateItems.length ? (
                <div className="mt-3 divide-y divide-[var(--color-border)] rounded-xl border border-[var(--color-border)]">
                  {checkin.candidateItems.slice(0, 12).map((item) => {
                    const key = `${item.kind}:${item.id}`;
                    const active = selected.has(key);
                    return (
                      <button
                        key={key}
                        type="button"
                        aria-pressed={active}
                        onClick={() => toggle(key)}
                        className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-[var(--color-hover-soft)]"
                      >
                        <span
                          className={cn(
                            'grid size-4 shrink-0 place-items-center rounded border text-[10px]',
                            active
                              ? 'border-[var(--color-accent)] bg-[var(--color-accent)] text-[var(--color-accent-foreground)]'
                              : 'border-[var(--color-border-strong)]',
                          )}
                        >
                          {active ? '✓' : ''}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-[12.5px]">{item.title}</span>
                        <span className="text-[10.5px] capitalize text-[var(--color-text-faint)]">
                          {item.kind}
                        </span>
                      </button>
                    );
                  })}
                </div>
              ) : null}
              <div className="mt-3 flex items-center justify-between gap-3">
                <SaveFeedback state={reflectionState} error={reflectionError} />
                <Button
                  size="sm"
                  disabled={reflectionState === 'saving' || (!text.trim() && !selected.size)}
                  onClick={() => void save('reflection')}
                >
                  {reflectionState === 'saving' ? 'Saving…' : 'Save today'}
                </Button>
              </div>
            </section>

            <section className="rounded-xl border border-[var(--color-border)] p-4">
              <label htmlFor="tomorrow-intent" className="text-[13.5px] font-medium">
                What should tomorrow protect?
              </label>
              <p className="mt-0.5 text-[11.5px] text-[var(--color-text-muted)]">
                Albatross will turn this into Work and schedule its first move after the answer is saved.
              </p>
              <textarea
                id="tomorrow-intent"
                value={tomorrowText}
                onChange={(event) => {
                  setTomorrowText(event.target.value);
                  setTomorrowState('idle');
                }}
                rows={3}
                placeholder="Submit the passport renewal before lunch…"
                className="mt-3 w-full resize-y rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] p-3 text-[13px] leading-relaxed outline-none focus:border-[var(--color-accent)]"
              />
              <div className="mt-3 flex items-center justify-between gap-3">
                <SaveFeedback state={tomorrowState} error={tomorrowError} background />
                <Button
                  size="sm"
                  disabled={tomorrowState === 'saving' || !tomorrowText.trim()}
                  onClick={() => void save('tomorrow')}
                >
                  {tomorrowState === 'saving' ? 'Saving…' : 'Plan tomorrow'}
                </Button>
              </div>
            </section>

            <div className="flex justify-end">
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                Close
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function SaveFeedback({
  state,
  error,
  background = false,
}: {
  state: SaveState;
  error: string | null;
  background?: boolean;
}) {
  if (error) return <p className="text-[11.5px] text-[var(--color-danger)]">{error} Try again.</p>;
  if (state === 'saved') {
    return (
      <p className="text-[11.5px] text-[var(--color-text-muted)]">
        {background ? 'Saved. Planning continues in the background.' : 'Saved.'}
      </p>
    );
  }
  return <span />;
}
