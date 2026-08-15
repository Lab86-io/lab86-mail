'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

export interface DailyCheckinData {
  _id: string;
  localDate: string;
  status: string;
  tomorrowIntentText?: string | null;
  candidateItems: Array<{
    kind: 'work' | 'project' | 'task' | 'event' | 'artifact';
    id: string;
    title: string;
    suggestedState?: string;
  }>;
}

/** Build the durable answer payload from either prose, tomorrow's intent, or selected evidence. */
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

export function dailyCheckinResponseError(
  responseOK: boolean,
  body: { error?: unknown; tomorrowPlanStatus?: unknown; tomorrowPlanError?: unknown },
): string | null {
  if (!responseOK) {
    return typeof body.error === 'string' && body.error ? body.error : 'Could not save the check-in.';
  }
  if (body.tomorrowPlanStatus === 'degraded') {
    return typeof body.tomorrowPlanError === 'string' && body.tomorrowPlanError
      ? body.tomorrowPlanError
      : 'Tomorrow planning is temporarily unavailable.';
  }
  return null;
}

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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = (key: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const submit = async () => {
    if (!checkin || busy || (!text.trim() && !tomorrowText.trim() && !selected.size)) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/albatross/checkin/${encodeURIComponent(checkin._id)}/answer`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(
          dailyCheckinAnswerPayload(
            checkin,
            selected,
            text,
            tomorrowText,
            Intl.DateTimeFormat().resolvedOptions().timeZone,
          ),
        ),
      });
      const body = await response.json();
      const responseError = dailyCheckinResponseError(response.ok, body);
      if (responseError) throw new Error(responseError);
      setText('');
      setTomorrowText('');
      setSelected(new Set());
      onOpenChange(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save the check-in.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88vh] max-w-xl overflow-y-auto">
        <DialogTitle className="font-serif text-2xl">What did you actually get done today?</DialogTitle>
        <DialogDescription>
          Tell Albatross what moved. Suggestions are evidence, not assumptions—you decide what is complete.
        </DialogDescription>
        {!checkin ? (
          <p className="py-6 text-[12.5px] text-[var(--color-text-muted)]">Preparing today’s check-in…</p>
        ) : (
          <div className="space-y-4">
            <textarea
              value={text}
              onChange={(event) => setText(event.target.value)}
              rows={5}
              autoFocus
              placeholder="I shipped…, made progress on…, and didn’t get to…"
              className="w-full resize-y rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] p-3 text-[13px] leading-relaxed outline-none focus:border-[var(--color-accent)]"
            />
            <div>
              <label htmlFor="tomorrow-intent" className="text-[12.5px] font-medium">
                What should tomorrow protect?
              </label>
              <p className="mt-0.5 text-[11.5px] text-[var(--color-text-muted)]">
                Albatross will turn this into Work and put its first move on the calendar.
              </p>
              <textarea
                id="tomorrow-intent"
                value={tomorrowText}
                onChange={(event) => setTomorrowText(event.target.value)}
                rows={3}
                placeholder="Submit the passport renewal before lunch…"
                className="mt-2 w-full resize-y rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] p-3 text-[13px] leading-relaxed outline-none focus:border-[var(--color-accent)]"
              />
            </div>
            {checkin.candidateItems.length ? (
              <div>
                <p className="mb-2 text-[11px] font-medium text-[var(--color-text-faint)]">
                  Mark anything that is truly done
                </p>
                <div className="divide-y divide-[var(--color-border)] rounded-xl border border-[var(--color-border)]">
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
              </div>
            ) : null}
            {error ? <p className="text-[12px] text-[var(--color-danger)]">{error}</p> : null}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                Later
              </Button>
              <Button
                disabled={busy || (!text.trim() && !tomorrowText.trim() && !selected.size)}
                onClick={() => void submit()}
              >
                {busy ? 'Saving…' : 'Save check-in'}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
