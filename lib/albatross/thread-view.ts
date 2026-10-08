// The Albatross thread, as the web client reads it (docs/albatross-thread.md
// and docs/research/albatross-thread-web-design-2026-10-07.md). Pure: the
// state copy of a run block, the plan line, the composer placeholder, the
// jump pill, the primary action of a handoff, the form prefill from personal
// details, the answered receipt, and the timeline readers. No React here.

import { phoneDisplay } from '../personal-details/format';
import { type NextBehaviour, nextBehaviour, primaryLabel, type StepRunNext } from './step-run-client';
import {
  type FormField,
  type FormFieldValue,
  type FormQuestion,
  type PersonalDetailView,
  type ThreadQuestion,
  type ThreadRunView,
} from './thread-contract';
import type { ExecutionStepRow, WorkDetailData } from './work-view';

// ---------------------------------------------------------------------------
// Run block copy (lead review decision 6: no -ing forms).
// ---------------------------------------------------------------------------

export const RUN_STATE_COPY = {
  queued: 'Starts soon',
  running: 'In progress',
  yourTurn: 'Your turn',
  needsAnswer: 'Needs your answer',
  readyForYou: 'Ready for you',
  stopped: 'Stopped',
  done: 'Done',
  failed: 'Did not finish',
  cancelled: 'Stopped by you',
  closed: 'Closed',
  answered: 'Answered',
  log: 'What Albatross did',
  continued: 'Continued',
  stopButton: 'Stop',
  dismissButton: 'Dismiss',
  tryAgain: 'Try again',
  handleIt: 'Handle it',
  openPage: 'Open the page',
  continueButton: 'Continue',
  markDone: 'Mark step done',
  stoppedTime: 'Albatross stopped at its time limit.',
  stoppedCost: 'Albatross stopped at its cost limit.',
  failedLine: 'This run did not finish.',
} as const;

export type RunBlockTone = 'working' | 'waiting' | 'done' | 'failed' | 'quiet';

/**
 * True when a needs_answer handoff has its answer: the form was answered or
 * skipped, or the allow_secure block holds a stored answer (secure store,
 * lead decision 10).
 */
export function runQuestionAnswered(
  run: Pick<ThreadRunView, 'outcome' | 'question'> & {
    next?: { kind?: string; allowAnswer?: unknown } | null;
  },
): boolean {
  if (run.outcome !== 'needs_answer') return false;
  if (run.question) return run.question.status !== 'pending';
  return run.next?.kind === 'allow_secure' && Boolean(run.next.allowAnswer);
}

/** The state word on the right of a run block header, and its tone. */
export function runStateLine(
  run: Pick<ThreadRunView, 'state' | 'outcome' | 'stoppedBy' | 'question'> & {
    next?: { kind?: string; allowAnswer?: unknown } | null;
  },
): {
  text: string;
  tone: RunBlockTone;
} {
  switch (run.state) {
    case 'queued':
      return { text: RUN_STATE_COPY.queued, tone: 'working' };
    case 'running':
      return { text: RUN_STATE_COPY.running, tone: 'working' };
    case 'handed_off':
      if (run.outcome === 'needs_answer') {
        return runQuestionAnswered(run)
          ? { text: RUN_STATE_COPY.answered, tone: 'quiet' }
          : { text: RUN_STATE_COPY.needsAnswer, tone: 'waiting' };
      }
      if (run.outcome === 'your_turn') return { text: RUN_STATE_COPY.yourTurn, tone: 'waiting' };
      if (run.outcome === 'ready_for_you') return { text: RUN_STATE_COPY.readyForYou, tone: 'waiting' };
      if (run.outcome === 'stopped') return { text: RUN_STATE_COPY.stopped, tone: 'quiet' };
      return { text: RUN_STATE_COPY.stopped, tone: 'quiet' };
    case 'done':
      return { text: RUN_STATE_COPY.done, tone: 'done' };
    case 'failed':
      return { text: RUN_STATE_COPY.failed, tone: 'failed' };
    case 'cancelled':
      return { text: RUN_STATE_COPY.cancelled, tone: 'quiet' };
    default:
      return { text: RUN_STATE_COPY.closed, tone: 'quiet' };
  }
}

/** "Albatross stopped at its time limit." for a limit stop, else null. */
export function stoppedReason(run: Pick<ThreadRunView, 'outcome' | 'stoppedBy'>): string | null {
  if (run.outcome !== 'stopped') return null;
  if (run.stoppedBy === 'time') return RUN_STATE_COPY.stoppedTime;
  if (run.stoppedBy === 'cost') return RUN_STATE_COPY.stoppedCost;
  return null;
}

/** The log disclosure: "What Albatross did" and the count as a quiet number (decision 7). */
export function logDisclosure(count: number): { label: string; count: string | null } {
  return { label: RUN_STATE_COPY.log, count: count > 0 ? String(count) : null };
}

// ---------------------------------------------------------------------------
// The primary action of a run block.
// ---------------------------------------------------------------------------

export type RunBlockAction =
  | { kind: 'stop' }
  | { kind: 'resume'; label: string }
  | { kind: 'next'; label: string; behaviour: NextBehaviour }
  | { kind: 'mark_done'; label: string }
  | { kind: 'start'; label: string }
  | { kind: 'none' };

/** The behaviours that open the thing a run made: a draft, a document, an approval, a page. */
const OPENS_RESULT = new Set<NextBehaviour['kind']>([
  'open_draft',
  'open_document',
  'open_approval',
  'open_url',
]);

/**
 * The one primary button. On the user's turn on a page it is `next.doneLabel`
 * ("I paid"), default "Continue", and it resumes the run (decision 5). A
 * question has no button: the form has it. A failed or stopped run offers a
 * restart or a continue.
 */
export function runBlockAction(
  run: Pick<ThreadRunView, 'state' | 'outcome' | 'next' | 'question'>,
  options: { startable?: boolean } = {},
): RunBlockAction {
  switch (run.state) {
    case 'queued':
    case 'running':
      return { kind: 'stop' };
    case 'handed_off': {
      const next = run.next as StepRunNext | null;
      if (run.outcome === 'needs_answer') return { kind: 'none' };
      if (run.outcome === 'stopped') return { kind: 'resume', label: RUN_STATE_COPY.continueButton };
      if (!next) return { kind: 'resume', label: RUN_STATE_COPY.continueButton };
      if (next.kind === 'sign_in' || next.kind === 'finish_on_page')
        return { kind: 'resume', label: next.doneLabel?.trim() || RUN_STATE_COPY.continueButton };
      if (next.kind === 'do_offline')
        return { kind: 'mark_done', label: primaryLabel(next) ?? 'Mark this step done' };
      if (next.kind === 'continue') return { kind: 'resume', label: RUN_STATE_COPY.continueButton };
      const behaviour = nextBehaviour(next);
      const label = primaryLabel(next);
      // A result waits for the user's check: the button opens it, and "Mark
      // step done" sits beside it. With nothing to open, marking it done is
      // the one action left (docs/albatross-document-handoff.md).
      if (run.outcome === 'ready_for_you' && !(behaviour && OPENS_RESULT.has(behaviour.kind)))
        return { kind: 'mark_done', label: RUN_STATE_COPY.markDone };
      return behaviour && label ? { kind: 'next', label, behaviour } : { kind: 'none' };
    }
    case 'failed':
      return options.startable ? { kind: 'start', label: RUN_STATE_COPY.tryAgain } : { kind: 'none' };
    case 'cancelled':
    case 'closed':
      return options.startable ? { kind: 'start', label: RUN_STATE_COPY.handleIt } : { kind: 'none' };
    default:
      return { kind: 'none' };
  }
}

/**
 * "Mark step done" as a second button: a result that waits for the user's
 * check, where the primary button opens the result.
 */
export function runBlockMarksDone(
  run: Pick<ThreadRunView, 'state' | 'outcome' | 'next' | 'question'>,
  options: { startable?: boolean } = {},
): boolean {
  if (run.state !== 'handed_off' || run.outcome !== 'ready_for_you') return false;
  return runBlockAction(run, options).kind === 'next';
}

/**
 * The quiet second button: "Dismiss" on every open handoff. An allow_secure
 * block has its own quiet refusal ("Do not allow"), so it offers no Dismiss.
 */
export function runBlockDismisses(
  run: Pick<ThreadRunView, 'state' | 'outcome' | 'question'> & { next?: { kind?: string } | null },
): boolean {
  if (run.state !== 'handed_off') return false;
  if (run.next?.kind === 'allow_secure') return false;
  if (run.outcome === 'needs_answer') return !run.question || run.question.status === 'pending';
  return true;
}

/** True when the run's page waits for the user on the shared browser. */
export function runUsesPage(run: Pick<ThreadRunView, 'browserSessionId' | 'state' | 'next'>): boolean {
  if (!run.browserSessionId) return false;
  if (run.state === 'queued' || run.state === 'running') return true;
  const kind = run.next?.kind;
  return run.state === 'handed_off' && (kind === 'sign_in' || kind === 'finish_on_page');
}

// ---------------------------------------------------------------------------
// The thread state, the plan line, the placeholder, the jump pill.
// ---------------------------------------------------------------------------

export type ThreadState = 'planning' | 'needs_answer' | 'ready' | 'running' | 'waiting' | 'done' | 'released';

export interface ThreadStateInput {
  workState?: string | null;
  planReady: boolean;
  totalSteps: number;
  /** Zero-based index of the current step, or null when every step is done. */
  currentIndex: number | null;
  currentStepTitle?: string | null;
  activeRun: ThreadRunView | null;
  /** The newest open handoff of the current step, if any. */
  handoff: ThreadRunView | null;
  pendingQuestion: boolean;
}

export function threadState(input: ThreadStateInput): ThreadState {
  if (input.workState === 'done') return 'done';
  if (input.workState === 'released' || input.workState === 'archived') return 'released';
  if (!input.planReady) return 'planning';
  // The current step's own question first; a run at work outranks a question
  // that some other part of the Work left open.
  if (input.pendingQuestion && input.handoff?.outcome === 'needs_answer') return 'needs_answer';
  if (input.activeRun) return 'running';
  if (input.pendingQuestion) return 'needs_answer';
  if (input.handoff) return 'waiting';
  return 'ready';
}

export const PLAN_LINE_COPY = {
  planning: 'Making the plan…',
  done: 'Done',
  released: 'Put down',
  needsAnswer: 'Needs your answer',
  working: 'In progress',
  yourMove: 'Your move',
  yourTurn: 'Your turn',
  readyForYou: 'Ready for you',
  next: 'Next',
} as const;

/** "Step 1 of 2 · Your turn". The header pill. */
export function planLine(input: ThreadStateInput): { text: string; state: ThreadState } {
  const state = threadState(input);
  if (state === 'planning') return { text: PLAN_LINE_COPY.planning, state };
  if (state === 'done') return { text: PLAN_LINE_COPY.done, state };
  if (state === 'released') return { text: PLAN_LINE_COPY.released, state };
  if (input.totalSteps === 0) return { text: PLAN_LINE_COPY.yourMove, state };
  if (input.currentIndex === null) return { text: `${input.totalSteps} of ${input.totalSteps} done`, state };
  const step = `Step ${input.currentIndex + 1} of ${input.totalSteps}`;
  let word: string;
  switch (state) {
    case 'needs_answer':
      word = PLAN_LINE_COPY.needsAnswer;
      break;
    case 'running':
      word = PLAN_LINE_COPY.working;
      break;
    case 'waiting':
      word =
        input.handoff?.outcome === 'ready_for_you' ? PLAN_LINE_COPY.readyForYou : PLAN_LINE_COPY.yourTurn;
      break;
    default:
      word = PLAN_LINE_COPY.yourMove;
  }
  return { text: `${step} · ${word}`, state };
}

/** The composer placeholder by state (decision 11). */
export function composerPlaceholder(state: ThreadState): string {
  switch (state) {
    case 'needs_answer':
      return 'Answer here, or tell Albatross what to change';
    case 'running':
      return 'Tell Albatross what to change';
    case 'planning':
      return 'Add anything Albatross should know';
    case 'done':
    case 'released':
      return 'Ask about this Albatross';
    default:
      return 'Tell Albatross what to do';
  }
}

/** The attribute the jump pill looks for: the pending form card in the thread. */
export const PENDING_FORM_ATTRIBUTE = 'data-thread-pending-form';

export const JUMP_PILL_COPY = {
  newest: 'Newest',
  needsAnswer: 'Albatross needs an answer',
} as const;

/**
 * True when at least `minVisible` px of the form card sit inside the chat
 * viewport, so the pill can say that an answer waits off screen.
 */
export function pendingFormVisibleIn(
  viewport: { top: number; bottom: number },
  target: { top: number; bottom: number },
  minVisible = 96,
): boolean {
  const top = Math.max(viewport.top, target.top);
  const bottom = Math.min(viewport.bottom, target.bottom);
  const height = target.bottom - target.top;
  return bottom - top >= Math.min(minVisible, Math.max(1, height));
}

/** The jump pill above the composer (decision 12). Null hides it. */
export function jumpPillLabel(input: {
  atBottom: boolean;
  pendingFormVisible: boolean | null;
}): string | null {
  if (input.pendingFormVisible === false) return JUMP_PILL_COPY.needsAnswer;
  if (!input.atBottom) return JUMP_PILL_COPY.newest;
  return null;
}

// ---------------------------------------------------------------------------
// Steps in the plan block and the details panel.
// ---------------------------------------------------------------------------

export type PlanStepState = 'done' | 'now' | 'next' | 'yours';

export interface PlanStepRow {
  key: string;
  index: number;
  title: string;
  state: PlanStepState;
  /** "Verified on the page · Registration confirmed" for a done step. */
  proof: string | null;
  runnable: boolean;
  offline: boolean;
  /** A run on this step handed off and waits for the user: no "Handle it". */
  waiting: boolean;
  /** The words for a waiting row: "Ready for you" for a result to check, else "Your turn". */
  waitingLabel: string | null;
}

const VERIFICATION_LABEL = {
  reported: 'Marked done',
  artifact: 'Noted',
  observed: 'Verified on the page',
  confirmed: 'Confirmed',
} as const;

export function planStepRows(
  steps: readonly ExecutionStepRow[],
  options: { runnerEnabled: boolean; runs?: readonly ThreadRunView[] } = { runnerEnabled: false },
): PlanStepRow[] {
  // The newest run of each step decides whether the step waits on the user.
  const newestRun = new Map<string, ThreadRunView>();
  for (const run of options.runs ?? []) {
    const known = newestRun.get(run.stepKey);
    if (!known || run.createdAt >= known.createdAt) newestRun.set(run.stepKey, run);
  }
  const currentKey = steps.find((step) => !step.done)?.key ?? null;
  return steps.map((step, index) => {
    const offline = step.stepMode === 'you_do_offline' || (!step.stepMode && step.kind === 'physical');
    let state: PlanStepState;
    if (step.done) state = 'done';
    else if (step.key === currentKey) state = offline ? 'yours' : 'now';
    else state = offline ? 'yours' : 'next';
    const proof = step.done
      ? [
          step.verification ? VERIFICATION_LABEL[step.verification.level] : null,
          step.verification?.evidenceTitle ?? null,
        ]
          .filter(Boolean)
          .join(' · ') || null
      : null;
    const newest = newestRun.get(step.key);
    const waiting = !step.done && newest?.state === 'handed_off';
    return {
      key: step.key,
      index,
      title: step.title,
      state,
      proof,
      runnable: options.runnerEnabled && !step.done && !waiting && Boolean(step.runnable),
      offline,
      waiting,
      waitingLabel: waiting
        ? newest?.outcome === 'ready_for_you'
          ? RUN_STATE_COPY.readyForYou
          : newest?.outcome === 'needs_answer'
            ? RUN_STATE_COPY.needsAnswer
            : RUN_STATE_COPY.yourTurn
        : null,
    };
  });
}

export const PLAN_STEP_STATE_LABEL: Record<PlanStepState, string> = {
  done: 'Done',
  now: 'Now',
  next: 'Next',
  yours: 'Yours, offline',
};

/** The index of the step a run belongs to, one-based for the block header. */
export function stepNumberFor(steps: readonly ExecutionStepRow[], stepKey: string): number | null {
  const index = steps.findIndex((step) => step.key === stepKey);
  return index === -1 ? null : index + 1;
}

/** The state input of a thread from the detail projection and the live runs. */
export function threadStateInput(
  detail: Pick<WorkDetailData, 'work' | 'plan' | 'execution' | 'questions'> | null,
  runs: readonly ThreadRunView[],
): ThreadStateInput {
  const steps = detail?.execution.guideSteps ?? [];
  const currentIndex = steps.findIndex((step) => !step.done);
  const current = currentIndex === -1 ? null : steps[currentIndex];
  const activeRun = runs.find((run) => run.state === 'queued' || run.state === 'running') ?? null;
  // An answered question is a closed handoff: the run continued as a new run.
  const handoff =
    [...runs]
      .reverse()
      .find(
        (run) =>
          run.state === 'handed_off' &&
          (!current || run.stepKey === current.key) &&
          !runQuestionAnswered(run),
      ) ?? null;
  const pendingQuestion =
    (handoff?.outcome === 'needs_answer' && !runQuestionAnswered(handoff)) ||
    Boolean(detail?.questions.some((question) => question.status === 'pending'));
  return {
    workState: detail?.work.workState ?? null,
    planReady: Boolean(detail?.plan && (steps.length > 0 || detail.plan.outcome)),
    totalSteps: steps.length,
    currentIndex: currentIndex === -1 ? null : currentIndex,
    currentStepTitle: current?.title ?? null,
    activeRun,
    handoff,
    pendingQuestion,
  };
}

// ---------------------------------------------------------------------------
// Timeline readers for mergeThreadTimeline.
// ---------------------------------------------------------------------------

/** `metadata.createdAt` of a message, or null for an older chat message. */
export function messageCreatedAt(message: { metadata?: unknown } | null | undefined): number | null {
  const metadata = message?.metadata as { createdAt?: unknown } | undefined;
  const at = metadata?.createdAt;
  return typeof at === 'number' && Number.isFinite(at) ? at : null;
}

/** The run ids this message started or continued: its `step_run` shapes. */
export function startedRunIds(message: { parts?: unknown[] } | null | undefined): string[] {
  const ids: string[] = [];
  for (const part of (message?.parts ?? []) as Array<{ type?: unknown; data?: unknown }>) {
    if (part?.type !== 'data-tool-shape') continue;
    const data = part.data as { kind?: unknown; runId?: unknown; action?: unknown } | undefined;
    if (data?.kind !== 'step_run' || typeof data.runId !== 'string') continue;
    if (data.action === 'started' || data.action === 'resumed') ids.push(data.runId);
  }
  return ids;
}

export const EARLIER_CHAT_DIVIDER = 'From an earlier chat';

// ---------------------------------------------------------------------------
// Forms: prefill from personal details, the save box, the receipt.
// ---------------------------------------------------------------------------

export const FORM_COPY = {
  submit: 'Continue',
  skip: 'Skip',
  change: 'Change',
  fromDetails: 'From your details',
  fromAccount: 'From your account',
  answeredInChat: 'Answered in the chat.',
  skipped: 'Skipped',
  noLongerOpen: 'No longer open',
  saved: 'Saved to your details:',
  undo: 'Undo',
  other: 'Other',
} as const;

const DETAIL_SOURCE_LINE: Record<PersonalDetailView['source'], string> = {
  account: FORM_COPY.fromAccount,
  settings: FORM_COPY.fromDetails,
  chat: FORM_COPY.fromDetails,
  form: FORM_COPY.fromDetails,
};

/** The field value a saved detail gives, in the field's own shape. */
export function detailValueForField(field: FormField, detail: PersonalDetailView): FormFieldValue | null {
  if (!field.detailKey || detail.key !== field.detailKey) return null;
  const value = detail.value;
  if (field.kind === 'name' || field.kind === 'address' || field.kind === 'contact')
    return value && typeof value === 'object' && !('label' in value) ? (value as FormFieldValue) : null;
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && 'value' in value) return String(value.value);
  return null;
}

export interface PrefilledField {
  value: FormFieldValue;
  /** "From your details", "From your account", or the run's `valueSource`. */
  source: string;
  /** True when the value came from the saved details (not from the run). */
  saved: boolean;
}

/**
 * The initial values of a form: the run's own values first, then the saved
 * details for bound fields, then the recommended choice. A bound field with
 * a saved value shows as a compact row; the others open as inputs.
 */
export function prefillForm(
  form: FormQuestion,
  details: readonly PersonalDetailView[] = [],
): { values: Record<string, FormFieldValue>; prefilled: Record<string, PrefilledField> } {
  const values: Record<string, FormFieldValue> = {};
  const prefilled: Record<string, PrefilledField> = {};
  for (const field of form.fields) {
    if (field.kind === 'choice') {
      const recommended = field.options?.find((option) => option.recommended);
      if (recommended) values[field.id] = { choices: [recommended.id] };
      continue;
    }
    if (field.value !== undefined && field.value !== null && field.value !== '') {
      values[field.id] = field.value as FormFieldValue;
      if (field.valueSource)
        prefilled[field.id] = {
          value: field.value as FormFieldValue,
          source: field.valueSource,
          saved: false,
        };
      continue;
    }
    const detail = field.detailKey ? details.find((row) => row.key === field.detailKey) : undefined;
    const value = detail ? detailValueForField(field, detail) : null;
    if (detail && value !== null) {
      values[field.id] = value;
      prefilled[field.id] = { value, source: DETAIL_SOURCE_LINE[detail.source], saved: true };
    }
  }
  return { values, prefilled };
}

/**
 * The bound fields whose value is new or different from the saved detail:
 * these are the ones "Save to my details" saves. The box shows when there is
 * at least one.
 */
export function fieldsToSave(
  form: FormQuestion,
  values: Record<string, FormFieldValue>,
  prefilled: Record<string, PrefilledField>,
): FormField[] {
  return form.fields.filter((field) => {
    if (!field.detailKey || field.kind === 'choice') return false;
    const value = values[field.id];
    if (value === undefined || value === null || value === '') return false;
    const saved = prefilled[field.id];
    if (!saved?.saved) return true;
    return JSON.stringify(saved.value) !== JSON.stringify(value);
  });
}

/** "Save phone to my details", "Save phone and address to my details". */
export function saveBoxLabel(fields: readonly FormField[]): string {
  const names = fields.map((field) => field.label.toLowerCase());
  if (!names.length) return 'Save to my details';
  if (names.length === 1) return `Save ${names[0]} to my details`;
  return `Save ${names.slice(0, -1).join(', ')} and ${names[names.length - 1]} to my details`;
}

/** The value of one answered field, as one line. */
export function formValueDisplay(field: FormField, value: FormFieldValue | undefined): string {
  if (value === undefined || value === null || value === '') return '—';
  if (field.kind === 'choice') {
    const choice = value as { choices?: string[]; other?: string };
    const labels = (choice.choices ?? []).map(
      (id) => field.options?.find((option) => option.id === id)?.label ?? id,
    );
    if (choice.other) labels.push(choice.other);
    return labels.join(', ') || '—';
  }
  if (field.kind === 'phone' && typeof value === 'string') return phoneDisplay(value);
  if (typeof value === 'string') return value;
  if (field.kind === 'name') {
    const name = value as { first: string; middle?: string; last: string };
    return [name.first, name.middle, name.last].filter((part) => part?.trim()).join(' ');
  }
  if (field.kind === 'address') {
    const address = value as {
      line1: string;
      line2?: string;
      city: string;
      region: string;
      postalCode: string;
      country: string;
    };
    const street = [address.line1, address.line2].filter((part) => part?.trim()).join(', ');
    return `${street}, ${address.city}, ${address.region} ${address.postalCode}`.trim();
  }
  if (field.kind === 'contact') {
    const contact = value as { name: string; phone: string; relationship?: string };
    const relation = contact.relationship ? ` (${contact.relationship})` : '';
    return `${contact.name}${relation}, ${phoneDisplay(contact.phone)}`;
  }
  return String(value);
}

/** The label and value rows of an answered form. */
export function formReceiptRows(
  form: FormQuestion,
  values: Record<string, FormFieldValue>,
): Array<{ id: string; label: string; value: string }> {
  return form.fields
    .filter((field) => values[field.id] !== undefined)
    .map((field) => ({ id: field.id, label: field.label, value: formValueDisplay(field, values[field.id]) }));
}

/** The receipt state line under the title of an answered question. */
export function questionReceiptLine(
  question: Pick<ThreadQuestion, 'status' | 'answeredIn'>,
  answeredAt?: string | null,
): string {
  if (question.status === 'answered') {
    if (question.answeredIn === 'chat') return FORM_COPY.answeredInChat;
    return answeredAt ? `Answered ${answeredAt}` : 'Answered';
  }
  if (question.status === 'dismissed') return FORM_COPY.skipped;
  return FORM_COPY.noLongerOpen;
}

/**
 * An answer the run recorded as text ("Class: Monday, October 19\nPhone: …"),
 * split back into label and value rows for the receipt.
 */
export function answerTextRows(
  answer: string | null | undefined,
): Array<{ id: string; label: string; value: string }> {
  const text = String(answer || '')
    .replace(/^Answered in the chat:\s*/, '')
    .trim();
  if (!text) return [];
  const rows: Array<{ id: string; label: string; value: string }> = [];
  for (const [index, line] of text.split('\n').entries()) {
    const match = /^([^:]{1,60}):\s*(.+)$/.exec(line.trim());
    if (!match) continue;
    if (match[1].startsWith("Saved to the user's personal details")) continue;
    rows.push({ id: `line-${index}`, label: match[1].trim(), value: match[2].trim() });
  }
  return rows;
}

/** "Saved to your details: Phone" from the run's answer text, when it names saved labels. */
export function savedLabelsFromAnswer(answer: string | null | undefined): string[] {
  const match = /Saved to the user's personal details:\s*([^.\n]+)\./.exec(String(answer || ''));
  if (!match) return [];
  return match[1]
    .split(',')
    .map((label) => label.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Personal details settings rows.
// ---------------------------------------------------------------------------

export const PERSONAL_DETAILS_COPY = {
  title: 'Personal details',
  blurb:
    'Albatross types these into forms for you. It never keeps passwords, card numbers, or ID numbers here.',
  /** When Passwords and IDs is on for this user, the blurb points there instead. */
  blurbWithSecure:
    'Albatross types these into forms for you. Passwords, ID numbers, and keys go in Passwords and IDs.',
  notSaved: 'Not saved',
  add: 'Add',
  change: 'Change',
  delete: 'Delete',
  cancel: 'Cancel',
  save: 'Save',
  saving: 'Saving…',
  addDetail: 'Add a detail',
  addDetailHint: 'A plain fact a form asks for, such as an employer or a member number.',
  note: 'A detail you give in a conversation or a form is saved with Undo. Delete one here at any time.',
  deleted: (label: string) => `${label} deleted`,
  saved: (label: string) => `${label} saved`,
  loading: 'Loading your details…',
  loadError: 'Could not load your details.',
  accountName: (name: string) => `Account name: ${name}`,
} as const;

function shortDate(at: number, locale?: string, timeZone?: string): string {
  return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', timeZone }).format(new Date(at));
}

/** "From your account", "You changed this on Oct 7", "You told Albatross on Oct 7", "From a form on Oct 7". */
export function detailSourceLine(
  detail: Pick<PersonalDetailView, 'source' | 'updatedAt' | 'saved'>,
  format: { locale?: string; timeZone?: string } = {},
): string {
  const when = detail.updatedAt ? shortDate(detail.updatedAt, format.locale, format.timeZone) : null;
  switch (detail.source) {
    case 'account':
      return FORM_COPY.fromAccount;
    case 'settings':
      return when ? `You changed this on ${when}` : 'You changed this';
    case 'chat':
      return when ? `You told Albatross on ${when}` : 'You told Albatross';
    default:
      return when ? `From a form on ${when}` : 'From a form';
  }
}

/** The legal-name hint: the saved name differs from the account name (S23). */
export function accountNameHint(
  detail: Pick<PersonalDetailView, 'key' | 'display' | 'source'> | null | undefined,
  accountName: string | null | undefined,
): string | null {
  if (!detail || detail.key !== 'name' || detail.source === 'account') return null;
  const account = String(accountName || '').trim();
  if (!account || account === detail.display.trim()) return null;
  return PERSONAL_DETAILS_COPY.accountName(account);
}

/** The settings list: every saved or default detail, then the missing fixed keys. */
export function personalDetailRows(
  response: { details: PersonalDetailView[]; missing: string[] } | null | undefined,
  labels: Record<string, string>,
): Array<{ key: string; label: string; detail: PersonalDetailView | null }> {
  if (!response) return [];
  const rows: Array<{ key: string; label: string; detail: PersonalDetailView | null }> = response.details.map(
    (detail) => ({ key: detail.key, label: detail.label, detail }),
  );
  for (const key of response.missing) rows.push({ key, label: labels[key] ?? key, detail: null });
  return rows;
}

/** "4 saved" for the heading aside. */
export function savedCountLine(details: readonly Pick<PersonalDetailView, 'saved'>[]): string | null {
  const saved = details.filter((detail) => detail.saved).length;
  return saved ? `${saved} saved` : null;
}
