import { describe, expect, mock, test } from 'bun:test';
import { NextRequest } from 'next/server';
import { createWorkSessionPost } from '../app/api/albatross/work/[workId]/session/route';

function sessionRequest(body: unknown) {
  return new NextRequest('http://localhost/api/albatross/work/work-1/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const context = { params: Promise.resolve({ workId: 'work-1' }) };

// The api proxy mints a fresh reference per property access, so the fakes key
// on the exported function name instead. Added queries can never flip a
// mapping the way call-order parity could.
const { getFunctionName } = await import('convex/server');
const isWorkDetail = (fn: any) => getFunctionName(fn) === 'albatrossWorkV2:workDetail';
const isActiveSession = (fn: any) => getFunctionName(fn) === 'albatrossBrowserSessions:activeSessionForWork';

const step = {
  key: 'step-1',
  identity: 'step:task:submit the form',
  title: 'Submit the form',
  url: 'https://county.example/form',
  doneWhen: 'The confirmation page shows a reference number.',
  done: false,
};

const detail = {
  work: { _id: 'work-1', title: 'Submit the county form' },
  plan: { outcome: 'The form is submitted' },
  execution: { guideSteps: [step] },
};

const sessionInfo = {
  sessionId: 'bb-1',
  connectUrl: 'wss://connect.example/bb-1',
  liveViewUrl: 'https://live.example/bb-1',
  replayUrl: 'https://browserbase.com/sessions/bb-1',
};

function makeDeps(overrides: Record<string, unknown> = {}) {
  const scheduled: Array<() => Promise<void>> = [];
  return {
    scheduled,
    deps: {
      requireCurrentUser: mock(async () => ({ userId: 'user-1', email: 'u@e.com', name: 'U' })) as any,
      enforceUserRateLimit: mock(async () => undefined) as any,
      convexQuery: mock(async (fn: any, args: any) => {
        if (isWorkDetail(fn)) return args.workId === 'work-1' ? detail : null;
        if (isActiveSession(fn)) return null;
        return null;
      }) as any,
      convexMutation: mock(async () => undefined) as any,
      browserSessionsConfigured: () => true,
      createBrowserSession: mock(async () => sessionInfo) as any,
      releaseBrowserSession: mock(async () => undefined) as any,
      navigateSession: mock(async () => undefined) as any,
      readSessionPage: mock(async () => ({
        url: 'https://county.example/confirmation',
        title: 'Application received',
        text: 'Your reference number is AB-1234.',
      })) as any,
      evidenceSatisfies: mock(async () => ({ satisfies: true, reason: 'Reference number shown.' })) as any,
      completeWorkStep: mock(async () => ({ ok: true })) as any,
      schedule: (task: () => Promise<void>) => {
        scheduled.push(task);
      },
      reportError: mock(() => undefined),
      ...overrides,
    },
  };
}

describe('work session route', () => {
  test('start opens a shared session, records it, and prepares the page', async () => {
    const { deps, scheduled } = makeDeps();
    const post = createWorkSessionPost(deps as any);
    const response = await post(sessionRequest({ action: 'start', stepKey: 'step-1' }), context);
    const body = await response.json();
    expect(body).toMatchObject({ ok: true, sessionId: 'bb-1', liveViewUrl: 'https://live.example/bb-1' });
    expect((deps.convexMutation as any).mock.calls[0][1]).toMatchObject({
      workId: 'work-1',
      stepKey: 'step-1',
      stepIdentity: 'step:task:submit the form',
      sessionId: 'bb-1',
    });
    expect(scheduled).toHaveLength(1);
    await scheduled[0]();
    expect(deps.navigateSession).toHaveBeenCalledWith(
      'wss://connect.example/bb-1',
      'https://county.example/form',
    );
    const statusCall = (deps.convexMutation as any).mock.calls.at(-1)[1];
    expect(statusCall).toMatchObject({ sessionId: 'bb-1', status: 'user' });
  });

  test('start reports unconfigured sessions honestly', async () => {
    const { deps } = makeDeps({ browserSessionsConfigured: () => false });
    const post = createWorkSessionPost(deps as any);
    const response = await post(sessionRequest({ action: 'start', stepKey: 'step-1' }), context);
    expect(response.status).toBe(503);
  });

  test('verify checks the page, files observed evidence, and completes the step', async () => {
    const activeSession = {
      sessionId: 'bb-1',
      status: 'user',
      liveViewUrl: 'https://live.example/bb-1',
      replayUrl: 'https://browserbase.com/sessions/bb-1',
    };
    const mutations: any[] = [];
    const { deps } = makeDeps({
      convexQuery: mock(async (fn: any) => {
        if (isWorkDetail(fn)) return detail;
        if (isActiveSession(fn)) return activeSession;
        return null;
      }) as any,
      convexMutation: mock(async (_fn: any, args: any) => {
        mutations.push(args);
        return undefined;
      }) as any,
    });
    const post = createWorkSessionPost(deps as any);
    const response = await post(
      sessionRequest({ action: 'verify', sessionId: 'bb-1', stepKey: 'step-1' }),
      context,
    );
    const body = await response.json();
    expect(body).toMatchObject({ ok: true, satisfied: true });
    const proof = mutations.find((args) => args.sourceKind === 'browser_session');
    expect(proof).toMatchObject({
      stepIdentity: 'step:task:submit the form',
      sourceId: 'bb-1',
      trust: 'observed',
      url: 'https://browserbase.com/sessions/bb-1',
    });
    expect(deps.completeWorkStep).toHaveBeenCalledWith({
      userId: 'user-1',
      workId: 'work-1',
      stepKey: 'step-1',
      source: 'evidence',
    });
    expect(mutations.at(-1)).toMatchObject({ status: 'user' });
  });

  test('a refuted page check completes nothing', async () => {
    const activeSession = {
      sessionId: 'bb-1',
      status: 'user',
      liveViewUrl: 'https://live.example/bb-1',
      replayUrl: 'https://browserbase.com/sessions/bb-1',
    };
    const mutations: any[] = [];
    const { deps } = makeDeps({
      convexQuery: mock(async (fn: any) => (isWorkDetail(fn) ? detail : activeSession)) as any,
      convexMutation: mock(async (_fn: any, args: any) => {
        mutations.push(args);
        return undefined;
      }) as any,
      evidenceSatisfies: mock(async () => ({ satisfies: false, reason: 'No reference number yet.' })) as any,
    });
    const post = createWorkSessionPost(deps as any);
    const response = await post(
      sessionRequest({ action: 'verify', sessionId: 'bb-1', stepKey: 'step-1' }),
      context,
    );
    const body = await response.json();
    expect(body).toMatchObject({ ok: true, satisfied: false });
    expect(deps.completeWorkStep).not.toHaveBeenCalled();
    expect(mutations.some((args) => args.sourceKind === 'browser_session')).toBe(false);
    expect(mutations.at(-1)?.statusDetail).toContain('No reference number yet.');
  });

  test('an unavailable gate never completes the step', async () => {
    const activeSession = {
      sessionId: 'bb-1',
      status: 'user',
      liveViewUrl: 'https://live.example/bb-1',
      replayUrl: 'https://browserbase.com/sessions/bb-1',
    };
    const mutations: any[] = [];
    const { deps } = makeDeps({
      convexQuery: mock(async (fn: any) => (isWorkDetail(fn) ? detail : activeSession)) as any,
      convexMutation: mock(async (_fn: any, args: any) => {
        mutations.push(args);
        return undefined;
      }) as any,
      evidenceSatisfies: mock(async () => ({
        satisfies: true,
        reason: 'The check did not run.',
        unavailable: true,
      })) as any,
    });
    const post = createWorkSessionPost(deps as any);
    const response = await post(
      sessionRequest({ action: 'verify', sessionId: 'bb-1', stepKey: 'step-1' }),
      context,
    );
    const body = await response.json();
    expect(body.satisfied).toBe(false);
    expect(deps.completeWorkStep).not.toHaveBeenCalled();
    expect(mutations.some((args) => args.sourceKind === 'browser_session')).toBe(false);
    expect(mutations.at(-1)?.statusDetail).toBe('The check did not run. Try again.');
  });

  test('verify rejects a step that is already done', async () => {
    const activeSession = {
      sessionId: 'bb-1',
      status: 'user',
      liveViewUrl: 'https://live.example/bb-1',
      replayUrl: 'https://browserbase.com/sessions/bb-1',
    };
    const doneDetail = { ...detail, execution: { guideSteps: [{ ...step, done: true }] } };
    const { deps } = makeDeps({
      convexQuery: mock(async (fn: any) => (isWorkDetail(fn) ? doneDetail : activeSession)) as any,
    });
    const post = createWorkSessionPost(deps as any);
    const response = await post(
      sessionRequest({ action: 'verify', sessionId: 'bb-1', stepKey: 'step-1' }),
      context,
    );
    expect(response.status).toBe(409);
    expect(deps.completeWorkStep).not.toHaveBeenCalled();
  });

  test('start releases a superseded remote session before opening a new one', async () => {
    const { deps, scheduled } = makeDeps({
      convexQuery: mock(async (fn: any) => {
        if (isWorkDetail(fn)) return detail;
        if (isActiveSession(fn)) return { sessionId: 'bb-old' };
        return null;
      }) as any,
    });
    const post = createWorkSessionPost(deps as any);
    await post(sessionRequest({ action: 'start', stepKey: 'step-1' }), context);
    expect(deps.releaseBrowserSession).toHaveBeenCalledWith('bb-old');
    expect(scheduled).toHaveLength(1);
  });

  test('end releases the session and closes the ledger row', async () => {
    const { deps } = makeDeps();
    const post = createWorkSessionPost(deps as any);
    const response = await post(sessionRequest({ action: 'end', sessionId: 'bb-1' }), context);
    const body = await response.json();
    expect(body).toMatchObject({ ok: true });
    expect(deps.releaseBrowserSession).toHaveBeenCalledWith('bb-1');
    expect((deps.convexMutation as any).mock.calls.at(-1)[1]).toMatchObject({
      sessionId: 'bb-1',
      status: 'ended',
    });
  });
});
