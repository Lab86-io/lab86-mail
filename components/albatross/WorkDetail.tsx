'use client';

import { useConvexAuth, useQuery } from 'convex/react';
import { ArrowLeft, CheckCircle2, CircleAlert, LoaderCircle, MessageCircle, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { api } from '@/convex/_generated/api';
import type { Id } from '@/convex/_generated/dataModel';
import { isBriefArtifactReadyMessage } from '@/lib/albatross/artifact-ready';
import { injectPlanArtifactRuntime } from '@/lib/albatross/plan-artifact-runtime';
import { callTool } from '@/lib/api-client';
import { useClientStore } from '@/lib/client-state';
import { postBriefTheme } from '@/lib/theme/brief-theme';
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
    assumptions?: string[];
    sourceRefs?: Array<{ kind: string; id: string; label?: string; url?: string }>;
    digitalActions?: Array<{ actionKey?: string; key?: string; kind: string; title: string }>;
    physicalActions?: Array<{ title: string; detail?: string; url?: string }>;
    appliedSteps?: Array<{ stepKey: string; kind: string }>;
  };
  project: null | { _id: string; title: string; outcome?: string; status: string; activeSprintId?: string };
  questions: WorkQuestion[];
  areaLinks: Array<{ areaId: string; role: string; status: string; reason?: string }>;
  application: null | {
    _id: string;
    status: string;
    operationIds: string[];
    artifacts: Array<{ kind: string; id: string; title?: string; operationId?: string }>;
  };
}

function stateLabel(work: WorkDetailData['work']) {
  if (work.agentState === 'needs_input') return 'Needs you';
  if (work.agentState === 'researching') return 'Researching';
  if (work.agentState === 'applying') return 'Creating';
  if (work.agentState === 'error') return 'Needs attention';
  if (work.workState === 'done') return 'Done';
  return work.workState || work.status;
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
  const projectTasks = useQuery(
    api.albatrossWork.projectTasks,
    isAuthenticated && detail?.project
      ? { projectId: detail.project._id as Id<'albatrossProjects'> }
      : 'skip',
  ) as Array<{ cardId: string; title: string; completedAt?: number }> | undefined;
  const [advancing, setAdvancing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [undoing, setUndoing] = useState<string | null>(null);
  const artifactFrameRef = useRef<HTMLIFrameElement>(null);
  const [artifactReady, setArtifactReady] = useState(false);
  const appFont = useClientStore((state) => state.appFont);
  const accentHue = useClientStore((state) => state.accentHue);
  const accentChroma = useClientStore((state) => state.accentChroma);
  const accent2Hue = useClientStore((state) => state.accent2Hue);
  const accent2Chroma = useClientStore((state) => state.accent2Chroma);
  const bgHue = useClientStore((state) => state.bgHue);
  const surfaceTint = useClientStore((state) => state.surfaceTint);

  const artifact = useMemo(
    () => (detail?.plan?.artifactHtml ? injectPlanArtifactRuntime(detail.plan.artifactHtml) : null),
    [detail?.plan?.artifactHtml],
  );
  const postTheme = useCallback(() => {
    postBriefTheme(artifactFrameRef.current?.contentWindow, appFont);
  }, [appFont]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new artifact must restart its own readiness handshake.
  useEffect(() => setArtifactReady(false), [detail?.plan?.artifactHtml]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: resolved CSS is read by postBriefTheme; customization slices intentionally retrigger it.
  useEffect(() => {
    postTheme();
  }, [postTheme, accentHue, accentChroma, accent2Hue, accent2Chroma, bgHue, surfaceTint]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new artifact must restart its readiness fallback.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (
        artifactFrameRef.current &&
        event.source === artifactFrameRef.current.contentWindow &&
        isBriefArtifactReadyMessage(event.data)
      ) {
        setArtifactReady(true);
      }
    };
    window.addEventListener('message', onMessage);
    const fallback = window.setTimeout(() => setArtifactReady(true), 2_500);
    return () => {
      window.removeEventListener('message', onMessage);
      window.clearTimeout(fallback);
    };
  }, [detail?.plan?.artifactHtml]);

  useEffect(() => {
    if (detail?.work.primaryAreaId) setSelectedAreaId(String(detail.work.primaryAreaId));
  }, [detail?.work.primaryAreaId, setSelectedAreaId]);

  const advance = async () => {
    setAdvancing(true);
    setError(null);
    try {
      const response = await fetch(`/api/albatross/work/${encodeURIComponent(workId)}/advance`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Could not continue this Work.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not continue this Work.');
    } finally {
      setAdvancing(false);
    }
  };

  if (detail === undefined) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-[12.5px] text-[var(--color-text-muted)]">
        <LoaderCircle className="size-4 animate-spin" /> Loading Work…
      </div>
    );
  }
  if (!detail) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center">
        <div>
          <p className="text-[14px] font-medium">This Work is no longer available.</p>
          <Button className="mt-4" size="sm" variant="outline" onClick={() => setSelectedWorkId(null)}>
            Back to Area
          </Button>
        </div>
      </div>
    );
  }

  const { work, plan, project } = detail;
  const pendingQuestion = detail.questions.find((question) => question.status === 'pending');
  const completedTasks = projectTasks?.filter((task) => task.completedAt).length ?? 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-2 border-b border-[var(--color-border)] px-4 py-3">
        <Button type="button" size="xs" variant="ghost" onClick={() => setSelectedWorkId(null)}>
          <ArrowLeft className="size-3.5" /> Back to Area
        </Button>
        <span className="text-[11px] text-[var(--color-text-faint)]">/</span>
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">Work</span>
        <Badge variant="outline" className="capitalize">
          {stateLabel(work)}
        </Badge>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-14 pt-6">
        <div className="mx-auto max-w-4xl">
          <div className="flex flex-wrap items-start justify-between gap-4 border-b border-[var(--color-border)] pb-6">
            <div className="min-w-0 max-w-2xl">
              <p className="font-serif text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-text-faint)]">
                Desired outcome
              </p>
              <h1 className="mt-2 font-serif text-[clamp(25px,4vw,38px)] font-semibold leading-[1.08] tracking-tight">
                {plan?.outcome || work.title || work.rawText}
              </h1>
              {plan?.summary ? (
                <p className="mt-3 max-w-2xl text-[13.5px] leading-relaxed text-[var(--color-text-muted)]">
                  {plan.summary}
                </p>
              ) : null}
            </div>
            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  setChatScope({ kind: 'work', workId });
                  setAiBarOpen(true);
                }}
              >
                <MessageCircle className="size-3.5" /> Discuss
              </Button>
              <Button type="button" size="sm" disabled={advancing} onClick={() => void advance()}>
                <RefreshCw className={cn('size-3.5', advancing && 'animate-spin')} />
                {advancing ? 'Working…' : 'Continue'}
              </Button>
            </div>
          </div>

          {pendingQuestion ? <WorkQuestionCard question={pendingQuestion} /> : null}

          {project ? (
            <section className="border-b border-[var(--color-border)] py-5">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-[10.5px] font-medium uppercase tracking-[0.14em] text-[var(--color-text-faint)]">
                    Project / Epic
                  </p>
                  <h2 className="mt-1.5 font-serif text-[19px] font-semibold">{project.title}</h2>
                  {project.outcome ? (
                    <p className="mt-1 text-[12.5px] text-[var(--color-text-muted)]">{project.outcome}</p>
                  ) : null}
                </div>
                <span className="text-[11.5px] capitalize text-[var(--color-text-muted)]">
                  {project.status}
                </span>
              </div>
              {projectTasks ? (
                <div className="mt-3">
                  <div className="flex justify-between text-[11px] text-[var(--color-text-faint)]">
                    <span>
                      {completedTasks} of {projectTasks.length} tasks complete
                    </span>
                    <span>
                      {projectTasks.length ? Math.round((completedTasks / projectTasks.length) * 100) : 0}%
                    </span>
                  </div>
                  <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-[var(--color-bg-muted)]">
                    <div
                      className="h-full rounded-full bg-[var(--color-accent)] transition-[width]"
                      style={{
                        width: `${projectTasks.length ? (completedTasks / projectTasks.length) * 100 : 0}%`,
                      }}
                    />
                  </div>
                </div>
              ) : null}
            </section>
          ) : null}

          {plan?.digitalActions?.length || plan?.physicalActions?.length ? (
            <section className="border-b border-[var(--color-border)] py-5">
              <h2 className="text-[12px] font-semibold uppercase tracking-[0.12em] text-[var(--color-text-muted)]">
                What Albatross created
              </h2>
              <div className="mt-2 divide-y divide-[var(--color-border)]/60">
                {(plan.digitalActions || []).map((action) => {
                  const done = plan.appliedSteps?.some((step) => step.stepKey === action.key);
                  return (
                    <div
                      key={action.actionKey || action.key || action.title}
                      className="flex items-center gap-3 py-2.5"
                    >
                      {done ? (
                        <CheckCircle2 className="size-4 shrink-0 text-[var(--color-success)]" />
                      ) : (
                        <span className="size-4 shrink-0 rounded-full border border-[var(--color-border-strong)]" />
                      )}
                      <span className="min-w-0 flex-1 text-[13px]">{action.title}</span>
                      <span className="text-[10.5px] capitalize text-[var(--color-text-faint)]">
                        {action.kind.replaceAll('_', ' ')}
                      </span>
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

          {detail.application?.operationIds.length ? (
            <section className="border-b border-[var(--color-border)] py-5">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h2 className="text-[12px] font-semibold uppercase tracking-[0.12em] text-[var(--color-text-muted)]">
                    Recent changes
                  </h2>
                  <p className="mt-1 text-[11.5px] text-[var(--color-text-faint)]">
                    Private changes were created automatically. Undo is available while the underlying
                    provider allows it.
                  </p>
                </div>
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  disabled={Boolean(undoing)}
                  onClick={async () => {
                    const operationId = detail.application!.operationIds.at(-1)!;
                    setUndoing(operationId);
                    setError(null);
                    try {
                      await callTool('undo_operation', { operationId });
                    } catch (cause) {
                      setError(
                        cause instanceof Error ? cause.message : 'This change can no longer be undone.',
                      );
                    } finally {
                      setUndoing(null);
                    }
                  }}
                >
                  {undoing ? 'Undoing…' : 'Undo latest'}
                </Button>
              </div>
            </section>
          ) : null}

          {artifact ? (
            <section className="py-5">
              <h2 className="mb-3 text-[12px] font-semibold uppercase tracking-[0.12em] text-[var(--color-text-muted)]">
                Brief
              </h2>
              <iframe
                ref={artifactFrameRef}
                title={`Brief for ${work.title || 'Work'}`}
                srcDoc={artifact}
                sandbox="allow-scripts allow-popups"
                onLoad={postTheme}
                aria-busy={!artifactReady}
                className={cn(
                  'min-h-[680px] w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)]',
                  artifactReady ? 'opacity-100' : 'opacity-0',
                )}
              />
            </section>
          ) : null}

          {plan?.assumptions?.length || plan?.sourceRefs?.length ? (
            <section className="border-t border-[var(--color-border)] py-5 text-[12px] text-[var(--color-text-muted)]">
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

          {error || work.planError ? (
            <div className="mt-4 flex gap-2 rounded-lg border border-[var(--color-danger)]/25 bg-[var(--color-danger-soft)] p-3 text-[12px] text-[var(--color-danger)]">
              <CircleAlert className="mt-0.5 size-4 shrink-0" /> {error || work.planError}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function WorkQuestionCard({ question }: { question: WorkQuestion }) {
  const [answer, setAnswer] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const option = question.options?.find((item) => item.id === selected);
    const value = answer.trim() || option?.label || '';
    if (!value || busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/albatross/work/questions/${encodeURIComponent(question._id)}/answer`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            answer: value,
            answeredOptionId: selected || undefined,
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          }),
        },
      );
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Could not save that answer.');
      setAnswer('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save that answer.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="my-5 rounded-xl border border-[var(--color-warning)]/30 bg-[var(--color-warning-soft)] p-4">
      <p className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-[var(--color-warning)]">
        Albatross needs one thing
      </p>
      <h2 className="mt-1.5 text-[15px] font-medium leading-snug">{question.prompt}</h2>
      {question.reason ? (
        <p className="mt-1 text-[11.5px] text-[var(--color-text-muted)]">{question.reason}</p>
      ) : null}
      {question.options?.length ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {question.options.map((option) => (
            <button
              key={option.id}
              type="button"
              aria-pressed={selected === option.id}
              onClick={() => setSelected(option.id)}
              className={cn(
                'rounded-lg border px-3 py-2 text-left text-[12px] transition-colors',
                selected === option.id
                  ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-accent)]'
                  : 'border-[var(--color-border)] bg-[var(--color-bg-elevated)] hover:border-[var(--color-border-strong)]',
              )}
            >
              <span className="block font-medium">{option.label}</span>
              {option.description ? (
                <span className="mt-0.5 block text-[11px] text-[var(--color-text-muted)]">
                  {option.description}
                </span>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}
      <div className="mt-3 flex gap-2">
        <input
          value={answer}
          onChange={(event) => setAnswer(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void submit();
          }}
          aria-label="Answer in your own words"
          placeholder="Or answer in your own words"
          className="min-w-0 flex-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-3 py-2 text-[12.5px] outline-none focus:border-[var(--color-accent)]"
        />
        <Button size="sm" disabled={busy || (!answer.trim() && !selected)} onClick={() => void submit()}>
          {busy ? 'Saving…' : 'Answer'}
        </Button>
      </div>
      {error ? <p className="mt-2 text-[11.5px] text-[var(--color-danger)]">{error}</p> : null}
    </section>
  );
}
