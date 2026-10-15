'use client';

// The Details panel of the Albatross thread (lead review decision 16): the
// plan with its proof, the files with Undo, the proof timeline, the
// commitments, the sources, and the plan document collapsed under "Read the
// plan". The shape body (a list, a practice, milestones) sits at the top when
// the Work has one.

import { type ReactNode, useState } from 'react';
import { OutcomeContractCard, ProofTimeline } from '@/components/albatross/Proof';
import { BriefCanvas } from '@/components/report/brief-canvas/BriefCanvas';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import type { RunSource } from '@/lib/albatross/goal-run-contract';
import {
  checklistCount,
  GOAL_RUN_COPY,
  type PackageBehaviour,
  packageRows,
  runSources,
  type SourceBehaviour,
  sourceChip,
} from '@/lib/albatross/goal-run-view';
import type { ThreadRunView } from '@/lib/albatross/thread-contract';
import type { PlanStepRow } from '@/lib/albatross/thread-view';
import { postJson, type WorkDetailData } from '@/lib/albatross/work-view';
import { cn } from '@/lib/utils';
import { PackageRows } from './PackageRows';
import { PlanSteps } from './PlanIntro';
import { ChecklistRows } from './RunChecklist';

export const DETAILS_COPY = {
  title: 'Details',
  plan: 'Plan',
  planNotReady: 'The plan is not ready.',
  files: 'Files',
  filesBlurb: 'Albatross made these in your accounts. Each one can be undone while the provider allows it.',
  noFiles: 'No files yet.',
  proof: 'Proof',
  commitments: 'Commitments',
  sources: 'Sources and assumptions',
  assumptions: 'Assumptions',
  sourcesHeading: 'Sources',
  readPlan: 'Read the plan',
  planGuess:
    "This is Albatross's best guess at the way through. Tell it if the plan is wrong and it will find another one.",
  undo: 'Undo',
  undoing: 'Undoing…',
  undone: 'undone',
  close: 'Close',
} as const;

export interface DetailsArtifact {
  kind: string;
  id: string;
  title?: string;
  operationId?: string;
}

/** The goal-run sections of the panel: the newest run's checklist, package, and sources. */
export interface DetailsGoal {
  /** The newest goal run, for the checklist and the sources. */
  run: ThreadRunView | null;
  /** The newest handoff with a package, for the package rows. */
  packageRun: ThreadRunView | null;
  sentDrafts?: Readonly<Record<string, string>>;
  onOpenItem?: (run: ThreadRunView, behaviour: PackageBehaviour) => void;
  onOpenSource?: (behaviour: SourceBehaviour, source: RunSource, run: ThreadRunView) => void;
}

export function DetailsPanel({
  detail,
  steps,
  activeStepKey,
  busyStepKey,
  onHandle,
  shapeBody,
  shapePicker,
  undoneOperations,
  undoing,
  onUndo,
  onError,
  onClose,
  goal,
  className,
}: {
  detail: WorkDetailData;
  steps: readonly PlanStepRow[];
  activeStepKey?: string | null;
  busyStepKey?: string | null;
  onHandle?: (stepKey: string) => void;
  /** The list, practice, or milestones body for a shaped Work. */
  shapeBody?: ReactNode;
  shapePicker?: ReactNode;
  undoneOperations: ReadonlySet<string>;
  undoing: string | null;
  onUndo: (operationId: string) => void;
  onError: (message: string) => void;
  /** The sheet on a narrow screen offers Close. */
  onClose?: () => void;
  /** A goal Work: Checklist, Package, and Sources replace the Plan section. */
  goal?: DetailsGoal | null;
  className?: string;
}) {
  const { plan } = detail;
  const document = plan?.artifactSource === 'document-v2' ? plan.document : undefined;
  const legacyPlan = Boolean(plan && !document && plan.artifactHtml);
  const artifacts = detail.application?.artifacts ?? [];
  const checklist = goal ? (goal.run?.checklist ?? detail.checklist ?? []) : [];
  const sources = goal?.run ? runSources(goal.run) : [];
  const rows = goal?.packageRun ? packageRows(goal.packageRun, { sent: goal.sentDrafts }) : [];
  return (
    <aside
      data-slot="details-panel"
      aria-label={DETAILS_COPY.title}
      className={cn('flex h-full min-h-0 min-w-0 flex-col bg-[var(--color-bg)]', className)}
    >
      <div className="flex h-11 shrink-0 items-center gap-3 border-b border-[var(--color-border)] px-4">
        <span className="text-[12.5px] font-medium">{DETAILS_COPY.title}</span>
        <span className="min-w-0 flex-1">{shapePicker}</span>
        {onClose ? (
          <Button type="button" size="xs" variant="ghost" onClick={onClose}>
            {DETAILS_COPY.close}
          </Button>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-8">
        {shapeBody ? <section className="py-4">{shapeBody}</section> : null}

        {goal ? (
          <>
            <Section
              title={GOAL_RUN_COPY.detailsChecklist}
              count={checklist.length ? checklistCount(checklist).text : undefined}
            >
              {checklist.length ? (
                <ChecklistRows items={checklist} />
              ) : (
                <p className="text-[12.5px] text-[var(--color-text-muted)]">{GOAL_RUN_COPY.noChecklist}</p>
              )}
            </Section>
            <Section
              title={GOAL_RUN_COPY.detailsPackage}
              count={rows.length ? String(rows.length) : undefined}
            >
              {rows.length && goal.packageRun ? (
                <PackageRows
                  rows={rows}
                  onOpen={
                    goal.onOpenItem
                      ? (behaviour) => goal.onOpenItem?.(goal.packageRun!, behaviour)
                      : undefined
                  }
                />
              ) : (
                <p className="text-[12.5px] text-[var(--color-text-muted)]">{GOAL_RUN_COPY.noPackage}</p>
              )}
            </Section>
            <Section
              title={GOAL_RUN_COPY.detailsSources}
              count={sources.length ? String(sources.length) : undefined}
            >
              {sources.length && goal.run ? (
                <SourceList run={goal.run} sources={sources} onOpen={goal.onOpenSource} />
              ) : (
                <p className="text-[12.5px] text-[var(--color-text-muted)]">{GOAL_RUN_COPY.noSources}</p>
              )}
            </Section>
          </>
        ) : (
          <Section title={DETAILS_COPY.plan}>
            {steps.length ? (
              <PlanSteps
                steps={steps}
                activeStepKey={activeStepKey}
                busyStepKey={busyStepKey}
                onHandle={onHandle}
                dense
              />
            ) : (
              <p className="text-[12.5px] text-[var(--color-text-muted)]">{DETAILS_COPY.planNotReady}</p>
            )}
          </Section>
        )}

        <Section title={DETAILS_COPY.files} blurb={artifacts.length ? DETAILS_COPY.filesBlurb : undefined}>
          {artifacts.length ? (
            <ul className="divide-y divide-[var(--color-list-divider)]">
              {artifacts.map((artifact) => {
                const undone = Boolean(artifact.operationId && undoneOperations.has(artifact.operationId));
                return (
                  <li
                    key={`${artifact.kind}:${artifact.id}`}
                    className={cn('flex items-center gap-3 py-2', undone && 'opacity-55')}
                  >
                    <span className={cn('min-w-0 flex-1 truncate text-[13px]', undone && 'line-through')}>
                      {artifact.title || artifact.id}
                    </span>
                    <span className="text-[10.5px] text-[var(--color-text-faint)]">
                      {undone ? DETAILS_COPY.undone : artifact.kind.replaceAll('_', ' ')}
                    </span>
                    {artifact.operationId && !undone ? (
                      <Button
                        type="button"
                        size="xs"
                        variant="ghost"
                        disabled={Boolean(undoing)}
                        onClick={() => onUndo(artifact.operationId!)}
                      >
                        {undoing === artifact.operationId ? DETAILS_COPY.undoing : DETAILS_COPY.undo}
                      </Button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-[12.5px] text-[var(--color-text-muted)]">{DETAILS_COPY.noFiles}</p>
          )}
        </Section>

        {detail.evidence?.length ? (
          <Section>
            <ProofTimeline evidence={detail.evidence} contract={detail.contract} />
          </Section>
        ) : null}

        {detail.contract ? (
          <Section title={DETAILS_COPY.commitments}>
            <OutcomeContractCard contract={detail.contract} evidence={detail.evidence || []} />
          </Section>
        ) : null}

        {plan?.assumptions?.length || plan?.sourceRefs?.length ? (
          <Section title={DETAILS_COPY.sources} collapsible>
            <div className="text-[12px] text-[var(--color-text-muted)]">
              {plan.assumptions?.length ? (
                <div>
                  <h3 className="font-medium text-[var(--color-text)]">{DETAILS_COPY.assumptions}</h3>
                  <ul className="mt-1 list-disc space-y-1 pl-4">
                    {plan.assumptions.map((assumption) => (
                      <li key={assumption}>{assumption}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {plan.sourceRefs?.length ? (
                <div className="mt-3">
                  <h3 className="font-medium text-[var(--color-text)]">{DETAILS_COPY.sourcesHeading}</h3>
                  <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
                    {plan.sourceRefs.map((source) => (
                      <span key={`${source.kind}:${source.id}`}>
                        {source.label || `${source.kind} ${source.id}`}
                      </span>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          </Section>
        ) : null}

        {document && !goal ? (
          <Section title={DETAILS_COPY.readPlan} collapsible>
            <BriefCanvas value={document} embedded />
            <p className="mt-4 text-[11.5px] text-[var(--color-text-faint)]">{DETAILS_COPY.planGuess}</p>
          </Section>
        ) : legacyPlan ? (
          <Section>
            <LegacyPlanNotice workId={detail.work._id} onError={onError} />
          </Section>
        ) : null}
      </div>
    </aside>
  );
}

/** Every source of the newest goal run, once, numbered: the title and its locator. */
function SourceList({
  run,
  sources,
  onOpen,
}: {
  run: ThreadRunView;
  sources: readonly RunSource[];
  onOpen?: DetailsGoal['onOpenSource'];
}) {
  return (
    <ol data-slot="details-sources" className="flex flex-col">
      {sources.map((source, index) => {
        const chip = sourceChip(source);
        const body = (
          <>
            <span className="w-[18px] shrink-0 pt-[2px] text-[11px] tabular-nums text-[var(--color-text-faint)]">
              {index + 1}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[12.5px]">{source.title}</span>
              {chip.locator ? (
                <span className="block text-[11px] text-[var(--color-text-faint)]">{chip.locator}</span>
              ) : null}
            </span>
          </>
        );
        const behaviour = chip.behaviour;
        return (
          <li key={chip.key} className="border-t border-[var(--color-list-divider)] first:border-t-0">
            {behaviour && onOpen ? (
              <button
                type="button"
                title={chip.title}
                onClick={() => onOpen(behaviour, source, run)}
                className="flex w-full items-start gap-2 py-1.5 text-left hover:text-[var(--color-accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
              >
                {body}
              </button>
            ) : (
              <div className="flex items-start gap-2 py-1.5">{body}</div>
            )}
          </li>
        );
      })}
    </ol>
  );
}

function Section({
  title,
  blurb,
  count,
  collapsible = false,
  children,
}: {
  title?: string;
  blurb?: string;
  /** A quiet count after the title: "6 of 7", "4". */
  count?: string;
  collapsible?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  if (collapsible && title) {
    return (
      <Collapsible
        open={open}
        onOpenChange={setOpen}
        className="border-t border-[var(--color-border)] py-3.5 first:border-t-0"
      >
        <CollapsibleTrigger className="group flex w-full items-center justify-between text-left text-[13px] font-semibold">
          <span>{title}</span>
          <span
            aria-hidden
            className="inline-block size-[7px] rotate-[-45deg] border-r border-b border-current text-[var(--color-text-faint)] transition-transform group-data-[state=open]:rotate-45"
          />
        </CollapsibleTrigger>
        <CollapsibleContent className="pt-3">{children}</CollapsibleContent>
      </Collapsible>
    );
  }
  return (
    <section className="border-t border-[var(--color-border)] py-3.5 first:border-t-0">
      {title ? (
        <h2 className="flex items-baseline gap-2 text-[13px] font-semibold">
          <span>{title}</span>
          {count ? (
            <span className="text-[11.5px] font-normal tabular-nums text-[var(--color-text-faint)]">
              {count}
            </span>
          ) : null}
        </h2>
      ) : null}
      {blurb ? <p className="mt-0.5 text-[11.5px] text-[var(--color-text-faint)]">{blurb}</p> : null}
      <div className={cn(title ? 'mt-2' : '')}>{children}</div>
    </section>
  );
}

/**
 * A plan from before the live page. Its HTML dossier no longer renders; one
 * regeneration turns it into the native document.
 */
export function LegacyPlanNotice({
  workId,
  onError,
}: {
  workId: string;
  onError: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="rounded-ui border border-[var(--color-border)] bg-[var(--color-bg-subtle)] p-4">
      <p className="text-[13px]">This plan predates the live page.</p>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="mt-3"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await postJson(
              '/api/albatross/plan',
              { intentId: workId, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone },
              'Could not rebuild the plan.',
            );
          } catch (cause) {
            onError(cause instanceof Error ? cause.message : 'Could not rebuild the plan.');
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? 'Rebuilding…' : 'Rebuild the plan'}
      </Button>
    </div>
  );
}
