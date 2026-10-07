import { afterEach, describe, expect, test } from 'bun:test';
import {
  guideStepsWithOptimisticCompletion,
  postJson,
  stepIsOffline,
  stepNeedsYou,
  workIsOpen,
  workTitle,
} from '../lib/albatross/work-view';

// Shared helpers of the Work thread (docs/albatross-thread.md): what is the
// user's alone on a step, the title, and the JSON post the thread uses.

const step = (over: Record<string, unknown>) =>
  ({ key: 'step-1', title: 'Register', done: false, ...over }) as any;

describe('stepNeedsYou', () => {
  test('the stored mode decides; personal details are never the user alone', () => {
    expect(stepNeedsYou(step({ stepMode: 'agent_does' }))).toEqual([]);
    expect(stepNeedsYou(step({ stepMode: 'agent_drafts' }))).toEqual([
      'Approve the draft before it goes anywhere.',
    ]);
    expect(stepNeedsYou(step({ stepMode: 'you_do_observed' }))).toEqual([
      'Payment, a signature, or a sign-in on the page is yours.',
    ]);
    expect(stepNeedsYou(step({ stepMode: 'you_do_offline' }))).toEqual([
      'Complete the real-world part and return here to record it.',
    ]);
    for (const line of stepNeedsYou(step({ stepMode: 'you_do_observed' })))
      expect(line.toLowerCase()).not.toContain('personal details');
  });

  test('without a stored mode, the legacy guesses fill in', () => {
    expect(stepNeedsYou(step({ kind: 'physical' }))).toEqual([
      'Complete the real-world part and return here to record it.',
    ]);
    expect(stepNeedsYou(step({ url: 'https://aliveat25.example.com' }))).toEqual([
      'Payment, a signature, or a sign-in on the page is yours.',
    ]);
    expect(stepNeedsYou(step({}))).toEqual([]);
  });
});

describe('small rules', () => {
  test('offline steps', () => {
    const offline = (over: Record<string, unknown>) => stepIsOffline(step(over));
    expect(offline({ stepMode: 'you_do_offline' })).toBe(true);
    expect(offline({ stepMode: 'agent_does' })).toBe(false);
    expect(offline({ kind: 'physical', url: 'https://x.example' })).toBe(true);
    expect(offline({ url: 'https://x.example' })).toBe(false);
    expect(offline({})).toBe(true);
  });

  test('open Work and titles', () => {
    expect(workIsOpen({ workState: 'active' })).toBe(true);
    expect(workIsOpen({ workState: undefined })).toBe(true);
    for (const workState of ['done', 'released', 'archived']) expect(workIsOpen({ workState })).toBe(false);
    expect(workTitle({ plan: { outcome: 'Course done' }, work: { title: 'T', rawText: 'R' } } as any)).toBe(
      'Course done',
    );
    expect(workTitle({ plan: null, work: { title: '', rawText: 'Register me' } } as any)).toBe('Register me');
  });

  test('a step marked done here shows done before the server says so', () => {
    const steps = [step({ key: 'a' }), step({ key: 'b' })];
    expect(guideStepsWithOptimisticCompletion(steps, new Set(['b'])).map((entry: any) => entry.done)).toEqual(
      [false, true],
    );
  });
});

describe('postJson', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test('it returns the parsed body on success', async () => {
    globalThis.fetch = (async () => Response.json({ ok: true, runId: 'run-1' })) as any;
    expect(await postJson('/x', { a: 1 }, 'Failed.')).toEqual({ ok: true, runId: 'run-1' });
  });

  test('an error carries the server message, the status, and the body', async () => {
    globalThis.fetch = (async () =>
      Response.json(
        { ok: false, error: 'Check the answers.', errors: { phone: 'Type a phone number.' } },
        { status: 400 },
      )) as any;
    try {
      await postJson('/x', {}, 'Failed.');
      throw new Error('expected a failure');
    } catch (error: any) {
      expect(error.message).toBe('Check the answers.');
      expect(error.status).toBe(400);
      expect(error.body.errors).toEqual({ phone: 'Type a phone number.' });
    }
  });

  test('a non-JSON error page falls back to the caller message', async () => {
    globalThis.fetch = (async () => new Response('<html>Bad gateway</html>', { status: 502 })) as any;
    await expect(postJson('/x', {}, 'The run did not start.')).rejects.toThrow('The run did not start.');
  });
});
