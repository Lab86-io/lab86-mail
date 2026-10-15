'use client';

// One run in the Albatross thread (docs/research/albatross-thread-web-design-2026-10-07.md,
// §5.1; goal runs: docs/research/goal-runs-web-design-2026-10-15.md, §3).
// A step run: the header names the step and the state; the log folds under
// "What Albatross did"; the summary, the question form or the handoff, and
// the one primary button follow. A goal run: the header is the start time
// and the state; the messages with their sources, the blank sentence, the
// package rows, "Not sure", the checklist, the live line, the log, and the
// buttons. A continued run attaches under its parent.

import { type ReactNode, useMemo, useState } from 'react';
import { FormQuestionCard, type FormReceipt } from '@/components/ai-elements/form-question-card';
import { Task, TaskContent, TaskItem, TaskTrigger } from '@/components/ai-elements/task';
import { BlankSentence } from '@/components/albatross/BlankSentence';
import { ShimmerText } from '@/components/odysseyui/text-shimmer';
import { Button } from '@/components/ui/button';
import { handoffBlanks } from '@/lib/albatross/blanks';
import type { RunSource } from '@/lib/albatross/goal-run-contract';
import {
  doingLine,
  isGoalRun,
  liveLine,
  packageRows,
  packageTabs,
  runWhenLine,
  type SourceBehaviour,
} from '@/lib/albatross/goal-run-view';
import {
  type AllowScope,
  allowAnswerOf,
  SAVE_SIGN_IN_COPY,
  saveSignInOffer,
} from '@/lib/albatross/secure-view';
import {
  artifactBehaviour,
  artifactKindLabel,
  formatLogTime,
  logLines,
  type NextBehaviour,
  runErrorLine,
  type StepRunArtifact,
} from '@/lib/albatross/step-run-client';
import {
  type FormAnswer,
  PERSONAL_DETAIL_LABELS,
  type PersonalDetailView,
  type ThreadRunView,
  threadQuestionForm,
} from '@/lib/albatross/thread-contract';
import {
  answerTextRows,
  logDisclosure,
  PENDING_FORM_ATTRIBUTE,
  questionReceiptLine,
  RUN_STATE_COPY,
  runBlockAction,
  runBlockDismisses,
  runBlockDoneContinue,
  runBlockMarksDone,
  runStateLine,
  runUsesPage,
  savedLabelsFromAnswer,
  stoppedReason,
} from '@/lib/albatross/thread-view';
import type { SecureItemView } from '@/lib/secure/contract';
import { cn } from '@/lib/utils';
import { AllowSecureBlock, type AllowSecureNote } from './AllowSecureBlock';
import { NotSure } from './NotSure';
import { openPackageBehaviour, PackageRows } from './PackageRows';
import { RunChecklist } from './RunChecklist';
import { RunMessages } from './RunMessages';

export interface RunBlockProps {
  run: ThreadRunView;
  /** The run continues an earlier one: it attaches under it with "Continued". */
  continues?: boolean;
  /** "Step 1" before the title. Null when the plan has no such step. */
  stepNumber?: number | null;
  /** The user may start the step again (a failed, cancelled, or closed run). */
  startable?: boolean;
  /** The page pane is open: the block does not offer "Open the page". */
  pageOpen?: boolean;
  /** Document mode shows this handoff in its "Your part" card: the block keeps only its record. */
  handoffShownElsewhere?: boolean;
  /** The saved details, for a question's bound fields. */
  details?: readonly PersonalDetailView[];
  /** The action in flight on this run, if any. */
  busy?: 'stop' | 'resume' | 'dismiss' | 'start' | 'answer' | 'mark_done' | 'allow' | null;
  error?: string | null;
  /** The saved Passwords and IDs: a sign-in handoff offers to save one only when none covers its site. */
  secureItems?: readonly SecureItemView[];
  /** The allow scope in flight while the identity check runs (`busy` is 'allow'). */
  allowBusy?: AllowScope | null;
  /** The line after a cancelled or failed check on this run's allow block. */
  allowNote?: AllowSecureNote | null;
  /** The answer this client sent, before the live run carries it. */
  allowAnswered?: AllowScope | null;
  /** The sign-in for this handoff's site was saved from its offer (V13). */
  signInSaved?: boolean;
  /** A queued goal run waits for a slot: "Starts when a run ends". */
  pastCap?: boolean;
  /** The drafts this client knows went out, by draft id, with the time to show. */
  sentDrafts?: Readonly<Record<string, string>>;
  onAllow?: (run: ThreadRunView, scope: AllowScope) => void;
  onSaveSignIn?: (run: ThreadRunView, site: string) => void;
  onOpenSecureSettings?: () => void;
  /** Field errors the answer route returned, by field id. */
  answerErrors?: Record<string, string> | null;
  timeZone?: string;
  onStop: (run: ThreadRunView) => void;
  onResume: (run: ThreadRunView) => void;
  onDismiss: (run: ThreadRunView) => void;
  onStart: (run: ThreadRunView) => void;
  onMarkDone: (run: ThreadRunView) => void;
  onNext: (behaviour: NextBehaviour, run: ThreadRunView) => void;
  onAnswer: (run: ThreadRunView, questionId: string, answer: FormAnswer) => void;
  onOpenPage?: (run: ThreadRunView) => void;
  onUndoSave?: (keys: string[]) => Promise<void> | void;
  /** Goal runs: "Open the package" (document mode with every tab) and a package row (one tab). */
  onOpenPackage?: (run: ThreadRunView, activeKey: string | null) => void;
  onOpenItem?: (run: ThreadRunView, key: string) => void;
  /** Goal runs: "Done, continue". */
  onDoneContinue?: (run: ThreadRunView) => void;
  /** Goal runs: a press on a source chip. */
  onOpenSource?: (behaviour: SourceBehaviour, source: RunSource, run: ThreadRunView) => void;
  className?: string;
}

const TONE_CLASS = {
  working: 'text-[var(--color-accent)]',
  waiting: 'text-[var(--color-accent-3)]',
  done: 'text-[var(--color-success)]',
  failed: 'text-[var(--color-danger)]',
  quiet: 'text-[var(--color-text-faint)]',
} as const;

const FOLD_TRIGGER_CLASS =
  'group flex cursor-pointer items-center gap-1.5 text-left text-[12px] text-[var(--color-text-muted)] hover:text-[var(--color-text)]';

export function RunBlock(props: RunBlockProps) {
  const {
    run,
    continues = false,
    stepNumber = null,
    startable = false,
    pageOpen = false,
    handoffShownElsewhere = false,
    busy,
    timeZone,
  } = props;
  const goal = isGoalRun(run);
  const state = runStateLine(run);
  const action = handoffShownElsewhere ? ({ kind: 'none' } as const) : runBlockAction(run, { startable });
  const dismisses = !handoffShownElsewhere && runBlockDismisses(run);
  const marksDone = !handoffShownElsewhere && runBlockMarksDone(run, { startable });
  const doneContinue = !handoffShownElsewhere && runBlockDoneContinue(run);
  const lines = logLines(run);
  const working = run.state === 'queued' || run.state === 'running';
  const newest = lines.length ? lines[lines.length - 1] : null;
  const disclosure = logDisclosure(lines.length);
  const stopped = stoppedReason(run, { goal });
  const question = run.state === 'handed_off' && run.outcome === 'needs_answer' ? run.question : null;
  const showPageRow = !pageOpen && runUsesPage(run) && Boolean(props.onOpenPage);
  const stamp = formatLogTime(run.finishedAt ?? run.updatedAt, undefined, timeZone);
  // Passwords and IDs: the allow block, and the offer to save a sign-in on a sign-in handoff.
  const allow =
    run.state === 'handed_off' && run.next?.kind === 'allow_secure' ? (run.next.allow ?? null) : null;
  const allowAnswer = props.allowAnswered ? { scope: props.allowAnswered } : allowAnswerOf(run);
  const offer = saveSignInOffer(run, props.secureItems);
  const [offerDismissed, setOfferDismissed] = useState(false);
  const savedSite =
    props.signInSaved && run.next?.kind === 'sign_in' ? (run.next.saveSignIn?.site ?? null) : null;
  const detailLine = savedSite ? SAVE_SIGN_IN_COPY.detailAfterSave : run.next?.detail;
  // Goal runs: the checklist opens while the run works; the live line says the
  // current item only when the open checklist does not (design critique).
  // A run stopped at its limit also opens it: the next run starts from there.
  const [checklistOpen, setChecklistOpen] = useState(working || run.outcome === 'stopped');
  const tabs = useMemo(() => (goal ? packageTabs(run) : []), [goal, run]);
  const rows = useMemo(
    () => (goal ? packageRows(run, { sent: props.sentDrafts }) : []),
    [goal, run, props.sentDrafts],
  );
  const when = goal ? runWhenLine(run, { timeZone }) : null;
  const showLiveLine = working && (!goal || !run.checklist.length || !checklistOpen || !doingLine(run));
  const liveText = goal ? liveLine(run, { pastCap: props.pastCap }) : (newest?.text ?? RUN_STATE_COPY.queued);

  const header = (
    <header className="flex min-w-0 flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
      {goal && when ? (
        <span className="flex min-w-0 flex-1 items-baseline gap-x-2.5 text-[12px] tabular-nums text-[var(--color-text-muted)]">
          <span>{when.text}</span>
          {when.duration ? <span className="text-[var(--color-text-faint)]">{when.duration}</span> : null}
        </span>
      ) : (
        <>
          {stepNumber ? (
            <span className="text-[12px] tabular-nums text-[var(--color-text-muted)]">Step {stepNumber}</span>
          ) : null}
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{run.stepTitle}</span>
        </>
      )}
      <span
        data-slot="run-state"
        aria-live="polite"
        className={cn('shrink-0 text-[11.5px] tabular-nums', TONE_CLASS[state.tone])}
      >
        {working ? (
          state.text
        ) : (
          <>
            {state.text}
            <span className="text-[var(--color-text-faint)]"> · {stamp}</span>
          </>
        )}
      </span>
    </header>
  );

  const live = showLiveLine ? (
    <p className="text-[12.5px]" aria-live="polite" data-slot="run-live-line">
      <ShimmerText text={liveText} duration={1.6} startOnView={false} />
    </p>
  ) : null;

  const log = lines.length ? (
    <Task defaultOpen={working && !goal} className="min-w-0">
      <TaskTrigger title={disclosure.label}>
        <button type="button" className={FOLD_TRIGGER_CLASS}>
          <span>{disclosure.label}</span>
          {disclosure.count ? (
            <span className="tabular-nums text-[var(--color-text-faint)]">{disclosure.count}</span>
          ) : null}
          <span
            aria-hidden
            className="ml-0.5 inline-block size-[7px] -translate-y-[1px] rotate-[-45deg] border-r border-b border-current group-data-[state=open]:translate-y-[1px] group-data-[state=open]:rotate-45"
          />
        </button>
      </TaskTrigger>
      <TaskContent>
        <div className="max-h-60 overflow-y-auto">
          {/* While a step run works, the live line above is the newest line. */}
          {(working && !goal && lines.length > 1 ? lines.slice(0, -1) : lines).map((line) => (
            <TaskItem key={`${line.at}:${line.text}`} className="flex gap-2 py-0.5">
              <time className="shrink-0 tabular-nums text-[var(--color-text-faint)]">
                {formatLogTime(line.at, undefined, timeZone)}
              </time>
              <span className="min-w-0">{line.text}</span>
            </TaskItem>
          ))}
        </div>
      </TaskContent>
    </Task>
  ) : null;

  const stoppedNode = stopped ? (
    <p className="text-[12.5px] text-[var(--color-text-muted)]">{stopped}</p>
  ) : null;
  const failedNode =
    run.state === 'failed' ? (
      <p className="text-[12.5px]">
        <span className="font-medium">{RUN_STATE_COPY.failedLine}</span>{' '}
        <span className="text-[var(--color-danger)]">{runErrorLine(run)}</span>
      </p>
    ) : null;
  // A goal run's messages say what it did; the summary shows only without them.
  const summaryNode =
    run.summary && (!goal || !run.messages.length) ? (
      <p className="text-[13.5px] leading-relaxed">{run.summary}</p>
    ) : null;

  const artifactsNode =
    !goal && run.artifacts.length ? (
      <ul className="divide-y divide-[var(--color-list-divider)] border-y border-[var(--color-list-divider)]">
        {run.artifacts.map((artifact) => (
          <ArtifactRow
            key={`${artifact.kind}:${artifact.id ?? artifact.url ?? artifact.title}`}
            artifact={artifact}
            onOpen={(behaviour) => props.onNext(behaviour, run)}
          />
        ))}
      </ul>
    ) : null;

  const packageNode =
    goal && rows.length ? (
      <PackageRows rows={rows} onOpen={(behaviour) => openPackageBehaviour(behaviour, run, props)} />
    ) : null;

  const questionNode = question ? (
    <RunQuestion
      run={run}
      question={question}
      details={props.details}
      busy={busy === 'answer'}
      errors={props.answerErrors}
      onAnswer={props.onAnswer}
      onUndoSave={props.onUndoSave}
    />
  ) : null;

  const allowNode = allow ? (
    <div {...(allowAnswer ? {} : { [PENDING_FORM_ATTRIBUTE]: '' })}>
      <AllowSecureBlock
        allow={allow}
        headline={state.text}
        answer={allowAnswer}
        busyScope={busy === 'allow' ? (props.allowBusy ?? 'once') : null}
        note={props.allowNote}
        onAnswer={(scope) => props.onAllow?.(run, scope)}
        onOpenSettings={props.onOpenSecureSettings}
      />
    </div>
  ) : null;

  const handoffNode =
    run.state === 'handed_off' &&
    run.outcome !== 'needs_answer' &&
    run.outcome !== 'stopped' &&
    !handoffShownElsewhere ? (
      <div className="flex flex-col gap-0.5" data-slot="run-handoff">
        {/* The user's part is the largest text of the run: the blanks to fill, or the next detail.
            The header already names the state, so no label repeats it here. */}
        <BlankSentence
          blanks={savedSite ? [] : handoffBlanks(run.next)}
          fallback={detailLine}
          className={handoffBlanks(run.next).length && !savedSite ? 'text-[24px]' : 'text-[19px]'}
        />
        {detailLine && handoffBlanks(run.next).length && !savedSite ? (
          <p className="pb-1 text-[13px] leading-relaxed text-[var(--color-text-muted)]">{detailLine}</p>
        ) : null}
        {savedSite ? (
          <p
            data-slot="save-sign-in-saved"
            className="pt-1 text-[12.5px] font-medium text-[var(--color-accent-3)]"
          >
            {SAVE_SIGN_IN_COPY.saved(savedSite)}
          </p>
        ) : offer && !offerDismissed ? (
          <div
            data-slot="save-sign-in-offer"
            className="mt-1.5 flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-ui border border-[var(--color-border)] px-3 py-2 text-[12.5px]"
          >
            <span className="min-w-0 flex-1 text-[var(--color-text-muted)]">
              {SAVE_SIGN_IN_COPY.offer(offer.site)}
            </span>
            <button
              type="button"
              className="text-[11.5px] font-medium text-[var(--color-accent)] hover:underline"
              onClick={() => props.onSaveSignIn?.(run, offer.site)}
            >
              {SAVE_SIGN_IN_COPY.save}
            </button>
            <button
              type="button"
              className="text-[11.5px] font-medium text-[var(--color-text-muted)] hover:underline"
              onClick={() => setOfferDismissed(true)}
            >
              {SAVE_SIGN_IN_COPY.notNow}
            </button>
          </div>
        ) : null}
      </div>
    ) : null;

  const pageRowNode = showPageRow ? (
    <button
      type="button"
      onClick={() => props.onOpenPage?.(run)}
      className="flex w-fit items-center gap-2 text-[12.5px] text-[var(--color-accent)] hover:underline"
    >
      {RUN_STATE_COPY.openPage}
    </button>
  ) : null;

  const actionsNode =
    action.kind !== 'none' || dismisses || marksDone || doneContinue ? (
      <div className="flex flex-wrap items-center gap-2 pt-0.5">
        {action.kind === 'stop' ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy === 'stop'}
            onClick={() => props.onStop(run)}
          >
            {busy === 'stop' ? 'Stopping…' : RUN_STATE_COPY.stopButton}
          </Button>
        ) : null}
        {action.kind === 'resume' ? (
          <Button type="button" size="sm" disabled={Boolean(busy)} onClick={() => props.onResume(run)}>
            {busy === 'resume' ? 'Continuing…' : savedSite ? RUN_STATE_COPY.continueButton : action.label}
          </Button>
        ) : null}
        {action.kind === 'next' ? (
          <Button
            type="button"
            size="sm"
            disabled={Boolean(busy)}
            onClick={() => props.onNext(action.behaviour, run)}
          >
            {action.label}
          </Button>
        ) : null}
        {action.kind === 'package' ? (
          <Button
            type="button"
            size="sm"
            disabled={Boolean(busy)}
            onClick={() => props.onOpenPackage?.(run, action.activeKey)}
          >
            {action.label}
          </Button>
        ) : null}
        {action.kind === 'done_continue' ? (
          <Button
            type="button"
            size="sm"
            disabled={Boolean(busy)}
            onClick={() => props.onDoneContinue?.(run)}
          >
            {busy === 'mark_done' ? 'Continuing…' : action.label}
          </Button>
        ) : null}
        {action.kind === 'mark_done' ? (
          <Button type="button" size="sm" disabled={Boolean(busy)} onClick={() => props.onMarkDone(run)}>
            {busy === 'mark_done' ? 'Saving…' : action.label}
          </Button>
        ) : null}
        {marksDone ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={Boolean(busy)}
            onClick={() => props.onMarkDone(run)}
          >
            {busy === 'mark_done' ? 'Saving…' : RUN_STATE_COPY.markDone}
          </Button>
        ) : null}
        {doneContinue ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={Boolean(busy)}
            onClick={() => props.onDoneContinue?.(run)}
          >
            {busy === 'mark_done' ? 'Continuing…' : RUN_STATE_COPY.doneContinue}
          </Button>
        ) : null}
        {action.kind === 'start' ? (
          <Button
            type="button"
            size="sm"
            variant={run.state === 'failed' ? 'outline' : 'default'}
            disabled={Boolean(busy)}
            onClick={() => props.onStart(run)}
          >
            {busy === 'start' ? 'Starting…' : action.label}
          </Button>
        ) : null}
        {dismisses ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={Boolean(busy)}
            onClick={() => props.onDismiss(run)}
          >
            {busy === 'dismiss' ? 'Closing…' : RUN_STATE_COPY.dismissButton}
          </Button>
        ) : null}
      </div>
    ) : null;

  const errorNode = props.error ? (
    <p className="text-[11.5px] text-[var(--color-danger)]">{props.error}</p>
  ) : null;

  const body: ReactNode = goal ? (
    <>
      <RunMessages
        messages={run.messages}
        working={working}
        tabs={tabs}
        timeZone={timeZone}
        onOpenSource={
          props.onOpenSource ? (behaviour, source) => props.onOpenSource?.(behaviour, source, run) : undefined
        }
      />
      {summaryNode}
      {handoffNode}
      {packageNode}
      <NotSure lines={run.unsure} />
      <RunChecklist items={run.checklist} open={checklistOpen} onOpenChange={setChecklistOpen} />
      {live}
      {stoppedNode}
      {failedNode}
      {log}
      {questionNode}
      {allowNode}
      {pageRowNode}
      {actionsNode}
      {errorNode}
    </>
  ) : (
    <>
      {live}
      {log}
      {stoppedNode}
      {failedNode}
      {summaryNode}
      {artifactsNode}
      {questionNode}
      {allowNode}
      {handoffNode}
      {pageRowNode}
      {actionsNode}
      {errorNode}
    </>
  );

  return (
    <section
      data-slot="run-block"
      data-run-state={run.state}
      data-run-outcome={run.outcome ?? undefined}
      data-run-goal={goal || undefined}
      aria-label={`${run.stepTitle}: ${state.text}`}
      className={cn(
        'relative flex w-full min-w-0 flex-col gap-2.5 rounded-ui border border-[var(--color-border)] px-4 pb-3.5 pt-3',
        continues && 'mt-1',
        props.className,
      )}
    >
      {continues ? (
        <span
          data-slot="run-continued"
          className="absolute -top-[9px] left-3 bg-[var(--color-bg)] px-1.5 text-[11px] text-[var(--color-text-faint)]"
        >
          {RUN_STATE_COPY.continued}
        </span>
      ) : null}
      {header}
      {body}
    </section>
  );
}

function RunQuestion({
  run,
  question,
  details,
  busy,
  errors,
  onAnswer,
  onUndoSave,
}: {
  run: ThreadRunView;
  question: NonNullable<ThreadRunView['question']>;
  details?: readonly PersonalDetailView[];
  busy: boolean;
  errors?: Record<string, string> | null;
  onAnswer: RunBlockProps['onAnswer'];
  onUndoSave?: RunBlockProps['onUndoSave'];
}) {
  const form = useMemo(() => threadQuestionForm(question), [question]);
  const receipt: FormReceipt | null = useMemo(() => {
    if (question.status === 'pending') return null;
    const savedLabels = savedLabelsFromAnswer(question.answer);
    // The server names saved details by their catalog label ("Phone"), which
    // can differ from the label the form gave the field ("Mobile phone").
    const keys = form.fields
      .filter((field) => field.detailKey && savedLabels.includes(savedDetailLabel(field)))
      .map((field) => String(field.detailKey));
    return {
      values: null,
      rows: answerTextRows(question.answer),
      stateLine: questionReceiptLine(question),
      savedLabels,
      onUndoSave: keys.length && onUndoSave ? () => onUndoSave(keys) : undefined,
    };
  }, [question, form, onUndoSave]);
  return (
    <div {...(receipt ? {} : { [PENDING_FORM_ATTRIBUTE]: '' })}>
      <FormQuestionCard
        form={form}
        mode="runner"
        details={details}
        receipt={receipt}
        busy={busy}
        errors={errors}
        onSubmit={(answer) => onAnswer(run, question.id, answer)}
      />
    </div>
  );
}

function ArtifactRow({
  artifact,
  onOpen,
}: {
  artifact: StepRunArtifact;
  onOpen: (behaviour: NextBehaviour) => void;
}) {
  const behaviour = artifactBehaviour(artifact);
  const kind = (
    <span className="shrink-0 text-[11px] text-[var(--color-text-faint)]">{artifactKindLabel(artifact)}</span>
  );
  if (!behaviour) {
    return (
      <li className="flex items-center gap-3 py-1.5">
        <span className="min-w-0 flex-1 truncate text-[12.5px]">{artifact.title}</span>
        {kind}
      </li>
    );
  }
  return (
    <li>
      <button
        type="button"
        onClick={() => onOpen(behaviour)}
        className="flex w-full items-center gap-3 py-1.5 text-left transition-colors hover:text-[var(--color-accent)]"
      >
        <span className="min-w-0 flex-1 truncate text-[12.5px] underline-offset-2 hover:underline">
          {artifact.title}
        </span>
        {kind}
      </button>
    </li>
  );
}

/** The label the server uses when it saves this field's detail. */
export function savedDetailLabel(field: { label: string; detailKey?: string }): string {
  const key = field.detailKey;
  if (key && key in PERSONAL_DETAIL_LABELS)
    return PERSONAL_DETAIL_LABELS[key as keyof typeof PERSONAL_DETAIL_LABELS];
  return field.label;
}
