// The step runner (docs/albatross-step-runner.md).
//
// One run works one plan step as far as it can, with no person in front of
// it, and ends with a handoff: what it did, what it made, and the one next
// action for the user. The queue lives in Convex (convex/albatrossStepRuns.ts);
// this module claims a run, keeps its lease, runs the agent, and settles it.
//
// Limits: the run meter counts every model call in the run, including the
// calls inside tools (document generation), and stops the run at its cost
// budget. A wall-clock deadline stops it at its time budget. A stopped run
// keeps its work and hands off "Continue".
//
// Proof: an agent that says "done" must pass the evidence gate against the
// step's doneWhen. A claim the gate does not accept becomes a "check it"
// handoff, so the UI never shows a verified check for a self-report.

import { randomUUID } from 'node:crypto';
import { generateText, hasToolCall, type ModelMessage, stepCountIs } from 'ai';
import { runWithAiRequestContext } from '../ai/context';
import {
  AiAccessError,
  agentProviderOptions,
  canFailOverAgentRuntime,
  maxOutputTokensForFeature,
  recordAgentUsage,
  resolveAgentRuntimes,
} from '../ai/gateway';
import { describeModelError, redactModelErrorMessage } from '../ai/log-error';
import { liftToolsForAgent } from '../ai/loop';
import { BriefBudgetExhaustedError, BriefEditionMeter, runWithBriefMeter } from '../brief/budget';
import { api, convexMutation, convexQuery } from '../hosted/convex';
import { pausedAssistantRisksStrict } from '../hosted/standing-orders';
import { resolveBriefTimezone } from '../mail/brief-timezone';
import { dispatchNativeNotification } from '../notifications/native-delivery';
import { aboutUserBlock, listPersonalDetails } from '../personal-details/store';
import type { SecureAllowRequest, SecureSaveSignInOffer } from '../secure/contract';
import { secureStoreEnabledFor } from '../secure/flag';
import { createSecureRunAccess, type SecureLeak, type SecureRunAccess } from '../secure/runner-access';
import { type SecureInventoryEntry, secureInventory } from '../secure/store';
import { truncateText } from '../shared/text';
import { getChatSession } from '../store/chat-sessions';
import { AgentBrowser, type AgentConnector, playwrightAgentConnector } from './browser-agent';
import { bindSessionWriter, releaseSessionWriter, sessionOptionsForUser } from './browser-contexts';
import {
  browserSessionsConfigured,
  createBrowserSession,
  releaseBrowserSession,
  sessionConnectUrl,
} from './browser-session';
import { evidenceSatisfies } from './evidence-gate';
import { completeWorkStep } from './step-execution';
import {
  isAutomaticTrigger,
  STEP_RUN_MAX_MODEL_STEPS,
  STEP_RUN_NOTIFY_AFTER_MS,
  type StepRunTrigger,
  stepAcceptsTrigger,
  stepRunFeature,
  stepRunLimits,
  stepRunsEnabled,
} from './step-run-policy';
import {
  type PreviousRun,
  type RunnerStep,
  runnerContext,
  runnerTaskMessage,
  STEP_RUNNER_RULES,
  steerMessage,
  threadUserNotes,
} from './step-run-prompt';
import { addSecureFetchTool, buildRunnerTools, type HandoffInput, type RunArtifact } from './step-run-tools';
import { workThreadSessionId } from './thread-contract';

const HEARTBEAT_MS = 30_000;

export interface ClaimedRun {
  _id: string;
  userId: string;
  workId: string;
  stepKey: string;
  stepIdentity: string;
  stepTitle: string;
  trigger: StepRunTrigger;
  attempts: number;
  startedAt?: number;
  parentRunId?: string;
  resumeNote?: string;
  browserSessionId?: string;
  log: Array<{ at: number; text: string }>;
  artifacts: RunArtifact[];
  budget?: { timeMs: number; costUsd: number; inputTokens: number; outputTokens: number; calls: number };
}

export interface SettleInput {
  outcome?: 'done' | 'ready_for_you' | 'your_turn' | 'needs_answer' | 'stopped';
  summary?: string;
  next?: {
    kind: NonNullable<HandoffInput['next']>['kind'];
    label: string;
    detail: string;
    doneLabel?: string;
    target?: { kind: string; id?: string; url?: string; accountId?: string };
    allow?: SecureAllowRequest;
    saveSignIn?: SecureSaveSignInOffer;
  };
  budget?: {
    timeMs: number;
    costUsd: number;
    inputTokens: number;
    outputTokens: number;
    calls: number;
    exhausted?: 'time' | 'cost';
  };
  error?: string;
  retryable?: boolean;
}

export interface StepRunnerDependencies {
  convexQuery: typeof convexQuery;
  convexMutation: typeof convexMutation;
  resolveAgentRuntimes: typeof resolveAgentRuntimes;
  generateText: typeof generateText;
  liftTools: typeof liftToolsForAgent;
  pausedRisks: typeof pausedAssistantRisksStrict;
  resolveTimezone: typeof resolveBriefTimezone;
  evidenceSatisfies: typeof evidenceSatisfies;
  completeWorkStep: typeof completeWorkStep;
  browserConfigured: typeof browserSessionsConfigured;
  createBrowserSession: typeof createBrowserSession;
  releaseBrowserSession: typeof releaseBrowserSession;
  sessionOptions: typeof sessionOptionsForUser;
  bindWriter: typeof bindSessionWriter;
  releaseWriter: typeof releaseSessionWriter;
  connectUrl: (sessionId: string) => string;
  connector: AgentConnector;
  notify: (userId: string, notificationId: string) => Promise<unknown>;
  recordUsage: typeof recordAgentUsage;
  now: () => number;
  heartbeatMs: number;
  reportError: typeof console.error;
  /** The account name and email (the users table), for personal details and the prompt. */
  readUser: (userId: string) => Promise<{ name: string | null; email: string | null }>;
  /** The saved personal details, for the "About the user" block (names only). */
  listDetails: typeof listPersonalDetails;
  /** The newest user messages of the Work thread, oldest first. */
  readThreadNotes: (userId: string, workId: string) => Promise<string[]>;
  /** The run's access to Passwords and IDs, or null when the store is off for the user. */
  secureAccess: (input: {
    userId: string;
    runId: string;
    workId: string;
    stepKey: string;
    log: (line: string) => Promise<void>;
  }) => SecureRunAccess | null;
  /** What the runner may know about the saved items: no values. */
  secureInventory: (userId: string) => Promise<SecureInventoryEntry[]>;
}

/** The account name and email of a user, for the run's request context. Null fields when unknown. */
export async function readUserProfile(userId: string, query: typeof convexQuery = convexQuery) {
  const row = await query<{ name?: string | null; email?: string | null } | null>(api.users.getByClerkId, {
    userId,
  }).catch(() => null);
  return { name: row?.name ?? null, email: row?.email ?? null };
}

/** The user's newest messages in the Work thread, read from its canonical chat session. */
export async function readThreadUserNotes(userId: string, workId: string): Promise<string[]> {
  const session = await runWithAiRequestContext({ userId, agent: 'ai' }, () =>
    getChatSession(workThreadSessionId(workId)),
  );
  return threadUserNotes(session?.messages || []);
}

const defaults: StepRunnerDependencies = {
  convexQuery,
  convexMutation,
  resolveAgentRuntimes,
  generateText,
  liftTools: liftToolsForAgent,
  // A failed read fails the run: a background writer never guesses a switch.
  pausedRisks: pausedAssistantRisksStrict,
  resolveTimezone: resolveBriefTimezone,
  evidenceSatisfies,
  completeWorkStep,
  browserConfigured: browserSessionsConfigured,
  createBrowserSession,
  releaseBrowserSession,
  sessionOptions: (userId) => sessionOptionsForUser(userId),
  bindWriter: (userId, options, sessionId) => bindSessionWriter(userId, options, sessionId),
  releaseWriter: (userId, options) => releaseSessionWriter(userId, options),
  connectUrl: sessionConnectUrl,
  connector: playwrightAgentConnector,
  notify: dispatchNativeNotification,
  recordUsage: recordAgentUsage,
  now: Date.now,
  heartbeatMs: HEARTBEAT_MS,
  reportError: console.error,
  readUser: (userId) => readUserProfile(userId),
  listDetails: listPersonalDetails,
  readThreadNotes: readThreadUserNotes,
  secureAccess: (input) => (secureStoreEnabledFor(input.userId) ? createSecureRunAccess(input) : null),
  secureInventory,
};

class RunCancelled extends Error {
  constructor() {
    super('The run was stopped.');
    this.name = 'RunCancelled';
  }
}

class RunDeadline extends Error {
  constructor() {
    super('The run used its time.');
    this.name = 'RunDeadline';
  }
}

interface SessionRow {
  sessionId: string;
  status: string;
  stepKey?: string | null;
}

/**
 * The runner's prepareStep for steer notes. generateText rebuilds each step
 * from the first messages plus the step responses, so a message added in one
 * prepareStep is gone in the next. This keeps every note at the point where it
 * arrived (between two complete steps, so no tool call loses its result) for
 * all later steps. Notes read before this attempt sit after the first messages.
 */
export function steerPrepareStep(input: {
  received: string[];
  initialCount: number;
  take: () => Promise<Array<{ text: string }>>;
  log: (line: string) => Promise<void>;
}) {
  const inserts: Array<{ at: number; message: ModelMessage }> = input.received.length
    ? [{ at: input.initialCount, message: steerMessage([...input.received]) }]
    : [];
  return async ({ messages: stepMessages }: { messages: ModelMessage[] }) => {
    const notes = (await input.take()) || [];
    if (notes.length) {
      const texts = notes.map((note) => note.text);
      for (const text of texts) await input.log(`Read your note: ${truncateText(text, 160)}`);
      input.received.push(...texts);
      inserts.push({ at: stepMessages.length, message: steerMessage(texts) });
    }
    if (!inserts.length) return undefined;
    const out = [...stepMessages];
    // From the highest index down, so each earlier index is still correct.
    for (const insert of [...inserts].sort((a, b) => b.at - a.at))
      out.splice(Math.min(insert.at, out.length), 0, insert.message);
    return { messages: out };
  };
}

/** The handoff when the run produced no step_handoff call. */
export function fallbackHandoff(text: string, artifacts: RunArtifact[]): SettleInput {
  const summary =
    truncateText(text.replace(/\s+/g, ' ').trim(), 600) || 'I worked on the step but did not finish it.';
  const draft = artifacts.find((artifact) => artifact.kind === 'draft');
  const document = artifacts.find((artifact) => artifact.kind === 'document');
  if (draft)
    return {
      outcome: 'ready_for_you',
      summary,
      next: {
        kind: 'review_draft',
        label: 'Read the draft',
        detail: 'I saved a draft. Read it and send it when it is right.',
        target: { kind: 'draft', id: draft.id, accountId: draft.accountId },
      },
    };
  if (document)
    return {
      outcome: 'ready_for_you',
      summary,
      next: {
        kind: 'review_document',
        label: 'Open the document',
        detail: 'I wrote a document. Check it before you use it.',
        target: { kind: 'document', id: document.id, url: document.url },
      },
    };
  return {
    outcome: 'stopped',
    summary,
    next: { kind: 'continue', label: 'Continue', detail: 'Press Continue and I take the step further.' },
  };
}

/** A handoff whose next action points at a real thing the run made. */
export function normalizeHandoff(
  handoff: HandoffInput,
  context: {
    artifacts: RunArtifact[];
    sessionId?: string | null;
    questionId?: string | null;
    /** The run's newest new-site question (lib/secure/runner-access.ts). */
    allow?: SecureAllowRequest | null;
    /** A sign-in page with no saved sign-in: the block offers to save one. */
    saveSignIn?: SecureSaveSignInOffer | null;
  },
): SettleInput {
  const next: SettleInput['next'] = handoff.next ? { ...handoff.next } : undefined;
  // Models fill optional fields with empty strings; an empty target is no target.
  if (next?.target) {
    const target = Object.fromEntries(
      Object.entries(next.target).filter(([, value]) => typeof value !== 'string' || value.trim()),
    ) as NonNullable<typeof next.target>;
    next.target = target.id || target.url ? target : undefined;
  }
  if (next && !next.target) {
    const find = (kind: RunArtifact['kind']) =>
      [...context.artifacts].reverse().find((artifact) => artifact.kind === kind);
    if (next.kind === 'review_draft') {
      const draft = find('draft');
      if (draft) next.target = { kind: 'draft', id: draft.id, accountId: draft.accountId };
    } else if (next.kind === 'review_document') {
      const document = find('document');
      if (document) next.target = { kind: 'document', id: document.id, url: document.url };
    } else if (next.kind === 'approve') {
      const approval = find('approval');
      if (approval) next.target = { kind: 'approval', id: approval.id };
    }
  }
  if (next && (next.kind === 'sign_in' || next.kind === 'finish_on_page') && context.sessionId)
    next.target = { kind: 'session', id: context.sessionId };
  if (next && next.kind === 'answer' && context.questionId)
    next.target = { kind: 'question', id: context.questionId };
  let outcome = handoff.outcome;
  if (next?.kind === 'allow_secure') {
    if (context.allow) {
      // The server's own words: the model never builds the question about a saved value.
      outcome = 'needs_answer';
      next.label = 'Answer';
      next.detail = `Use your saved ${context.allow.itemLabel} on ${context.allow.site}?`;
      next.doneLabel = undefined;
      next.allow = context.allow;
      next.target = { kind: 'secure', id: context.allow.itemId, url: `https://${context.allow.host}` };
    } else {
      next.kind = 'finish_on_page';
      if (context.sessionId) next.target = { kind: 'session', id: context.sessionId };
    }
  }
  if (next?.kind === 'sign_in' && context.saveSignIn) next.saveSignIn = context.saveSignIn;
  return {
    outcome,
    summary: handoff.summary,
    ...(next ? { next } : {}),
  };
}

function stopTimer(timer: ReturnType<typeof setInterval> | null) {
  if (timer) clearInterval(timer);
}

/**
 * Claim and run one queued step run. Every exit settles the run or leaves it
 * to the lease: a lost process never leaves a run "working" forever.
 */
export async function runStepRun(
  userId: string,
  runId: string,
  overrides: Partial<StepRunnerDependencies> = {},
): Promise<{ state: string | null }> {
  const deps = { ...defaults, ...overrides };
  const token = randomUUID();
  const fence = { userId, id: runId, token };
  const run = await deps.convexMutation<ClaimedRun | null>(api.albatrossStepRuns.claim, fence);
  if (!run) return { state: null };

  const startedAt = deps.now();
  const limits = stepRunLimits();
  const priorMs = Math.max(0, Number(run.budget?.timeMs) || 0);
  const remainingMs = Math.max(1_000, limits.timeBudgetMs - priorMs);
  const cancel = new AbortController();
  // A value this run typed showed on a page outside its sites (SecureLeak).
  const leakStop = new AbortController();
  let leak: SecureLeak | null = null;
  const deadline = new AbortController();
  const deadlineTimer = setTimeout(() => deadline.abort(new RunDeadline()), remainingMs);
  (deadlineTimer as { unref?: () => void }).unref?.();
  let heartbeat: ReturnType<typeof setInterval> | null = setInterval(() => {
    deps
      .convexMutation<boolean>(api.albatrossStepRuns.heartbeat, fence)
      .then((ok) => {
        if (!ok) cancel.abort(new RunCancelled());
      })
      .catch(() => undefined);
  }, deps.heartbeatMs);
  (heartbeat as { unref?: () => void }).unref?.();
  const meter = new BriefEditionMeter({
    timeBudgetMs: limits.timeBudgetMs,
    costBudgetUsd: limits.costBudgetUsd,
    prior: run.budget,
  });
  const artifacts: RunArtifact[] = [...(run.artifacts || [])];
  let connection: Awaited<ReturnType<AgentConnector>> | null = null;
  let browser: AgentBrowser | null = null;
  let sessionId: string | null = run.browserSessionId || null;
  let handoff: HandoffInput | null = null;
  let usedPage = false;

  const settle = async (input: SettleInput) => {
    stopTimer(heartbeat);
    heartbeat = null;
    const record = meter.record(false);
    return deps.convexMutation<{ state: string | null }>(api.albatrossStepRuns.settle, {
      ...fence,
      ...input,
      ...(input.next?.target
        ? {
            next: {
              ...input.next,
              target: Object.fromEntries(
                Object.entries(input.next.target).filter(([, value]) => value !== undefined),
              ),
            },
          }
        : {}),
      budget: {
        timeMs: priorMs + Math.max(0, deps.now() - startedAt),
        costUsd: record.costUsd,
        inputTokens: record.inputTokens,
        outputTokens: record.outputTokens,
        calls: record.calls,
        ...(input.budget?.exhausted ? { exhausted: input.budget.exhausted } : {}),
      },
    });
  };
  const log = async (line: string) => {
    await deps.convexMutation(api.albatrossStepRuns.progress, { ...fence, line }).catch(() => undefined);
  };
  const setSessionStatus = async (status: 'agent' | 'user', detail: string) => {
    if (!sessionId) return;
    await deps
      .convexMutation(api.albatrossBrowserSessions.setSessionStatus, {
        userId,
        sessionId,
        status,
        statusDetail: truncateText(detail, 300),
        stepKey: run.stepKey,
        stepIdentity: run.stepIdentity,
      })
      .catch(() => undefined);
  };

  try {
    if (!stepRunsEnabled()) return await settle({ error: 'Step runs are off.' });
    const detail = await deps.convexQuery<any>(api.albatrossWorkV2.workDetail, {
      userId,
      workId: run.workId,
    });
    const step: RunnerStep | undefined = (detail?.execution?.guideSteps || []).find(
      (entry: RunnerStep) => entry.key === run.stepKey,
    );
    if (!detail?.work || !step) return await settle({ error: 'This step is no longer in the plan.' });
    if (step.done) return await settle({ outcome: 'done', summary: 'The step was already done.' });
    // The queue is server-only, but the step may have changed since: a run
    // never works a step that stays with the user.
    if (!stepAcceptsTrigger(step as any, run.trigger === 'resume' ? 'user' : run.trigger))
      return await settle({ error: 'This step stays with you.' });

    const parent: PreviousRun | null = run.parentRunId
      ? await deps
          .convexQuery<any>(api.albatrossStepRuns.get, { userId, id: run.parentRunId })
          .catch(() => null)
      : null;
    // A retried attempt of this same run continues from what the first attempt
    // did (its log and its artifacts), instead of doing the step again.
    const previous: PreviousRun | null =
      run.attempts > 1 && ((run.log || []).length || (run.artifacts || []).length)
        ? {
            summary: `An earlier attempt of this run stopped before it finished.${parent?.summary ? ` Before that: ${parent.summary}` : ''}`,
            log: run.log,
            artifacts: run.artifacts,
            next: parent?.next ?? null,
          }
        : parent;
    // A resumed run picks up the earlier run's shared browser when it is still open.
    if (sessionId) {
      const live = await deps
        .convexQuery<SessionRow | null>(api.albatrossBrowserSessions.activeSessionForWork, {
          userId,
          workId: run.workId,
        })
        .catch(() => null);
      if (!live || live.sessionId !== sessionId) sessionId = null;
    }
    const browserAvailable = deps.browserConfigured();
    const timezone = await deps.resolveTimezone(userId, undefined).catch(() => 'UTC');
    const paused = await deps.pausedRisks(userId);
    const lifted = deps.liftTools(runId, timezone, undefined, { clientPlatform: 'ios', pausedRisks: paused });
    const profile = await deps.readUser(userId).catch(() => ({ name: null, email: null }));
    const secure = deps.secureAccess({ userId, runId, workId: run.workId, stepKey: run.stepKey, log });
    const secureItems = secure ? await deps.secureInventory(userId).catch(() => []) : null;
    const [aboutUser, threadNotes] = await Promise.all([
      deps
        .listDetails({ userId, name: profile.name, email: profile.email })
        .then(aboutUserBlock)
        .catch(() => ''),
      deps.readThreadNotes(userId, run.workId).catch(() => [] as string[]),
    ]);

    // One open for the whole run: parallel browser calls in one model step
    // share the same promise instead of each starting a session.
    let opening: Promise<AgentBrowser> | null = null;
    const startBrowser = async (): Promise<AgentBrowser> => {
      if (!sessionId) {
        const options = await deps.sessionOptions(userId);
        let session: Awaited<ReturnType<typeof deps.createBrowserSession>>;
        try {
          session = await deps.createBrowserSession(fetch, options);
        } catch (error) {
          await deps.releaseWriter(userId, options).catch(() => undefined);
          throw error;
        }
        try {
          if (!(await deps.bindWriter(userId, options, session.sessionId)))
            throw new Error('The saved sign-in place could not be bound.');
          await deps.convexMutation(api.albatrossBrowserSessions.openSession, {
            userId,
            workId: run.workId,
            stepKey: run.stepKey,
            stepIdentity: run.stepIdentity,
            sessionId: session.sessionId,
            liveViewUrl: session.liveViewUrl,
            replayUrl: session.replayUrl,
          });
        } catch (error) {
          await deps.releaseBrowserSession(session.sessionId).catch(() => undefined);
          await deps.releaseWriter(userId, options).catch(() => undefined);
          throw error;
        }
        sessionId = session.sessionId;
        await deps.convexMutation(api.albatrossStepRuns.progress, { ...fence, browserSessionId: sessionId });
      }
      connection = await deps.connector(deps.connectUrl(sessionId));
      const page = await connection.page();
      if (!page) throw new Error('The shared browser has no page.');
      browser = new AgentBrowser(page, secure);
      usedPage = true;
      return browser;
    };
    const openBrowser = (): Promise<AgentBrowser> => {
      if (browser) return Promise.resolve(browser);
      opening ??= startBrowser().catch((error) => {
        opening = null;
        throw error;
      });
      return opening;
    };

    const tools = buildRunnerTools(lifted, {
      browserAvailable,
      secure,
      log,
      artifact: async (artifact) => {
        artifacts.push(artifact);
        await deps
          .convexMutation(api.albatrossStepRuns.progress, { ...fence, artifact })
          .catch(() => undefined);
      },
      browser: openBrowser,
      browserStatus: (statusDetail) => setSessionStatus('agent', statusDetail),
      enqueueApproval: async (input) =>
        String(
          await deps.convexMutation(api.albatrossWork.enqueueApproval, {
            userId,
            kind: input.kind,
            title: input.title,
            detail: `From the step "${truncateText(run.stepTitle, 160)}".`,
            intentId: run.workId,
            operationBatchId: runId,
            artifactKind: 'step_run',
            // One approval for each call: a retried attempt gets the same row back.
            artifactId: `${runId}:${approvalKey(input.toolName, input.toolArgs)}`,
            dedupe: true,
            toolName: input.toolName,
            toolArgs: input.toolArgs,
            risk: 'Reaches other people. It runs only after you approve it.',
          }),
        ),
      finish: (input) => {
        handoff = input;
      },
      stopForLeak: (found) => {
        if (leak) return;
        leak = found;
        leakStop.abort(found);
      },
    });
    addSecureFetchTool(tools, secure);

    const system = [
      STEP_RUNNER_RULES,
      runnerContext({
        detail,
        step,
        trigger: run.trigger,
        previous,
        resumeNote: run.resumeNote,
        browserAvailable,
        sessionOpen: Boolean(sessionId),
        limits,
        aboutUser,
        threadNotes,
        secureItems,
      }),
    ].join('\n\n');
    const messages: ModelMessage[] = [{ role: 'user', content: runnerTaskMessage(step, Boolean(previous)) }];
    const feature = stepRunFeature(run.trigger);
    const runtimes = await deps.resolveAgentRuntimes({ userId, speed: 'primary', feature });
    const signal = AbortSignal.any([cancel.signal, deadline.signal, meter.signal, leakStop.signal]);
    await log(previous ? 'Continued the step.' : 'Started on the step.');

    let result: Awaited<ReturnType<typeof generateText>> | null = null;
    let lastError: unknown;
    // Notes the run already read. A failover attempt starts from the first
    // messages again, so it gets these notes at once.
    const receivedNotes: string[] = [];
    for (let index = 0; index < runtimes.length && !result; index += 1) {
      const runtime = runtimes[index];
      try {
        result = await runWithAiRequestContext(
          {
            userId,
            userName: profile.name,
            userEmail: profile.email,
            agent: 'ai',
            runId,
            operationBatchId: runId,
            userTimezone: timezone,
          },
          () =>
            runWithBriefMeter(meter, () =>
              deps.generateText({
                model: runtime.model,
                system,
                messages,
                tools,
                // A note the user writes while the run works reaches the next model
                // step and stays for every step after it (steerPrepareStep).
                prepareStep: steerPrepareStep({
                  received: receivedNotes,
                  initialCount: messages.length,
                  take: () =>
                    deps
                      .convexMutation<Array<{ text: string }> | null>(
                        api.albatrossStepRuns.takeSteerNotes,
                        fence,
                      )
                      .then((notes) => {
                        // Null: the run was stopped ("Stop", "Stop and redirect") or lost.
                        // Stop at this step, not at the next heartbeat (docs/albatross-threads.md, T8).
                        if (notes === null) cancel.abort(new RunCancelled());
                        return notes ?? [];
                      })
                      .catch(() => []),
                  log,
                }),
                stopWhen: [hasToolCall('step_handoff'), stepCountIs(STEP_RUN_MAX_MODEL_STEPS)],
                abortSignal: signal,
                maxOutputTokens: maxOutputTokensForFeature(feature),
                providerOptions: agentProviderOptions(runtime, `step-run:${userId}`),
                onStepFinish: (stepResult: any) => {
                  meter.addStep(runtime, stepResult?.usage);
                },
              }),
            ),
        );
        await deps.recordUsage(runtime, feature, (result as any).totalUsage ?? result.usage, true);
      } catch (error) {
        lastError = error;
        await deps
          .recordUsage(
            runtime,
            feature,
            undefined,
            false,
            redactModelErrorMessage(String((error as Error)?.message || error)),
          )
          .catch(() => undefined);
        // Fail over only before the run did anything visible.
        const madeNothing = artifacts.length === (run.artifacts || []).length && !handoff;
        if (signal.aborted || !madeNothing || !canFailOverAgentRuntime(error, feature, runtime)) throw error;
      }
    }
    if (!result) throw lastError ?? new Error('No model runtime answered.');

    const finalHandoff = handoff as HandoffInput | null;
    let questionId: string | null = null;
    if (finalHandoff?.outcome === 'needs_answer' && finalHandoff.question) {
      const form = finalHandoff.question.form;
      questionId = await deps
        .convexMutation<string>(api.albatrossWorkV2.upsertQuestion, {
          userId,
          workId: run.workId,
          kind: 'clarification',
          prompt: form?.title || finalHandoff.question.prompt || 'Albatross needs an answer to continue.',
          reason: form?.detail || `Needed to continue the step "${truncateText(run.stepTitle, 160)}".`,
          options: form
            ? undefined
            : (finalHandoff.question.options || []).map((option) => ({ id: option.id, label: option.label })),
          ...(form ? { form } : {}),
          // A new run's question never receives an earlier run's answer.
          dedupeSalt: runId,
        })
        .then((id) => (id ? String(id) : null))
        .catch(() => null);
    }
    const saveSignIn =
      finalHandoff?.next?.kind === 'sign_in' && secure && browser
        ? await secure.signInOffer((browser as AgentBrowser).currentUrl()).catch(() => null)
        : null;
    let settled: SettleInput = finalHandoff
      ? normalizeHandoff(
          finalHandoff.outcome === 'needs_answer'
            ? {
                ...finalHandoff,
                next: finalHandoff.next ?? {
                  kind: 'answer',
                  label: 'Answer',
                  detail: 'Answer the question and I continue the step.',
                },
              }
            : finalHandoff,
          { artifacts, sessionId, questionId, allow: secure?.pendingAllow() ?? null, saveSignIn },
        )
      : fallbackHandoff(result.text || '', artifacts);

    // A cancel or a lost lease shows only at the next heartbeat. Ask now, before
    // anything checks the step off or tells the user about it.
    // false means stopped or lost; null means the check itself failed twice.
    const heartbeatOnce = () => deps.convexMutation<boolean>(api.albatrossStepRuns.heartbeat, fence);
    const ownership: boolean | null = await heartbeatOnce()
      .catch(() => heartbeatOnce())
      .catch(() => null);
    if (ownership === false) throw new RunCancelled();
    // Ownership unknown: check nothing off and tell nobody. A done claim
    // waits for the user; settle is fenced, so it decides who owns the run.
    if (ownership === null && settled.outcome === 'done') {
      settled = {
        outcome: 'ready_for_you',
        summary: settled.summary,
        next: {
          kind: 'review',
          label: 'Check the result',
          detail: 'I think the step is done. Check it, then mark the step done.',
        },
      };
    }
    if (settled.outcome === 'done') {
      settled = await proveDone({
        deps,
        userId,
        run,
        step,
        detail,
        handoff: finalHandoff,
        artifacts,
        browser,
        sessionId,
        settled,
      });
    }
    if (sessionId && usedPage) {
      const kind = settled.next?.kind;
      await setSessionStatus(
        'user',
        kind === 'sign_in' || kind === 'finish_on_page'
          ? settled.next!.detail
          : 'Albatross is done with the page. You have it now.',
      );
    }
    const outcome = await settle(settled);
    if (outcome?.state && ownership) await notifyHandoff(deps, userId, run, settled, deps.now() - startedAt);
    return outcome;
  } catch (error) {
    if (cancel.signal.aborted || error instanceof RunCancelled) {
      // The user stopped the run (the cancel closed the row), or the lease
      // moved to another attempt. The page is the user's either way.
      await setSessionStatus('user', 'You have the page.');
      return { state: 'cancelled' };
    }
    if (leak || leakStop.signal.aborted) {
      // The run stops at once. The model got at most one bit, and the user has the page.
      if (sessionId && usedPage)
        await setSessionStatus(
          'user',
          'Albatross stopped: this page showed a saved value. You have the page.',
        );
      const stopped: SettleInput = {
        outcome: 'your_turn',
        summary: 'I stopped because a page outside the saved sites showed one of your saved values.',
        next: {
          kind: 'finish_on_page',
          label: 'Open the page',
          detail: 'Check the page and what it shows. Albatross did not continue on it.',
          ...(sessionId ? { target: { kind: 'session', id: sessionId } } : {}),
        },
      };
      const outcome = await settle(stopped);
      if (outcome?.state) await notifyHandoff(deps, userId, run, stopped, deps.now() - startedAt);
      return outcome;
    }
    const exhausted: 'time' | 'cost' | null =
      deadline.signal.aborted || error instanceof RunDeadline
        ? 'time'
        : error instanceof BriefBudgetExhaustedError || meter.exhausted
          ? meter.exhausted || 'cost'
          : null;
    if (exhausted) {
      if (sessionId && usedPage)
        await setSessionStatus('user', 'Albatross stopped at its limit. You have the page.');
      const stopped: SettleInput = {
        outcome: 'stopped',
        summary:
          exhausted === 'time'
            ? 'I used the time for this run before I finished the step.'
            : 'I used the cost limit for this run before I finished the step.',
        next: {
          kind: 'continue',
          label: 'Continue',
          detail: 'Press Continue to start a new run that picks up from here.',
        },
        budget: { timeMs: 0, costUsd: 0, inputTokens: 0, outputTokens: 0, calls: 0, exhausted },
      };
      const outcome = await settle(stopped);
      if (outcome?.state) await notifyHandoff(deps, userId, run, stopped, deps.now() - startedAt);
      return outcome;
    }
    // No model access (no plan, no key, the month's budget is used up): the
    // gateway's message is user copy, and another attempt cannot succeed.
    if (error instanceof AiAccessError || (error as Error)?.name === 'AiAccessError')
      return await settle({ error: truncateText((error as Error).message, 300) }).catch(() => ({
        state: null,
      }));
    deps.reportError('[step-runner] run failed', runId, describeModelError(error));
    return await settle({
      error: 'The run failed. Try again.',
      retryable: isRetryableRunError(error),
    }).catch(() => ({ state: null }));
  } finally {
    clearTimeout(deadlineTimer);
    stopTimer(heartbeat);
    meter.finish();
    if (connection) await (connection as Awaited<ReturnType<AgentConnector>>).close().catch(() => undefined);
  }
}

/** A stable key for one tool call, for approval dedupe across attempts. */
export function approvalKey(toolName: string, args: unknown): string {
  const stable = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(stable)
      : value && typeof value === 'object'
        ? Object.fromEntries(
            Object.keys(value as Record<string, unknown>)
              .sort()
              .map((key) => [key, stable((value as Record<string, unknown>)[key])]),
          )
        : value;
  const text = `${toolName}:${JSON.stringify(stable(args))}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** Provider hiccups and lost connections may retry once; argument and access errors may not. */
export function isRetryableRunError(error: unknown): boolean {
  const message = String((error as any)?.message || error || '');
  const status = Number((error as any)?.statusCode ?? (error as any)?.status);
  if (status === 429 || status >= 500) return true;
  return /ECONNRESET|ETIMEDOUT|socket hang up|fetch failed|temporarily unavailable|Provider returned error/i.test(
    message,
  );
}

async function proveDone(input: {
  deps: StepRunnerDependencies;
  userId: string;
  run: ClaimedRun;
  step: RunnerStep;
  detail: any;
  handoff: HandoffInput | null;
  artifacts: RunArtifact[];
  browser: AgentBrowser | null;
  sessionId: string | null;
  settled: SettleInput;
}): Promise<SettleInput> {
  const { deps, userId, run, step } = input;
  const page = input.browser ? await input.browser.readText().catch(() => null) : null;
  const evidenceText = [
    input.handoff?.evidence ? `Agent evidence: ${input.handoff.evidence}` : null,
    `Agent summary: ${input.settled.summary || ''}`,
    input.artifacts.length
      ? `Made: ${input.artifacts.map((artifact) => `${artifact.kind} "${artifact.title}"`).join('; ')}`
      : null,
    page ? `Page: ${page.url}\nTitle: ${page.title}\n${page.text}` : null,
  ]
    .filter(Boolean)
    .join('\n');
  const verdict = await deps
    .evidenceSatisfies({
      userId,
      workTitle: String(input.detail?.plan?.outcome || input.detail?.work?.title || ''),
      outcome: input.detail?.plan?.outcome ?? null,
      requirement: step.doneWhen || `"${step.title}" is complete.`,
      evidenceText,
    })
    .catch(() => ({ satisfies: false, reason: '', unavailable: true }));
  if (!verdict.satisfies || verdict.unavailable) {
    const made = [...input.artifacts].reverse()[0];
    return {
      outcome: 'ready_for_you',
      summary: input.settled.summary,
      next: {
        kind:
          made?.kind === 'draft' ? 'review_draft' : made?.kind === 'document' ? 'review_document' : 'review',
        label: 'Check the result',
        detail:
          'I think the step is done, but the proof check did not pass. Check it, then mark the step done.',
        ...(made
          ? {
              target:
                made.kind === 'draft'
                  ? { kind: 'draft', id: made.id, accountId: made.accountId }
                  : made.kind === 'document'
                    ? { kind: 'document', id: made.id, url: made.url }
                    : { kind: made.kind === 'approval' ? 'approval' : 'url', id: made.id, url: made.url },
            }
          : {}),
      },
    };
  }
  // "Verified on the page" needs the page alone to show it. The combined
  // check above includes the agent's own words, so it proves less.
  const pageVerdict =
    page && input.sessionId
      ? await deps
          .evidenceSatisfies({
            userId,
            workTitle: String(input.detail?.plan?.outcome || input.detail?.work?.title || ''),
            outcome: input.detail?.plan?.outcome ?? null,
            requirement: step.doneWhen || `"${step.title}" is complete.`,
            evidenceText: `Page: ${page.url}\nTitle: ${page.title}\n${page.text}`,
          })
          .catch(() => ({ satisfies: false, reason: '', unavailable: true }))
      : null;
  const onPage = Boolean(page && pageVerdict?.satisfies && !pageVerdict.unavailable);
  await deps
    .convexMutation(api.albatrossWorkV2.attachProof, {
      userId,
      workId: run.workId,
      claim: truncateText(`${step.title}: ${verdict.reason || 'done'}`, 400),
      title: onPage
        ? page!.title || 'Verified on the page'
        : truncateText(input.artifacts.at(-1)?.title || step.title, 200),
      summary: truncateText(input.settled.summary || '', 600),
      ...(onPage ? { url: `https://browserbase.com/sessions/${input.sessionId}` } : {}),
      sourceKind: onPage ? 'browser_session' : 'step_run',
      sourceId: onPage ? input.sessionId! : run._id,
      stepIdentity: run.stepIdentity,
      trust: onPage ? 'observed' : 'inferred',
      // Only proof the page shows may settle the Work's contract. The agent's
      // own account checks the step, but it never closes the Work.
      settleContract: onPage,
    })
    .catch((error) => deps.reportError('[step-runner] proof failed', run._id, describeModelError(error)));
  await deps
    .completeWorkStep({ userId, workId: run.workId, stepKey: run.stepKey, source: 'evidence' })
    .catch((error) =>
      deps.reportError('[step-runner] step check failed', run._id, describeModelError(error)),
    );
  return input.settled;
}

async function notifyHandoff(
  deps: StepRunnerDependencies,
  userId: string,
  run: ClaimedRun,
  settled: SettleInput,
  elapsedMs: number,
) {
  if (!isAutomaticTrigger(run.trigger) && elapsedMs < STEP_RUN_NOTIFY_AFTER_MS) return;
  const title =
    settled.outcome === 'done'
      ? `Done: ${run.stepTitle}`
      : settled.next
        ? `${settled.next.label}: ${run.stepTitle}`
        : run.stepTitle;
  try {
    const queued = await deps.convexMutation<{ notificationId?: string; created?: boolean }>(
      api.albatrossNotifications.queueStepRunHandoff,
      {
        userId,
        workId: run.workId,
        runId: run._id,
        title: truncateText(title, 180),
        // A lock screen never names a saved item or the site that asks for it.
        body: truncateText(
          settled.next?.kind === 'allow_secure'
            ? 'A site asks to use one of your saved details.'
            : settled.next?.detail || settled.summary || '',
          400,
        ),
      },
    );
    if (queued?.created && queued.notificationId) await deps.notify(userId, String(queued.notificationId));
  } catch (error) {
    deps.reportError('[step-runner] handoff notice failed', run._id, describeModelError(error));
  }
}
