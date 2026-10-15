import { afterEach, describe, expect, test } from 'bun:test';
import {
  GOAL_CLIENT_COPY,
  goalContinueBody,
  goalStartBody,
  postGoalContinue,
  postGoalStart,
} from '../lib/albatross/goal-run-client';
import { openSavedFilePath } from '../lib/albatross/step-run-navigation';
import {
  earlierChatMessageFixture,
  goalHoursDocumentFixture,
  goalInvoiceDocumentFixture,
  goalMessagesFixture,
} from '../lib/albatross/thread-fixtures';

// The web client's goal-run calls (docs/albatross-goal-runs.md, "Lead decisions
// during the build"): start with no step, and "Done, continue" with the goal key.

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function stubFetch(answer: () => Response) {
  const calls: Array<{ url: string; body: unknown }> = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    return answer();
  }) as unknown as typeof fetch;
  return calls;
}

describe('goal run client calls', () => {
  test('the bodies: a start with no step, and a continue with the goal key and the zone', () => {
    expect(goalStartBody()).toEqual({ action: 'start' });
    expect(goalContinueBody()).toMatchObject({ stepKey: 'goal', continue: true });
    expect(typeof goalContinueBody().timezone).toBe('string');
  });

  test('start posts to the run route and reads the run id', async () => {
    const calls = stubFetch(() => Response.json({ ok: true, runId: 'run_1' }));
    expect(await postGoalStart('work 1')).toEqual({ runId: 'run_1' });
    expect(calls).toEqual([{ url: '/api/albatross/work/work%201/run', body: { action: 'start' } }]);
    stubFetch(() => Response.json({ ok: true }));
    expect(await postGoalStart('work_1')).toEqual({ runId: null });
  });

  test('continue posts to the step route; a refusal keeps the server words or the plain copy', async () => {
    const calls = stubFetch(() => Response.json({ ok: true, nextRunId: 'run_2', allStepsComplete: false }));
    expect(await postGoalContinue('work_1')).toEqual({ nextRunId: 'run_2', allStepsComplete: false });
    expect(calls[0].url).toBe('/api/albatross/work/work_1/step');
    stubFetch(() => Response.json({ ok: true }));
    expect(await postGoalContinue('work_1')).toEqual({ nextRunId: null, allStepsComplete: false });
    stubFetch(() => Response.json({ ok: false, error: 'No goal handoff waits.' }, { status: 409 }));
    await expect(postGoalContinue('work_1')).rejects.toMatchObject({
      message: 'No goal handoff waits.',
      status: 409,
    });
    stubFetch(() => new Response('bad', { status: 500 }));
    await expect(postGoalStart('work_1')).rejects.toThrow(GOAL_CLIENT_COPY.startFailed);
  });
});

describe('a saved file link', () => {
  test('a link that is not a URL opens nothing', () => {
    const deps = {
      getState: () => ({ setPrimaryView: () => undefined }) as any,
      pushPath: () => undefined,
      dispatch: () => undefined,
    };
    expect(openSavedFilePath(deps, 'http://[')).toBe(false);
    expect(openSavedFilePath(deps, '   ')).toBe(false);
  });
});

describe('the goal harness fixtures', () => {
  test('the documents, the messages, and the earlier chat message are well formed', () => {
    const now = Date.UTC(2026, 9, 15, 18);
    const invoice = goalInvoiceDocumentFixture(now);
    const hours = goalHoursDocumentFixture(now);
    expect(invoice.model.kind).toBe('doc');
    expect(hours.model.kind).toBe('doc');
    expect(invoice.model.kind === 'doc' && invoice.model.blocks.length).toBeGreaterThan(0);
    expect(hours.model.kind === 'doc' && hours.model.blocks.length).toBeGreaterThan(0);
    expect(invoice.documentId).not.toBe(hours.documentId);
    const messages = goalMessagesFixture(now, 'run_goal_running');
    expect(messages.length).toBeGreaterThan(0);
    expect(messages.every((message) => message.parts.length > 0)).toBe(true);
    expect(earlierChatMessageFixture().id).toBe('m_earlier');
  });
});
