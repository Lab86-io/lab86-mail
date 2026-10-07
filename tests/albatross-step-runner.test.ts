import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { getFunctionName } from 'convex/server';
import { z } from 'zod';
import type { AgentConnector, AgentPage } from '../lib/albatross/browser-agent';
import {
  fallbackHandoff,
  isRetryableRunError,
  normalizeHandoff,
  runStepRun,
  type StepRunnerDependencies,
} from '../lib/albatross/step-runner';

// The runner end to end, with a fake model that calls the run's tools the way
// a real model would. Convex, the gateway, and the browser are fakes.

const name = (fn: any) => getFunctionName(fn);

const step = {
  key: 'step-1',
  identity: 'step:document:write the proposal',
  title: 'Write the proposal',
  detail: 'A one-page proposal for Dana.',
  url: 'https://venue.example/book',
  kind: 'document',
  stepMode: 'agent_does',
  doneWhen: 'The proposal document exists.',
  done: false,
};

const detail = {
  work: { _id: 'work-1', title: 'Proposal', rawText: 'Send the proposal to Dana' },
  plan: { outcome: 'Dana has the proposal' },
  execution: { guideSteps: [step], currentStep: step },
};

function claimedRun(overrides: Record<string, unknown> = {}) {
  return {
    _id: 'run-1',
    userId: 'user-1',
    workId: 'work-1',
    stepKey: 'step-1',
    stepIdentity: step.identity,
    stepTitle: step.title,
    trigger: 'user',
    attempts: 1,
    log: [],
    artifacts: [],
    ...overrides,
  };
}

interface Harness {
  deps: Partial<StepRunnerDependencies>;
  mutations: Array<{ fn: string; args: any }>;
  settled: () => any;
  calls: (fn: string) => any[];
  generateOptions: () => any;
}

type Behaviour = (options: any) => Promise<any>;

function harness(
  behaviour: Behaviour,
  options: {
    run?: Record<string, unknown> | null;
    detail?: any;
    verdict?: { satisfies: boolean; reason: string; unavailable?: boolean };
    browser?: boolean;
    heartbeatOk?: boolean;
    parent?: any;
    liveSession?: any;
    runtimes?: any[];
    page?: Partial<AgentPage>;
  } = {},
): Harness {
  const mutations: Array<{ fn: string; args: any }> = [];
  let generateOptions: any;
  const page: AgentPage = {
    goto: async () => undefined,
    url: () => 'https://venue.example/book',
    title: async () => 'Book a room',
    snapshot: async () => '- heading "Book a room" [ref=e1]\n- button "Sign in" [ref=e2]',
    click: async () => undefined,
    fill: async () => undefined,
    select: async () => undefined,
    press: async () => undefined,
    back: async () => undefined,
    wait: async () => undefined,
    inputKind: async () => null,
    text: async () => 'Your booking reference is BK-42.',
    ...options.page,
  };
  const closed = mock(async () => undefined);
  const connector: AgentConnector = async () => ({ page: async () => page, close: closed });
  const deps: Partial<StepRunnerDependencies> = {
    convexMutation: (async (fn: any, args: any) => {
      const fnName = name(fn);
      mutations.push({ fn: fnName, args });
      switch (fnName) {
        case 'albatrossStepRuns:claim':
          return options.run === null ? null : claimedRun(options.run || {});
        case 'albatrossStepRuns:heartbeat':
          return options.heartbeatOk ?? true;
        case 'albatrossStepRuns:settle':
          return {
            state: args.error && !args.outcome ? 'failed' : args.outcome === 'done' ? 'done' : 'handed_off',
          };
        case 'albatrossWork:enqueueApproval':
          return 'approval-1';
        case 'albatrossWorkV2:upsertQuestion':
          return 'question-1';
        case 'albatrossNotifications:queueStepRunHandoff':
          return { created: true, notificationId: 'note-1' };
        default:
          return true;
      }
    }) as any,
    convexQuery: (async (fn: any) => {
      switch (name(fn)) {
        case 'albatrossWorkV2:workDetail':
          return options.detail === undefined ? detail : options.detail;
        case 'albatrossStepRuns:get':
          return options.parent ?? null;
        case 'albatrossBrowserSessions:activeSessionForWork':
          return options.liveSession ?? null;
        default:
          return null;
      }
    }) as any,
    resolveAgentRuntimes: (async () =>
      options.runtimes || [
        { provider: 'openrouter', modelName: 'openai/gpt-5.5', model: {}, source: 'lab86' },
      ]) as any,
    generateText: (async (opts: any) => {
      generateOptions = opts;
      return behaviour(opts);
    }) as any,
    liftTools: (() => ({
      save_draft: {
        description: 'Save a draft',
        inputSchema: z.object({}).passthrough(),
        execute: async (args: any) => ({
          ok: true,
          draft: { id: 'draft-1', subject: args.subject, account: 'acct-1' },
        }),
      },
      document_create: {
        description: 'Create a document',
        inputSchema: z.object({}).passthrough(),
        execute: async (args: any) => ({
          ok: true,
          documentId: 'doc-1',
          title: args.title,
          openPath: '/documents/doc-1',
        }),
      },
      calendar_create_event: {
        description: 'Create an event',
        inputSchema: z.object({}).passthrough(),
        execute: async () => ({ ok: true, eventId: 'event-1' }),
      },
      archive_thread: {
        description: 'not for runs',
        inputSchema: z.object({}),
        execute: async () => ({ ok: true }),
      },
    })) as any,
    pausedRisks: (async () => new Set()) as any,
    resolveTimezone: (async () => 'America/New_York') as any,
    evidenceSatisfies: (async () =>
      options.verdict || { satisfies: true, reason: 'The document exists.' }) as any,
    completeWorkStep: mock(async () => ({ ok: true })) as any,
    browserConfigured: () => options.browser === true,
    createBrowserSession: (async () => ({
      sessionId: 'bb-1',
      connectUrl: 'wss://x',
      liveViewUrl: 'https://live',
      replayUrl: 'https://replay',
    })) as any,
    sessionOptions: (async () => ({ contextId: 'ctx-1', persist: true })) as any,
    connectUrl: (id: string) => `wss://connect/${id}`,
    connector,
    notify: mock(async () => ({ ok: true })),
    recordUsage: mock(async () => undefined) as any,
    heartbeatMs: 60_000,
    reportError: mock(() => undefined),
  };
  return {
    deps,
    mutations,
    settled: () => mutations.filter((entry) => entry.fn === 'albatrossStepRuns:settle').at(-1)?.args,
    calls: (fn: string) => mutations.filter((entry) => entry.fn === fn).map((entry) => entry.args),
    generateOptions: () => generateOptions,
  };
}

const usage = { inputTokens: 100, outputTokens: 50 };

const savedEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const key of ['LAB86_STEP_RUNS', 'LAB86_STEP_RUN_COST_BUDGET_USD', 'LAB86_STEP_RUN_TIME_BUDGET_MS'])
    savedEnv[key] = process.env[key];
  delete process.env.LAB86_STEP_RUNS;
  delete process.env.LAB86_STEP_RUN_COST_BUDGET_USD;
  delete process.env.LAB86_STEP_RUN_TIME_BUDGET_MS;
});
afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('runStepRun', () => {
  test('a lost claim does nothing', async () => {
    const h = harness(async () => ({}), { run: null });
    expect(await runStepRun('user-1', 'run-1', h.deps)).toEqual({ state: null });
    expect(h.settled()).toBeUndefined();
  });

  test('a switched-off feature, a missing step, and a done step settle at once', async () => {
    process.env.LAB86_STEP_RUNS = 'off';
    const off = harness(async () => ({}));
    await runStepRun('user-1', 'run-1', off.deps);
    expect(off.settled()).toMatchObject({ error: 'Step runs are off.' });
    delete process.env.LAB86_STEP_RUNS;

    const missing = harness(async () => ({}), {
      detail: { work: detail.work, execution: { guideSteps: [] } },
    });
    await runStepRun('user-1', 'run-1', missing.deps);
    expect(missing.settled()).toMatchObject({ error: 'This step is no longer in the plan.' });

    const done = harness(async () => ({}), {
      detail: { ...detail, execution: { guideSteps: [{ ...step, done: true }] } },
    });
    await runStepRun('user-1', 'run-1', done.deps);
    expect(done.settled()).toMatchObject({ outcome: 'done', summary: 'The step was already done.' });
  });

  test('a draft becomes a ready-for-you handoff that opens the draft', async () => {
    const h = harness(async (opts) => {
      expect(Object.keys(opts.tools)).not.toContain('archive_thread');
      expect(Object.keys(opts.tools)).not.toContain('browser_open');
      await opts.tools.save_draft.execute({ subject: 'The proposal', to: 'dana@example.test', body: 'Hi' });
      await opts.tools.step_handoff.execute({
        outcome: 'ready_for_you',
        summary: 'I wrote the proposal and saved a draft to Dana.',
        next: { kind: 'review_draft', label: 'Read and send', detail: 'Read the draft and send it.' },
      });
      opts.onStepFinish?.({ usage });
      return { text: '', usage, totalUsage: usage };
    });
    const result = await runStepRun('user-1', 'run-1', h.deps);
    expect(result).toEqual({ state: 'handed_off' });
    const settled = h.settled();
    expect(settled).toMatchObject({
      outcome: 'ready_for_you',
      next: {
        kind: 'review_draft',
        label: 'Read and send',
        target: { kind: 'draft', id: 'draft-1', accountId: 'acct-1' },
      },
    });
    expect(settled.budget.calls).toBe(1);
    expect(settled.budget.costUsd).toBeGreaterThan(0);
    const lines = h.calls('albatrossStepRuns:progress').flatMap((args) => (args.line ? [args.line] : []));
    expect(lines).toContain('Started on the step.');
    expect(lines).toContain('Saved a draft: “The proposal”.');
    expect(h.calls('albatrossStepRuns:progress').some((args) => args.artifact?.kind === 'draft')).toBe(true);
    expect(h.deps.recordUsage).toHaveBeenCalled();
    // A quick user run does not notify.
    expect(h.calls('albatrossNotifications:queueStepRunHandoff')).toEqual([]);
    expect(h.generateOptions().system).toContain('[THIS STEP] Write the proposal');
  });

  test('an automatic run notifies at its handoff', async () => {
    const h = harness(
      async (opts) => {
        await opts.tools.step_handoff.execute({
          outcome: 'your_turn',
          summary: 'I found the form.',
          next: { kind: 'do_offline', label: 'Sign it', detail: 'Sign the form and mail it.' },
        });
        return { text: '', usage };
      },
      { run: { trigger: 'conductor' } },
    );
    await runStepRun('user-1', 'run-1', h.deps);
    expect(h.calls('albatrossNotifications:queueStepRunHandoff')[0]).toMatchObject({
      workId: 'work-1',
      runId: 'run-1',
      title: 'Sign it: Write the proposal',
    });
    expect(h.deps.notify).toHaveBeenCalledWith('user-1', 'note-1');
  });

  test('done passes the proof check, attaches the proof, and checks the step', async () => {
    const h = harness(async (opts) => {
      await opts.tools.document_create.execute({ title: 'Proposal for Dana' });
      await opts.tools.step_handoff.execute({
        outcome: 'done',
        summary: 'I wrote the proposal.',
        evidence: 'The document "Proposal for Dana" exists.',
      });
      return { text: '', usage };
    });
    await runStepRun('user-1', 'run-1', h.deps);
    expect(h.calls('albatrossWorkV2:attachProof')[0]).toMatchObject({
      sourceKind: 'step_run',
      sourceId: 'run-1',
      trust: 'inferred',
      stepIdentity: step.identity,
    });
    expect(h.deps.completeWorkStep).toHaveBeenCalledWith({
      userId: 'user-1',
      workId: 'work-1',
      stepKey: 'step-1',
      source: 'evidence',
    });
    expect(h.settled()).toMatchObject({ outcome: 'done' });
  });

  test('a done claim the gate refuses becomes "Check the result"', async () => {
    const h = harness(
      async (opts) => {
        await opts.tools.document_create.execute({ title: 'Proposal for Dana' });
        await opts.tools.step_handoff.execute({ outcome: 'done', summary: 'I wrote it.' });
        return { text: '', usage };
      },
      { verdict: { satisfies: false, reason: 'No proof.' } },
    );
    await runStepRun('user-1', 'run-1', h.deps);
    expect(h.calls('albatrossWorkV2:attachProof')).toEqual([]);
    expect(h.deps.completeWorkStep).not.toHaveBeenCalled();
    expect(h.settled()).toMatchObject({
      outcome: 'ready_for_you',
      next: {
        kind: 'review_document',
        label: 'Check the result',
        target: { kind: 'document', id: 'doc-1', url: '/documents/doc-1' },
      },
    });
  });

  test('a question becomes a Work question that the handoff points at', async () => {
    const h = harness(async (opts) => {
      await opts.tools.step_handoff.execute({
        outcome: 'needs_answer',
        summary: 'I found two venues.',
        question: {
          prompt: 'Which venue?',
          options: [
            { id: 'a', label: 'Hall A' },
            { id: 'b', label: 'Hall B' },
          ],
        },
      });
      return { text: '', usage };
    });
    // next is required by the tool for every outcome but done; a missing one is refused.
    await runStepRun('user-1', 'run-1', h.deps);
    expect(h.settled()).toMatchObject({ outcome: 'stopped' });

    const answered = harness(async (opts) => {
      await opts.tools.step_handoff.execute({
        outcome: 'needs_answer',
        summary: 'I found two venues.',
        next: { kind: 'answer', label: 'Answer', detail: 'Pick one.' },
        question: { prompt: 'Which venue?', options: [{ id: 'a', label: 'Hall A' }] },
      });
      return { text: '', usage };
    });
    await runStepRun('user-1', 'run-1', answered.deps);
    expect(answered.calls('albatrossWorkV2:upsertQuestion')[0]).toMatchObject({
      workId: 'work-1',
      kind: 'clarification',
      prompt: 'Which venue?',
      options: [{ id: 'a', label: 'Hall A' }],
    });
    expect(answered.settled()).toMatchObject({
      outcome: 'needs_answer',
      next: { kind: 'answer', target: { kind: 'question', id: 'question-1' } },
    });
  });

  test('an invite with attendees waits in the approval queue', async () => {
    const h = harness(async (opts) => {
      const result = await opts.tools.calendar_create_event.execute({
        account: 'acct-1',
        title: 'Review with Dana',
        attendees: [{ email: 'dana@example.test' }],
      });
      expect(result).toMatchObject({ status: 'queued_for_approval', approvalId: 'approval-1' });
      await opts.tools.step_handoff.execute({
        outcome: 'ready_for_you',
        summary: 'I prepared the invite.',
        next: {
          kind: 'approve',
          label: 'Approve the invite',
          detail: 'Approve it and Dana gets the invite.',
        },
      });
      return { text: '', usage };
    });
    await runStepRun('user-1', 'run-1', h.deps);
    expect(h.calls('albatrossWork:enqueueApproval')[0]).toMatchObject({
      kind: 'calendar_invite',
      intentId: 'work-1',
      toolName: 'calendar_create_event',
      operationBatchId: 'run-1',
    });
    expect(h.settled().next.target).toEqual({ kind: 'approval', id: 'approval-1' });
  });

  test('no handoff call falls back to the work it made', async () => {
    const h = harness(async () => ({ text: 'I looked at the venues.', usage }));
    await runStepRun('user-1', 'run-1', h.deps);
    expect(h.settled()).toMatchObject({
      outcome: 'stopped',
      summary: 'I looked at the venues.',
      next: { kind: 'continue', label: 'Continue' },
    });
  });

  test('the cost limit stops the run with "Continue"', async () => {
    process.env.LAB86_STEP_RUN_COST_BUDGET_USD = '0.000001';
    const h = harness(async (opts) => {
      opts.onStepFinish?.({ usage: { inputTokens: 100_000, outputTokens: 10_000 } });
      opts.abortSignal.throwIfAborted();
      return { text: '', usage };
    });
    await runStepRun('user-1', 'run-1', h.deps);
    expect(h.settled()).toMatchObject({
      outcome: 'stopped',
      next: { kind: 'continue' },
      budget: { exhausted: 'cost' },
    });
  });

  test('the time limit stops the run with "Continue"', async () => {
    process.env.LAB86_STEP_RUN_TIME_BUDGET_MS = '1';
    const h = harness(
      (opts) =>
        new Promise((_, reject) => {
          opts.abortSignal.addEventListener('abort', () => reject(opts.abortSignal.reason));
        }),
    );
    await runStepRun('user-1', 'run-1', h.deps);
    expect(h.settled()).toMatchObject({ outcome: 'stopped', budget: { exhausted: 'time' } });
  });

  test('a cancelled run stops at its next heartbeat and settles nothing', async () => {
    const h = harness(
      (opts) =>
        new Promise((_, reject) => {
          opts.abortSignal.addEventListener('abort', () => reject(opts.abortSignal.reason));
        }),
      { heartbeatOk: false },
    );
    h.deps.heartbeatMs = 5;
    expect(await runStepRun('user-1', 'run-1', h.deps)).toEqual({ state: 'cancelled' });
    expect(h.settled()).toBeUndefined();
  });

  test('a provider failure before any work fails over; a later failure settles retryable', async () => {
    const calls: string[] = [];
    const failover = harness(
      async (opts) => {
        calls.push(opts.model.id);
        if (opts.model.id === 'primary') throw Object.assign(new Error('upstream'), { statusCode: 503 });
        await opts.tools.step_handoff.execute({
          outcome: 'ready_for_you',
          summary: 'Done on the fallback.',
          next: { kind: 'review', label: 'Open', detail: 'Open it.' },
        });
        return { text: '', usage };
      },
      {
        runtimes: [
          { provider: 'openrouter', modelName: 'openai/gpt-5.5', model: { id: 'primary' }, source: 'lab86' },
          {
            provider: 'openrouter',
            modelName: 'anthropic/claude-sonnet-4.6',
            model: { id: 'fallback' },
            source: 'lab86',
          },
        ],
      },
    );
    await runStepRun('user-1', 'run-1', failover.deps);
    expect(calls).toEqual(['primary', 'fallback']);
    expect(failover.settled()).toMatchObject({ outcome: 'ready_for_you' });

    const failing = harness(async (opts) => {
      await opts.tools.save_draft.execute({ subject: 'x' });
      throw Object.assign(new Error('upstream'), { statusCode: 503 });
    });
    await runStepRun('user-1', 'run-1', failing.deps);
    expect(failing.settled()).toMatchObject({ error: 'The run failed. Try again.', retryable: true });
  });

  test('the shared browser opens with saved sign-ins and goes to the user at sign-in', async () => {
    const h = harness(
      async (opts) => {
        const opened = await opts.tools.browser_open.execute({ url: 'https://venue.example/book' });
        expect(opened).toMatchObject({ ok: true, title: 'Book a room' });
        const refused = await opts.tools.browser_click.execute({ ref: 'e1' });
        expect(refused).toMatchObject({ ok: true });
        await opts.tools.step_handoff.execute({
          outcome: 'your_turn',
          summary: 'I opened the booking page.',
          next: { kind: 'sign_in', label: 'Sign in', detail: 'Sign in on the page, then press Continue.' },
        });
        return { text: '', usage };
      },
      { browser: true },
    );
    await runStepRun('user-1', 'run-1', h.deps);
    expect(h.calls('albatrossBrowserSessions:openSession')[0]).toMatchObject({
      workId: 'work-1',
      sessionId: 'bb-1',
      stepKey: 'step-1',
    });
    expect(h.calls('albatrossStepRuns:progress').some((args) => args.browserSessionId === 'bb-1')).toBe(true);
    const statuses = h.calls('albatrossBrowserSessions:setSessionStatus');
    expect(statuses[0]).toMatchObject({ status: 'agent' });
    expect(statuses.at(-1)).toMatchObject({
      status: 'user',
      statusDetail: 'Sign in on the page, then press Continue.',
    });
    expect(h.settled().next.target).toEqual({ kind: 'session', id: 'bb-1' });
  });

  test('a resumed run reads the earlier run and keeps its open browser', async () => {
    const h = harness(
      async (opts) => {
        await opts.tools.step_handoff.execute({
          outcome: 'ready_for_you',
          summary: 'I finished the form.',
          next: {
            kind: 'finish_on_page',
            label: 'Check and submit',
            detail: 'Check the form and submit it.',
          },
        });
        return { text: '', usage };
      },
      {
        browser: true,
        run: {
          trigger: 'resume',
          parentRunId: 'run-0',
          browserSessionId: 'bb-9',
          resumeNote: 'I signed in.',
        },
        parent: {
          summary: 'I opened the booking page.',
          log: [{ text: 'Opened venue.example.' }],
          next: { kind: 'sign_in', label: 'Sign in', detail: 'Sign in.' },
          artifacts: [],
        },
        liveSession: { sessionId: 'bb-9', status: 'user' },
      },
    );
    await runStepRun('user-1', 'run-1', h.deps);
    const system = h.generateOptions().system;
    expect(system).toContain('The earlier run on this step');
    expect(system).toContain('I opened the booking page.');
    expect(system).toContain('I signed in.');
    expect(system).toContain('The shared browser is open from the earlier run.');
    expect(h.generateOptions().messages[0].content).toContain('Continue the step');
    expect(h.settled().next.target).toEqual({ kind: 'session', id: 'bb-9' });
  });
});

describe('runner helpers', () => {
  test('fallbackHandoff prefers a draft, then a document, then Continue', () => {
    expect(fallbackHandoff('', [{ kind: 'draft', id: 'd', title: 'D', accountId: 'a' }])).toMatchObject({
      outcome: 'ready_for_you',
      summary: 'I worked on the step but did not finish it.',
      next: { kind: 'review_draft', target: { kind: 'draft', id: 'd', accountId: 'a' } },
    });
    expect(
      fallbackHandoff('Text', [{ kind: 'document', id: 'x', title: 'X', url: '/documents/x' }]),
    ).toMatchObject({
      next: { kind: 'review_document', target: { kind: 'document', id: 'x', url: '/documents/x' } },
    });
    expect(fallbackHandoff('Text', [])).toMatchObject({ outcome: 'stopped', next: { kind: 'continue' } });
  });

  test('normalizeHandoff fills targets from what the run made', () => {
    const artifacts = [
      { kind: 'document' as const, id: 'doc', title: 'Doc', url: '/documents/doc' },
      { kind: 'approval' as const, id: 'ap', title: 'Invite' },
    ];
    expect(
      normalizeHandoff(
        {
          outcome: 'ready_for_you',
          summary: 's',
          next: { kind: 'review_document', label: 'Open', detail: 'd' },
        },
        { artifacts },
      ).next?.target,
    ).toEqual({ kind: 'document', id: 'doc', url: '/documents/doc' });
    expect(
      normalizeHandoff(
        { outcome: 'ready_for_you', summary: 's', next: { kind: 'approve', label: 'Approve', detail: 'd' } },
        { artifacts },
      ).next?.target,
    ).toEqual({ kind: 'approval', id: 'ap' });
    expect(
      normalizeHandoff(
        {
          outcome: 'your_turn',
          summary: 's',
          next: { kind: 'sign_in', label: 'Sign in', detail: 'd', target: { kind: 'url', url: 'https://x' } },
        },
        { artifacts, sessionId: 'bb' },
      ).next?.target,
    ).toEqual({ kind: 'session', id: 'bb' });
    expect(
      normalizeHandoff(
        {
          outcome: 'ready_for_you',
          summary: 's',
          next: {
            kind: 'review',
            label: 'Read result',
            detail: 'd',
            target: { kind: 'url', url: 'https://x.example', accountId: '' },
          },
        },
        { artifacts },
      ).next?.target,
    ).toEqual({ kind: 'url', url: 'https://x.example' });
    expect(
      normalizeHandoff(
        {
          outcome: 'ready_for_you',
          summary: 's',
          next: {
            kind: 'review_document',
            label: 'Open',
            detail: 'd',
            target: { kind: 'document', id: ' ' },
          },
        },
        { artifacts },
      ).next?.target,
    ).toEqual({ kind: 'document', id: 'doc', url: '/documents/doc' });
    expect(normalizeHandoff({ outcome: 'done', summary: 's' }, { artifacts })).toEqual({
      outcome: 'done',
      summary: 's',
    });
  });

  test('isRetryableRunError keeps retries for transient failures only', () => {
    expect(isRetryableRunError(Object.assign(new Error('x'), { statusCode: 429 }))).toBe(true);
    expect(isRetryableRunError(new Error('socket hang up'))).toBe(true);
    expect(isRetryableRunError(new Error('Invalid args for save_draft'))).toBe(false);
  });
});
