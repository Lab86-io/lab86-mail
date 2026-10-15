import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { getFunctionName } from 'convex/server';
import { z } from 'zod';
import { GOAL_CHECK_FIRST, GOAL_RUNNER_RULES } from '../lib/albatross/goal-run-prompt';
import {
  GOAL_CHECK_COPY,
  handoffNotice,
  normalizeHandoff,
  redactGoalSettle,
  runStepRun,
  type StepRunnerDependencies,
} from '../lib/albatross/step-runner';

// Goal runs end to end (docs/albatross-goal-runs.md): a fake model calls the
// run's tools and finishes model steps the way a real model does. Convex, the
// gateway, and the browser are fakes. Invented data only.

const name = (fn: any) => getFunctionName(fn);

const contract = {
  outcome: 'The client has the July invoice',
  proofs: [
    { id: 'send-0', what: 'The message left your account' },
    { id: 'send-1', what: 'The person acknowledged it' },
  ],
  closeWhen: 'outcome_likely',
};

const detail = {
  work: { _id: 'work-1', title: 'July invoice', rawText: 'Send the July invoice to the client' },
  plan: { outcome: 'July invoice', digitalActions: [], physicalActions: [] },
  execution: { guideSteps: [], currentStep: null },
  contract,
  questions: [],
};

function claimedRun(overrides: Record<string, unknown> = {}) {
  return {
    _id: 'run-2',
    userId: 'user-1',
    workId: 'work-1',
    stepKey: 'goal',
    stepIdentity: 'goal:work-1',
    stepTitle: 'July invoice',
    trigger: 'user',
    attempts: 1,
    goal: true,
    checklist: [{ id: 'c1', text: 'Find the July hours', state: 'todo' }],
    log: [],
    artifacts: [],
    ...overrides,
  };
}

const earlierRun = {
  id: 'run-1',
  goal: true,
  stepKey: 'goal',
  stepTitle: 'July invoice',
  state: 'handed_off',
  outcome: 'ready_for_you',
  summary: 'I wrote the invoice and saved a draft.',
  stoppedBy: null,
  createdAt: Date.UTC(2026, 9, 14, 15, 0),
  next: { label: 'Read and send', detail: 'Read the draft and send it.' },
  messages: [{ id: 'm1', at: 1, text: 'The Jira worklog shows 78 hours.', sources: [] }],
  items: [{ kind: 'draft', id: 'draft-9', title: 'July invoice', state: 'check' }],
  unsure: ['I used 78 hours from the Jira worklog.'],
  artifacts: [{ kind: 'draft', id: 'draft-9', title: 'July invoice', accountId: 'acct-1' }],
};

const usage = { inputTokens: 100, outputTokens: 50 };

type Behaviour = (options: any) => Promise<any>;

function harness(
  behaviour: Behaviour,
  options: {
    run?: Record<string, unknown> | null;
    detail?: any;
    freshDetail?: any;
    history?: any[] | Error;
    verdict?: { satisfies: boolean; reason: string; unavailable?: boolean };
    runtimes?: any[];
  } = {},
) {
  const mutations: Array<{ fn: string; args: any }> = [];
  const queries: Array<{ fn: string; args: any }> = [];
  let generateOptions: any;
  let detailReads = 0;
  const lifted: Record<string, any> = {
    save_draft: {
      description: 'Save a draft',
      inputSchema: z.object({}).passthrough(),
      execute: async (args: any) => ({
        ok: true,
        draft: { id: 'draft-1', subject: args.subject, account: 'acct-1' },
      }),
    },
    update_draft: {
      description: 'Update a draft',
      inputSchema: z.object({}).passthrough(),
      execute: async () => ({ ok: true }),
    },
    read_thread: {
      description: 'Read a thread',
      inputSchema: z.object({}).passthrough(),
      execute: async (args: any) => ({
        account: args.account,
        threadId: args.threadId,
        subject: 'July hours',
        messages: [{ from: 'lead@example.com', body: '78 hours' }],
      }),
    },
    web_file_save: {
      description: 'Save a file from the web',
      inputSchema: z.object({}).passthrough(),
      execute: async () => ({
        ok: true,
        fileId: 'file-1',
        title: 'fw9.pdf',
        openPath: '/?view=files&file=file-1',
        size: 10,
        contentType: 'application/pdf',
        sourceUrl: 'https://www.irs.gov/pub/irs-pdf/fw9.pdf',
        sha256: 'x',
      }),
    },
    document_create: {
      description: 'Create a document',
      inputSchema: z.object({}).passthrough(),
      execute: async (args: any) => ({
        ok: true,
        documentId: args.kind === 'deck' ? 'deck-1' : 'doc-1',
        title: args.title,
        kind: args.kind,
        openPath: `/?view=files&document=${args.kind === 'deck' ? 'deck-1' : 'doc-1'}`,
      }),
    },
  };
  const liftTools = mock((..._args: any[]) => lifted);
  const deps: Partial<StepRunnerDependencies> = {
    convexMutation: (async (fn: any, args: any) => {
      const fnName = name(fn);
      mutations.push({ fn: fnName, args });
      switch (fnName) {
        case 'albatrossStepRuns:claim':
          return options.run === null ? null : claimedRun(options.run || {});
        case 'albatrossStepRuns:settle':
          return {
            state: args.error && !args.outcome ? 'failed' : args.outcome === 'done' ? 'done' : 'handed_off',
          };
        case 'albatrossStepRuns:updateGoal':
          return { ok: true, outcome: args.outcome ?? contract.outcome, proofs: [] };
        case 'albatrossWorkV2:upsertQuestion':
          return 'question-1';
        case 'albatrossWork:enqueueApproval':
          return 'approval-1';
        case 'albatrossNotifications:queueStepRunHandoff':
          return { created: true, notificationId: 'note-1' };
        case 'albatrossStepRuns:takeSteerNotes':
          return [];
        default:
          return true;
      }
    }) as any,
    convexQuery: (async (fn: any, args: any) => {
      const fnName = name(fn);
      queries.push({ fn: fnName, args });
      switch (fnName) {
        case 'albatrossWorkV2:workDetail':
          detailReads += 1;
          if (detailReads > 1 && options.freshDetail) return options.freshDetail;
          return options.detail === undefined ? detail : options.detail;
        case 'albatrossStepRuns:runsForWorkHistory':
          if (options.history instanceof Error) throw options.history;
          return options.history ?? [earlierRun, { ...claimedRun(), id: 'run-2', state: 'running' }];
        case 'albatrossStepRuns:get':
          return null;
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
    liftTools: liftTools as any,
    pausedRisks: (async () => new Set()) as any,
    resolveTimezone: (async () => 'America/New_York') as any,
    evidenceSatisfies: mock(
      async () => options.verdict || { satisfies: true, reason: 'The draft was sent.' },
    ) as any,
    completeWorkStep: mock(async () => ({ ok: true })) as any,
    browserConfigured: () => false,
    connectUrl: (id: string) => `wss://connect/${id}`,
    notify: mock(async () => ({ ok: true })),
    recordUsage: mock(async () => undefined) as any,
    heartbeatMs: 60_000,
    reportError: mock(() => undefined),
    now: () => Date.UTC(2026, 9, 15, 14, 0),
    readUser: async () => ({ name: 'Sam Rivera', email: 'sam.rivera@example.com' }),
    listDetails: (async () => []) as any,
    readThreadNotes: async () => [],
    secureAccess: () => null,
    secureInventory: async () => [],
  };
  return {
    deps,
    liftTools,
    mutations,
    queries,
    settled: () => mutations.filter((entry) => entry.fn === 'albatrossStepRuns:settle').at(-1)?.args,
    calls: (fn: string) => mutations.filter((entry) => entry.fn === fn).map((entry) => entry.args),
    generateOptions: () => generateOptions,
  };
}

const ENV = [
  'LAB86_STEP_RUNS',
  'LAB86_GOAL_RUN_TIME_BUDGET_MS',
  'LAB86_GOAL_RUN_COST_BUDGET_USD',
  'LAB86_GOAL_RUN_MAX_MODEL_STEPS',
  'LAB86_STEP_RUN_TIME_BUDGET_MS',
];
const savedEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const key of ENV) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});
afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('a goal run', () => {
  test('uses the goal rules, the goal tools, its own limits, and a delegated deck session', async () => {
    const h = harness(async (opts) => {
      await opts.tools.step_handoff.execute({
        outcome: 'your_turn',
        summary: 'I found the form.',
        next: { kind: 'do_offline', label: 'Sign it', detail: 'Sign the W-9.' },
      });
      return { text: '', usage };
    });
    await runStepRun('user-1', 'run-2', h.deps);
    const opts = h.generateOptions();
    expect(opts.system.startsWith(GOAL_RUNNER_RULES)).toBe(true);
    expect(opts.system).toContain('## The goal');
    expect(opts.system).toContain('Outcome: The client has the July invoice');
    expect(opts.system).toContain('Limits: at most 30 minutes and $8 of model cost.');
    expect(opts.system).toContain('Today: 2026-10-15 (America/New_York).');
    expect(opts.messages[0].content).toContain('Work on the goal "July invoice" now.');
    const names = Object.keys(opts.tools);
    expect(names).toContain('checklist_set');
    expect(names).toContain('goal_update');
    expect(names).toContain('web_file_save');
    expect(names).not.toContain('step_note');
    // presentation_plan asks no pickers in a run.
    expect(h.liftTools.mock.calls[0][2]).toEqual({ delegate: true });
    const lines = h.calls('albatrossStepRuns:progress').flatMap((args) => (args.line ? [args.line] : []));
    expect(lines[0]).toBe('Started on the goal.');
    // A missing step does not matter: no plan step is looked up or checked.
    expect(h.settled()).toMatchObject({ outcome: 'your_turn' });
  });

  test('the context lists earlier runs, what they made with ids, and the checklist', async () => {
    const h = harness(async (opts) => {
      await opts.tools.step_handoff.execute({
        outcome: 'your_turn',
        summary: 'x',
        next: { kind: 'do_offline', label: 'Sign it', detail: 'Sign it.' },
      });
      return { text: '', usage };
    });
    await runStepRun('user-1', 'run-2', h.deps);
    const system = h.generateOptions().system;
    expect(system).toContain('## Your checklist\n1. [todo] Find the July hours');
    expect(system).toContain('## Earlier runs on this Albatross (oldest first)');
    expect(system).toContain('2026-10-14 15:00 UTC · goal run · ready for you');
    expect(system).toContain('Said: The Jira worklog shows 78 hours.');
    expect(system).toContain('Handed over: draft "July invoice" (check, id draft-9)');
    expect(system).toContain('Not sure: I used 78 hours from the Jira worklog.');
    expect(system).toContain('Things earlier runs made');
    expect(system).toContain('- draft "July invoice" (id draft-9, account acct-1)');
    // This run itself is not an earlier run.
    expect(system.match(/goal run ·/g)?.length).toBe(1);
  });

  test('text between tool calls becomes messages with the sources since the last message', async () => {
    const h = harness(async (opts) => {
      await opts.tools.checklist_set.execute({
        items: [
          { text: 'Find the July hours', state: 'doing' },
          { text: 'Sign the W-9', state: 'yours' },
        ],
      });
      await opts.tools.read_thread.execute({ account: 'acct-1', threadId: 't1' });
      opts.onStepFinish({ usage, text: '' });
      await opts.tools.web_file_save.execute({ url: 'https://www.irs.gov/pub/irs-pdf/fw9.pdf' });
      opts.onStepFinish({ usage, text: '  The mail from the lead says 78 hours. I saved the W-9.  ' });
      await opts.tools.save_draft.execute({ subject: 'July invoice' });
      await opts.tools.step_handoff.execute({
        outcome: 'ready_for_you',
        summary: 'I saved the draft with the W-9.',
        next: { kind: 'review_draft', label: 'Read and send', detail: 'Read the draft.', blanks: ['rate'] },
        unsure: ['I used 78 hours from the mail.', 'I used 78 hours from the mail.'],
      });
      opts.onStepFinish({ usage, text: 'The draft is ready.' });
      return { text: 'The draft is ready.', usage };
    });
    await runStepRun('user-1', 'run-2', h.deps);
    const progress = h.calls('albatrossStepRuns:progress');
    expect(progress.find((args) => args.checklist)?.checklist).toEqual([
      { id: 'c1', text: 'Find the July hours', state: 'doing' },
      { id: 'c2', text: 'Sign the W-9', state: 'yours' },
    ]);
    const messages = progress.flatMap((args) => (args.message ? [args.message] : []));
    expect(messages.map((message) => message.text)).toEqual([
      'The mail from the lead says 78 hours. I saved the W-9.',
      'The draft is ready.',
    ]);
    expect(messages[0].sources).toEqual([
      { kind: 'mail', title: 'July hours (lead@example.com)', id: 't1', accountId: 'acct-1' },
      { kind: 'web', title: 'fw9.pdf', url: 'https://www.irs.gov/pub/irs-pdf/fw9.pdf' },
    ]);
    expect(messages[1].sources).toEqual([]);
    expect(typeof messages[0].id).toBe('string');
    const artifacts = progress.flatMap((args) => (args.artifact ? [args.artifact] : []));
    expect(artifacts).toEqual([
      { kind: 'file', id: 'file-1', title: 'fw9.pdf', url: '/?view=files&file=file-1' },
      {
        kind: 'draft',
        id: 'draft-1',
        title: 'July invoice',
        accountId: 'acct-1',
        url: '/?view=mail&account=acct-1&draft=draft-1',
      },
    ]);
    // No items from the model: the package is every made thing, the target first.
    expect(h.settled()).toMatchObject({
      outcome: 'ready_for_you',
      next: { kind: 'review_draft', target: { kind: 'draft', id: 'draft-1', accountId: 'acct-1' } },
      items: [
        {
          kind: 'draft',
          id: 'draft-1',
          state: 'blanks',
          blanks: ['rate'],
          url: '/?view=mail&account=acct-1&draft=draft-1',
        },
        { kind: 'file', id: 'file-1', state: 'check', url: '/?view=files&file=file-1' },
      ],
      unsure: ['I used 78 hours from the mail.'],
    });
  });

  test('a step run keeps its text to itself', async () => {
    const h = harness(
      async (opts) => {
        opts.onStepFinish({ usage, text: 'Some words.' });
        return { text: 'Some words.', usage };
      },
      {
        run: { goal: undefined, stepKey: 'step-1', stepIdentity: 's', checklist: undefined },
        detail: {
          ...detail,
          execution: {
            guideSteps: [{ key: 'step-1', title: 'Write it', stepMode: 'agent_does', done: false }],
          },
        },
      },
    );
    await runStepRun('user-1', 'run-2', h.deps);
    expect(h.calls('albatrossStepRuns:progress').some((args) => args.message)).toBe(false);
    expect(h.queries.some((query) => query.fn === 'albatrossStepRuns:runsForWorkHistory')).toBe(false);
    expect(h.liftTools.mock.calls[0][2]).toBeUndefined();
    expect(h.settled()).toMatchObject({ outcome: 'stopped', summary: 'Some words.' });
    expect(h.settled().items).toBeUndefined();
  });

  test('an edit to an earlier draft puts that draft in the package, with its name', async () => {
    const h = harness(async (opts) => {
      await opts.tools.update_draft.execute({ id: 'draft-9', patch: { body: 'New body' } });
      await opts.tools.update_draft.execute({ id: 'draft-9', patch: { body: 'Again' } });
      await opts.tools.update_draft.execute({ id: 'draft-new', patch: {} });
      await opts.tools.step_handoff.execute({
        outcome: 'ready_for_you',
        summary: 'I changed the draft.',
        next: { kind: 'review_draft', label: 'Read and send', detail: 'Read it.' },
      });
      return { text: '', usage };
    });
    await runStepRun('user-1', 'run-2', h.deps);
    const artifacts = h
      .calls('albatrossStepRuns:progress')
      .flatMap((args) => (args.artifact ? [args.artifact] : []));
    expect(artifacts).toEqual([
      {
        kind: 'draft',
        id: 'draft-9',
        title: 'July invoice',
        accountId: 'acct-1',
        url: '/?view=mail&account=acct-1&draft=draft-9',
      },
      { kind: 'draft', id: 'draft-new', title: 'Draft', url: '/?view=mail&draft=draft-new' },
    ]);
    expect(h.settled().next.target).toEqual({ kind: 'draft', id: 'draft-new' });
    expect(h.settled().items.map((item: any) => item.id)).toEqual(['draft-new', 'draft-9']);
  });

  test('goal_update changes the contract through the fenced mutation', async () => {
    const h = harness(async (opts) => {
      const result = await opts.tools.goal_update.execute({
        outcome: '  The client has the July invoice and the W-9 ',
        proofs: ['The draft with both files was sent'],
      });
      expect(result.ok).toBe(true);
      expect((await opts.tools.goal_update.execute({ outcome: '   ' })).ok).toBe(false);
      await opts.tools.step_handoff.execute({
        outcome: 'your_turn',
        summary: 'x',
        next: { kind: 'do_offline', label: 'Sign it', detail: 'Sign it.' },
      });
      return { text: '', usage };
    });
    await runStepRun('user-1', 'run-2', h.deps);
    expect(h.calls('albatrossStepRuns:updateGoal')).toEqual([
      {
        userId: 'user-1',
        id: 'run-2',
        token: expect.any(String),
        outcome: 'The client has the July invoice and the W-9',
        proofs: ['The draft with both files was sent'],
      },
    ]);
  });

  test('done is checked against the contract, attaches to the Work, and checks no step', async () => {
    const fresh = {
      ...detail,
      contract: { ...contract, outcome: 'The client replied', proofs: [{ id: 'g', what: 'A reply came' }] },
    };
    const h = harness(
      async (opts) => {
        await opts.tools.save_draft.execute({ subject: 'July invoice' });
        await opts.tools.step_handoff.execute({
          outcome: 'done',
          summary: 'The client replied.',
          evidence: 'The reply says thanks.',
        });
        return { text: '', usage };
      },
      { freshDetail: fresh },
    );
    await runStepRun('user-1', 'run-2', h.deps);
    const verdictInput = (h.deps.evidenceSatisfies as any).mock.calls[0][0];
    expect(verdictInput.requirement).toBe('The client replied\nWhat proves it:\n- A reply came');
    expect(verdictInput.outcome).toBe('The client replied');
    expect(verdictInput.source).toBe('run');
    const proof = h.calls('albatrossWorkV2:attachProof')[0];
    expect(proof).toMatchObject({
      workId: 'work-1',
      claim: 'July invoice: The draft was sent.',
      sourceKind: 'step_run',
      sourceId: 'run-2',
      trust: 'inferred',
      settleContract: false,
    });
    expect(proof).not.toHaveProperty('stepIdentity');
    expect(h.deps.completeWorkStep).not.toHaveBeenCalled();
    expect(h.settled()).toMatchObject({ outcome: 'done' });
  });

  test('a done claim that the check refuses waits for the user with the goal copy and the package', async () => {
    const h = harness(
      async (opts) => {
        await opts.tools.document_create.execute({ kind: 'deck', title: 'Plan' });
        await opts.tools.step_handoff.execute({ outcome: 'done', summary: 'Done.' });
        return { text: '', usage };
      },
      { verdict: { satisfies: false, reason: 'No reply yet.' } },
    );
    await runStepRun('user-1', 'run-2', h.deps);
    expect(h.calls('albatrossWorkV2:attachProof')).toEqual([]);
    expect(h.settled()).toMatchObject({
      outcome: 'ready_for_you',
      next: {
        kind: 'review_document',
        label: 'Check the result',
        detail: GOAL_CHECK_COPY.notProved('No reply yet.'),
        target: { kind: 'document', id: 'deck-1', url: '/?view=files&document=deck-1' },
      },
      items: [
        { kind: 'deck', id: 'deck-1', title: 'Plan', state: 'check', url: '/?view=files&document=deck-1' },
      ],
    });
    expect(GOAL_CHECK_COPY.notProved('')).toContain('could not prove it. Check it');
    expect(GOAL_CHECK_COPY.checkDidNotRun).toContain('the check did not run');
  });

  test('no handoff: a goal run hands over every thing it made', async () => {
    const made = harness(async (opts) => {
      await opts.tools.web_file_save.execute({ url: 'https://www.irs.gov/pub/irs-pdf/fw9.pdf' });
      await opts.tools.save_draft.execute({ subject: 'July invoice' });
      return { text: 'I saved the form and a draft.', usage };
    });
    await runStepRun('user-1', 'run-2', made.deps);
    expect(made.settled()).toMatchObject({
      outcome: 'ready_for_you',
      summary: 'I saved the form and a draft.',
      next: { kind: 'review', target: { kind: 'url', id: 'file-1', url: '/?view=files&file=file-1' } },
      items: [{ kind: 'file' }, { kind: 'draft' }],
    });

    const nothing = harness(async () => ({ text: '', usage }));
    await runStepRun('user-1', 'run-2', nothing.deps);
    expect(nothing.settled()).toMatchObject({
      outcome: 'stopped',
      summary: 'I worked on the goal but did not finish it.',
      next: { kind: 'continue', detail: 'Press Continue and I take the goal further.' },
    });
  });

  test('the time limit hands over what the run made so far', async () => {
    process.env.LAB86_GOAL_RUN_TIME_BUDGET_MS = '1';
    const h = harness(async (opts) => {
      await opts.tools.save_draft.execute({ subject: 'July invoice' });
      return new Promise((_, reject) => {
        opts.abortSignal.addEventListener('abort', () => reject(opts.abortSignal.reason));
      });
    });
    await runStepRun('user-1', 'run-2', h.deps);
    expect(h.settled()).toMatchObject({
      outcome: 'stopped',
      summary: 'I used the time for this run before I finished the goal.',
      items: [{ kind: 'draft', id: 'draft-1' }],
      budget: { exhausted: 'time' },
    });
  });

  test('a goal run on a Work that is gone settles at once; a failed history read is no history', async () => {
    const gone = harness(async () => ({ text: '', usage }), { detail: null });
    await runStepRun('user-1', 'run-2', gone.deps);
    expect(gone.settled()).toMatchObject({ error: 'This Albatross is no longer open.' });

    const noHistory = harness(
      async (opts) => {
        await opts.tools.step_handoff.execute({
          outcome: 'your_turn',
          summary: 'x',
          next: { kind: 'do_offline', label: 'Sign it', detail: 'Sign it.' },
        });
        return { text: '', usage };
      },
      { history: new Error('down') },
    );
    await runStepRun('user-1', 'run-2', noHistory.deps);
    expect(noHistory.generateOptions().system).not.toContain('## Earlier runs');
    expect(noHistory.settled()).toMatchObject({ outcome: 'your_turn' });
  });

  test('a run after "Done, continue" checks the goal first; a retry keeps its earlier messages', async () => {
    const h = harness(
      async (opts) => {
        await opts.tools.step_handoff.execute({
          outcome: 'your_turn',
          summary: 'x',
          next: { kind: 'do_offline', label: 'Sign it', detail: 'Sign it.' },
        });
        return { text: '', usage };
      },
      {
        run: {
          trigger: 'resume',
          attempts: 2,
          resumeNote: 'The user did their part: Read and send.',
          messages: [{ id: 'm9', at: 1, text: 'I read the thread.', sources: [] }],
          artifacts: [{ kind: 'draft', id: 'draft-1', title: 'July invoice' }],
        },
      },
    );
    await runStepRun('user-1', 'run-2', h.deps);
    const system = h.generateOptions().system;
    expect(system).toContain(GOAL_CHECK_FIRST);
    expect(system).toContain('## An earlier attempt of this run stopped before it finished');
    expect(system).toContain('Said: I read the thread.');
    expect(system).toContain('Started by: the user, to continue.');
    expect(h.generateOptions().messages[0].content).toContain('Continue the goal "July invoice"');
    const lines = h.calls('albatrossStepRuns:progress').flatMap((args) => (args.line ? [args.line] : []));
    expect(lines[0]).toBe('Continued the goal.');
  });

  test('a question names the goal, and its default action says it continues', async () => {
    const h = harness(async (opts) => {
      await opts.tools.step_handoff.execute({
        outcome: 'needs_answer',
        summary: 'I need the rate.',
        next: { kind: 'answer', label: 'Answer', detail: 'Give the rate.' },
        question: { prompt: 'What is the hourly rate?' },
      });
      return { text: '', usage };
    });
    await runStepRun('user-1', 'run-2', h.deps);
    expect(h.calls('albatrossWorkV2:upsertQuestion')[0]).toMatchObject({
      reason: 'Needed to continue "July invoice".',
    });
  });

  test('a run that spoke does not fail over to another runtime', async () => {
    let calls = 0;
    const h = harness(
      async (opts) => {
        calls += 1;
        opts.onStepFinish({ usage, text: 'I look for the hours.' });
        throw Object.assign(new Error('Provider returned error'), { statusCode: 503 });
      },
      {
        runtimes: [
          { provider: 'openrouter', modelName: 'a', model: {}, source: 'lab86' },
          { provider: 'openrouter', modelName: 'b', model: {}, source: 'lab86' },
        ],
      },
    );
    await runStepRun('user-1', 'run-2', h.deps);
    expect(calls).toBe(1);
    expect(h.settled()).toMatchObject({ error: 'The run failed. Try again.', retryable: true });
  });

  test('an automatic goal run notifies with the goal and the count of things', async () => {
    const h = harness(
      async (opts) => {
        await opts.tools.save_draft.execute({ subject: 'July invoice' });
        await opts.tools.web_file_save.execute({ url: 'https://www.irs.gov/x.pdf' });
        await opts.tools.step_handoff.execute({
          outcome: 'ready_for_you',
          summary: 'I made two things.',
          next: { kind: 'review_draft', label: 'Read and send', detail: 'Read the draft.' },
        });
        return { text: '', usage };
      },
      { run: { trigger: 'brief', stepIdentity: 'goal:work-1:2026-10-15' } },
    );
    await runStepRun('user-1', 'run-2', h.deps);
    expect(h.calls('albatrossNotifications:queueStepRunHandoff')[0]).toMatchObject({
      title: 'Ready for you: July invoice',
      body: '2 things wait for you. Read the draft.',
    });
  });
});

describe('goal handoff helpers', () => {
  test('notices: done, one thing, many things, a step run, and a saved detail', () => {
    const goal = { stepTitle: 'July invoice', goal: true, stepKey: 'goal' };
    expect(handoffNotice(goal, { outcome: 'done', summary: 'Sent.' })).toEqual({
      title: 'Done: July invoice',
      body: 'Sent.',
    });
    const next = { kind: 'review_draft' as const, label: 'Read and send', detail: 'Read the draft.' };
    expect(
      handoffNotice(goal, {
        outcome: 'ready_for_you',
        next,
        items: [{ kind: 'draft', title: 'x', state: 'check' }],
      }),
    ).toEqual({ title: 'Read and send: July invoice', body: 'Read the draft.' });
    expect(
      handoffNotice(goal, {
        outcome: 'ready_for_you',
        next,
        items: [
          { kind: 'draft', title: 'x', state: 'check' },
          { kind: 'event', title: 'y', state: 'ready' },
        ],
      }).title,
    ).toBe('Read and send: July invoice');
    const step = { stepTitle: 'Write it', stepKey: 'step-1' };
    expect(
      handoffNotice(step, {
        outcome: 'ready_for_you',
        next,
        items: [
          { kind: 'draft', title: 'x', state: 'check' },
          { kind: 'file', title: 'y', state: 'check' },
        ],
      }),
    ).toEqual({ title: 'Read and send: Write it', body: 'Read the draft.' });
    expect(
      handoffNotice(goal, {
        outcome: 'needs_answer',
        next: { kind: 'allow_secure', label: 'Answer', detail: 'Use your saved ID on example.com?' },
      }).body,
    ).toBe('A site asks to use one of your saved details.');
    expect(handoffNotice(goal, { outcome: 'stopped' })).toEqual({ title: 'July invoice', body: '' });
  });

  test('normalizeHandoff keeps the package only for a goal run', () => {
    const handoff = {
      outcome: 'ready_for_you' as const,
      summary: 'x',
      next: { kind: 'review_document' as const, label: 'Open', detail: 'Open it.' },
      items: [{ kind: 'document' as const, id: 'w1', title: 'Invoice', state: 'check' as const }],
      unsure: ['Check the rate.'],
    };
    const artifacts = [{ kind: 'deck' as const, id: 'k1', title: 'Deck', url: '/?view=files&document=k1' }];
    const step = normalizeHandoff(handoff, { artifacts });
    expect(step).not.toHaveProperty('items');
    expect(step).not.toHaveProperty('unsure');
    expect(step.next?.target).toBeUndefined();
    const goal = normalizeHandoff(handoff, {
      artifacts,
      goal: true,
      known: [{ kind: 'document', id: 'w1', title: 'Invoice', url: '/?view=files&office=w1' }],
    });
    // A goal run's review_document opens its deck when it made no document.
    expect(goal.next?.target).toEqual({ kind: 'document', id: 'k1', url: '/?view=files&document=k1' });
    expect(goal.items).toEqual([
      { kind: 'document', title: 'Invoice', state: 'check', id: 'w1', url: '/?view=files&office=w1' },
    ]);
    expect(goal.unsure).toEqual(['Check the rate.']);
  });

  test('redactGoalSettle cleans every line the model wrote', () => {
    const secure = { cleanText: (text: string) => text.replace('99-1234567', '[secure: tax ID]') } as any;
    const settled = redactGoalSettle(
      {
        outcome: 'ready_for_you',
        summary: 'I filled 99-1234567.',
        next: { kind: 'review', label: 'Check {{secure:a.number}}', detail: 'See 99-1234567.' },
        items: [
          { kind: 'file', title: 'W-9 99-1234567', state: 'check', note: 'Tax ID {{secure:a.number}}' },
        ],
        unsure: ['The ID is 99-1234567.'],
      },
      secure,
    );
    expect(JSON.stringify(settled)).not.toContain('99-1234567');
    expect(JSON.stringify(settled)).not.toContain('{{secure');
    expect(settled.items?.[0].note).toBe('Tax ID [saved value]');
    expect(redactGoalSettle({ outcome: 'stopped' })).toEqual({ outcome: 'stopped' });
  });
});
