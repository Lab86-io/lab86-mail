'use client';

import { useMutation } from 'convex/react';
import { useState } from 'react';
import { AlbatrossMark } from '@/components/albatross/AlbatrossMark';
import { Button } from '@/components/ui/button';
import { api } from '@/convex/_generated/api';
import type { Id } from '@/convex/_generated/dataModel';
import {
  LAPSE_REASONS,
  type LapseReason,
  lapseHeadline,
  RECOVERY_LABEL,
  type Recovery,
  recoveriesFor,
  recoveryAcknowledgement,
  reEntryLine,
  reviewHeadline,
  shrinkSuggestion,
} from '@/lib/albatross/forgiveness';
import { cn } from '@/lib/utils';

/**
 * A step did not happen.
 *
 * Nothing here is red, nothing says overdue, and nothing asks the user to
 * explain themselves. It asks what changed, because the answer is information
 * about the plan — and the plan is what was wrong.
 */
export function LapsePrompt({
  workId,
  stepTitle,
  plannedAt,
  onDone,
}: {
  workId: string;
  stepTitle?: string | null;
  plannedAt?: number;
  onDone?: () => void;
}) {
  const recordLapse = useMutation(api.albatrossWorkV2.recordLapse);
  const [reason, setReason] = useState<LapseReason | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<Recovery | null>(null);
  const [error, setError] = useState<string | null>(null);

  const choose = async (recovery: Recovery) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await recordLapse({
        workId: workId as Id<'albatrossIntents'>,
        stepTitle: stepTitle || undefined,
        plannedAt,
        reasonKind: reason || 'other',
        reasonSource: 'user',
        recovery,
        revisedStep: recovery === 'shrink' ? shrinkSuggestion(stepTitle) : undefined,
      });
      setDone(recovery);
      onDone?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save that.');
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-4 py-3.5">
        <p className="text-[13px]">{recoveryAcknowledgement(done)}</p>
        {done === 'shrink' ? (
          <p className="mt-1 text-[12px] text-[var(--color-text-muted)]">{shrinkSuggestion(stepTitle)}</p>
        ) : null}
      </section>
    );
  }

  return (
    <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-4 py-3.5">
      <h3 className="text-[13.5px] font-medium">{lapseHeadline(stepTitle)}</h3>
      <p className="mt-0.5 text-[12px] text-[var(--color-text-muted)]">
        Nothing is lost. Albatross assumes the plan was wrong, not you.
      </p>

      <div className="mt-3 flex flex-wrap gap-1.5">
        {LAPSE_REASONS.map((item) => (
          <button
            key={item.kind}
            type="button"
            aria-pressed={reason === item.kind}
            onClick={() => setReason(reason === item.kind ? null : item.kind)}
            className={cn(
              'rounded-full border px-3 py-1 text-[12px] transition-colors',
              reason === item.kind
                ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-accent)]'
                : 'border-[var(--color-border)] text-[var(--color-text-muted)] hover:border-[var(--color-border-strong)] hover:text-[var(--color-text)]',
            )}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-[var(--color-border)]/60 pt-3">
        {recoveriesFor(reason).map((recovery) => (
          <Button
            key={recovery}
            type="button"
            size="sm"
            variant={recovery === 'release' ? 'ghost' : 'outline'}
            disabled={busy}
            onClick={() => void choose(recovery)}
          >
            {RECOVERY_LABEL[recovery]}
          </Button>
        ))}
      </div>

      {reason === 'step_too_large' || reason === 'no_energy' ? (
        <p className="mt-2 text-[11.5px] text-[var(--color-text-faint)]">
          Smaller would look like: {shrinkSuggestion(stepTitle).toLowerCase()}
        </p>
      ) : null}
      {error ? <p className="mt-2 text-[11.5px] text-[var(--color-danger)]">{error}</p> : null}
    </section>
  );
}

/**
 * Putting something down.
 *
 * Presented as an ending in the same visual family as completion, because it is
 * one. Release removes weight; that is the entire product.
 */
export function ReleaseSheet({
  workId,
  title,
  onReleased,
  onCancel,
}: {
  workId: string;
  title: string;
  onReleased?: () => void;
  onCancel?: () => void;
}) {
  const release = useMutation(api.albatrossWorkV2.releaseWork);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [released, setReleased] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const put = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await release({ workId: workId as Id<'albatrossIntents'>, reason: reason.trim() || undefined });
      setReleased(true);
      onReleased?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not put that down.');
    } finally {
      setBusy(false);
    }
  };

  if (released) {
    return (
      <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-4 py-6 text-center">
        <AlbatrossMark className="mx-auto size-9 text-[var(--color-accent)]" />
        <p className="mt-3 font-serif text-[16px] font-semibold">That is one less thing.</p>
        <p className="mt-1 text-[12.5px] text-[var(--color-text-muted)]">
          You can pick it up again whenever you want. Nothing was deleted.
        </p>
      </section>
    );
  }

  return (
    <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-4 py-3.5">
      <h3 className="text-[13.5px] font-medium">Put “{title}” down?</h3>
      <p className="mt-0.5 text-[12px] text-[var(--color-text-muted)]">
        Deciding something no longer deserves your attention is a real ending, not a failure. Albatross keeps
        the history either way.
      </p>
      <input
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        placeholder="Why, if you want to say (optional)"
        aria-label="Why you are putting this down"
        className="mt-3 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-[12.5px] outline-none focus:border-[var(--color-accent)]"
      />
      <div className="mt-3 flex gap-2">
        <Button type="button" size="sm" disabled={busy} onClick={() => void put()}>
          {busy ? 'Putting it down…' : 'Put it down'}
        </Button>
        {onCancel ? (
          <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
            Keep it
          </Button>
        ) : null}
      </div>
      {error ? <p className="mt-2 text-[11.5px] text-[var(--color-danger)]">{error}</p> : null}
    </section>
  );
}

export interface ReviewItem {
  _id: string;
  title: string | null;
  rawText: string;
  updatedAt: number;
}

/**
 * The staleness review.
 *
 * Batched deliberately. One prompt per item, arriving whenever each happens to
 * age out, is the drip of small guilt this product exists to remove. Nobody
 * curates their own old intentions, so Albatross has to offer — once, together,
 * and without implying anybody failed.
 */
export function ReviewBatch({
  items,
  onResolved,
}: {
  items: ReviewItem[];
  onResolved?: (workId: string) => void;
}) {
  const release = useMutation(api.albatrossWorkV2.releaseWork);
  const updateState = useMutation(api.albatrossWorkV2.updateWorkState);
  const [busy, setBusy] = useState<string | null>(null);
  const [handled, setHandled] = useState<Record<string, string>>({});

  if (!items.length) return null;

  const act = async (workId: string, action: 'keep' | 'pause' | 'release') => {
    setBusy(workId);
    try {
      if (action === 'release') {
        await release({
          workId: workId as Id<'albatrossIntents'>,
          reason: 'Not moving, and no longer worth the space.',
          proposedBy: 'system',
        });
      } else if (action === 'pause') {
        await updateState({ workId: workId as Id<'albatrossIntents'>, state: 'paused' });
      } else {
        // Keeping it is a real answer: touching updatedAt resets the clock so
        // Albatross does not ask again next week.
        await updateState({ workId: workId as Id<'albatrossIntents'>, state: 'active' });
      }
      setHandled((prev) => ({ ...prev, [workId]: action }));
      onResolved?.(workId);
    } finally {
      setBusy(null);
    }
  };

  const remaining = items.filter((item) => !handled[item._id]);
  if (!remaining.length) return null;

  return (
    <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-4 py-3.5">
      <h3 className="text-[13.5px] font-medium">{reviewHeadline(remaining.length)}</h3>
      <p className="mt-0.5 text-[12px] text-[var(--color-text-muted)]">
        No wrong answer. Putting something down is as good an outcome as finishing it.
      </p>
      <ul className="mt-3 divide-y divide-[var(--color-border)]/60">
        {remaining.map((item) => (
          <li key={item._id} className="flex flex-wrap items-center gap-2 py-2.5">
            <span className="min-w-0 flex-1 truncate text-[13px]">
              {(item.title || item.rawText).slice(0, 90)}
            </span>
            {(['keep', 'pause', 'release'] as const).map((action) => (
              <Button
                key={action}
                type="button"
                size="xs"
                variant={action === 'keep' ? 'outline' : 'ghost'}
                disabled={busy === item._id}
                onClick={() => void act(item._id, action)}
              >
                {action === 'keep' ? 'Keep it' : action === 'pause' ? 'Pause' : 'Put it down'}
              </Button>
            ))}
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Coming back after a while away.
 *
 * The one thing this must never do is present a wall of accumulated overdue
 * work. That feeling is the thing the product exists to remove, and producing
 * it at the exact moment somebody returns would undo everything else.
 */
export function ReEntry({
  days,
  onShowUrgent,
  onReviewOld,
  onDismiss,
}: {
  days: number;
  onShowUrgent: () => void;
  onReviewOld: () => void;
  onDismiss: () => void;
}) {
  return (
    <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-4 py-4">
      <div className="flex items-start gap-3">
        <AlbatrossMark className="mt-0.5 size-7 shrink-0 text-[var(--color-accent)]" />
        <div className="min-w-0 flex-1">
          <h3 className="font-serif text-[15px] font-semibold">{reEntryLine(days)}</h3>
          <p className="mt-1 text-[12.5px] leading-relaxed text-[var(--color-text-muted)]">
            Albatross kept carrying things while you were gone. Nothing is overdue and nothing is waiting for
            an apology.
          </p>
          <div className="mt-3 flex flex-wrap gap-1.5">
            <Button type="button" size="sm" onClick={onShowUrgent}>
              Show only what needs me
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={onReviewOld}>
              Review what has gone quiet
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={onDismiss}>
              Just show me today
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}
