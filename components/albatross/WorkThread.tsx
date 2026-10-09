'use client';

// The Albatross thread: one Albatross is one conversation (docs/albatross-thread.md,
// docs/research/albatross-thread-web-design-2026-10-07.md). The header carries
// the plan line and the Page, Details, and More controls; the conversation
// column is the shared chat with the runs merged in by time; the right region
// is the page pane or the details panel, never both. `WorkThreadView` renders
// from a model so the dev harness and the tests mount it without a backend.

import { useReverification } from '@clerk/nextjs';
import { useQueryClient } from '@tanstack/react-query';
import type { ChatTransport, UIMessage } from 'ai';
import { useConvexAuth, useQuery } from 'convex/react';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Group, Panel, Separator, useDefaultLayout } from 'react-resizable-panels';
import { usePersonalDetails } from '@/components/ai-elements/use-personal-details';
import {
  answerSecureAllow,
  createSecureItem,
  isIdentityCheckCancelled,
  SECURE_DETAILS_QUERY_KEY,
  SecureApiError,
  useSecureDetails,
} from '@/components/ai-elements/use-secure-details';
import { LapsePrompt, ReleaseSheet } from '@/components/albatross/Forgiveness';
import { HorizonControl } from '@/components/albatross/HorizonControl';
import { SplitSheet } from '@/components/albatross/SplitSheet';
import { ListBody } from '@/components/albatross/shapes/ListBody';
import { PracticeBody } from '@/components/albatross/shapes/PracticeBody';
import { ProjectBody } from '@/components/albatross/shapes/ProjectBody';
import { shapeFinishes, shapeShowsPlan } from '@/components/albatross/shapes/ShapeFrame';
import { ShapePicker } from '@/components/albatross/shapes/ShapePicker';
import { SecureItemSheet, type SecureSheetRequest } from '@/components/settings/SecureItemSheet';
import { AssistantChat } from '@/components/shell/AIBar';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { api } from '@/convex/_generated/api';
import type { Id } from '@/convex/_generated/dataModel';
import { useMediaQuery } from '@/hooks/use-media-query';
import {
  DOCUMENT_HANDOFF_COPY,
  documentHandoffDetail,
  documentHandoffFor,
  resolveDocumentTarget,
} from '@/lib/albatross/document-handoff';
import { ALLOW_COPY, type AllowScope } from '@/lib/albatross/secure-view';
import { shapeDetail } from '@/lib/albatross/shape-policy';
import { type DocumentTarget, type NextBehaviour, runForStep } from '@/lib/albatross/step-run-client';
import { performNextBehaviour } from '@/lib/albatross/step-run-navigation';
import {
  type FormAnswer,
  type PersonalDetailView,
  type ThreadRunView,
  workThreadSessionId,
} from '@/lib/albatross/thread-contract';
import { hopDirection, isTextFieldTarget } from '@/lib/albatross/thread-list-view';
import { setThreadDraft, setThreadScroll, threadDraft, threadScroll } from '@/lib/albatross/thread-memory';
import {
  composerPlaceholder,
  openWorkQuestions,
  planLine,
  planStepRows,
  stepNumberFor,
  threadStateInput,
} from '@/lib/albatross/thread-view';
import { adjacentThread, filterThreadRows, nextNeedingYou } from '@/lib/albatross/threads';
import {
  guideStepsWithOptimisticCompletion,
  postJson,
  type WorkDetailData,
  workDetailRecoveryPrompt,
  workIsOpen,
  workTitle,
} from '@/lib/albatross/work-view';
import { callTool } from '@/lib/api-client';
import { useClientStore } from '@/lib/client-state';
import type { SecureItemView } from '@/lib/secure/contract';
import { cn } from '@/lib/utils';
import { undoPersonalDetails } from '../ai-elements/form-question-card';
import { awakeWork } from './AlbatrossesSurface';
import { ThreadAnswerInPlace } from './ThreadAnswerInPlace';
import { ThreadRail } from './ThreadRail';
import type { AllowSecureNote } from './thread/AllowSecureBlock';
import { DetailsPanel } from './thread/DetailsPanel';
import { DocumentSplit, ThreadDocumentEditor, YourPartBar, YourPartCard } from './thread/DocumentPane';
import { PagePane, type PageSession } from './thread/PagePane';
import { PlanIntro, PlanLine, PlanOutro } from './thread/PlanIntro';
import { RunBlock } from './thread/RunBlock';
import { ThreadJumpPill } from './thread/ThreadJumpPill';
import { useWorkShape, type WorkShapeState } from './thread/use-work-shape';
import { WorkQuestions } from './thread/WorkQuestions';
import { useThreadActions, useThreadDraftIds } from './use-thread-actions';
import { useAllWork, useMarkSeen, useThreadRows } from './use-thread-rows';

export type ThreadRegion = 'page' | 'details' | 'document' | null;
export type RunBusy = 'stop' | 'resume' | 'dismiss' | 'start' | 'answer' | 'mark_done' | 'allow';

export const THREAD_COPY = {
  back: 'Back',
  page: 'Page',
  details: 'Details',
  more: 'More',
  horizon: 'Change the horizon',
  split: 'Split this work',
  putDown: 'Put it down',
  markComplete: 'Mark it complete',
  reopen: 'Reopen',
  pickUp: 'Pick it back up',
  loading: 'Loading this Albatross…',
  gone: 'This Albatross is no longer available.',
  backToList: 'Back to Albatrosses',
  couldNotOpen: 'Albatross could not open that. Ask about it here.',
  takeOverFailed: 'The run did not stop.',
  resumeFailed: 'The run did not continue.',
  startFailed: 'Albatross could not start this step.',
  dismissFailed: 'The handoff did not close.',
  answerFailed: 'Could not save that answer.',
  stepFailed: 'Could not complete this step.',
  pageOpenFailed: 'The shared browser could not open.',
  pageCloseFailed: 'The shared browser did not close.',
  stateFailed: 'Could not update this Albatross.',
  undoFailed: 'This change can no longer be undone.',
  steerFailed: 'The note did not reach the run.',
} as const;

/** Desktop and laptop: the region docks beside the conversation. Below: a sheet. */
export const THREAD_SPLIT_QUERY = '(min-width: 1024px)';

export interface ThreadModel {
  workId: string;
  title: string;
  detail: WorkDetailData;
  runs: readonly ThreadRunView[];
  session: PageSession | null;
  personalDetails?: readonly PersonalDetailView[];
  nowMs: number;
  timeZone?: string;
  busy: { runId: string | null; action: RunBusy | null; stepKey: string | null };
  runError: string | null;
  /** Field errors of the last answer, by field id, for the run in `busy`. */
  answerErrors: Record<string, string> | null;
  undoneOperations: ReadonlySet<string>;
  undoing: string | null;
  completing: boolean;
  error: string | null;
  region: ThreadRegion;
  /** True when the region is wide enough to dock beside the conversation. */
  wide: boolean;
  shape: WorkShapeState;
  /** Passwords and IDs (docs/albatross-secure-store.md): the saved items, and the allow and save states. */
  secureItems?: readonly SecureItemView[];
  /** The allow scope in flight while the identity check runs; `busy.action` is 'allow'. */
  allowBusy?: AllowScope | null;
  /** The line after a cancelled or failed check, on one run. */
  allowNote?: ({ runId: string } & AllowSecureNote) | null;
  /** The answers this client sent, by run id, before the live run carries them. */
  allowAnswered?: Readonly<Record<string, AllowScope>>;
  /** The runs whose sign-in offer was saved in this visit (V13). */
  signInSaved?: ReadonlySet<string>;
  /** The chat reply of this thread still runs on the server (T5). */
  replyInProgress?: boolean;
  /** The document open in document mode (docs/albatross-document-handoff.md, D5). */
  document?: DocumentTarget | null;
  /** "Done, continue" is in flight, or failed with this line. */
  documentDone?: { busy: boolean; error: string | null };
  /** A Work question (no run owns it) whose answer is in flight, or the line of a failed answer. */
  workQuestion?: { busyId: string | null; error: { questionId: string; text: string } | null };
}

export interface ThreadHandlers {
  /** A note to the run that works now (T7). False when it did not reach the run. */
  onSteerNote?: (runId: string, text: string, noteId: string) => Promise<boolean>;
  /** "Stop and redirect", first half: stop the run at once (T8). */
  onRedirectStop?: (runId: string) => Promise<boolean>;
  /** "Stop and redirect", second half: continue the stopped run with the note. */
  onRedirectResume?: (runId: string, text: string) => Promise<boolean>;
  onBack: () => void;
  onHandle: (stepKey: string) => void;
  onStop: (run: ThreadRunView) => void;
  onResume: (run: ThreadRunView) => void;
  onDismiss: (run: ThreadRunView) => void;
  /** `continue`: the user marked a run's result done, and Albatross goes on to the next step. */
  onMarkDone: (stepKey: string, options?: { continue?: boolean }) => void;
  /** Document mode: open a document in the center, close it, and "Done, continue". */
  onOpenDocument?: (target: DocumentTarget) => void;
  onCloseDocument?: () => void;
  onDocumentDone?: (run: ThreadRunView) => void;
  /** Answer a question of the Work that no run owns. */
  onAnswerWorkQuestion?: (questionId: string, answer: FormAnswer) => void;
  onNext: (behaviour: NextBehaviour, run: ThreadRunView) => void;
  onAnswer: (run: ThreadRunView, questionId: string, answer: FormAnswer) => void;
  onUndoSave: (keys: string[]) => Promise<void>;
  onUndoArtifact: (operationId: string) => void;
  onTakeOver: () => void;
  onPageDone: (run: ThreadRunView | null) => void;
  onClosePage: () => void;
  onReopenPage: () => void;
  onRegionChange: (region: ThreadRegion) => void;
  onSetWorkState: (state: 'done' | 'active') => void;
  onError: (message: string) => void;
  /** Answer an allow_secure block. "Allow once" and "Always on {site}" run the identity check. */
  onAllow?: (run: ThreadRunView, scope: AllowScope) => void;
  /** Open the add sheet for a sign-in on this handoff's site (V13). */
  onSaveSignIn?: (run: ThreadRunView, site: string) => void;
  onOpenSecureSettings?: () => void;
  /** The dev harness: a fixture transport, preview mode, and the messages to show. */
  chat?: { transport?: ChatTransport<UIMessage>; preview?: boolean; initialMessages?: UIMessage[] };
}

// ---------------------------------------------------------------------------
// The view.
// ---------------------------------------------------------------------------

export function WorkThreadView({ model, handlers }: { model: ThreadModel; handlers: ThreadHandlers }) {
  const { detail, runs, session, workId, title, region, wide, shape } = model;
  const steps = detail.execution.guideSteps;
  const runnerEnabled = detail.execution.runner?.enabled ?? false;
  const stateInput = useMemo(() => threadStateInput(detail, runs), [detail, runs]);
  const line = planLine(stateInput);
  const stepRows = useMemo(() => planStepRows(steps, { runnerEnabled, runs }), [steps, runnerEnabled, runs]);
  const workQuestions = useMemo(() => openWorkQuestions(detail, runs), [detail, runs]);
  const activeRun = stateInput.activeRun;
  const open = workIsOpen(detail.work);
  const showsPlan = shapeShowsPlan(shape.shape);
  const finishes = shapeFinishes(shape.shape);
  const liveSession = Boolean(session && session.status !== 'ended' && session.status !== 'failed');
  const [horizonOpen, setHorizonOpen] = useState(false);
  const [splitting, setSplitting] = useState(false);
  const [releasing, setReleasing] = useState(false);
  const setSelectedWorkId = useClientStore((state) => state.setSelectedWorkId);

  // The run the page belongs to: the open run, else the newest handoff that waits on the page.
  const pageRun = useMemo(() => {
    if (activeRun?.browserSessionId) return activeRun;
    return (
      [...runs]
        .reverse()
        .find(
          (run) =>
            run.state === 'handed_off' &&
            run.browserSessionId &&
            (run.next?.kind === 'sign_in' ||
              run.next?.kind === 'finish_on_page' ||
              run.outcome === 'needs_answer'),
        ) ?? null
    );
  }, [activeRun, runs]);
  const pageStep = steps.find((step) => step.key === (session?.stepKey ?? pageRun?.stepKey));

  // Document mode: the document in the center, the thread on the right.
  const documentTarget = region === 'document' ? (model.document ?? null) : null;
  const documentRun = documentTarget ? documentHandoffFor(runs, documentTarget) : null;
  const documentRunId = documentRun?.id ?? null;
  const latestByStep = useMemo(() => {
    const map = new Map<string, string>();
    for (const run of runs) map.set(run.stepKey, run.id);
    return map;
  }, [runs]);

  const renderRun = useCallback(
    (run: ThreadRunView, continues: boolean) => {
      const step = steps.find((row) => row.key === run.stepKey);
      const newest = latestByStep.get(run.stepKey) === run.id;
      const startable =
        newest && runnerEnabled && Boolean(step && !step.done && step.runnable) && !activeRun && open;
      const busy = model.busy.runId === run.id ? model.busy.action : null;
      return (
        <RunBlock
          run={run}
          continues={continues}
          stepNumber={stepNumberFor(steps, run.stepKey)}
          startable={startable}
          pageOpen={region === 'page'}
          handoffShownElsewhere={documentRunId === run.id}
          details={model.personalDetails}
          busy={busy}
          error={model.busy.runId === run.id ? model.runError : null}
          answerErrors={model.busy.runId === run.id ? model.answerErrors : null}
          timeZone={model.timeZone}
          onStop={handlers.onStop}
          onResume={handlers.onResume}
          onDismiss={handlers.onDismiss}
          onStart={(target) => handlers.onHandle(target.stepKey)}
          onMarkDone={(target) => handlers.onMarkDone(target.stepKey, { continue: true })}
          onNext={handlers.onNext}
          onAnswer={handlers.onAnswer}
          onOpenPage={liveSession ? () => handlers.onRegionChange('page') : undefined}
          onUndoSave={handlers.onUndoSave}
          secureItems={model.secureItems}
          allowBusy={model.busy.runId === run.id ? model.allowBusy : null}
          allowNote={model.allowNote?.runId === run.id ? model.allowNote : null}
          allowAnswered={model.allowAnswered?.[run.id] ?? null}
          signInSaved={model.signInSaved?.has(run.id)}
          onAllow={handlers.onAllow}
          onSaveSignIn={handlers.onSaveSignIn}
          onOpenSecureSettings={handlers.onOpenSecureSettings}
        />
      );
    },
    [
      steps,
      latestByStep,
      runnerEnabled,
      activeRun,
      open,
      model,
      region,
      liveSession,
      handlers,
      documentRunId,
    ],
  );

  const pendingForm = stateInput.pendingQuestion;
  // The composer steers the open run (lead decision 5). The draft and the
  // reader's place belong to this thread across hops (lead decision 4).
  const steerRun = useMemo(
    () =>
      activeRun && (activeRun.state === 'running' || activeRun.state === 'queued')
        ? {
            id: activeRun.id,
            stepTitle: activeRun.stepTitle,
            stepNumber: stepNumberFor(steps, activeRun.stepKey),
          }
        : null,
    [activeRun, steps],
  );
  const steer = useMemo(
    () =>
      handlers.onSteerNote && handlers.onRedirectStop && handlers.onRedirectResume
        ? {
            run: steerRun,
            send: handlers.onSteerNote,
            stop: handlers.onRedirectStop,
            resume: handlers.onRedirectResume,
          }
        : undefined,
    [handlers.onSteerNote, handlers.onRedirectStop, handlers.onRedirectResume, steerRun],
  );
  const memory = useMemo(
    () => ({
      draft: { get: () => threadDraft(workId), set: (text: string) => setThreadDraft(workId, text) },
      scroll: {
        restore: () => threadScroll(workId),
        save: (state: { top: number; atBottom: boolean }) => setThreadScroll(workId, state),
      },
    }),
    [workId],
  );
  const documentDetail = documentHandoffDetail(documentRun);
  const documentStepNumber = documentRun ? stepNumberFor(steps, documentRun.stepKey) : null;
  const [documentChatOpen, setDocumentChatOpen] = useState(false);
  const intro = (
    <>
      {model.detail.execution.scheduledEndAt ? (
        <Recovery detail={detail} workId={workId} nowMs={model.nowMs} />
      ) : null}
      <PlanIntro
        outcome={title}
        summary={detail.plan?.summary}
        steps={showsPlan ? stepRows : []}
        state={line.state}
        activeStepKey={activeRun?.stepKey ?? null}
        busyStepKey={model.busy.action === 'start' ? model.busy.stepKey : null}
        onHandle={open && runnerEnabled ? handlers.onHandle : undefined}
      />
    </>
  );

  const conversation = (
    <div className="flex h-full min-h-0 min-w-0 flex-col" data-thread-conversation>
      {splitting ? (
        <div className="shrink-0 border-b border-[var(--color-border)] px-4 py-3">
          <SplitSheet
            workId={workId}
            onDone={(workIds) => {
              setSplitting(false);
              if (workIds[0]) setSelectedWorkId(workIds[0]);
            }}
            onCancel={() => setSplitting(false)}
          />
        </div>
      ) : null}
      {releasing ? (
        <div className="shrink-0 border-b border-[var(--color-border)] px-4 py-3">
          <ReleaseSheet
            workId={workId}
            title={title}
            onReleased={() => setReleasing(false)}
            onCancel={() => setReleasing(false)}
          />
        </div>
      ) : null}
      {model.error || detail.work.planError ? (
        <p className="shrink-0 border-b border-[var(--color-danger)]/25 bg-[var(--color-danger-soft)] px-4 py-2 text-[12px] text-[var(--color-danger)]">
          {model.error || detail.work.planError}
        </p>
      ) : null}
      <div className="min-h-0 flex-1 [&_[data-thread-column]]:mx-auto [&_[data-thread-column]]:max-w-[680px]">
        <AssistantChat
          key={workId}
          preview={handlers.chat?.preview}
          transport={handlers.chat?.transport}
          thread={{
            sessionId: workThreadSessionId(workId),
            scope: { kind: 'work', workId, label: title },
            runs,
            renderRun,
            // The "Your part" card names the step; the plan stays in Details.
            intro: documentTarget ? undefined : intro,
            outro: (
              <>
                {handlers.onAnswerWorkQuestion ? (
                  <WorkQuestions
                    questions={workQuestions}
                    details={model.personalDetails}
                    busyId={model.workQuestion?.busyId ?? null}
                    error={model.workQuestion?.error ?? null}
                    onAnswer={handlers.onAnswerWorkQuestion}
                  />
                ) : null}
                <PlanOutro state={line.state} />
              </>
            ),
            placeholder: documentTarget ? DOCUMENT_HANDOFF_COPY.placeholder : composerPlaceholder(line.state),
            document: documentTarget
              ? { kind: 'document', id: documentTarget.id, provider: documentTarget.provider }
              : null,
            scrollButton: <ThreadJumpPill hasPendingForm={pendingForm} />,
            initialMessages: handlers.chat?.initialMessages,
            steer,
            replyInProgress: model.replyInProgress,
            memory,
          }}
        />
      </div>
    </div>
  );

  const documentDone = model.documentDone ?? { busy: false, error: null };
  const yourPart =
    documentTarget && documentRun && documentDetail && handlers.onDocumentDone ? (
      <YourPartCard
        stepLabel={
          documentStepNumber ? `Step ${documentStepNumber} · ${documentRun.stepTitle}` : documentRun.stepTitle
        }
        detail={documentDetail}
        busy={documentDone.busy}
        error={documentDone.error}
        onDone={() => handlers.onDocumentDone?.(documentRun)}
        onBack={() => handlers.onCloseDocument?.()}
      />
    ) : null;
  const documentNode = documentTarget ? (
    <ThreadDocumentEditor
      target={documentTarget}
      onClose={() => handlers.onCloseDocument?.()}
      onChat={wide ? undefined : () => setDocumentChatOpen(true)}
    />
  ) : null;
  const shapeBody = showsPlan ? null : <ShapeBody shape={shape} detail={detail} nowMs={model.nowMs} />;
  const regionNode =
    region === 'page' ? (
      <PagePane
        session={session}
        run={pageRun}
        url={pageStep?.url}
        busy={model.busy.action === 'stop' || model.busy.action === 'resume'}
        onTakeOver={handlers.onTakeOver}
        onDone={() => handlers.onPageDone(pageRun)}
        onClose={handlers.onClosePage}
        onReopen={pageStep?.url ? handlers.onReopenPage : undefined}
      />
    ) : region === 'details' ? (
      <DetailsPanel
        detail={detail}
        steps={showsPlan ? stepRows : []}
        activeStepKey={activeRun?.stepKey ?? null}
        busyStepKey={model.busy.action === 'start' ? model.busy.stepKey : null}
        onHandle={open && runnerEnabled ? handlers.onHandle : undefined}
        shapeBody={shapeBody}
        shapePicker={
          <ShapePicker
            value={shape.shape}
            onChange={(next) => void shape.saveShape(next)}
            saving={shape.shapeSaving}
            error={shape.shapeError}
          />
        }
        undoneOperations={model.undoneOperations}
        undoing={model.undoing}
        onUndo={handlers.onUndoArtifact}
        onError={handlers.onError}
        onClose={wide ? undefined : () => handlers.onRegionChange(null)}
      />
    ) : null;

  return (
    <div data-slot="work-thread" data-thread-state={line.state} className="flex h-full min-h-0 flex-col">
      <header className="flex h-[50px] shrink-0 items-center gap-3 border-b border-[var(--color-border)] px-4">
        <Button type="button" size="xs" variant="ghost" onClick={handlers.onBack}>
          {THREAD_COPY.back}
        </Button>
        <h1 className="min-w-0 flex-1 truncate font-display text-[16px] font-medium">{title}</h1>
        <div className="hidden sm:block">
          <PlanLine
            text={line.text}
            state={line.state}
            active={region === 'details'}
            onClick={() => handlers.onRegionChange(region === 'details' ? null : 'details')}
          />
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {liveSession ? (
            <HeaderTool
              active={region === 'page'}
              onClick={() => handlers.onRegionChange(region === 'page' ? null : 'page')}
            >
              {THREAD_COPY.page}
            </HeaderTool>
          ) : null}
          <HeaderTool
            active={region === 'details'}
            onClick={() => handlers.onRegionChange(region === 'details' ? null : 'details')}
          >
            {THREAD_COPY.details}
          </HeaderTool>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <HeaderTool>{THREAD_COPY.more}</HeaderTool>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-44">
              {open ? (
                <>
                  <DropdownMenuItem onSelect={() => setHorizonOpen((value) => !value)}>
                    {THREAD_COPY.horizon}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() => {
                      setSplitting((value) => !value);
                      setReleasing(false);
                    }}
                  >
                    {THREAD_COPY.split}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() => {
                      setReleasing((value) => !value);
                      setSplitting(false);
                    }}
                  >
                    {THREAD_COPY.putDown}
                  </DropdownMenuItem>
                  {finishes ? (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        disabled={model.completing}
                        onSelect={() => handlers.onSetWorkState('done')}
                      >
                        {THREAD_COPY.markComplete}
                      </DropdownMenuItem>
                    </>
                  ) : null}
                </>
              ) : (
                <DropdownMenuItem
                  disabled={model.completing}
                  onSelect={() => handlers.onSetWorkState('active')}
                >
                  {detail.work.workState === 'done' ? THREAD_COPY.reopen : THREAD_COPY.pickUp}
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>
      <div className="flex h-9 shrink-0 items-center border-b border-[var(--color-border)] px-4 sm:hidden">
        <PlanLine
          text={line.text}
          state={line.state}
          active={region === 'details'}
          onClick={() => handlers.onRegionChange(region === 'details' ? null : 'details')}
        />
      </div>
      {horizonOpen && open ? (
        <div className="shrink-0 border-b border-[var(--color-border)] px-4 py-2">
          <HorizonControl
            value={shape.horizon}
            nowMs={model.nowMs}
            onChange={(next) => void shape.saveHorizon(next)}
            saving={shape.horizonSaving}
            error={shape.horizonError}
            autoFocus
            onCancel={() => setHorizonOpen(false)}
          />
        </div>
      ) : null}

      <div className="relative min-h-0 flex-1">
        {documentNode && wide ? (
          <DocumentSplit
            document={documentNode}
            conversation={
              <div className="flex h-full min-h-0 flex-col border-l border-[var(--color-border)]">
                {yourPart}
                <div className="min-h-0 flex-1">{conversation}</div>
              </div>
            }
          />
        ) : documentNode ? (
          <div className="flex h-full min-h-0 flex-col">
            <div className="min-h-0 flex-1">{documentNode}</div>
            <YourPartBar
              detail={yourPart ? documentDetail : null}
              busy={documentDone.busy}
              error={documentDone.error}
              onDone={yourPart && documentRun ? () => handlers.onDocumentDone?.(documentRun) : null}
              onChat={() => setDocumentChatOpen(true)}
            />
            <Sheet open={documentChatOpen} onOpenChange={setDocumentChatOpen}>
              <SheetContent
                side="right"
                showCloseButton={false}
                className="w-[92vw] gap-0 p-0 sm:max-w-[92vw]"
                aria-describedby={undefined}
              >
                <SheetTitle className="sr-only">{DOCUMENT_HANDOFF_COPY.chat}</SheetTitle>
                {conversation}
              </SheetContent>
            </Sheet>
          </div>
        ) : wide && regionNode ? (
          <ThreadSplit region={region} conversation={conversation} regionNode={regionNode} />
        ) : (
          conversation
        )}
        {!wide && regionNode ? (
          <Sheet open onOpenChange={(next) => !next && handlers.onRegionChange(null)}>
            <SheetContent
              side="right"
              showCloseButton={false}
              className="w-[92vw] gap-0 p-0 sm:max-w-[92vw]"
              aria-describedby={undefined}
            >
              <SheetTitle className="sr-only">
                {region === 'page' ? THREAD_COPY.page : THREAD_COPY.details}
              </SheetTitle>
              {regionNode}
            </SheetContent>
          </Sheet>
        ) : null}
      </div>
    </div>
  );
}

function HeaderTool({
  active,
  onClick,
  children,
  ...rest
}: {
  active?: boolean;
  onClick?: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active || undefined}
      onClick={onClick}
      {...rest}
      className={cn(
        'h-7 rounded-ui px-2.5 text-[12.5px] text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text)]',
        active && 'bg-[var(--color-control-hover)] text-[var(--color-text)]',
      )}
    >
      {children}
    </button>
  );
}

function Recovery({ detail, workId, nowMs }: { detail: WorkDetailData; workId: string; nowMs: number }) {
  const prompt = workDetailRecoveryPrompt(detail, workId, nowMs);
  return prompt ? <LapsePrompt {...prompt} /> : null;
}

/** The docked split: the conversation and the region, resizable, saved per device. */
function ThreadSplit({
  region,
  conversation,
  regionNode,
}: {
  region: ThreadRegion;
  conversation: ReactNode;
  regionNode: ReactNode;
}) {
  const [resizing, setResizing] = useState(false);
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: 'lab86-mail-thread-split',
    panelIds: ['conversation', 'region'],
    storage: typeof window !== 'undefined' ? window.localStorage : noopStorage,
  });
  return (
    <Group
      orientation="horizontal"
      defaultLayout={defaultLayout}
      onLayoutChanged={onLayoutChanged}
      data-panel-resizing={resizing || undefined}
      className="h-full min-h-0 w-full"
    >
      <Panel id="conversation" defaultSize="56%" minSize="480px">
        {conversation}
      </Panel>
      <Separator
        onPointerDown={() => {
          const end = () => {
            window.removeEventListener('pointerup', end);
            window.removeEventListener('blur', end);
            setResizing(false);
          };
          setResizing(true);
          window.addEventListener('pointerup', end);
          window.addEventListener('blur', end);
        }}
        aria-label="Resize the conversation and the panel"
        className="group relative w-[6px] shrink-0 cursor-col-resize outline-none"
      >
        <span
          className="pointer-events-none absolute bottom-0 left-1/2 top-0 w-px -translate-x-1/2 bg-[var(--color-border)] transition-colors group-hover:bg-[var(--color-accent)] group-data-[separator-state=drag]:w-[2px] group-data-[separator-state=drag]:bg-[var(--color-accent)]"
          aria-hidden
        />
      </Separator>
      <Panel id="region" defaultSize="44%" minSize="380px" maxSize="60%">
        {/* A drag must not fall into the live view. */}
        <div
          data-thread-region={region}
          className={cn('h-full min-h-0', resizing && '[&_iframe]:pointer-events-none')}
        >
          {regionNode}
        </div>
      </Panel>
    </Group>
  );
}

const noopStorage: Pick<Storage, 'getItem' | 'setItem'> = { getItem: () => null, setItem: () => undefined };

function ShapeBody({
  shape,
  detail,
  nowMs,
}: {
  shape: WorkShapeState;
  detail: WorkDetailData;
  nowMs: number;
}) {
  switch (shapeDetail(shape.shape)) {
    case 'list':
      return (
        <ListBody
          items={shape.listItems}
          onAdd={(texts) => void shape.addListItems(texts)}
          onToggle={(itemId) => void shape.toggleListItem(itemId)}
          onRemove={(itemId) => void shape.removeListItem(itemId)}
          busyIds={shape.listBusyIds}
          error={shape.listError}
        />
      );
    case 'practice':
      return (
        <PracticeBody
          metric={detail.work.metric ?? null}
          entries={shape.metricEntries}
          nowMs={nowMs}
          onLog={(value, note) => void shape.logMetric(value, note)}
          saving={shape.metricSaving}
          error={shape.metricError}
          freshId={shape.freshEntryId}
        />
      );
    case 'milestones':
      return (
        <ProjectBody
          milestones={shape.milestones}
          evidence={detail.evidence || []}
          artifacts={detail.application?.artifacts ?? []}
          lastUserTouchAt={detail.work.lastUserTouchAt ?? null}
          nowMs={nowMs}
          onToggle={(milestoneId) => void shape.toggleMilestone(milestoneId)}
          onSetMilestones={shape.saveMilestones}
          busyIds={shape.milestoneBusyIds}
          saving={shape.milestonesSaving}
          error={shape.milestoneError}
        />
      );
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// The data layer.
// ---------------------------------------------------------------------------

/** Desktop: the rail is 300 px. Below, on a laptop, 272 px, and it hides while a region is open. */
export const THREAD_RAIL_WIDE_QUERY = '(min-width: 1280px)';

/** Where focus was when a hop started, so the new thread puts it back (T3). */
let hopFocus: 'composer' | null = null;

export function WorkThread({ workId }: { workId: string }) {
  const queryClient = useQueryClient();
  const { isAuthenticated } = useConvexAuth();
  const setSelectedWorkId = useClientStore((state) => state.setSelectedWorkId);
  const setSelectedAreaId = useClientStore((state) => state.setSelectedAreaId);
  const primaryView = useClientStore((state) => state.primaryView);
  const selectedAreaId = useClientStore((state) => state.selectedAreaId);
  const listFilter = useClientStore((state) => state.threadListFilter);
  const setListFilter = useClientStore((state) => state.setThreadListFilter);
  // The rail: every awake thread, live (lead decision 9). Inside an Area, that Area's threads.
  const works = useAllWork();
  const railAreaId = primaryView === 'areas' ? selectedAreaId : null;
  const [railNowMs, setRailNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = globalThis.setInterval(() => setRailNowMs(Date.now()), 30_000);
    return () => globalThis.clearInterval(timer);
  }, []);
  const scopedWorks = useMemo(
    () => (works ? works.filter((work) => !railAreaId || work.primaryAreaId === railAreaId) : undefined),
    [works, railAreaId],
  );
  const awakeWorks = useMemo(
    () => (scopedWorks ? awakeWork(scopedWorks, railNowMs) : undefined),
    [scopedWorks, railNowMs],
  );
  const laterCount = scopedWorks && awakeWorks ? scopedWorks.length - awakeWorks.length : 0;
  const rows = useThreadRows(awakeWorks);
  const row = useMemo(() => rows?.find((item) => item.workId === workId) ?? null, [rows, workId]);
  const railAreaName = useMemo(
    () => (railAreaId ? (scopedWorks?.find((work) => work.areaName)?.areaName ?? null) : null),
    [railAreaId, scopedWorks],
  );
  const railActions = useThreadActions(setSelectedWorkId);
  const draftIds = useThreadDraftIds();
  const [answeringWorkId, setAnsweringWorkId] = useState<string | null>(null);
  const railWide = useMediaQuery(THREAD_RAIL_WIDE_QUERY);

  // Seen (T2): on open and after each new activity, while the thread is on screen and the window has focus.
  const markSeen = useMarkSeen();
  const lastActivityAt = row?.lastActivityAt ?? 0;
  // biome-ignore lint/correctness/useExhaustiveDependencies: new activity marks the thread seen again
  useEffect(() => {
    if (!isAuthenticated) return;
    let timer: number | null = null;
    const visible = () => document.visibilityState === 'visible' && document.hasFocus();
    const touch = () => {
      if (!visible()) return;
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => void markSeen(workId), 1_000);
    };
    touch();
    window.addEventListener('focus', touch);
    document.addEventListener('visibilitychange', touch);
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      window.removeEventListener('focus', touch);
      document.removeEventListener('visibilitychange', touch);
    };
  }, [isAuthenticated, markSeen, workId, lastActivityAt]);

  // Hop keys (T3, lead decision 4): ⌘↑ / ⌘↓, ⌥⌘↑ / ⌥⌘↓ in a text field, ⌥⌘↩ for the next thread that needs you.
  const hopRows = useMemo(
    () => (rows ? filterThreadRows(rows, listFilter).filter((item) => !item.closed) : []),
    [rows, listFilter],
  );
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      const direction = hopDirection(event, isTextFieldTarget(event.target));
      if (!direction) return;
      const target =
        direction === 'needs_you'
          ? nextNeedingYou(hopRows, workId)
          : adjacentThread(hopRows, workId, direction === 'next' ? 1 : -1);
      if (!target) return;
      event.preventDefault();
      hopFocus = (event.target as HTMLElement | null)?.closest?.('[data-thread-composer]')
        ? 'composer'
        : null;
      setSelectedWorkId(target);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [hopRows, workId, setSelectedWorkId]);
  // Focus follows the hop: a hop from the composer lands in the new composer.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the hop (a new workId) is the trigger
  useEffect(() => {
    if (hopFocus !== 'composer') return;
    hopFocus = null;
    const frame = requestAnimationFrame(() => {
      document.querySelector<HTMLTextAreaElement>('[data-thread-composer] textarea')?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [workId]);
  const detail = useQuery(
    api.albatrossWorkV2.workDetail,
    isAuthenticated ? { workId: workId as Id<'albatrossIntents'> } : 'skip',
  ) as WorkDetailData | null | undefined;
  const session = useQuery(
    api.albatrossBrowserSessions.activeSessionForWork,
    isAuthenticated ? { workId } : 'skip',
  ) as PageSession | null | undefined;
  const liveRuns = useQuery(
    api.albatrossStepRuns.runsForWorkHistory,
    isAuthenticated ? { workId, limit: 30 } : 'skip',
  ) as ThreadRunView[] | undefined;
  const personalDetails = usePersonalDetails(isAuthenticated);
  const secure = useSecureDetails(isAuthenticated);
  const [allowBusy, setAllowBusy] = useState<AllowScope | null>(null);
  const [allowNote, setAllowNote] = useState<({ runId: string } & AllowSecureNote) | null>(null);
  const [allowAnswered, setAllowAnswered] = useState<Record<string, AllowScope>>({});
  const [signInSaved, setSignInSaved] = useState<ReadonlySet<string>>(() => new Set());
  const [secureSheet, setSecureSheet] = useState<(SecureSheetRequest & { runId: string }) | null>(null);
  // The two allows need the identity check: Clerk's modal opens on the 403 and the call retries.
  const allowWithCheck = useReverification(answerSecureAllow);
  const shape = useWorkShape(workId, detail);
  const wide = useMediaQuery(THREAD_SPLIT_QUERY);

  const [busy, setBusy] = useState<ThreadModel['busy']>({ runId: null, action: null, stepKey: null });
  const [runError, setRunError] = useState<string | null>(null);
  const [answerErrors, setAnswerErrors] = useState<Record<string, string> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [completing, setCompleting] = useState(false);
  const [undoing, setUndoing] = useState<string | null>(null);
  const [undoneOperations, setUndoneOperations] = useState<ReadonlySet<string>>(new Set());
  const [optimisticDone, setOptimisticDone] = useState<ReadonlySet<string>>(() => new Set());
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [region, setRegionState] = useState<ThreadRegion>(null);
  const [openDocument, setOpenDocument] = useState<DocumentTarget | null>(null);
  const [workQuestion, setWorkQuestion] = useState<NonNullable<ThreadModel['workQuestion']>>({
    busyId: null,
    error: null,
  });
  const [documentDone, setDocumentDone] = useState<{ busy: boolean; error: string | null }>({
    busy: false,
    error: null,
  });
  const regionBy = useRef<'user' | 'auto' | null>(null);
  const mountedAt = useRef(Date.now());
  const startedHere = useRef<Set<string>>(new Set());

  useEffect(() => {
    const timer = globalThis.setInterval(() => setNowMs(Date.now()), 30_000);
    return () => globalThis.clearInterval(timer);
  }, []);
  useEffect(() => {
    if (detail?.work.primaryAreaId) setSelectedAreaId(String(detail.work.primaryAreaId));
  }, [detail?.work.primaryAreaId, setSelectedAreaId]);
  useEffect(() => {
    if (!detail) return;
    const serverDone = new Set(
      detail.execution.guideSteps.filter((step) => step.done).map((step) => step.key),
    );
    setOptimisticDone((current) => {
      const pending = [...current].filter((key) => !serverDone.has(key));
      return pending.length === current.size ? current : new Set(pending);
    });
  }, [detail]);

  const runs = useMemo(() => liveRuns ?? [], [liveRuns]);
  const activeRun = runs.find((run) => run.state === 'queued' || run.state === 'running') ?? null;

  const setRegion = useCallback((next: ThreadRegion, by: 'user' | 'auto' = 'user') => {
    regionBy.current = next ? by : null;
    setRegionState(next);
  }, []);

  // The page pane opens by itself only for a run the user started from this
  // view (lead review decision 13), and closes again when that session ends.
  const liveSession = Boolean(session && session.status !== 'ended' && session.status !== 'failed');
  useEffect(() => {
    if (!activeRun) return;
    // A start or a continue always comes from the user (a button, a message, an answer).
    if (
      (activeRun.trigger === 'user' || activeRun.trigger === 'resume') &&
      activeRun.createdAt >= mountedAt.current
    )
      startedHere.current.add(activeRun.id);
    if (liveSession && region === null && startedHere.current.has(activeRun.id)) setRegion('page', 'auto');
  }, [activeRun, liveSession, region, setRegion]);
  useEffect(() => {
    if (region === 'page' && !liveSession && regionBy.current === 'auto') setRegion(null);
  }, [region, liveSession, setRegion]);

  const navDeps = useMemo(
    () => ({
      getState: () => useClientStore.getState(),
      setState: (patch: Record<string, unknown>) => useClientStore.setState(patch as never),
      callTool: (name: string, args: Record<string, unknown>) => callTool(name, args),
      openWindow: (url: string) => {
        window.open(url, '_blank', 'noopener,noreferrer');
      },
      pushPath: (path: string) => window.history.pushState(window.history.state, '', path),
      dispatch: (eventName: string) => window.dispatchEvent(new Event(eventName)),
    }),
    [],
  );

  const runAction = useCallback(
    async (
      action: 'start' | 'cancel' | 'resume' | 'dismiss',
      body: Record<string, unknown>,
      mark: ThreadModel['busy'],
    ) => {
      const fallback = {
        start: THREAD_COPY.startFailed,
        cancel: THREAD_COPY.takeOverFailed,
        resume: THREAD_COPY.resumeFailed,
        dismiss: THREAD_COPY.dismissFailed,
      }[action];
      setBusy(mark);
      setRunError(null);
      try {
        const result = await postJson(
          `/api/albatross/work/${encodeURIComponent(workId)}/run`,
          { action, ...body },
          fallback,
        );
        if (action === 'start' && typeof result?.runId === 'string') startedHere.current.add(result.runId);
        if (action === 'resume' && typeof result?.runId === 'string') startedHere.current.add(result.runId);
        setBusy({ runId: null, action: null, stepKey: null });
        return true;
      } catch (cause) {
        setRunError(cause instanceof Error ? cause.message : fallback);
        // The run keeps the mark without an action, so its block shows the error.
        setBusy({ runId: mark.runId, action: null, stepKey: mark.stepKey });
        return false;
      }
    },
    [workId],
  );

  const sessionAction = useCallback(
    async (body: Record<string, unknown>, fallback: string) => {
      setError(null);
      try {
        return await postJson(`/api/albatross/work/${encodeURIComponent(workId)}/session`, body, fallback);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : fallback);
        return null;
      }
    },
    [workId],
  );

  const handlers = useMemo<ThreadHandlers>(
    () => ({
      onBack: () => setSelectedWorkId(null),
      onHandle: (stepKey) => void runAction('start', { stepKey }, { runId: null, action: 'start', stepKey }),
      onStop: (run) =>
        void runAction('cancel', { runId: run.id }, { runId: run.id, action: 'stop', stepKey: run.stepKey }),
      onResume: (run) =>
        void runAction(
          'resume',
          { runId: run.id },
          { runId: run.id, action: 'resume', stepKey: run.stepKey },
        ),
      onDismiss: (run) =>
        void runAction(
          'dismiss',
          { runId: run.id },
          { runId: run.id, action: 'dismiss', stepKey: run.stepKey },
        ),
      onMarkDone: (stepKey, options) => {
        setOptimisticDone((current) => new Set([...current, stepKey]));
        setBusy({ runId: null, action: 'mark_done', stepKey });
        setError(null);
        void postJson(
          `/api/albatross/work/${encodeURIComponent(workId)}/step`,
          {
            stepKey,
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            ...(options?.continue ? { continue: true } : {}),
          },
          THREAD_COPY.stepFailed,
        )
          .then((result) => {
            if (typeof result?.nextRunId === 'string') startedHere.current.add(result.nextRunId);
          })
          .catch((cause) => {
            setOptimisticDone((current) => {
              const next = new Set(current);
              next.delete(stepKey);
              return next;
            });
            setError(cause instanceof Error ? cause.message : THREAD_COPY.stepFailed);
          })
          .finally(() => setBusy({ runId: null, action: null, stepKey: null }));
      },
      onNext: (behaviour, run) => {
        // A document opens here, in document mode, not in Files.
        if (behaviour.kind === 'open_document') {
          const target = resolveDocumentTarget(run.artifacts, behaviour.url, behaviour.id);
          if (target) {
            handlers.onOpenDocument?.(target);
            return;
          }
        }
        void performNextBehaviour(behaviour, navDeps, {
          showBrowser: () => setRegion('page'),
          showArtifacts: () => setRegion('details'),
          showQuestion: () => undefined,
          markDone: () => handlers.onMarkDone(run.stepKey),
          resume: () => handlers.onResume(run),
        })
          .catch(() => false)
          .then((opened) => {
            if (!opened) setRunError(THREAD_COPY.couldNotOpen);
          });
      },
      onAnswer: (run, questionId, answer) => {
        setBusy({ runId: run.id, action: 'answer', stepKey: run.stepKey });
        setRunError(null);
        setAnswerErrors(null);
        void postJson(
          `/api/albatross/work/questions/${encodeURIComponent(questionId)}/answer`,
          { form: answer, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone },
          THREAD_COPY.answerFailed,
        )
          .then((result) => {
            if (typeof result?.runId === 'string') startedHere.current.add(result.runId);
            if (answer.save) void queryClient.invalidateQueries({ queryKey: ['personal-details'] });
          })
          .catch((cause: Error & { body?: { errors?: Record<string, string> } }) => {
            const errors = cause?.body?.errors;
            if (errors && typeof errors === 'object') {
              setAnswerErrors(errors);
              setBusy({ runId: run.id, action: null, stepKey: run.stepKey });
              return;
            }
            setRunError(cause instanceof Error ? cause.message : THREAD_COPY.answerFailed);
          })
          .finally(() =>
            setBusy((current) =>
              current.action === 'answer' ? { runId: null, action: null, stepKey: null } : current,
            ),
          );
      },
      onUndoSave: async (keys) => {
        await undoPersonalDetails(keys);
        void queryClient.invalidateQueries({ queryKey: ['personal-details'] });
      },
      onUndoArtifact: (operationId) => {
        setUndoing(operationId);
        setError(null);
        void callTool('undo_operation', { operationId })
          .then(() => setUndoneOperations((previous) => new Set([...previous, operationId])))
          .catch((cause) => setError(cause instanceof Error ? cause.message : THREAD_COPY.undoFailed))
          .finally(() => setUndoing(null));
      },
      onTakeOver: () => {
        if (activeRun)
          void runAction(
            'cancel',
            { runId: activeRun.id },
            { runId: activeRun.id, action: 'stop', stepKey: activeRun.stepKey },
          );
      },
      onPageDone: (run) => {
        if (run) handlers.onResume(run);
      },
      onClosePage: () => {
        if (session)
          void sessionAction({ action: 'end', sessionId: session.sessionId }, THREAD_COPY.pageCloseFailed);
        setRegion(null);
      },
      onReopenPage: () => {
        const step = detail?.execution.currentStep;
        if (step) void sessionAction({ action: 'start', stepKey: step.key }, THREAD_COPY.pageOpenFailed);
        setRegion('page');
      },
      onRegionChange: (next) => setRegion(next),
      onAnswerWorkQuestion: (questionId, answer) => {
        setWorkQuestion({ busyId: questionId, error: null });
        void postJson(
          `/api/albatross/work/questions/${encodeURIComponent(questionId)}/answer`,
          { form: answer, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone },
          THREAD_COPY.answerFailed,
        )
          .then((result) => {
            if (typeof result?.runId === 'string') startedHere.current.add(result.runId);
            if (answer.save) void queryClient.invalidateQueries({ queryKey: ['personal-details'] });
            setWorkQuestion({ busyId: null, error: null });
          })
          .catch((cause) =>
            setWorkQuestion({
              busyId: null,
              error: { questionId, text: cause instanceof Error ? cause.message : THREAD_COPY.answerFailed },
            }),
          );
      },
      onOpenDocument: (target) => {
        setOpenDocument(target);
        setDocumentDone({ busy: false, error: null });
        setRegion('document');
      },
      onCloseDocument: () => {
        setRegion(null);
        setOpenDocument(null);
      },
      onDocumentDone: (run) => {
        setDocumentDone({ busy: true, error: null });
        setOptimisticDone((current) => new Set([...current, run.stepKey]));
        void postJson(
          `/api/albatross/work/${encodeURIComponent(workId)}/step`,
          {
            stepKey: run.stepKey,
            continue: true,
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          },
          DOCUMENT_HANDOFF_COPY.failed,
        )
          .then((result) => {
            if (typeof result?.nextRunId === 'string') startedHere.current.add(result.nextRunId);
            setDocumentDone({ busy: false, error: null });
            setRegion(null);
            setOpenDocument(null);
          })
          .catch((cause) => {
            setOptimisticDone((current) => {
              const next = new Set(current);
              next.delete(run.stepKey);
              return next;
            });
            setDocumentDone({
              busy: false,
              error: cause instanceof Error ? cause.message : DOCUMENT_HANDOFF_COPY.failed,
            });
          });
      },
      onSetWorkState: (state) => {
        setCompleting(true);
        setError(null);
        void postJson(
          `/api/albatross/work/${encodeURIComponent(workId)}/state`,
          { state },
          THREAD_COPY.stateFailed,
        )
          .then(() => queryClient.invalidateQueries({ queryKey: ['brief-v2', 'inactive'] }))
          .catch((cause) => setError(cause instanceof Error ? cause.message : THREAD_COPY.stateFailed))
          .finally(() => setCompleting(false));
      },
      onError: (message) => setError(message),
      onAllow: (run, scope) => {
        const allow = run.next?.kind === 'allow_secure' ? run.next.allow : null;
        if (!allow) return;
        setBusy({ runId: run.id, action: 'allow', stepKey: run.stepKey });
        setAllowBusy(scope);
        setAllowNote(null);
        // "Do not allow" needs no check (lead decision 5).
        const send = scope === 'deny' ? answerSecureAllow : allowWithCheck;
        void send({ runId: run.id, itemId: allow.itemId, site: allow.site, scope })
          .then((result) => {
            if (!result || !('runId' in result)) return;
            if (result.runId) startedHere.current.add(result.runId);
            setAllowAnswered((current) => ({ ...current, [run.id]: scope }));
            void queryClient.invalidateQueries({ queryKey: SECURE_DETAILS_QUERY_KEY });
          })
          .catch((cause) => {
            if (isIdentityCheckCancelled(cause)) {
              setAllowNote({ runId: run.id, text: ALLOW_COPY.cancelled, tone: 'quiet' });
              return;
            }
            // 409: another device answered first. The live run carries that answer.
            if (cause instanceof SecureApiError && cause.status === 409) return;
            setAllowNote({
              runId: run.id,
              text: cause instanceof SecureApiError && cause.message ? cause.message : ALLOW_COPY.failed,
              tone: 'danger',
            });
          })
          .finally(() => {
            setAllowBusy(null);
            setBusy((current) =>
              current.action === 'allow' ? { runId: null, action: null, stepKey: null } : current,
            );
          });
      },
      onSaveSignIn: (run, site) => setSecureSheet({ kind: 'sign_in', site, runId: run.id }),
      onOpenSecureSettings: () => {
        window.location.assign('/settings?tab=secure');
      },
      // Steering (T7–T9, lead decisions 5 and 6). The thread keeps the note; the run reads it.
      onSteerNote: async (runId, note, noteId) => {
        try {
          await postJson(
            `/api/albatross/work/${encodeURIComponent(workId)}/run`,
            { action: 'steer', runId, note, noteId },
            THREAD_COPY.steerFailed,
          );
          return true;
        } catch {
          return false;
        }
      },
      // The error of a failed stop or resume shows on the run's block.
      onRedirectStop: (runId) =>
        runAction(
          'cancel',
          { runId },
          { runId, action: 'stop', stepKey: runs.find((run) => run.id === runId)?.stepKey ?? null },
        ),
      onRedirectResume: (runId, note) =>
        runAction(
          'resume',
          { runId, note },
          { runId, action: 'resume', stepKey: runs.find((run) => run.id === runId)?.stepKey ?? null },
        ),
    }),
    [
      activeRun,
      allowWithCheck,
      detail,
      navDeps,
      queryClient,
      runAction,
      runs,
      session,
      sessionAction,
      setRegion,
      setSelectedWorkId,
      workId,
    ],
  );

  if (detail === undefined) {
    return (
      <div className="flex h-full items-center justify-center text-[12.5px] text-[var(--color-text-muted)]">
        {THREAD_COPY.loading}
      </div>
    );
  }
  if (!detail) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center">
        <div>
          <p className="text-[14px] font-medium">{THREAD_COPY.gone}</p>
          <Button className="mt-4" size="sm" variant="outline" onClick={() => setSelectedWorkId(null)}>
            {THREAD_COPY.backToList}
          </Button>
        </div>
      </div>
    );
  }

  const visibleDetail: WorkDetailData = optimisticDone.size
    ? {
        ...detail,
        execution: {
          ...detail.execution,
          guideSteps: guideStepsWithOptimisticCompletion(detail.execution.guideSteps, optimisticDone),
        },
      }
    : detail;
  // The projection's run rows fill the thread until the live query answers.
  const threadRuns: readonly ThreadRunView[] = liveRuns
    ? runs
    : visibleDetail.execution.guideSteps
        .map((step) => runForStep(null, step))
        .filter((run): run is NonNullable<typeof run> => Boolean(run))
        .map((run) => ({ ...run, question: null }) as ThreadRunView);

  const model: ThreadModel = {
    workId,
    title: workTitle(visibleDetail),
    detail: visibleDetail,
    runs: threadRuns,
    session: session ?? null,
    personalDetails: personalDetails.data?.details,
    nowMs,
    busy,
    runError,
    answerErrors,
    undoneOperations,
    undoing,
    completing,
    error,
    region,
    wide,
    shape,
    secureItems: secure.data?.items,
    allowBusy,
    allowNote,
    allowAnswered,
    signInSaved,
    replyInProgress: row?.status === 'answering',
    document: openDocument,
    documentDone,
    workQuestion,
  };
  // The rail beside the thread (lead decision 3): 300 px on desktops, 272 px on
  // laptops, where it also yields to an open region; none below 1024 px.
  const showRail = wide && region !== 'document' && (railWide || region === null);
  return (
    <>
      <div className="flex h-full min-h-0 min-w-0">
        {showRail ? (
          <ThreadRail
            rows={rows}
            laterCount={laterCount}
            openWorkId={workId}
            filter={listFilter}
            onFilterChange={setListFilter}
            nowMs={railNowMs}
            areaName={railAreaName}
            draftWorkIds={draftIds}
            width={railWide ? 300 : 272}
            onOpen={setSelectedWorkId}
            onAction={(kind, target) => {
              if (kind === 'answer') setAnsweringWorkId(target.workId);
              else railActions.act(kind, target);
            }}
            onSteer={railActions.steer}
            onMarkUnread={(target) => void railActions.markUnread(target)}
            answeringWorkId={answeringWorkId}
            renderAnswer={(target) => (
              <ThreadAnswerInPlace
                row={target}
                onDone={() => setAnsweringWorkId(null)}
                onCancel={() => setAnsweringWorkId(null)}
                onOpenThread={() => {
                  setAnsweringWorkId(null);
                  setSelectedWorkId(target.workId);
                }}
              />
            )}
            onShowFinished={() => setSelectedWorkId(null)}
            onShowLater={() => setSelectedWorkId(null)}
          />
        ) : null}
        <div className="min-h-0 min-w-0 flex-1">
          <WorkThreadView model={model} handlers={handlers} />
        </div>
      </div>
      <SecureItemSheet
        request={secureSheet}
        onClose={() => setSecureSheet(null)}
        onSave={createSecureItem}
        onSaved={() => {
          if (secureSheet) setSignInSaved((current) => new Set([...current, secureSheet.runId]));
          void queryClient.invalidateQueries({ queryKey: SECURE_DETAILS_QUERY_KEY });
        }}
        hasDateOfBirth={Boolean(secure.data?.items.some((item) => item.kind === 'date_of_birth'))}
      />
    </>
  );
}
