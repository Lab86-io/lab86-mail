'use client';

// One run in the Albatross thread (docs/research/albatross-thread-web-design-2026-10-07.md,
// §5.1). The header names the step and the state; the log folds under "What
// Albatross did"; the summary, the question form or the handoff, and the one
// primary button follow. A continued run attaches under its parent.

import { useMemo } from 'react';
import { FormQuestionCard, type FormReceipt } from '@/components/ai-elements/form-question-card';
import { Task, TaskContent, TaskItem, TaskTrigger } from '@/components/ai-elements/task';
import { ShimmerText } from '@/components/odysseyui/text-shimmer';
import { Button } from '@/components/ui/button';
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
  runStateLine,
  runUsesPage,
  savedLabelsFromAnswer,
  stoppedReason,
} from '@/lib/albatross/thread-view';
import { cn } from '@/lib/utils';

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
  /** The saved details, for a question's bound fields. */
  details?: readonly PersonalDetailView[];
  /** The action in flight on this run, if any. */
  busy?: 'stop' | 'resume' | 'dismiss' | 'start' | 'answer' | 'mark_done' | null;
  error?: string | null;
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
  className?: string;
}

const TONE_CLASS = {
  working: 'text-[var(--color-accent)]',
  waiting: 'text-[var(--color-accent-3)]',
  done: 'text-[var(--color-success)]',
  failed: 'text-[var(--color-danger)]',
  quiet: 'text-[var(--color-text-faint)]',
} as const;

export function RunBlock(props: RunBlockProps) {
  const {
    run,
    continues = false,
    stepNumber = null,
    startable = false,
    pageOpen = false,
    busy,
    timeZone,
  } = props;
  const state = runStateLine(run);
  const action = runBlockAction(run, { startable });
  const dismisses = runBlockDismisses(run);
  const lines = logLines(run);
  const working = run.state === 'queued' || run.state === 'running';
  const newest = lines.length ? lines[lines.length - 1] : null;
  const disclosure = logDisclosure(lines.length);
  const stopped = stoppedReason(run);
  const question = run.state === 'handed_off' && run.outcome === 'needs_answer' ? run.question : null;
  const showPageRow = !pageOpen && runUsesPage(run) && Boolean(props.onOpenPage);
  const stamp = formatLogTime(run.finishedAt ?? run.updatedAt, undefined, timeZone);

  return (
    <section
      data-slot="run-block"
      data-run-state={run.state}
      data-run-outcome={run.outcome ?? undefined}
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

      <header className="flex min-w-0 flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
        {stepNumber ? (
          <span className="text-[12px] tabular-nums text-[var(--color-text-muted)]">Step {stepNumber}</span>
        ) : null}
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{run.stepTitle}</span>
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

      {working ? (
        <p className="text-[12.5px]" aria-live="polite">
          <ShimmerText text={newest?.text ?? RUN_STATE_COPY.queued} duration={1.6} startOnView={false} />
        </p>
      ) : null}

      {lines.length ? (
        <Task defaultOpen={working} className="min-w-0">
          <TaskTrigger title={disclosure.label}>
            <button
              type="button"
              className="group flex cursor-pointer items-center gap-1.5 text-left text-[12px] text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text)]"
            >
              <span>{disclosure.label}</span>
              {disclosure.count ? (
                <span className="tabular-nums text-[var(--color-text-faint)]">{disclosure.count}</span>
              ) : null}
              <span
                aria-hidden
                className="ml-0.5 inline-block size-[7px] -translate-y-[1px] rotate-[-45deg] border-r border-b border-current transition-transform group-data-[state=open]:translate-y-[1px] group-data-[state=open]:rotate-45"
              />
            </button>
          </TaskTrigger>
          <TaskContent>
            <div className="max-h-60 overflow-y-auto">
              {/* While the run works, the live line above is the newest line. */}
              {(working && lines.length > 1 ? lines.slice(0, -1) : lines).map((line) => (
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
      ) : null}

      {stopped ? <p className="text-[12.5px] text-[var(--color-text-muted)]">{stopped}</p> : null}
      {run.state === 'failed' ? (
        <p className="text-[12.5px]">
          <span className="font-medium">{RUN_STATE_COPY.failedLine}</span>{' '}
          <span className="text-[var(--color-danger)]">{runErrorLine(run)}</span>
        </p>
      ) : null}
      {run.summary ? <p className="text-[13.5px] leading-relaxed">{run.summary}</p> : null}

      {run.artifacts.length ? (
        <ul className="divide-y divide-[var(--color-list-divider)] border-y border-[var(--color-list-divider)]">
          {run.artifacts.map((artifact) => (
            <ArtifactRow
              key={`${artifact.kind}:${artifact.id ?? artifact.url ?? artifact.title}`}
              artifact={artifact}
              onOpen={(behaviour) => props.onNext(behaviour, run)}
            />
          ))}
        </ul>
      ) : null}

      {question ? (
        <RunQuestion
          run={run}
          question={question}
          details={props.details}
          busy={busy === 'answer'}
          errors={props.answerErrors}
          onAnswer={props.onAnswer}
          onUndoSave={props.onUndoSave}
        />
      ) : null}

      {run.state === 'handed_off' && run.outcome !== 'needs_answer' && run.outcome !== 'stopped' ? (
        <div className="flex flex-col gap-0.5">
          <span className={cn('text-[11.5px] font-medium', TONE_CLASS[state.tone])}>{state.text}</span>
          {run.next?.detail ? (
            <p className="text-[14px] font-medium leading-snug">{run.next.detail}</p>
          ) : null}
        </div>
      ) : null}

      {showPageRow ? (
        <button
          type="button"
          onClick={() => props.onOpenPage?.(run)}
          className="flex w-fit items-center gap-2 text-[12.5px] text-[var(--color-accent)] hover:underline"
        >
          {RUN_STATE_COPY.openPage}
        </button>
      ) : null}

      {action.kind !== 'none' || dismisses ? (
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
              {busy === 'resume' ? 'Continuing…' : action.label}
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
          {action.kind === 'mark_done' ? (
            <Button type="button" size="sm" disabled={Boolean(busy)} onClick={() => props.onMarkDone(run)}>
              {busy === 'mark_done' ? 'Saving…' : action.label}
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
      ) : null}
      {props.error ? <p className="text-[11.5px] text-[var(--color-danger)]">{props.error}</p> : null}
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
    const keys = form.fields
      .filter((field) => field.detailKey && savedLabels.includes(field.label))
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
