import { afterEach, expect, spyOn, test } from 'bun:test';
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';
import { MockLanguageModelV3 } from 'ai/test';
import * as gateway from '../lib/ai/gateway';
import { runAgent } from '../lib/ai/loop';
import {
  type PresentationSession,
  presentationSessionFromMessages,
} from '../lib/documents/presentation-choices';
import { planPresentation } from '../lib/documents/presentation-plan';
import * as narrative from '../lib/narrative/service';
import * as memories from '../lib/store/memories';
import { presentationPlan } from '../lib/tools/presentations';

const restores: Array<() => void> = [];
afterEach(() => {
  for (const restore of restores.splice(0).reverse()) restore();
});

function model(...turns: LanguageModelV3StreamPart[][]) {
  let index = 0;
  return new MockLanguageModelV3({
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller) {
          for (const part of turns[index++] ?? []) controller.enqueue(part);
          controller.close();
        },
      }),
    }),
  });
}

function textParts(text: string): LanguageModelV3StreamPart[] {
  return [
    { type: 'text-start', id: 'text' },
    { type: 'text-delta', id: 'text', delta: text },
    { type: 'text-end', id: 'text' },
  ];
}

function finish(reason: 'stop' | 'tool-calls' = 'stop'): LanguageModelV3StreamPart {
  return {
    type: 'finish',
    finishReason: { unified: reason, raw: reason },
    usage: {
      inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 2, text: 2, reasoning: 0 },
    },
  };
}

async function run(
  models: MockLanguageModelV3[],
  signal?: AbortSignal,
  presentationSession?: PresentationSession,
) {
  const runtimeSpy = spyOn(gateway, 'resolveAgentRuntimes').mockResolvedValue(
    models.map((model, index) => ({
      userId: 'owner',
      source: 'lab86',
      provider: 'openai',
      modelName: `model-${index}`,
      model,
    })),
  );
  const usage = spyOn(gateway, 'recordAgentUsage').mockResolvedValue(undefined);
  const context = spyOn(narrative, 'narrativePrompt').mockResolvedValue('');
  const memory = spyOn(memories, 'listMemories').mockResolvedValue([]);
  for (const spy of [runtimeSpy, usage, context, memory]) restores.push(() => spy.mockRestore());
  const agent = await runAgent({
    runId: 'deck-run',
    userId: 'owner',
    toolGroups: ['documents'],
    messages: [{ role: 'user', content: 'Restyle the deck' }],
    signal,
    presentationSession,
  });
  const response = agent.toUIMessageStreamResponse();
  expect(response.headers.get('x-agent-run-id')).toBe('deck-run');
  expect(response.headers.get('x-accel-buffering')).toBe('no');
  const events = (await response.text())
    .split('\n')
    .filter((line) => line.startsWith('data: {'))
    .map((line) => JSON.parse(line.slice(6)));
  return { events, steps: await agent.steps, usage, runtimeSpy };
}

function answeredBrief(delegateRemaining = false) {
  return presentationSessionFromMessages([
    {
      role: 'assistant',
      parts: [
        {
          type: 'tool-ask_presentation_choices',
          toolCallId: 'brief',
          state: 'output-available',
          input: {
            presentationId: 'bengals',
            stage: 'brief',
            title: 'Cincinnati Bengals: The Last Six Seasons',
          },
          output: {
            presentationId: 'bengals',
            stage: 'brief',
            decision: 'continue',
            delegateRemaining,
            brief: {
              audience: 'me',
              purpose: 'Review the last six seasons',
              sources: ['provided', 'web'],
              sourceGuidance: '',
              contentSlides: 6,
              sectionBreaks: 2,
              detail: 'balanced',
            },
          },
        },
      ],
    },
  ]);
}

function pickerCall(id: string, stage = 'design'): LanguageModelV3StreamPart {
  return {
    type: 'tool-call',
    toolCallId: id,
    toolName: 'ask_presentation_choices',
    input: JSON.stringify({
      presentationId: 'bengals',
      stage,
      title: 'Cincinnati Bengals: The Last Six Seasons',
    }),
  };
}

test('a repeated brief is repaired internally and only the next design picker opens', async () => {
  const session = answeredBrief();
  const saved = structuredClone(session);
  const primary = model(
    [pickerCall('duplicate-brief', 'brief'), finish('tool-calls')],
    [pickerCall('design'), finish('tool-calls')],
  );
  const { events, steps } = await run([primary], undefined, session);
  expect(steps).toHaveLength(2);
  const schema = primary.doStreamCalls[0].tools?.find((tool) => tool.name === 'ask_presentation_choices');
  expect(schema).toMatchObject({
    inputSchema: {
      properties: {
        stage: { const: 'design' },
        presentationId: { const: 'bengals' },
      },
    },
  });
  expect(events.filter((event) => event.type === 'tool-input-available')).toEqual([
    expect.objectContaining({
      toolCallId: 'design',
      input: expect.objectContaining({ stage: 'design' }),
    }),
  ]);
  expect(events).toContainEqual(
    expect.objectContaining({
      type: 'tool-output-error',
      toolCallId: 'duplicate-brief',
    }),
  );
  expect(events.some((event) => event.type === 'error')).toBe(false);
  expect(session).toEqual(saved);
});

test('parallel presentation questions expose one picker and pause without replaying the model', async () => {
  const session = answeredBrief();
  const primary = model(
    [pickerCall('first'), pickerCall('duplicate'), finish('tool-calls')],
    [...textParts('Must wait for the user'), finish()],
  );
  const { events } = await run([primary], undefined, session);
  expect(primary.doStreamCalls).toHaveLength(1);
  expect(events.filter((event) => event.type === 'tool-input-available')).toEqual([
    expect.objectContaining({ toolCallId: 'first' }),
  ]);
  expect(events).toContainEqual(
    expect.objectContaining({
      type: 'tool-output-error',
      toolCallId: 'duplicate',
      errorText: expect.stringContaining('already awaiting'),
    }),
  );
  expect(events.some((event) => event.type === 'error')).toBe(false);
  expect(session).toEqual(answeredBrief());
});

test('delegated continuations omit the picker and reject a provider replay without revoking delegation', async () => {
  const session = answeredBrief(true);
  const primary = model(
    [pickerCall('stale-brief', 'brief'), finish('tool-calls')],
    [...textParts('Continuing with the researched deck.'), finish()],
  );
  const { events } = await run([primary], undefined, session);
  expect(primary.doStreamCalls).toHaveLength(2);
  for (const call of primary.doStreamCalls) {
    expect(call.tools?.some((tool) => tool.name === 'ask_presentation_choices')).toBe(false);
    expect(call.tools?.some((tool) => tool.name === 'presentation_plan')).toBe(true);
    expect(call.tools?.some((tool) => tool.name === 'document_create')).toBe(true);
  }
  expect(events.filter((event) => event.type === 'tool-input-available')).toHaveLength(0);
  expect(events).toContainEqual(
    expect.objectContaining({
      type: 'text-delta',
      delta: 'Continuing with the researched deck.',
    }),
  );
  expect(events.some((event) => event.type === 'error')).toBe(false);
  expect(session).toEqual(answeredBrief(true));
});

test('a planner timeout and malformed storyboard recover in the same stream, then pause for actual user choices', async () => {
  const evidence = [
    { id: 'source', source: 'Supplied historical source', content: 'Source content remains in context.' },
  ];
  const failed = await planPresentation(
    { userId: 'owner', instruction: 'Plan the history deck', audience: 'Students', evidence, slideCount: 3 },
    async () => {
      throw new Error('Planning timed out');
    },
  );
  const planner = spyOn(presentationPlan, 'handler').mockResolvedValue(failed);
  restores.push(() => planner.mockRestore());
  const session: PresentationSession = {
    presentationId: 'history',
    brief: {
      audience: 'Students',
      purpose: 'Understand the history',
      sources: ['provided'],
      sourceGuidance: '',
      contentSlides: 1,
      sectionBreaks: 0,
      detail: 'balanced',
    },
    design: { theme: 'rose', fontPair: 'literary', imagery: 'none', guidance: '' },
  };
  const valid = {
    presentationId: 'history',
    stage: 'storyboard',
    title: 'The Zong and its legacy',
    theme: 'rose',
    fontPair: 'literary',
    audience: null,
    slides: ['cover', 'content', 'close'].map((kind, index) => ({
      id: `slide-${index}`,
      kind,
      title: `Chapter ${index + 1}`,
      takeaway: 'A grounded historical account',
      recommended: 'typography',
      chart: null,
      table: null,
    })),
  };
  const primary = model(
    [
      {
        type: 'tool-call',
        toolCallId: 'plan',
        toolName: 'presentation_plan',
        input: JSON.stringify({
          instruction: 'Plan the history deck',
          audience: 'Students',
          evidence,
          slideCount: 3,
        }),
      },
      finish('tool-calls'),
    ],
    [
      {
        type: 'tool-call',
        toolCallId: 'bad-picker',
        toolName: 'ask_presentation_choices',
        input: JSON.stringify({
          ...valid,
          slides: valid.slides.map((slide) => ({ ...slide, takeaway: 'x'.repeat(401) })),
        }),
      },
      finish('tool-calls'),
    ],
    [
      {
        type: 'tool-call',
        toolCallId: 'fixed-picker',
        toolName: 'ask_presentation_choices',
        input: JSON.stringify(valid),
      },
      finish('tool-calls'),
    ],
  );
  const { events, steps } = await run([primary], undefined, session);
  expect(steps).toHaveLength(3);
  expect(events).toContainEqual(
    expect.objectContaining({
      type: 'tool-output-error',
      toolCallId: 'bad-picker',
      errorText: expect.stringContaining('takeaway'),
    }),
  );
  expect(events).toContainEqual(
    expect.objectContaining({
      type: 'tool-input-available',
      toolCallId: 'fixed-picker',
      input: expect.objectContaining({ theme: 'rose', fontPair: 'literary' }),
    }),
  );
  expect(events.some((event) => event.type === 'error')).toBe(false);
  expect(
    events.some((event) => event.type === 'tool-output-available' && event.toolCallId === 'fixed-picker'),
  ).toBe(false);
  expect(session.brief?.contentSlides).toBe(1);
  expect(session.design?.theme).toBe('rose');
  expect(session.design?.fontPair).toBe('literary');
  const thirdRequest = JSON.stringify(primary.doStreamCalls[2].prompt);
  expect(thirdRequest).toContain('Source content remains in context');
  expect(thirdRequest).toContain('takeaway');
  expect(thirdRequest).toContain('Continue NOW');
});

test('a rejected deck edit is a recoverable tool result, not a failed provider stream', async () => {
  const primary = model(
    [
      {
        type: 'tool-call',
        toolCallId: 'invalid-edit',
        toolName: 'document_edit',
        input: JSON.stringify({
          documentId: 'deck',
          expectedRevision: 4,
          operations: [
            {
              op: 'element_upsert',
              slideId: 'slide',
              element: {
                id: 'accent',
                type: 'shape',
                x: 0,
                y: -1,
                width: 50,
                height: 0,
              },
            },
          ],
        }),
      },
      finish('tool-calls'),
    ],
    [...textParts('The edit needs valid geometry.'), finish()],
  );
  const { events, usage, steps } = await run([primary]);
  expect(events).toContainEqual(
    expect.objectContaining({ type: 'tool-output-error', toolCallId: 'invalid-edit' }),
  );
  expect(events).toContainEqual({ type: 'finish', finishReason: 'stop' });
  expect(events.some((event) => event.type === 'error')).toBe(false);
  expect(primary.doStreamCalls).toHaveLength(2);
  expect(steps).toHaveLength(2);
  expect(usage.mock.calls[0][3]).toBe(true);
});

test('a fatal provider error after content preserves the partial turn and prevents runtime replay', async () => {
  const primary = model([
    ...textParts('I have read the deck.'),
    { type: 'error', error: Object.assign(new Error('provider disconnected'), { statusCode: 503 }) },
  ]);
  const fallback = model([...textParts('Do not replay this turn.'), finish()]);
  const { events, usage } = await run([primary, fallback]);
  expect(events).toContainEqual(
    expect.objectContaining({ type: 'text-delta', delta: 'I have read the deck.' }),
  );
  expect(events).toContainEqual({ type: 'error', errorText: 'provider disconnected' });
  expect(events).toContainEqual({ type: 'finish', finishReason: 'error' });
  expect(fallback.doStreamCalls).toHaveLength(0);
  expect(usage.mock.calls[0].slice(3)).toEqual([false, 'provider disconnected']);
});

test('a transient error before any content can safely fall back without leaking a failed turn', async () => {
  const primary = model([
    { type: 'error', error: Object.assign(new Error('upstream unavailable'), { statusCode: 503 }) },
  ]);
  const fallback = model([...textParts('The deck is ready to edit.'), finish()]);
  const { events, usage } = await run([primary, fallback]);
  expect(fallback.doStreamCalls).toHaveLength(1);
  expect(events.some((event) => event.type === 'error')).toBe(false);
  expect(events).toContainEqual({ type: 'finish', finishReason: 'stop' });
  expect(usage.mock.calls.map((call) => call[3])).toEqual([false, true]);
});

test('an already cancelled request never starts model generation', async () => {
  const controller = new AbortController();
  controller.abort();
  const primary = model([...textParts('Must not run.'), finish()]);
  const { events, runtimeSpy, steps } = await run([primary], controller.signal);
  expect(events).toContainEqual({ type: 'abort' });
  expect(runtimeSpy).not.toHaveBeenCalled();
  expect(primary.doStreamCalls).toHaveLength(0);
  expect(steps).toEqual([]);
});

test('cancelling after partial content produces an abort, not a failure finish', async () => {
  const abort = new AbortController();
  const primary = new MockLanguageModelV3({
    doStream: async () => ({
      stream: new ReadableStream({
        async start(controller) {
          for (const chunk of textParts('Partial response')) controller.enqueue(chunk);
          await new Promise((resolve) => setTimeout(resolve, 20));
          abort.abort();
          controller.close();
        },
      }),
    }),
  });
  const { events } = await run([primary], abort.signal);
  expect(events).toContainEqual(expect.objectContaining({ type: 'text-delta', delta: 'Partial response' }));
  expect(events).toContainEqual({ type: 'abort' });
  expect(events).not.toContainEqual({ type: 'finish', finishReason: 'error' });
});
