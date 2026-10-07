'use client';

// The step runner on one step. One panel renders every state from one
// StepRunView: "Handle it" on an eligible step, the live log while the run
// works, the handoff card when it stops, the error line when it fails. The
// Work page and the guided pane both mount it. Design note:
// docs/research/step-runner-web-design-2026-10-07.md.

import { useState } from 'react';
import { Task, TaskContent, TaskItem, TaskTrigger } from '@/components/ai-elements/task';
import { ShimmerText } from '@/components/odysseyui/text-shimmer';
import { Button } from '@/components/ui/button';
import {
  artifactBehaviour,
  artifactKindLabel,
  blockedByOtherRun,
  COPY,
  canStartRun,
  formatLogTime,
  handoffHeadline,
  logLines,
  type NextBehaviour,
  nextBehaviour,
  primaryLabel,
  runErrorLine,
  type StepRunArtifact,
  type StepRunView,
  showsContinue,
  stepRunPhase,
  workingLine,
} from '@/lib/albatross/step-run-client';
import { cn } from '@/lib/utils';

export interface StepRunQuestion {
  _id: string;
  prompt: string;
  options?: Array<{ id: string; label: string; description?: string }>;
}

export interface StepRunPanelProps {
  run: StepRunView | null;
  stepDone: boolean;
  /** `execution.runner.enabled`: false hides every run control. */
  enabled: boolean;
  /** `guideSteps[i].runnable`: the user may press "Handle it". */
  runnable: boolean;
  /** The open run of the Work, which may belong to another step. */
  activeRun?: StepRunView | null;
  /** The action in flight: 'start', 'cancel', 'resume', 'dismiss', 'answer', or null. */
  busy?: string | null;
  error?: string | null;
  /** The Work question a `needs_answer` handoff waits on. */
  question?: StepRunQuestion | null;
  onStart: () => void;
  onCancel: (runId: string) => void;
  onResume: (runId: string) => void;
  onDismiss: (runId: string) => void;
  onDiscuss?: () => void;
  /** The primary button, or an artifact row. */
  onNext: (behaviour: NextBehaviour, run: StepRunView) => void;
  onAnswer?: (questionId: string, answer: string, optionId?: string) => void;
  /** For deterministic log times in the harness and tests. */
  timeZone?: string;
  className?: string;
}

export function StepRunPanel(props: StepRunPanelProps) {
  const { run, enabled, className } = props;
  if (!enabled) return null;
  const phase = stepRunPhase(run);
  const start = canStartRun({
    enabled,
    runnable: props.runnable,
    stepDone: props.stepDone,
    run,
    activeRun: props.activeRun,
  });

  if (phase === 'none' || phase === 'done') {
    if (props.stepDone) return null;
    if (start) {
      return (
        <div
          data-step-run="eligible"
          className={cn('flex flex-wrap items-center justify-between gap-2', className)}
        >
          <span className="text-[12px] text-[var(--color-text-muted)]">{COPY.canHandle}</span>
          <Button type="button" size="sm" disabled={props.busy === 'start'} onClick={props.onStart}>
            {props.busy === 'start' ? 'Starting…' : 'Handle it'}
          </Button>
        </div>
      );
    }
    if (props.runnable && blockedByOtherRun(run, props.activeRun)) {
      return (
        <p data-step-run="blocked" className={cn('text-[12px] text-[var(--color-text-faint)]', className)}>
          {COPY.blocked}
        </p>
      );
    }
    return null;
  }

  if (!run) return null;

  if (phase === 'working') {
    return (
      <section
        data-step-run="working"
        className={cn(
          'rounded-xl border border-[var(--color-accent)]/25 bg-[var(--color-bg-elevated)] p-3',
          className,
        )}
      >
        <div className="flex items-start justify-between gap-3">
          <p className="min-w-0 flex-1 text-[12.5px] font-medium" aria-live="polite">
            <ShimmerText text={workingLine(run)} duration={1.6} startOnView={false} />
          </p>
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={props.busy === 'cancel'}
            onClick={() => props.onCancel(run.id)}
          >
            {props.busy === 'cancel' ? 'Stopping…' : 'Stop'}
          </Button>
        </div>
        <RunLog run={run} open title={COPY.soFar} timeZone={props.timeZone} />
        {props.error ? <p className="mt-2 text-[11.5px] text-[var(--color-danger)]">{props.error}</p> : null}
      </section>
    );
  }

  if (phase === 'failed') {
    return (
      <section
        data-step-run="failed"
        className={cn(
          'rounded-xl border border-[var(--color-danger)]/25 bg-[var(--color-danger-soft)] p-3',
          className,
        )}
      >
        <p className="text-[12.5px] font-medium">{COPY.failed}</p>
        <p className="mt-0.5 text-[12px] text-[var(--color-danger)]">{runErrorLine(run)}</p>
        <RunLog run={run} title={COPY.whatIDid} timeZone={props.timeZone} />
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {props.runnable && !props.stepDone ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={props.busy === 'start'}
              onClick={props.onStart}
            >
              {props.busy === 'start' ? 'Starting…' : 'Try again'}
            </Button>
          ) : null}
          {props.onDiscuss ? (
            <Button type="button" size="sm" variant="ghost" onClick={props.onDiscuss}>
              Discuss this
            </Button>
          ) : null}
        </div>
        {props.error ? <p className="mt-2 text-[11.5px] text-[var(--color-danger)]">{props.error}</p> : null}
      </section>
    );
  }

  return <HandoffCard {...props} run={run} />;
}

function HandoffCard(props: StepRunPanelProps & { run: StepRunView }) {
  const { run } = props;
  const next = run.next;
  const behaviour = nextBehaviour(next);
  const label = primaryLabel(next);
  const stopped = run.outcome === 'stopped';
  // A stopped run without a next action still offers Continue: the run meter
  // ended it, not the work.
  const resumeOnly = stopped && !behaviour;
  const busy = props.busy;
  return (
    <section
      data-step-run="handed_off"
      data-outcome={run.outcome ?? undefined}
      className={cn(
        'rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-4',
        props.className,
      )}
    >
      <p className="text-[11.5px] text-[var(--color-text-faint)]">{handoffHeadline(run)}</p>
      {run.summary ? <p className="mt-1 text-[13px] leading-relaxed">{run.summary}</p> : null}
      {run.artifacts.length ? (
        <ul className="mt-3 divide-y divide-[var(--color-border)]/60 border-y border-[var(--color-border)]/60">
          {run.artifacts.map((artifact) => (
            <ArtifactRow
              key={`${artifact.kind}:${artifact.id ?? artifact.url ?? artifact.title}`}
              artifact={artifact}
              onOpen={(target) => props.onNext(target, run)}
            />
          ))}
        </ul>
      ) : null}
      <RunLog run={run} title={COPY.whatIDid} timeZone={props.timeZone} />
      {next?.detail ? (
        <p className="mt-3 text-[12.5px] leading-relaxed text-[var(--color-text-muted)]">{next.detail}</p>
      ) : null}
      {next?.kind === 'answer' && props.question ? (
        <QuestionForm
          question={props.question}
          busy={busy === 'answer'}
          onAnswer={(answer, optionId) => props.onAnswer?.(props.question!._id, answer, optionId)}
        />
      ) : null}
      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-[var(--color-border)]/70 pt-3">
        {behaviour && label ? (
          <Button
            type="button"
            size="sm"
            disabled={Boolean(busy)}
            onClick={() => props.onNext(behaviour, run)}
          >
            {behaviour.kind === 'resume' && busy === 'resume' ? 'Continuing…' : label}
          </Button>
        ) : null}
        {resumeOnly ? (
          <Button type="button" size="sm" disabled={Boolean(busy)} onClick={() => props.onResume(run.id)}>
            {busy === 'resume' ? 'Continuing…' : 'Continue'}
          </Button>
        ) : null}
        {showsContinue(next) ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={Boolean(busy)}
            onClick={() => props.onResume(run.id)}
          >
            {busy === 'resume' ? 'Continuing…' : 'Continue'}
          </Button>
        ) : null}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={Boolean(busy)}
          onClick={() => props.onDismiss(run.id)}
        >
          {busy === 'dismiss' ? 'Closing…' : 'Dismiss'}
        </Button>
        {props.onDiscuss ? (
          <Button type="button" size="sm" variant="ghost" onClick={props.onDiscuss}>
            Discuss this
          </Button>
        ) : null}
      </div>
      {props.error ? <p className="mt-2 text-[11.5px] text-[var(--color-danger)]">{props.error}</p> : null}
    </section>
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
    <span className="shrink-0 text-[10.5px] text-[var(--color-text-faint)]">
      {artifactKindLabel(artifact)}
    </span>
  );
  if (!behaviour) {
    return (
      <li className="flex items-center gap-3 py-2">
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
        className="flex w-full items-center gap-3 py-2 text-left transition-colors hover:text-[var(--color-accent)]"
      >
        <span className="min-w-0 flex-1 truncate text-[12.5px] underline-offset-2 hover:underline">
          {artifact.title}
        </span>
        {kind}
      </button>
    </li>
  );
}

/** The log in a collapsible row. Open while the run works; collapsed after. */
function RunLog({
  run,
  title,
  open = false,
  timeZone,
}: {
  run: StepRunView;
  title: string;
  open?: boolean;
  timeZone?: string;
}) {
  const lines = logLines(run);
  if (!lines.length) return null;
  return (
    <Task defaultOpen={open} className="mt-3">
      <TaskTrigger title={title} />
      <TaskContent>
        {lines.map((line) => (
          <TaskItem key={`${line.at}:${line.text}`} className="flex gap-2">
            <time className="shrink-0 tabular-nums text-[var(--color-text-faint)]">
              {formatLogTime(line.at, undefined, timeZone)}
            </time>
            <span className="min-w-0">{line.text}</span>
          </TaskItem>
        ))}
      </TaskContent>
    </Task>
  );
}

/** A `needs_answer` handoff: the question, its choices, and a free answer. */
function QuestionForm({
  question,
  busy,
  onAnswer,
}: {
  question: StepRunQuestion;
  busy: boolean;
  onAnswer: (answer: string, optionId?: string) => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [text, setText] = useState('');
  const option = question.options?.find((row) => row.id === selected);
  const value = text.trim() || option?.label || '';
  const inputId = `step-run-answer-${question._id}`;
  return (
    <div className="mt-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-3">
      <p className="text-[12.5px] font-medium">{question.prompt}</p>
      {question.options?.length ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {question.options.map((row) => (
            <button
              key={row.id}
              type="button"
              aria-pressed={selected === row.id}
              onClick={() => setSelected((current) => (current === row.id ? null : row.id))}
              className={cn(
                'rounded-lg border px-2.5 py-1.5 text-left text-[12px] transition-colors',
                selected === row.id
                  ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-accent)]'
                  : 'border-[var(--color-border)] hover:border-[var(--color-border-strong)]',
              )}
            >
              <span className="block">{row.label}</span>
              {row.description ? (
                <span className="block text-[11px] text-[var(--color-text-faint)]">{row.description}</span>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}
      <div className="mt-2 flex gap-2">
        <label htmlFor={inputId} className="sr-only">
          Answer in your own words
        </label>
        <input
          id={inputId}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && value && !busy) onAnswer(value, selected ?? undefined);
          }}
          placeholder="Answer in your own words"
          className="min-w-0 flex-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1.5 text-[12px] outline-none focus:border-[var(--color-accent)]"
        />
        <Button
          type="button"
          size="sm"
          disabled={busy || !value}
          onClick={() => onAnswer(value, selected ?? undefined)}
        >
          {busy ? 'Saving…' : 'Answer'}
        </Button>
      </div>
    </div>
  );
}
