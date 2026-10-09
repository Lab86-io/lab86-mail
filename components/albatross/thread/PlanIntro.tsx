'use client';

// The first item of every thread: what Albatross understood (S2) — the
// outcome, the plan in one compact block, and "Handle it" on the current
// step. While the plan is not ready it says so and the composer still works.
// The same step rows serve the Details panel's Plan section (S3).

import { ShimmerText } from '@/components/odysseyui/text-shimmer';
import { Button } from '@/components/ui/button';
import { PLAN_STEP_STATE_LABEL, type PlanStepRow, type ThreadState } from '@/lib/albatross/thread-view';
import { cn } from '@/lib/utils';

export const PLAN_COPY = {
  heading: 'What Albatross understood',
  outcome: 'Outcome',
  plan: 'Plan',
  making: 'Albatross makes the plan.',
  noSteps: 'No steps yet. Tell Albatross what the outcome is.',
  handleIt: 'Handle it',
  working: 'In progress',
  waiting: 'Your turn',
  done: 'Done.',
  released: 'You put this down.',
} as const;

export function PlanSteps({
  steps,
  activeStepKey,
  busyStepKey,
  onHandle,
  dense = false,
}: {
  steps: readonly PlanStepRow[];
  /** The step with an open run: its row says "In progress" instead of offering a button. */
  activeStepKey?: string | null;
  busyStepKey?: string | null;
  onHandle?: (stepKey: string) => void;
  dense?: boolean;
}) {
  return (
    <ol data-slot="plan-steps" className="flex flex-col">
      {steps.map((step) => {
        const active = step.key === activeStepKey;
        return (
          <li
            key={step.key}
            data-plan-step={step.state}
            className={cn(
              'grid grid-cols-[20px_minmax(0,1fr)_auto] items-start gap-x-3 border-t border-[var(--color-list-divider)] first:border-t-0',
              dense ? 'py-1.5' : 'py-2',
            )}
          >
            <span
              aria-hidden
              className={cn(
                'mt-[2px] grid size-[18px] place-items-center rounded-full text-[10.5px] font-medium tabular-nums',
                step.state === 'done'
                  ? 'bg-[var(--color-success)] text-white'
                  : step.state === 'now'
                    ? 'bg-[var(--color-accent)] text-[var(--color-accent-foreground)]'
                    : 'border border-[var(--color-border-strong)] text-[var(--color-text-faint)]',
              )}
            >
              {step.state === 'done' ? '✓' : step.index + 1}
            </span>
            <span className="min-w-0">
              <span
                className={cn(
                  'block text-[13px] leading-snug',
                  step.state === 'done' ? 'text-[var(--color-text-muted)]' : 'text-[var(--color-text)]',
                  step.state === 'now' && 'font-medium',
                )}
              >
                {step.title}
              </span>
              {step.proof ? (
                <span className="block text-[11.5px] text-[var(--color-success)]">{step.proof}</span>
              ) : (
                <span className="block text-[11.5px] text-[var(--color-text-faint)]">
                  {PLAN_STEP_STATE_LABEL[step.state]}
                </span>
              )}
            </span>
            <span className="flex items-center">
              {active ? (
                <span className="text-[11.5px] text-[var(--color-accent)]">{PLAN_COPY.working}</span>
              ) : step.waiting ? (
                <span className="text-[11.5px] text-[var(--color-accent)]">
                  {step.waitingLabel ?? PLAN_COPY.waiting}
                </span>
              ) : step.runnable && onHandle ? (
                <Button
                  type="button"
                  size="xs"
                  variant={step.state === 'now' ? 'default' : 'outline'}
                  disabled={Boolean(busyStepKey)}
                  aria-busy={busyStepKey === step.key || undefined}
                  onClick={() => onHandle(step.key)}
                >
                  {PLAN_COPY.handleIt}
                </Button>
              ) : null}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * The plan as one strip of steps under the title: a bar on top of each step
 * shows done, now, and next. A plan is a real sequence, so the steps keep
 * their numbers. The step that waits for the user carries the blank voice.
 */
export function PlanStrip({
  steps,
  activeStepKey,
  busyStepKey,
  onHandle,
}: {
  steps: readonly PlanStepRow[];
  activeStepKey?: string | null;
  busyStepKey?: string | null;
  onHandle?: (stepKey: string) => void;
}) {
  return (
    <ol
      data-slot="plan-steps"
      className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-x-3 gap-y-4"
    >
      {steps.map((step) => {
        const active = step.key === activeStepKey;
        return (
          <li
            key={step.key}
            data-plan-step={step.state}
            className={cn(
              'flex min-w-0 flex-col gap-1 border-t-[3px] pt-2',
              step.state === 'done'
                ? 'border-[var(--color-text-faint)]'
                : step.state === 'now'
                  ? step.waiting
                    ? 'border-[var(--color-accent-3)]'
                    : 'border-[var(--color-accent)]'
                  : 'border-[var(--color-border)]',
            )}
          >
            <span
              className={cn(
                'font-display text-[15px] leading-none tabular-nums',
                step.state === 'now'
                  ? step.waiting
                    ? 'text-[var(--color-accent-3)]'
                    : 'text-[var(--color-accent)]'
                  : 'text-[var(--color-text-faint)]',
              )}
            >
              {step.index + 1}
            </span>
            <span
              className={cn(
                'text-[12.5px] leading-snug',
                step.state === 'done'
                  ? 'text-[var(--color-text-faint)]'
                  : step.state === 'now'
                    ? 'text-[var(--color-text)]'
                    : 'text-[var(--color-text-muted)]',
              )}
            >
              {step.title}
            </span>
            {step.proof ? (
              <span className="text-[11.5px] text-[var(--color-success)]">{step.proof}</span>
            ) : active ? (
              <span className="text-[11.5px] text-[var(--color-accent)]">{PLAN_COPY.working}</span>
            ) : step.waiting ? (
              <span className="text-[11.5px] text-[var(--color-accent-3)]">
                {step.waitingLabel ?? PLAN_COPY.waiting}
              </span>
            ) : step.runnable && onHandle ? (
              <Button
                type="button"
                size="xs"
                className="mt-0.5 w-fit"
                variant={step.state === 'now' ? 'default' : 'outline'}
                disabled={Boolean(busyStepKey)}
                aria-busy={busyStepKey === step.key || undefined}
                onClick={() => onHandle(step.key)}
              >
                {PLAN_COPY.handleIt}
              </Button>
            ) : (
              <span className="text-[11.5px] text-[var(--color-text-faint)]">
                {PLAN_STEP_STATE_LABEL[step.state]}
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/** The top of every thread: the outcome as the page title, and the plan strip under it. */
export function PlanIntro({
  outcome,
  summary,
  steps,
  state,
  activeStepKey,
  busyStepKey,
  onHandle,
}: {
  outcome: string;
  summary?: string | null;
  steps: readonly PlanStepRow[];
  state: ThreadState;
  activeStepKey?: string | null;
  busyStepKey?: string | null;
  onHandle?: (stepKey: string) => void;
}) {
  return (
    <section
      data-slot="plan-intro"
      data-thread-state={state}
      aria-label={PLAN_COPY.heading}
      className="flex w-full min-w-0 flex-col gap-4 pb-2 pt-2"
    >
      <div className="min-w-0">
        <p className="font-display text-[28px] font-normal leading-[1.15] tracking-[-0.015em] text-balance">
          {outcome}
        </p>
        {summary ? (
          <p className="mt-2 max-w-[68ch] text-[13.5px] leading-relaxed text-[var(--color-text-muted)]">
            {summary}
          </p>
        ) : null}
      </div>
      {state === 'planning' ? (
        <p className="text-[12.5px]" aria-live="polite">
          <ShimmerText text={PLAN_COPY.making} duration={1.6} startOnView={false} />
        </p>
      ) : steps.length ? (
        <PlanStrip
          steps={steps}
          activeStepKey={activeStepKey}
          busyStepKey={busyStepKey}
          onHandle={onHandle}
        />
      ) : (
        <p className="text-[12.5px] text-[var(--color-text-muted)]">{PLAN_COPY.noSteps}</p>
      )}
    </section>
  );
}

/** The closing line of a done or released Albatross, below the timeline. */
export function PlanOutro({ state }: { state: ThreadState }) {
  if (state !== 'done' && state !== 'released') return null;
  return (
    <p data-slot="plan-outro" className="px-1 py-1 text-[12.5px] text-[var(--color-text-muted)]">
      {state === 'done' ? PLAN_COPY.done : PLAN_COPY.released}
    </p>
  );
}

/** The header pill: "Step 1 of 2" and the state word. Opens the Details panel at Plan. */
export function PlanLine({
  text,
  state,
  onClick,
  active,
}: {
  text: string;
  state: ThreadState;
  onClick?: () => void;
  active?: boolean;
}) {
  const [step, word] = text.includes(' · ') ? text.split(' · ') : [null, text];
  return (
    <button
      type="button"
      data-slot="plan-line"
      data-thread-state={state}
      aria-label={`Plan, ${text.toLowerCase()}`}
      aria-pressed={active || undefined}
      onClick={onClick}
      className={cn(
        'inline-flex h-[26px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-ui border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-2.5 text-[12px] transition-colors hover:border-[var(--color-border-strong)]',
        active && 'bg-[var(--color-control-hover)]',
      )}
    >
      {step ? <span className="tabular-nums">{step}</span> : null}
      <span
        className={cn(
          'font-medium',
          state === 'running'
            ? 'text-[var(--color-accent)]'
            : state === 'done'
              ? 'text-[var(--color-success)]'
              : state === 'planning' || state === 'released'
                ? 'text-[var(--color-text-muted)]'
                : 'text-[var(--color-accent-3)]',
        )}
      >
        {word}
      </span>
    </button>
  );
}
