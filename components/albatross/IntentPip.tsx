'use client';

/* Picture-in-picture planning: capture a thought, keep using the app. This
 * renders ONLY into the browser's Document Picture-in-Picture window (opened
 * at capture, Chromium/Dia) — there is no in-app dock. While an intent is
 * planning the window shows a small feeding orb; when Albatross needs an
 * answer the question appears RIGHT THERE (options or free text) and
 * answering regenerates in the background; when a plan lands it offers one
 * "View plan" jump. */

import { useConvexAuth, useMutation, useQuery } from 'convex/react';
import { useReducedMotion } from 'motion/react';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import {
  getGeo,
  type IntentQuestion,
  type IntentStatus,
  nextUnansweredQuestion,
  type QuestionOption,
} from '@/components/albatross/PlansSurface';
import { api } from '@/convex/_generated/api';
import type { Id } from '@/convex/_generated/dataModel';
import { getPipWindow, subscribePipWindow } from '@/lib/albatross/pip-window';
import { cn } from '@/lib/utils';

interface PipIntent {
  _id: Id<'albatrossIntents'>;
  status: IntentStatus;
  rawText: string;
  title?: string;
  questions?: IntentQuestion[];
  updatedAt: number;
}

/** Pure: which intent deserves the pip right now, and in which mode. */
export function pipStateFor(
  intents: Array<Pick<PipIntent, '_id' | 'status' | 'updatedAt'>> | undefined,
  dismissed: ReadonlySet<string>,
  readyIds: ReadonlySet<string>,
): { intentId: string; mode: 'question' | 'planning' | 'ready' } | null {
  if (!intents?.length) return null;
  const alive = intents.filter((intent) => !dismissed.has(String(intent._id)));
  const byRecency = [...alive].sort((a, b) => b.updatedAt - a.updatedAt);
  const asking = byRecency.find((intent) => intent.status === 'needs_answers');
  if (asking) return { intentId: String(asking._id), mode: 'question' };
  const planning = byRecency.find((intent) => intent.status === 'planning');
  if (planning) return { intentId: String(planning._id), mode: 'planning' };
  const ready = byRecency.find((intent) => readyIds.has(String(intent._id)));
  if (ready) return { intentId: String(ready._id), mode: 'ready' };
  return null;
}

export function IntentPip({ onOpenIntent }: { onOpenIntent: (intentId: string) => void }) {
  const reduced = useReducedMotion() ?? false;
  const { isAuthenticated } = useConvexAuth();
  const intents = useQuery(api.albatrossIntents.listIntents, isAuthenticated ? {} : 'skip') as
    | PipIntent[]
    | undefined;
  const answerQuestions = useMutation(api.albatrossIntents.answerQuestions);

  // "Ready" is a transition, not a state: only intents SEEN planning/asking
  // in this session announce themselves, so old plans don't nag on load.
  const prevStatus = useRef<Map<string, string>>(new Map());
  const [readyIds, setReadyIds] = useState<Set<string>>(() => new Set());
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  const [answerText, setAnswerText] = useState('');
  const [selectedOption, setSelectedOption] = useState<QuestionOption | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const pipWindow = useSyncExternalStore(subscribePipWindow, getPipWindow, () => null);

  useEffect(() => {
    for (const intent of intents ?? []) {
      const id = String(intent._id);
      const prior = prevStatus.current.get(id);
      if (
        (prior === 'planning' || prior === 'needs_answers') &&
        (intent.status === 'ready' || intent.status === 'applied')
      ) {
        setReadyIds((prev) => new Set(prev).add(id));
      }
      prevStatus.current.set(id, intent.status);
    }
  }, [intents]);

  const pip = pipStateFor(intents, dismissed, readyIds);
  const intent = pip ? (intents ?? []).find((entry) => String(entry._id) === pip.intentId) : undefined;
  const question = pip?.mode === 'question' ? nextUnansweredQuestion(intent ?? null) : null;

  // Reset the answer draft whenever the question under the pip changes.
  const questionKey = question ? `${pip?.intentId}:${question.id}` : '';
  const lastQuestionKey = useRef(questionKey);
  useEffect(() => {
    if (questionKey !== lastQuestionKey.current) {
      lastQuestionKey.current = questionKey;
      setAnswerText('');
      setSelectedOption(null);
    }
  }, [questionKey]);

  // Browser pip only: no window (closed, or unsupported browser) means the
  // Plans surface is the sole home for questions and status.
  if (!pipWindow || !pip || !intent) return null;

  const words = (intent.title || intent.rawText).replace(/\s+/g, ' ').trim();
  const shortWords = words.length > 64 ? `${words.slice(0, 64).trimEnd()}…` : words;

  const dismiss = () => setDismissed((prev) => new Set(prev).add(pip.intentId));

  const submitAnswer = async (option: QuestionOption | null, text: string) => {
    if (!question || submitting) return;
    const answer = option ? option.title : text.trim();
    if (!answer) return;
    setSubmitting(true);
    try {
      await answerQuestions({
        intentId: intent._id,
        answers: [{ id: question.id, answer, answeredOptionId: option?.id }],
      });
      // Last answer? Regenerate in the background — same contract as the
      // full surface: the pip flips to the planning state reactively.
      const remaining = (intent.questions ?? []).filter((entry) => entry.id !== question.id && !entry.answer);
      if (remaining.length === 0) {
        const geo = await getGeo();
        void fetch('/api/albatross/plan', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            intentId: intent._id,
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            geo,
          }),
        }).catch(() => {});
      }
    } finally {
      setSubmitting(false);
    }
  };

  const card = (
    <>
      <div className="flex items-start gap-2 px-3.5 pt-3">
        <div className="min-w-0 flex-1">
          <p className="text-[11px] text-[var(--color-text-faint)]">
            {pip.mode === 'question'
              ? 'Albatross needs an answer'
              : pip.mode === 'planning'
                ? 'Planning in the background'
                : 'Plan ready'}
          </p>
          <p className="truncate text-[12.5px] font-medium text-[var(--color-text)]">{shortWords}</p>
        </div>
        {pip.mode === 'planning' ? (
          <span
            className={cn('mt-1 size-3 shrink-0 rounded-full', !reduced && 'animate-pulse')}
            style={{
              background:
                'radial-gradient(circle at 38% 32%, color-mix(in oklab, var(--color-accent) 80%, white), var(--color-accent) 55%, color-mix(in oklab, var(--color-accent) 35%, var(--color-text)))',
            }}
          />
        ) : null}
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss"
          className="rounded p-0.5 text-[var(--color-text-faint)] hover:text-[var(--color-text)]"
        >
          <svg viewBox="0 0 12 12" className="size-3" aria-hidden="true" role="presentation">
            <title>Dismiss</title>
            <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.4" />
          </svg>
        </button>
      </div>

      {pip.mode === 'question' && question ? (
        <div className="flex flex-col gap-2 px-3.5 pb-3.5 pt-2">
          <p className="text-[13px] leading-snug text-[var(--color-text)]">{question.prompt}</p>
          {question.options?.length ? (
            <div className="flex flex-col gap-1">
              {question.options.slice(0, 4).map((option) => (
                <button
                  key={option.id}
                  type="button"
                  disabled={submitting}
                  onClick={() => {
                    setSelectedOption(option);
                    void submitAnswer(option, '');
                  }}
                  className={cn(
                    'rounded-md border px-2.5 py-1.5 text-left text-[12.5px] transition-colors',
                    selectedOption?.id === option.id
                      ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)]'
                      : 'border-[var(--color-border)] hover:bg-[var(--color-bg-muted)]',
                  )}
                >
                  <span className="block font-medium text-[var(--color-text)]">{option.title}</span>
                  {option.address ? (
                    <span className="block truncate text-[11px] text-[var(--color-text-muted)]">
                      {option.address}
                    </span>
                  ) : null}
                </button>
              ))}
            </div>
          ) : null}
          <input
            value={answerText}
            onChange={(event) => setAnswerText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void submitAnswer(null, answerText);
              }
            }}
            disabled={submitting}
            placeholder={question.options?.length ? 'Or type something else…' : 'Type an answer…'}
            className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1.5 text-[12.5px] text-[var(--color-text)] placeholder:text-[var(--color-text-faint)] focus:border-[var(--color-accent)] focus:outline-none"
          />
          <div className="flex items-center justify-between">
            <button
              type="button"
              onClick={() => onOpenIntent(pip.intentId)}
              className="text-[11.5px] text-[var(--color-text-faint)] hover:text-[var(--color-text)]"
            >
              Open in Plans
            </button>
            {submitting ? (
              <span className="text-[11.5px] text-[var(--color-text-faint)]">Saving…</span>
            ) : null}
          </div>
        </div>
      ) : pip.mode === 'ready' ? (
        <div className="flex items-center justify-between gap-2 px-3.5 pb-3.5 pt-1.5">
          <button
            type="button"
            onClick={() => {
              setReadyIds((prev) => {
                const next = new Set(prev);
                next.delete(pip.intentId);
                return next;
              });
              onOpenIntent(pip.intentId);
            }}
            className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-[12.5px] font-medium text-[var(--color-accent-foreground)] hover:opacity-90"
          >
            View plan
          </button>
          <span className="text-[11.5px] text-[var(--color-text-faint)]">Created in the background</span>
        </div>
      ) : (
        <div className="flex items-center justify-between gap-2 px-3.5 pb-3.5 pt-1.5">
          <span className="text-[11.5px] text-[var(--color-text-muted)]">
            Reading mail, calendar, areas, and the web…
          </span>
          <button
            type="button"
            onClick={() => onOpenIntent(pip.intentId)}
            className="shrink-0 text-[11.5px] text-[var(--color-text-faint)] hover:text-[var(--color-text)]"
          >
            Watch
          </button>
        </div>
      )}
    </>
  );

  // Render into the always-on-top browser window (Chromium Document PiP -
  // visible from other tabs, e.g. in Dia). React keeps the portal live, so
  // questions and status updates stream into it. The window opens at the
  // compact planning height; question mode scrolls within it and the user
  // can drag the window larger.
  return createPortal(
    <div className="flex h-screen flex-col overflow-y-auto bg-[var(--color-bg-elevated)] pb-2 font-sans text-[var(--color-text)]">
      {card}
    </div>,
    pipWindow.document.body,
  );
}
