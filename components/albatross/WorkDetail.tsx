'use client';

import { useConvexAuth, useQuery } from 'convex/react';
import { useEffect, useState } from 'react';
import { ReleaseSheet } from '@/components/albatross/Forgiveness';
import { GuidedStepPane } from '@/components/albatross/GuidedStep';
import { OutcomeContractCard, ProofTimeline } from '@/components/albatross/Proof';
import { OutcomeHeader } from '@/components/albatross/primitives';
import { BriefCanvas } from '@/components/report/brief-canvas/BriefCanvas';
import { Button } from '@/components/ui/button';
import { api } from '@/convex/_generated/api';
import type { Id } from '@/convex/_generated/dataModel';
import type { OutcomeContract } from '@/lib/albatross/contract';
import type { EvidenceLike } from '@/lib/albatross/proof';
import { workStateKey } from '@/lib/albatross/work-state';
import { callTool } from '@/lib/api-client';
import { useClientStore } from '@/lib/client-state';
import type { BriefDocumentV2 } from '@/lib/shared/brief-document';
import { cn } from '@/lib/utils';

interface WorkQuestion {
  _id: string;
  status: string;
  prompt: string;
  reason?: string;
  options?: Array<{ id: string; label: string; description?: string }>;
}

interface WorkDetailData {
  work: {
    _id: string;
    title?: string;
    rawText: string;
    status: string;
    workState?: string;
    agentState?: string;
    planError?: string;
    primaryAreaId?: string;
    primaryProjectId?: string;
    updatedAt: number;
  };
  plan: null | {
    _id: string;
    outcome?: string;
    summary?: string;
    status: string;
    artifactHtml?: string;
    document?: BriefDocumentV2;
    artifactSource?: string;
    assumptions?: string[];
    sourceRefs?: Array<{ kind: string; id: string; label?: string; url?: string }>;
    digitalActions?: Array<{ actionKey?: string; key?: string; kind: string; title: string }>;
    physicalActions?: Array<{ title: string; detail?: string; url?: string }>;
    appliedSteps?: Array<{ stepKey: string; kind: string }>;
  };
  project: null | { _id: string; title: string; outcome?: string; status: string };
  questions: WorkQuestion[];
  areaLinks: Array<{ areaId: string; role: string; status: string; reason?: string }>;
  execution: {
    currentStep: null | {
      key: string;
      kind: string;
      title: string;
      detail: string | null;
      url: string | null;
      done: boolean;
      cardId: string | null;
    };
    guideSteps: Array<{
      key: string;
      kind: string;
      title: string;
      detail: string | null;
      url: string | null;
      done: boolean;
      cardId: string | null;
    }>;
    remainingSteps: number;
    totalSteps: number;
  };
  contract: OutcomeContract | null;
  evidence: EvidenceLike[];
  application: null | {
    _id: string;
    status: string;
    operationIds: string[];
    artifacts: Array<{ kind: string; id: string; title?: string; operationId?: string }>;
  };
}

/**
 * POST json and tolerate a non-json error body — a gateway's HTML error page
 * must surface the caller's fallback message, not a parse failure.
 */
async function postJson(url: string, body: Record<string, unknown>, fallback: string) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const parsed = await response.json().catch(() => null);
  if (!response.ok) throw new Error(parsed?.error || fallback);
  return parsed;
}

export function WorkDetail({ workId }: { workId: string }) {
  const { isAuthenticated } = useConvexAuth();
  const setSelectedWorkId = useClientStore((state) => state.setSelectedWorkId);
  const setSelectedAreaId = useClientStore((state) => state.setSelectedAreaId);
  const setAiBarOpen = useClientStore((state) => state.setAiBarOpen);
  const setChatScope = useClientStore((state) => state.setChatScope);
  const detail = useQuery(
    api.albatrossWorkV2.workDetail,
    isAuthenticated ? { workId: workId as Id<'albatrossIntents'> } : 'skip',
  ) as WorkDetailData | null | undefined;
  const [advancing, setAdvancing] = useState(false);
  const [releasing, setReleasing] = useState(false);
  const [completing, setCompleting] = useState(false);
  const [guided, setGuided] = useState(false);
  const [activeGuideId, setActiveGuideId] = useState<string>();
  const [completingStep, setCompletingStep] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [undoing, setUndoing] = useState<string | null>(null);
  // The stored application keeps its artifacts after an undo; the ledger must
  // not keep offering Undo for a change that is already gone.
  const [undoneOperations, setUndoneOperations] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    if (detail?.work.primaryAreaId) setSelectedAreaId(String(detail.work.primaryAreaId));
  }, [detail?.work.primaryAreaId, setSelectedAreaId]);

  const advance = async () => {
    setAdvancing(true);
    setError(null);
    try {
      await postJson(
        `/api/albatross/work/${encodeURIComponent(workId)}/advance`,
        { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone },
        'Could not continue this Albatross.',
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not continue this Albatross.');
    } finally {
      setAdvancing(false);
    }
  };

  const setWorkState = async (state: 'done' | 'active') => {
    setCompleting(true);
    setError(null);
    try {
      await postJson(
        `/api/albatross/work/${encodeURIComponent(workId)}/state`,
        { state },
        'Could not update this Albatross.',
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not update this Albatross.');
    } finally {
      setCompleting(false);
    }
  };

  const completeGuidedStep = async (stepKey: string) => {
    setCompletingStep(true);
    setError(null);
    try {
      await postJson(
        `/api/albatross/work/${encodeURIComponent(workId)}/step`,
        { stepKey, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone },
        'Could not complete this step.',
      );
      setActiveGuideId(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not complete this step.');
    } finally {
      setCompletingStep(false);
    }
  };

  if (detail === undefined) {
    return (
      <div className="flex h-full items-center justify-center text-[12.5px] text-[var(--color-text-muted)]">
        Loading this Albatross…
      </div>
    );
  }
  if (!detail) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center">
        <div>
          <p className="text-[14px] font-medium">This Albatross is no longer available.</p>
          <Button className="mt-4" size="sm" variant="outline" onClick={() => setSelectedWorkId(null)}>
            Back to Albatrosses
          </Button>
        </div>
      </div>
    );
  }

  const { work, plan } = detail;
  const pendingQuestions = detail.questions.filter((question) => question.status === 'pending');
  const document = plan?.artifactSource === 'document-v2' ? plan.document : undefined;
  const legacyPlan = Boolean(plan && !document && plan.artifactHtml);
  const open = work.workState !== 'done' && work.workState !== 'released' && work.workState !== 'archived';
  const openAttachedChat = () => {
    setChatScope({
      kind: 'work',
      workId,
      label: plan?.outcome || work.title || work.rawText,
    });
    setAiBarOpen(true);
  };

  if (guided && detail.execution.guideSteps.length) {
    return (
      <GuidedStepPane
        steps={detail.execution.guideSteps.map((step) => ({
          id: step.key,
          title: step.title,
          detail: step.detail,
          url: step.url,
          knows: [],
          needsYou:
            step.kind === 'physical'
              ? ['Complete the real-world part and return here to record it.']
              : step.url
                ? ['Review the page before anything is submitted.']
                : [],
          done: step.done,
        }))}
        activeId={activeGuideId || detail.execution.currentStep?.key}
        onSelect={setActiveGuideId}
        onExit={() => setGuided(false)}
        onComplete={(stepKey) => void completeGuidedStep(stepKey)}
        onDiscuss={openAttachedChat}
        completing={completingStep}
        error={error}
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-2 border-b border-[var(--color-border)] px-4 py-3">
        <Button type="button" size="xs" variant="ghost" onClick={() => setSelectedWorkId(null)}>
          Back
        </Button>
        <span className="text-[11px] text-[var(--color-text-faint)]">/</span>
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">Albatross</span>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-24 pt-6">
        <div className="mx-auto max-w-4xl">
          <OutcomeHeader
            outcome={plan?.outcome || work.title || work.rawText}
            summary={plan?.summary}
            work={{ ...work, openQuestions: pendingQuestions.length }}
            evidence={detail.evidence || []}
            state={workStateKey({ ...work, openQuestions: pendingQuestions.length })}
            actions={
              <>
                <Button type="button" size="sm" variant="outline" onClick={openAttachedChat}>
                  Discuss
                </Button>
                {detail.execution.currentStep ? (
                  <Button type="button" size="sm" onClick={() => setGuided(true)}>
                    Open guided work
                  </Button>
                ) : (
                  <Button type="button" size="sm" disabled={advancing} onClick={() => void advance()}>
                    {advancing ? 'Working…' : 'Continue'}
                  </Button>
                )}
                {open ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => setReleasing((value) => !value)}
                  >
                    Put it down
                  </Button>
                ) : null}
              </>
            }
          />

          {releasing ? (
            <div className="mt-6">
              <ReleaseSheet
                workId={workId}
                title={plan?.outcome || work.title || work.rawText}
                onReleased={() => setReleasing(false)}
                onCancel={() => setReleasing(false)}
              />
            </div>
          ) : null}

          {pendingQuestions.length ? (
            <section className="mt-6 rounded-xl border border-[var(--color-warning)]/30 bg-[var(--color-warning-soft)] p-4">
              <h2 className="text-[13px] font-medium text-[var(--color-text)]">
                {pendingQuestions[0].prompt}
              </h2>
              <p className="mt-1 text-[11.5px] text-[var(--color-text-muted)]">
                Answer in the attached conversation so Albatross can research the answer and rewrite the plan.
              </p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="mt-3"
                aria-label="Answer in chat about this Albatross"
                onClick={openAttachedChat}
              >
                Answer in chat
              </Button>
            </section>
          ) : null}

          {detail.execution.currentStep ? (
            <section className="mt-6 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-4">
              <p className="text-[11.5px] text-[var(--color-text-faint)]">Current step</p>
              <h2 className="mt-1 font-serif text-[18px] font-semibold">
                {detail.execution.currentStep.title}
              </h2>
              {detail.execution.currentStep.detail ? (
                <p className="mt-1 text-[12.5px] leading-relaxed text-[var(--color-text-muted)]">
                  {detail.execution.currentStep.detail}
                </p>
              ) : null}
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-[var(--color-border)]/70 pt-3">
                <span className="text-[12px] text-[var(--color-text-muted)]">
                  {detail.execution.remainingSteps} of {detail.execution.totalSteps} steps remain
                </span>
                <Button type="button" size="sm" onClick={() => setGuided(true)}>
                  Start this step
                </Button>
              </div>
            </section>
          ) : null}

          {document ? (
            // The page is the plan. The document flows in the page scroll —
            // no frame, no fixed height, no second scrollbar.
            <section className="mt-6">
              <BriefCanvas value={document} embedded />
              <p className="mt-4 text-[11.5px] text-[var(--color-text-faint)]">
                This is Albatross&apos;s best guess at the way through. Tell it if the plan is wrong and it
                will find another one.
              </p>
            </section>
          ) : legacyPlan ? (
            <LegacyPlanNotice workId={workId} onError={setError} />
          ) : null}

          {!document && plan?.digitalActions?.length ? (
            <section className="border-b border-[var(--color-border)] py-5">
              <h2 className="text-[13px] font-semibold text-[var(--color-text)]">The proposed steps</h2>
              <div className="mt-2 divide-y divide-[var(--color-border)]/60">
                {(plan.digitalActions || []).map((action) => {
                  const done = detail.execution.guideSteps.some(
                    (step) => step.key === action.key && step.done,
                  );
                  return (
                    <div
                      key={action.actionKey || action.key || action.title}
                      className="flex items-center gap-3 py-2.5"
                    >
                      <span
                        role="img"
                        aria-label={done ? 'Applied' : 'Not applied'}
                        className={cn(
                          'size-4 shrink-0 rounded-full border',
                          done
                            ? 'border-[var(--color-success)] bg-[var(--color-success)]/15'
                            : 'border-[var(--color-border-strong)]',
                        )}
                      />
                      <span className="min-w-0 flex-1 text-[13px]">{action.title}</span>
                    </div>
                  );
                })}
                {(plan.physicalActions || []).map((action) => (
                  <div key={action.title} className="py-2.5">
                    <p className="text-[13px]">{action.title}</p>
                    {action.detail ? (
                      <p className="mt-0.5 text-[11.5px] text-[var(--color-text-muted)]">{action.detail}</p>
                    ) : null}
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          {detail.application?.artifacts.length ? (
            <section className="border-b border-[var(--color-border)] py-5">
              <h2 className="text-[13px] font-semibold text-[var(--color-text)]">What changed</h2>
              <p className="mt-1 text-[11.5px] text-[var(--color-text-faint)]">
                Albatross created these in your accounts. Each one can be undone while the provider allows it.
              </p>
              <div className="mt-2 divide-y divide-[var(--color-border)]/60">
                {detail.application.artifacts.map((artifact) => {
                  const undone = Boolean(artifact.operationId && undoneOperations.has(artifact.operationId));
                  return (
                    <div
                      key={`${artifact.kind}:${artifact.id}`}
                      className={cn('flex items-center gap-3 py-2', undone && 'opacity-55')}
                    >
                      <span className={cn('min-w-0 flex-1 truncate text-[13px]', undone && 'line-through')}>
                        {artifact.title || artifact.id}
                      </span>
                      <span className="text-[10.5px] capitalize text-[var(--color-text-faint)]">
                        {undone ? 'undone' : artifact.kind.replaceAll('_', ' ')}
                      </span>
                      {artifact.operationId && !undone ? (
                        <Button
                          type="button"
                          size="xs"
                          variant="ghost"
                          disabled={Boolean(undoing)}
                          onClick={async () => {
                            setUndoing(artifact.operationId!);
                            setError(null);
                            try {
                              await callTool('undo_operation', { operationId: artifact.operationId });
                              setUndoneOperations(
                                (previous) => new Set([...previous, artifact.operationId!]),
                              );
                            } catch (cause) {
                              setError(
                                cause instanceof Error
                                  ? cause.message
                                  : 'This change can no longer be undone.',
                              );
                            } finally {
                              setUndoing(null);
                            }
                          }}
                        >
                          {undoing === artifact.operationId ? 'Undoing…' : 'Undo'}
                        </Button>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </section>
          ) : null}

          {detail.contract ? (
            <section className="border-b border-[var(--color-border)] py-5">
              <OutcomeContractCard contract={detail.contract} evidence={detail.evidence || []} />
            </section>
          ) : null}

          {detail.evidence?.length ? (
            <section className="border-b border-[var(--color-border)] py-5">
              <ProofTimeline evidence={detail.evidence} contract={detail.contract} />
            </section>
          ) : null}

          {plan?.assumptions?.length || plan?.sourceRefs?.length ? (
            <section className="border-b border-[var(--color-border)] py-5 text-[12px] text-[var(--color-text-muted)]">
              {plan.assumptions?.length ? (
                <div>
                  <h2 className="font-medium text-[var(--color-text)]">Assumptions</h2>
                  <ul className="mt-1 list-disc space-y-1 pl-4">
                    {plan.assumptions.map((assumption) => (
                      <li key={assumption}>{assumption}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {plan.sourceRefs?.length ? (
                <div className="mt-4">
                  <h2 className="font-medium text-[var(--color-text)]">Sources</h2>
                  <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
                    {plan.sourceRefs.map((source) => (
                      <span key={`${source.kind}:${source.id}`}>
                        {source.label || `${source.kind} ${source.id}`}
                      </span>
                    ))}
                  </div>
                </div>
              ) : null}
            </section>
          ) : null}

          {open ? (
            <section className="mt-8 rounded-xl border border-[var(--color-border)] p-4">
              <h2 className="font-serif text-[17px] font-semibold">Is this albatross complete?</h2>
              <p className="mt-1 text-[12px] text-[var(--color-text-muted)]">
                The check closes it and saves the record: the steps you finished and the time it took.
              </p>
              <Button
                type="button"
                size="sm"
                className="mt-3"
                disabled={completing}
                onClick={() => void setWorkState('done')}
              >
                {completing ? 'Saving…' : 'Mark it complete'}
              </Button>
            </section>
          ) : work.workState === 'done' || work.workState === 'released' ? (
            <section className="mt-8 flex items-center justify-between rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-subtle)] p-4">
              <p className="text-[13px]">
                {work.workState === 'done'
                  ? 'Finished. This one is off your list.'
                  : 'You put this down. That is one less thing.'}
              </p>
              <Button
                type="button"
                size="xs"
                variant="ghost"
                disabled={completing}
                onClick={() => void setWorkState('active')}
              >
                {work.workState === 'done' ? 'Reopen' : 'Pick it back up'}
              </Button>
            </section>
          ) : null}

          {error || work.planError ? (
            <div className="mt-4 rounded-lg border border-[var(--color-danger)]/25 bg-[var(--color-danger-soft)] p-3 text-[12px] text-[var(--color-danger)]">
              {error || work.planError}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * A plan from before the live page. Its HTML dossier no longer renders; one
 * regeneration turns it into the native document.
 */
function LegacyPlanNotice({ workId, onError }: { workId: string; onError: (message: string) => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <section className="mt-6 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-subtle)] p-4">
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
    </section>
  );
}
