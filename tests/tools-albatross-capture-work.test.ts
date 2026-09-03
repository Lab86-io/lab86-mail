import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { SYSTEM_PROMPT } from '../lib/ai/system-prompt';
import { harvestTurnArtifacts, toolCallsFromSteps } from '../lib/albatross/work-turn-reconcile';
import { getTool } from '../lib/tools';
import * as albatross from '../lib/tools/albatross';
import { runTool } from './tools/harness';

const captureCalls: Array<{ input: any; user: any }> = [];

beforeEach(() => {
  captureCalls.length = 0;
  albatross.__setAlbatrossToolDepsForTest({
    captureFromChat: async (input: any, user: any) => {
      captureCalls.push({ input, user });
      return {
        captureId: 'capture-1',
        workIds: ['work-1', 'work-2'],
        work: [
          {
            id: 'work-1',
            title: 'Book the dentist',
            shape: 'quick',
            horizon: { kind: 'now', by: 1_800_000_000_000 },
          },
          { id: 'work-2', title: 'Renew the passport', shape: 'quick', horizon: null },
        ],
        existing: false,
      };
    },
  });
});

afterAll(() => {
  albatross.__setAlbatrossToolDepsForTest();
});

describe('albatross_capture_work', () => {
  test('is registered with the other albatross tools', () => {
    expect(getTool('albatross_capture_work')?.name).toBe('albatross_capture_work');
    expect(albatross.albatrossCaptureWork.mutating).toBe(true);
  });

  test('captures with source chat and returns id, title, shape, and horizon per Work', async () => {
    const result = await runTool(
      albatross.albatrossCaptureWork.handler,
      { text: 'book the dentist and renew the passport', conversationId: 'conv-1' },
      { userEmail: 'jakob@example.test', userName: 'Jakob' },
    );
    expect(result).toEqual({
      ok: true,
      work: [
        {
          id: 'work-1',
          title: 'Book the dentist',
          shape: 'quick',
          horizon: { kind: 'now', by: 1_800_000_000_000 },
        },
        { id: 'work-2', title: 'Renew the passport', shape: 'quick', horizon: null },
      ],
    });
    expect(captureCalls).toHaveLength(1);
    expect(captureCalls[0].input).toEqual({
      text: 'book the dentist and renew the passport',
      shape: undefined,
      horizon: undefined,
      conversationId: 'conv-1',
    });
    expect(captureCalls[0].user).toEqual({
      userId: 'test_user_tools',
      email: 'jakob@example.test',
      name: 'Jakob',
      source: 'clerk',
    });
  });

  test('passes an explicit shape and horizon through', async () => {
    await runTool(albatross.albatrossCaptureWork.handler, {
      text: 'lose fifteen pounds by spring',
      shape: 'practice',
      horizon: { kind: 'now', by: 1_800_000_000_000, label: 'by spring' },
    });
    expect(captureCalls[0].input).toMatchObject({
      shape: 'practice',
      horizon: { kind: 'now', by: 1_800_000_000_000, label: 'by spring' },
    });
  });

  test('falls back to the chat id from the tool context', async () => {
    await runTool(albatross.albatrossCaptureWork.handler, { text: 'hold this' }, { chatId: 'chat-9' });
    expect(captureCalls[0].input.conversationId).toBe('chat-9');
  });

  test('refuses without a user', async () => {
    await expect(
      runTool(albatross.albatrossCaptureWork.handler, { text: 'hold this' }, { userId: null }),
    ).rejects.toThrow('Not authenticated.');
    expect(captureCalls).toHaveLength(0);
  });

  test('the input schema rejects an unknown shape or horizon kind', () => {
    const input = albatross.albatrossCaptureWork.input;
    expect(input.safeParse({ text: 'x', shape: 'wish' }).success).toBe(false);
    expect(input.safeParse({ text: 'x', horizon: { kind: 'never' } }).success).toBe(false);
    expect(input.safeParse({ text: 'x', horizon: { kind: 'later', notBefore: 1 } }).success).toBe(true);
  });
});

describe('the assistant prompt', () => {
  test('allows the capture tool only on an explicit ask, and forbids emoji and the word AI in output', () => {
    expect(SYSTEM_PROMPT).toContain(
      'Call albatross_capture_work only when the user explicitly asks to hold, keep, or remember something as Work; never on your own initiative.',
    );
    expect(SYSTEM_PROMPT).toContain('Never use emoji');
    expect(SYSTEM_PROMPT).toContain('Never write the word "AI" in a response.');
  });
});

describe('turn reconcile', () => {
  test('recognizes albatross_capture_work results as workCaptured artifacts', () => {
    const artifacts = harvestTurnArtifacts(
      toolCallsFromSteps([
        {
          content: [
            {
              type: 'tool-call',
              toolCallId: 'c1',
              toolName: 'albatross_capture_work',
              input: { text: 'hold this' },
            },
            {
              type: 'tool-result',
              toolCallId: 'c1',
              output: {
                ok: true,
                work: [
                  { id: 'work-1', title: 'Book the dentist', shape: 'quick', horizon: null },
                  { id: '', title: 'skipped' },
                ],
              },
            },
          ],
        },
      ]),
    );
    expect(artifacts).toEqual([
      { kind: 'workCaptured', id: 'work-1', title: 'Book the dentist', sourceKind: 'chat' },
    ]);
  });

  test('ignores a failed capture call', () => {
    const artifacts = harvestTurnArtifacts(
      toolCallsFromSteps([
        {
          content: [
            { type: 'tool-call', toolCallId: 'c1', toolName: 'albatross_capture_work', input: { text: 'x' } },
            { type: 'tool-result', toolCallId: 'c1', output: { ok: false } },
          ],
        },
      ]),
    );
    expect(artifacts).toEqual([]);
  });
});
