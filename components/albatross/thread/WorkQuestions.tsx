'use client';

// The open questions of a Work that no run owns: the plan asked them
// (docs/albatross-document-handoff.md). They sit at the end of the thread,
// above the composer, so the "Needs your answer" in the header points at
// something. An answer here saves like any other; a message in the chat can
// answer too.

import { useMemo } from 'react';
import { FormQuestionCard } from '@/components/ai-elements/form-question-card';
import {
  type FormAnswer,
  legacyQuestionToForm,
  type PersonalDetailView,
} from '@/lib/albatross/thread-contract';
import { PENDING_FORM_ATTRIBUTE } from '@/lib/albatross/thread-view';
import type { WorkQuestion } from '@/lib/albatross/work-view';

export const WORK_QUESTION_COPY = {
  label: 'Albatross asks',
} as const;

export function WorkQuestions({
  questions,
  details,
  busyId,
  error,
  onAnswer,
}: {
  questions: readonly WorkQuestion[];
  details?: readonly PersonalDetailView[];
  /** The question whose answer is in flight. */
  busyId: string | null;
  error: { questionId: string; text: string } | null;
  onAnswer: (questionId: string, answer: FormAnswer) => void;
}) {
  if (!questions.length) return null;
  return (
    <div data-slot="work-questions" className="flex flex-col gap-3">
      {questions.map((question) => (
        <WorkQuestionCard
          key={question._id}
          question={question}
          details={details}
          busy={busyId === question._id}
          error={error?.questionId === question._id ? error.text : null}
          onAnswer={onAnswer}
        />
      ))}
    </div>
  );
}

function WorkQuestionCard({
  question,
  details,
  busy,
  error,
  onAnswer,
}: {
  question: WorkQuestion;
  details?: readonly PersonalDetailView[];
  busy: boolean;
  error: string | null;
  onAnswer: (questionId: string, answer: FormAnswer) => void;
}) {
  const form = useMemo(() => legacyQuestionToForm(question), [question]);
  return (
    <section
      {...{ [PENDING_FORM_ATTRIBUTE]: '' }}
      aria-label={WORK_QUESTION_COPY.label}
      className="flex flex-col gap-1.5"
    >
      <span className="text-[11.5px] font-medium text-[var(--color-accent-3)]">
        {WORK_QUESTION_COPY.label}
      </span>
      <FormQuestionCard
        form={form}
        mode="runner"
        details={details}
        busy={busy}
        onSubmit={(answer) => onAnswer(question._id, answer)}
      />
      {error ? <p className="text-[11.5px] text-[var(--color-danger)]">{error}</p> : null}
    </section>
  );
}
