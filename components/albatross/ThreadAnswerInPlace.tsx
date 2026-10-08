'use client';

// "Answer" from a row (docs/albatross-threads.md, T10; lead decision 7): the
// run's question opens in place, as the PR 1 form card, for a small form. A
// long form, an allow, or an identity check opens the thread instead. The
// row grows downward, so the list keeps its scroll position.

import { useQueryClient } from '@tanstack/react-query';
import { useConvexAuth, useQuery } from 'convex/react';
import { useEffect, useMemo, useState } from 'react';
import { FormQuestionCard } from '@/components/ai-elements/form-question-card';
import { usePersonalDetails } from '@/components/ai-elements/use-personal-details';
import { Button } from '@/components/ui/button';
import { api } from '@/convex/_generated/api';
import {
  type FormAnswer,
  type PersonalDetailView,
  type ThreadRunView,
  threadQuestionForm,
} from '@/lib/albatross/thread-contract';
import { formOpensInPlace, THREAD_ROW_COPY } from '@/lib/albatross/thread-list-view';
import type { ThreadRow } from '@/lib/albatross/threads';
import { postJson } from '@/lib/albatross/work-view';

export const ANSWER_IN_PLACE_COPY = {
  loading: 'Loading the question…',
  gone: 'This question is no longer open.',
  failed: 'Could not save that answer.',
} as const;

export interface ThreadAnswerInPlaceProps {
  row: ThreadRow;
  /** The runs of the thread. The live component loads them; the harness passes them. */
  runs?: readonly ThreadRunView[];
  onDone: () => void;
  onCancel: () => void;
  onOpenThread: () => void;
  /** The harness: the answer goes nowhere. */
  submit?: (questionId: string, answer: FormAnswer) => Promise<unknown>;
}

/** The question of the row's newest run, when it is still open and small enough for a row. */
export function answerableQuestion(
  row: Pick<ThreadRow, 'latestRunId'>,
  runs: readonly ThreadRunView[] | undefined,
) {
  const run = runs?.find((candidate) => candidate.id === row.latestRunId) ?? null;
  const question = run?.question?.status === 'pending' ? run.question : null;
  if (!question) return { run, question: null, form: null, inPlace: false };
  if (run?.next?.kind === 'allow_secure') return { run, question, form: null, inPlace: false };
  const form = threadQuestionForm(question);
  return { run, question, form, inPlace: formOpensInPlace(form) };
}

export function ThreadAnswerInPlace(props: ThreadAnswerInPlaceProps) {
  if (props.runs) return <ThreadAnswerInPlaceView {...props} runs={props.runs} />;
  return <ThreadAnswerInPlaceLive {...props} />;
}

function ThreadAnswerInPlaceLive(props: ThreadAnswerInPlaceProps) {
  const { isAuthenticated } = useConvexAuth();
  const runs = useQuery(
    api.albatrossStepRuns.runsForWorkHistory,
    isAuthenticated ? { workId: props.row.workId, limit: 5 } : 'skip',
  ) as ThreadRunView[] | undefined;
  const details = usePersonalDetails(isAuthenticated);
  const queryClient = useQueryClient();
  if (!runs)
    return (
      <p className="py-2 text-[12.5px] text-[var(--color-text-muted)]">{ANSWER_IN_PLACE_COPY.loading}</p>
    );
  return (
    <ThreadAnswerInPlaceView
      {...props}
      runs={runs}
      details={details.data?.details}
      // A detail saved with the answer shows in every other form at once, as in the thread.
      afterAnswer={(answer) => {
        if (answer.save) void queryClient.invalidateQueries({ queryKey: ['personal-details'] });
      }}
    />
  );
}

function ThreadAnswerInPlaceView({
  row,
  runs,
  onDone,
  onCancel,
  onOpenThread,
  submit,
  details,
  afterAnswer,
}: ThreadAnswerInPlaceProps & {
  runs: readonly ThreadRunView[];
  details?: readonly PersonalDetailView[];
  afterAnswer?: (answer: FormAnswer) => void;
}) {
  const { question, form, inPlace } = useMemo(() => answerableQuestion(row, runs), [row, runs]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string> | null>(null);

  // A form that does not fit a row opens the thread at once.
  useEffect(() => {
    if (question && !inPlace) onOpenThread();
  }, [question, inPlace, onOpenThread]);

  if (!question || !form) {
    return (
      <div className="flex items-center gap-3 py-1 text-[12.5px] text-[var(--color-text-muted)]">
        <span>{ANSWER_IN_PLACE_COPY.gone}</span>
        <Button type="button" size="xs" variant="ghost" onClick={onCancel}>
          {THREAD_ROW_COPY.answerCancel}
        </Button>
      </div>
    );
  }
  if (!inPlace) return null;

  const send = submit
    ? submit
    : (questionId: string, answer: FormAnswer) =>
        postJson(
          `/api/albatross/work/questions/${encodeURIComponent(questionId)}/answer`,
          { form: answer, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone },
          ANSWER_IN_PLACE_COPY.failed,
        );

  return (
    <div
      data-thread-answer-in-place
      className="rounded-ui border border-[var(--color-border)] bg-[var(--color-bg)] p-3"
    >
      <FormQuestionCard
        form={form}
        details={details}
        mode="runner"
        busy={busy}
        errors={errors}
        onSubmit={(answer) => {
          setBusy(true);
          setError(null);
          setErrors(null);
          void send(question.id, answer)
            .then(() => {
              afterAnswer?.(answer);
              onDone();
            })
            .catch((cause: Error & { body?: { errors?: Record<string, string> } }) => {
              const fieldErrors = cause?.body?.errors;
              if (fieldErrors && typeof fieldErrors === 'object') setErrors(fieldErrors);
              else setError(cause instanceof Error ? cause.message : ANSWER_IN_PLACE_COPY.failed);
            })
            .finally(() => setBusy(false));
        }}
      />
      {error ? <p className="mt-2 text-[12px] text-[var(--color-danger)]">{error}</p> : null}
      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          onClick={onOpenThread}
          className="mr-auto text-[12.5px] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
        >
          {THREAD_ROW_COPY.answerOpenThread}
        </button>
        <Button type="button" size="xs" variant="ghost" disabled={busy} onClick={onCancel}>
          {THREAD_ROW_COPY.answerCancel}
        </Button>
      </div>
    </div>
  );
}
