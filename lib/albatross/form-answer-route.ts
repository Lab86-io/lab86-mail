// A form answer to a Work question (docs/albatross-thread.md): check it
// against the stored form, save the bound personal details when the user
// asked, and write the answer text that the Work question and the run keep.

import { api, convexQuery } from '../hosted/convex';
import { type PersonalDetailsUser, saveAnsweredDetails } from '../personal-details/store';
import { truncateText } from '../shared/text';
import { boundDetailInputs, checkFormAnswer, formAnswerText, parseFormQuestion } from './form-question';
import { legacyQuestionToForm } from './thread-contract';

export interface FormAnswerDependencies {
  readQuestion: (userId: string, questionId: string) => Promise<StoredQuestion | null>;
  saveDetails: typeof saveAnsweredDetails;
}

interface StoredQuestion {
  status: string;
  prompt: string;
  reason?: string | null;
  options?: Array<{ id: string; label: string; description?: string }> | null;
  form?: unknown;
}

const defaults: FormAnswerDependencies = {
  readQuestion: (userId, questionId) =>
    convexQuery<StoredQuestion | null>(api.albatrossWorkV2.questionForAnswer, { userId, questionId }).catch(
      () => null,
    ),
  saveDetails: saveAnsweredDetails,
};

export type FormAnswerResult =
  | {
      ok: true;
      /** The text the Work question keeps: personal-detail fields show no value. */
      answer: string;
      /** The note for the run: an unsaved detail keeps its value, so the run can type it. */
      note?: string;
      answeredOptionId?: string;
      savedLabels: string[];
    }
  | { ok: false; status: 400 | 404 | 409; error: string; errors?: Record<string, string> };

export async function answerFromForm(
  user: PersonalDetailsUser,
  questionId: string,
  rawAnswer: unknown,
  overrides: Partial<FormAnswerDependencies> = {},
): Promise<FormAnswerResult> {
  const deps = { ...defaults, ...overrides };
  const question = await deps.readQuestion(user.userId, questionId);
  if (!question) return { ok: false, status: 404, error: 'Question not found.' };
  if (question.status !== 'pending')
    return { ok: false, status: 409, error: 'This question is already closed.' };
  const answer = (rawAnswer && typeof rawAnswer === 'object' ? rawAnswer : {}) as {
    values?: Record<string, unknown>;
    save?: unknown;
  };
  const legacy = !question.form;
  const form = parseFormQuestion(question.form) ?? legacyQuestionToForm(question);
  const checked = checkFormAnswer(
    form,
    answer.values && typeof answer.values === 'object' ? answer.values : {},
  );
  if (!checked.ok) return { ok: false, status: 400, error: 'Check the answers.', errors: checked.errors };

  let savedLabels: string[] = [];
  if (answer.save === true) {
    const inputs = boundDetailInputs(form, checked.values);
    if (inputs.length) {
      const result = await deps.saveDetails(user, inputs);
      savedLabels = result.saved.map((entry) => entry.label);
    }
  }

  // A planner question keeps its old answer shape: the chosen option label
  // and its id, which the plan reads.
  if (legacy && form.fields.length === 1) {
    const value = checked.values.answer as { choices?: string[]; other?: string } | string | undefined;
    if (value && typeof value === 'object' && 'choices' in value) {
      const id = value.choices?.[0];
      const label = question.options?.find((option) => option.id === id)?.label;
      return {
        ok: true,
        answer: value.other || label || id || '',
        answeredOptionId: value.other ? undefined : id,
        savedLabels,
      };
    }
    if (typeof value === 'string') return { ok: true, answer: value, savedLabels };
  }
  return {
    ok: true,
    answer: truncateText(formAnswerText(form, checked.values, savedLabels, { details: 'record' }), 2_000),
    note: truncateText(formAnswerText(form, checked.values, savedLabels, { details: 'run' }), 2_000),
    savedLabels,
  };
}
