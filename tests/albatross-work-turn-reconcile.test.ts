import { describe, expect, test } from 'bun:test';
import {
  conversationExcerpt,
  harvestTurnArtifacts,
  reconcileWorkTurn,
  setWorkTurnReconcileDependenciesForTest,
  toolCallsFromSteps,
  turnSignals,
} from '../lib/albatross/work-turn-reconcile';

const step = (content: any[]) => ({ content });
const call = (toolCallId: string, toolName: string, input: any) => ({
  type: 'tool-call',
  toolCallId,
  toolName,
  input,
});
const result = (toolCallId: string, output: any) => ({ type: 'tool-result', toolCallId, output });

describe('toolCallsFromSteps', () => {
  test('pairs calls with results across steps and marks errors', () => {
    const calls = toolCallsFromSteps([
      step([call('c1', 'calendar_create_event', { title: 'Trip' })]),
      step([
        result('c1', { ok: true, eventId: 'evt_1', operationId: 'op_1' }),
        call('c2', 'search_threads', { query: 'x' }),
        { type: 'tool-error', toolCallId: 'c2', error: 'boom' },
      ]),
    ]);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ toolName: 'calendar_create_event', ok: true });
    expect(calls[0].output.eventId).toBe('evt_1');
    expect(calls[1].ok).toBe(false);
  });

  test('treats ok:false outputs as failed calls', () => {
    const calls = toolCallsFromSteps([
      step([call('c1', 'tasks_create_card', { title: 'T' }), result('c1', { ok: false })]),
    ]);
    expect(calls[0].ok).toBe(false);
  });
});

describe('harvestTurnArtifacts', () => {
  test('collects chat-created events, tasks, and documents', () => {
    const artifacts = harvestTurnArtifacts(
      toolCallsFromSteps([
        step([
          call('c1', 'calendar_create_event', { title: 'Keuka Lake Trip' }),
          result('c1', { ok: true, eventId: 'evt_1', operationId: 'op_1' }),
          call('c2', 'tasks_create_card', { title: 'Book the U-Haul' }),
          result('c2', { ok: true, cardId: 'card_1', operationId: 'op_2' }),
          call('c3', 'document_create', { title: 'Packing list' }),
          result('c3', { ok: true, documentId: 'doc_1' }),
          call('c4', 'search_threads', { query: 'u-haul' }),
          result('c4', { ok: true, threads: [] }),
        ]),
      ]),
    );
    expect(artifacts).toEqual([
      {
        kind: 'calendarEvent',
        id: 'evt_1',
        title: 'Keuka Lake Trip',
        operationId: 'op_1',
        sourceKind: 'calendar_event',
      },
      { kind: 'task', id: 'card_1', title: 'Book the U-Haul', operationId: 'op_2', sourceKind: 'task' },
      {
        kind: 'document',
        id: 'doc_1',
        title: 'Packing list',
        operationId: undefined,
        sourceKind: 'manual',
      },
    ]);
  });

  test('skips failed creations', () => {
    const artifacts = harvestTurnArtifacts(
      toolCallsFromSteps([
        step([call('c1', 'calendar_create_event', { title: 'Trip' }), result('c1', { ok: false })]),
      ]),
    );
    expect(artifacts).toEqual([]);
  });
});

describe('turnSignals', () => {
  test('reads progress, explicit answers, and replan from the turn', () => {
    const signals = turnSignals(
      toolCallsFromSteps([
        step([
          call('c1', 'albatross_record_progress', {
            claim: 'Trip is Wednesday.',
            questionAnswers: [{ questionId: 'q1', answer: 'Wednesday' }],
          }),
          result('c1', { ok: true }),
          call('c2', 'albatross_replan_work', { workId: 'w1', reason: 'progress' }),
          result('c2', { ok: true }),
        ]),
      ]),
    );
    expect(signals).toEqual({
      recordedProgress: true,
      progressClaims: ['Trip is Wednesday.'],
      answersViaTool: 1,
      replanSucceeded: true,
    });
  });

  test('a failed replan does not count as replanned', () => {
    const signals = turnSignals(
      toolCallsFromSteps([
        step([
          call('c1', 'albatross_replan_work', { workId: 'w1' }),
          { type: 'tool-error', toolCallId: 'c1', error: 'timeout' },
        ]),
      ]),
    );
    expect(signals.replanSucceeded).toBe(false);
  });
});

describe('conversationExcerpt', () => {
  test('replays text turns and question-form exchanges', () => {
    const excerpt = conversationExcerpt([
      { role: 'user', parts: [{ type: 'text', text: 'The furniture is at the lake house.' }] },
      {
        role: 'assistant',
        parts: [
          { type: 'text', text: 'Two questions.' },
          {
            type: 'tool-ask_user',
            state: 'output-available',
            input: { questions: [{ question: 'Which day works?' }] },
            output: { answers: [{ question: 'Which day works?', response: 'Wednesday' }] },
          },
          { type: 'tool-search_threads', state: 'output-available', output: { threads: [] } },
        ],
      },
    ]);
    expect(excerpt).toContain('User: The furniture is at the lake house.');
    expect(excerpt).toContain('Assistant asked: Which day works?');
    expect(excerpt).toContain('Wednesday');
    expect(excerpt).not.toContain('search_threads');
  });

  test('an unanswered form contributes nothing', () => {
    const excerpt = conversationExcerpt([
      {
        role: 'assistant',
        parts: [
          {
            type: 'tool-ask_user',
            state: 'input-available',
            input: { questions: [{ question: 'Which day?' }] },
          },
        ],
      },
    ]);
    expect(excerpt).toBe('');
  });
});

interface HarnessOptions {
  detail?: any;
  classifierText?: string;
  classifierError?: boolean;
  answerResults?: Array<{ shouldAdvance: boolean }>;
}

function harness(options: HarnessOptions = {}) {
  const mutations: Array<{ args: any }> = [];
  const advances: any[] = [];
  let answerIndex = 0;
  const detail =
    options.detail === undefined
      ? {
          work: { _id: 'w1', workState: 'active', status: 'active', lastEvidenceAt: 111 },
          questions: [],
        }
      : options.detail;
  const restore = setWorkTurnReconcileDependenciesForTest({
    convexQuery: (async () => detail) as any,
    convexMutation: (async (_ref: any, args: any) => {
      mutations.push({ args });
      if (args?.questionId) {
        const next = options.answerResults?.[answerIndex] ?? { shouldAdvance: true };
        answerIndex += 1;
        return next;
      }
      return undefined;
    }) as any,
    generateTextForCurrentUser: (async () => {
      if (options.classifierError) throw new Error('model down');
      return { text: options.classifierText ?? '{"answers": []}' };
    }) as any,
    advanceWork: (async (input: any) => {
      advances.push(input);
      return { status: 'ready', workId: input.workId };
    }) as any,
    reportError: () => undefined,
  });
  return { mutations, advances, restore };
}

const baseInput = {
  userId: 'user_1',
  userEmail: 'owner@example.test',
  userName: 'Owner',
  workId: 'w1',
  timezone: 'America/New_York',
};

const artifactSteps = [
  step([
    call('c1', 'calendar_create_event', { title: 'Keuka Lake Trip' }),
    result('c1', { ok: true, eventId: 'evt_1', operationId: 'op_1' }),
  ]),
];

describe('reconcileWorkTurn', () => {
  test('records chat artifacts on the Work and replans', async () => {
    const state = harness();
    try {
      const outcome = await reconcileWorkTurn({ ...baseInput, steps: artifactSteps, uiMessages: [] });
      expect(outcome).toEqual({
        status: 'ok',
        artifactsRecorded: 1,
        questionsAnswered: 0,
        advanced: true,
      });
      const append = state.mutations.find((entry) => entry.args.artifacts);
      expect(append?.args.artifacts).toEqual([
        { kind: 'calendarEvent', id: 'evt_1', title: 'Keuka Lake Trip', operationId: 'op_1' },
      ]);
      const proof = state.mutations.find((entry) => entry.args.sourceKind === 'calendar_event');
      expect(proof?.args).toMatchObject({
        workId: 'w1',
        sourceId: 'evt_1',
        trust: 'observed',
        settleContract: false,
      });
      expect(state.advances).toHaveLength(1);
      const reconcileMark = state.mutations.find((entry) => entry.args.evidenceAt === 111);
      expect(reconcileMark).toBeDefined();
    } finally {
      state.restore();
    }
  });

  test('skips the extra replan when the model already replanned after progress', async () => {
    const state = harness();
    try {
      const steps = [
        step([
          call('c1', 'albatross_record_progress', { claim: 'Done with step one.' }),
          result('c1', { ok: true }),
          call('c2', 'albatross_replan_work', { workId: 'w1', reason: 'progress' }),
          result('c2', { ok: true }),
        ]),
      ];
      const outcome = await reconcileWorkTurn({ ...baseInput, steps, uiMessages: [] });
      expect(outcome.advanced).toBe(false);
      expect(state.advances).toHaveLength(0);
    } finally {
      state.restore();
    }
  });

  test('resolves an open question from the conversation and advances', async () => {
    const state = harness({
      detail: {
        work: { _id: 'w1', workState: 'active', status: 'active', lastEvidenceAt: 222 },
        questions: [
          { _id: 'q_open', status: 'pending', prompt: 'What items are in the lake?' },
          { _id: 'q_old', status: 'answered', prompt: 'Which lake?' },
        ],
      },
      classifierText: '{"answers": [{"questionId": "q_open", "answer": "A coffee table and a desk."}]}',
    });
    try {
      const outcome = await reconcileWorkTurn({
        ...baseInput,
        steps: [],
        uiMessages: [{ role: 'user', parts: [{ type: 'text', text: 'It is a coffee table and a desk.' }] }],
      });
      expect(outcome).toMatchObject({ status: 'ok', questionsAnswered: 1, advanced: true });
      const answered = state.mutations.find((entry) => entry.args.questionId);
      expect(answered?.args).toMatchObject({ questionId: 'q_open', answer: 'A coffee table and a desk.' });
      expect(state.advances).toHaveLength(1);
    } finally {
      state.restore();
    }
  });

  test('drops classifier answers for unknown question ids', async () => {
    const state = harness({
      detail: {
        work: { _id: 'w1', workState: 'active', status: 'active' },
        questions: [{ _id: 'q_open', status: 'pending', prompt: 'Which day?' }],
      },
      classifierText: '{"answers": [{"questionId": "q_forged", "answer": "Whatever."}]}',
    });
    try {
      const outcome = await reconcileWorkTurn({
        ...baseInput,
        steps: [],
        uiMessages: [{ role: 'user', parts: [{ type: 'text', text: 'Hello.' }] }],
      });
      expect(outcome).toMatchObject({ questionsAnswered: 0, advanced: false });
      expect(state.mutations.filter((entry) => entry.args.questionId)).toHaveLength(0);
      expect(state.advances).toHaveLength(0);
    } finally {
      state.restore();
    }
  });

  test('a classifier failure never breaks the turn', async () => {
    const state = harness({
      detail: {
        work: { _id: 'w1', workState: 'active', status: 'active' },
        questions: [{ _id: 'q_open', status: 'pending', prompt: 'Which day?' }],
      },
      classifierError: true,
    });
    try {
      const outcome = await reconcileWorkTurn({
        ...baseInput,
        steps: [],
        uiMessages: [{ role: 'user', parts: [{ type: 'text', text: 'Hello.' }] }],
      });
      expect(outcome.status).toBe('ok');
      expect(outcome.questionsAnswered).toBe(0);
    } finally {
      state.restore();
    }
  });

  test('does not replan when an answer closed the Work', async () => {
    const closed = {
      work: { _id: 'w1', workState: 'done', status: 'done' },
      questions: [{ _id: 'q_done', status: 'pending', prompt: 'Did this get done?' }],
    };
    // First query: still active with the pending question. Second: closed.
    const active = {
      work: { _id: 'w1', workState: 'active', status: 'active', lastEvidenceAt: 1 },
      questions: closed.questions,
    };
    let queries = 0;
    const advances: any[] = [];
    const restore = setWorkTurnReconcileDependenciesForTest({
      convexQuery: (async () => {
        queries += 1;
        return queries === 1 ? active : closed;
      }) as any,
      convexMutation: (async (_ref: any, args: any) =>
        args?.questionId ? { shouldAdvance: false } : undefined) as any,
      generateTextForCurrentUser: (async () => ({
        text: '{"answers": [{"questionId": "q_done", "answer": "Yes, all recovered."}]}',
      })) as any,
      advanceWork: (async (input: any) => {
        advances.push(input);
        return { status: 'ready', workId: input.workId };
      }) as any,
      reportError: () => undefined,
    });
    try {
      const outcome = await reconcileWorkTurn({
        ...baseInput,
        steps: [],
        uiMessages: [{ role: 'user', parts: [{ type: 'text', text: 'Yes, all recovered.' }] }],
      });
      expect(outcome.questionsAnswered).toBe(1);
      expect(outcome.advanced).toBe(false);
      expect(advances).toHaveLength(0);
    } finally {
      restore();
    }
  });

  test('a quiet conversational turn touches nothing', async () => {
    const state = harness();
    try {
      const outcome = await reconcileWorkTurn({
        ...baseInput,
        steps: [step([{ type: 'text', text: 'The plan is unchanged.' }])],
        uiMessages: [{ role: 'user', parts: [{ type: 'text', text: 'What is the plan?' }] }],
      });
      expect(outcome).toEqual({
        status: 'ok',
        artifactsRecorded: 0,
        questionsAnswered: 0,
        advanced: false,
      });
      expect(state.mutations).toHaveLength(0);
      expect(state.advances).toHaveLength(0);
    } finally {
      state.restore();
    }
  });

  test('skips missing and closed Work without side effects', async () => {
    const missing = harness({ detail: null });
    try {
      expect((await reconcileWorkTurn({ ...baseInput, steps: artifactSteps, uiMessages: [] })).status).toBe(
        'skipped',
      );
      expect(missing.mutations).toHaveLength(0);
    } finally {
      missing.restore();
    }
    const done = harness({
      detail: { work: { _id: 'w1', workState: 'done', status: 'done' }, questions: [] },
    });
    try {
      expect((await reconcileWorkTurn({ ...baseInput, steps: artifactSteps, uiMessages: [] })).status).toBe(
        'skipped',
      );
      expect(done.mutations).toHaveLength(0);
    } finally {
      done.restore();
    }
  });

  test('an unexpected failure reports and returns error instead of throwing', async () => {
    const errors: unknown[] = [];
    const restore = setWorkTurnReconcileDependenciesForTest({
      convexQuery: (async () => {
        throw new Error('convex down');
      }) as any,
      reportError: ((...args: unknown[]) => errors.push(args)) as any,
    });
    try {
      const outcome = await reconcileWorkTurn({ ...baseInput, steps: [], uiMessages: [] });
      expect(outcome.status).toBe('error');
      expect(errors.length).toBe(1);
    } finally {
      restore();
    }
  });
});
