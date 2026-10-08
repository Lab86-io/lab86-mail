import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { getFunctionName } from 'convex/server';
import { NextRequest } from 'next/server';
import { createBrowserContextRoutes } from '../app/api/albatross/browser-context/route';
import { createHandoffsGet } from '../app/api/albatross/handoffs/route';
import { createStepRunPost } from '../app/api/albatross/work/[workId]/run/route';
import { createStepRunJobPost } from '../app/api/cron/step-run/route';
import { createStepRunsCronPost } from '../app/api/cron/step-runs/route';
import { StepRunStartError } from '../lib/albatross/step-run-start';
import { AuthRequiredError } from '../lib/auth/current-user';
import { RateLimitError } from '../lib/rate-limit';

const nameOf = (fn: any) => getFunctionName(fn);

let errorSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  errorSpy = spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  errorSpy.mockRestore();
});

function post(url: string, body: unknown) {
  return new NextRequest(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const user = { userId: 'user-1', email: 'u@example.com', name: 'U' };

describe('POST /api/albatross/work/[workId]/run', () => {
  const context = { params: Promise.resolve({ workId: 'work-1' }) };
  const request = (body: unknown) => post('http://localhost/api/albatross/work/work-1/run', body);

  function makeDeps(overrides: Record<string, unknown> = {}) {
    const mutations: Array<[string, any]> = [];
    const deps = {
      requireCurrentUser: mock(async () => user) as any,
      enforceUserRateLimit: mock(async () => undefined) as any,
      convexMutation: mock(async (fn: any, args: any) => {
        const name = nameOf(fn);
        mutations.push([name, args]);
        if (name === 'albatrossStepRuns:cancel') return { cancelled: true, browserSessionId: 'bb-1' };
        return { dismissed: true };
      }) as any,
      startStepRun: mock(async () => ({ runId: 'run-1', created: true })) as any,
      resumeStepRun: mock(async () => ({ runId: 'run-2', created: true })) as any,
      ...overrides,
    };
    return { deps, mutations };
  }

  test('a start or a resume that queued nothing answers 409 with a reason', async () => {
    const { deps } = makeDeps({
      startStepRun: mock(async () => ({ runId: null, created: false, reason: 'no_step' })) as any,
      resumeStepRun: mock(async () => ({ runId: null, created: false })) as any,
    });
    const started = await createStepRunPost(deps)(request({ action: 'start', stepKey: 'step-1' }), context);
    expect(started.status).toBe(409);
    expect(await started.json()).toEqual({
      ok: false,
      error: 'Albatross could not start on this step now. Try again.',
    });
    const resumed = await createStepRunPost(deps)(request({ action: 'resume', runId: 'run-1' }), context);
    expect(resumed.status).toBe(409);
    expect(await resumed.json()).toEqual({
      ok: false,
      error: 'Albatross could not continue this step now. Try again.',
    });
  });

  test('start runs the step with the user trigger', async () => {
    const { deps } = makeDeps();
    const response = await createStepRunPost(deps)(
      request({ action: 'start', stepKey: ' step-1 ' }),
      context,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, runId: 'run-1' });
    expect(deps.startStepRun).toHaveBeenCalledWith({
      userId: 'user-1',
      workId: 'work-1',
      stepKey: 'step-1',
      trigger: 'user',
    });
    expect(deps.enforceUserRateLimit).toHaveBeenCalledWith({
      userId: 'user-1',
      key: 'albatross-step-run',
      limit: 60,
      windowMs: 60_000,
    });
  });

  test('resume passes the run and the note', async () => {
    const { deps } = makeDeps();
    const response = await createStepRunPost(deps)(
      request({ action: 'resume', runId: 'run-1', note: 'I signed in.' }),
      context,
    );
    expect(await response.json()).toEqual({ ok: true, runId: 'run-2' });
    expect(deps.resumeStepRun).toHaveBeenCalledWith({
      userId: 'user-1',
      workId: 'work-1',
      runId: 'run-1',
      note: 'I signed in.',
    });
  });

  test('missing ids and unknown actions are 400', async () => {
    const { deps } = makeDeps();
    const handler = createStepRunPost(deps);
    for (const [body, error] of [
      [{ action: 'start' }, 'stepKey is required.'],
      [{ action: 'resume', runId: '  ' }, 'runId is required.'],
      [{ action: 'cancel' }, 'runId is required.'],
      [{ action: 'dismiss', runId: 7 }, 'runId is required.'],
      [{ action: 'explode' }, 'Unknown action.'],
      ['not json', 'Unknown action.'],
    ] as const) {
      const response = await handler(request(body), context);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ ok: false, error });
    }
    expect(deps.startStepRun).not.toHaveBeenCalled();
  });

  test('a StepRunStartError keeps its status and message', async () => {
    for (const status of [403, 404, 409] as const) {
      const { deps } = makeDeps({
        startStepRun: mock(async () => {
          throw new StepRunStartError('Albatross is already working on this.', status);
        }),
      });
      const response = await createStepRunPost(deps)(
        request({ action: 'start', stepKey: 'step-1' }),
        context,
      );
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ ok: false, error: 'Albatross is already working on this.' });
    }
  });

  test('cancel gives the shared browser to the user', async () => {
    const { deps, mutations } = makeDeps();
    const response = await createStepRunPost(deps)(request({ action: 'cancel', runId: 'run-1' }), context);
    expect(await response.json()).toEqual({ ok: true });
    expect(mutations).toEqual([
      ['albatrossStepRuns:cancel', { userId: 'user-1', id: 'run-1' }],
      [
        'albatrossBrowserSessions:setSessionStatus',
        { userId: 'user-1', sessionId: 'bb-1', status: 'user', statusDetail: 'You have the page.' },
      ],
    ]);
  });

  test('cancel without a browser session only cancels, and a failed status write is ignored', async () => {
    const plain = makeDeps({
      convexMutation: mock(async () => ({ cancelled: true, browserSessionId: null })),
    });
    await createStepRunPost(plain.deps)(request({ action: 'cancel', runId: 'run-1' }), context);
    expect(plain.deps.convexMutation).toHaveBeenCalledTimes(1);

    const failing = makeDeps({
      convexMutation: mock(async (fn: any) => {
        if (nameOf(fn) === 'albatrossBrowserSessions:setSessionStatus') throw new Error('gone');
        return { cancelled: true, browserSessionId: 'bb-1' };
      }),
    });
    const response = await createStepRunPost(failing.deps)(
      request({ action: 'cancel', runId: 'run-1' }),
      context,
    );
    expect(response.status).toBe(200);
  });

  test('dismiss closes the handoff', async () => {
    const { deps, mutations } = makeDeps();
    const response = await createStepRunPost(deps)(request({ action: 'dismiss', runId: 'run-1' }), context);
    expect(await response.json()).toEqual({ ok: true });
    expect(mutations).toEqual([['albatrossStepRuns:dismissHandoff', { userId: 'user-1', id: 'run-1' }]]);
  });

  test('a missing or invalid run is 404 for cancel and dismiss', async () => {
    for (const message of ['Run not found.', 'ArgumentValidationError: id', 'Invalid argument `id`']) {
      for (const action of ['cancel', 'dismiss']) {
        const { deps } = makeDeps({
          convexMutation: mock(async () => {
            throw new Error(message);
          }),
        });
        const response = await createStepRunPost(deps)(request({ action, runId: 'bad' }), context);
        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({ ok: false, error: 'Run not found.' });
      }
    }
  });

  test('another cancel failure is a 500 with a fixed message', async () => {
    const { deps } = makeDeps({
      convexMutation: mock(async () => {
        throw new Error('Convex internal detail');
      }),
    });
    const response = await createStepRunPost(deps)(request({ action: 'cancel', runId: 'run-1' }), context);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ ok: false, error: 'The run failed to start.' });
  });

  test('the rate limit answers 429', async () => {
    const { deps } = makeDeps({
      enforceUserRateLimit: mock(async () => {
        throw new RateLimitError('Too many requests. Try again shortly.', 4_000, 20);
      }),
    });
    const response = await createStepRunPost(deps)(request({ action: 'start', stepKey: 'step-1' }), context);
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('4');
    expect(deps.startStepRun).not.toHaveBeenCalled();
  });

  test('a signed-out request is 401', async () => {
    const { deps } = makeDeps({
      requireCurrentUser: mock(async () => {
        throw new AuthRequiredError('Sign in first.');
      }),
    });
    const response = await createStepRunPost(deps)(request({ action: 'start', stepKey: 'step-1' }), context);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ ok: false, error: 'Sign in first.' });
  });
});

describe('POST /api/cron/step-run', () => {
  const url = 'http://localhost/api/cron/step-run';

  function makeDeps(authorized = true, run: any = mock(async () => undefined)) {
    const scheduled: Array<() => Promise<void>> = [];
    const deps = {
      authorized: () => authorized,
      after: (task: () => Promise<void>) => {
        scheduled.push(task);
      },
      run,
    };
    return { deps: deps as any, scheduled, run };
  }

  test('an unauthorized request is 401', async () => {
    const { deps, scheduled } = makeDeps(false);
    const response = await createStepRunJobPost(deps)(post(url, { userId: 'user-1', id: 'run-1' }));
    expect(response.status).toBe(401);
    expect(scheduled).toEqual([]);
  });

  test('a body without the run is 400', async () => {
    const { deps, scheduled } = makeDeps();
    const handler = createStepRunJobPost(deps);
    for (const body of [
      { userId: 'user-1' },
      { id: 'run-1' },
      { userId: '', id: 'run-1' },
      { userId: 1, id: 2 },
      'x',
    ])
      expect((await handler(post(url, body))).status).toBe(400);
    expect(scheduled).toEqual([]);
  });

  test('accepts the run with 202 and runs it after the response', async () => {
    const { deps, scheduled, run } = makeDeps();
    const response = await createStepRunJobPost(deps)(post(url, { userId: 'user-1', id: 'run-1' }));
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: true });
    expect(run).not.toHaveBeenCalled();
    expect(scheduled).toHaveLength(1);
    await scheduled[0]();
    expect(run).toHaveBeenCalledWith('user-1', 'run-1');
  });

  test('a crashing run is caught and logged by name', async () => {
    const crash = mock(async () => {
      throw new TypeError('boom');
    });
    const { deps, scheduled } = makeDeps(true, crash);
    await createStepRunJobPost(deps)(post(url, { userId: 'user-1', id: 'run-1' }));
    await scheduled[0]();
    expect(errorSpy).toHaveBeenCalledWith('[cron/step-run] run crashed', 'run-1', 'TypeError');

    const odd = makeDeps(
      true,
      mock(async () => {
        throw 'odd';
      }),
    );
    await createStepRunJobPost(odd.deps)(post(url, { userId: 'user-1', id: 'run-2' }));
    await odd.scheduled[0]();
    expect(errorSpy).toHaveBeenCalledWith('[cron/step-run] run crashed', 'run-2', 'error');
  });
});

describe('POST /api/cron/step-runs', () => {
  const url = 'http://localhost/api/cron/step-runs';

  function makeDeps(start: any = mock(async () => ({ started: [], reasons: {} })), authorized = true) {
    return { deps: { authorized: () => authorized, start } as any, start };
  }

  test('an unauthorized request is 401', async () => {
    const { deps, start } = makeDeps(undefined, false);
    expect((await createStepRunsCronPost(deps)(post(url, { candidates: [] }))).status).toBe(401);
    expect(start).not.toHaveBeenCalled();
  });

  test('groups the candidates by user, drops bad rows, and counts started runs', async () => {
    const start = mock(async ({ userId }: { userId: string }) => ({
      started: userId === 'user-1' ? ['run-1'] : [],
      reasons: {},
    }));
    const { deps } = makeDeps(start);
    const response = await createStepRunsCronPost(deps)(
      post(url, {
        candidates: [
          { userId: 'user-1', workId: 'w1' },
          { userId: 'user-2', workId: 'w2' },
          { userId: 'user-1', workId: 'w3' },
          { userId: '', workId: 'w4' },
          { userId: 'user-3' },
          { userId: 'user-3', workId: 5 },
          null,
          'row',
        ],
      }),
    );
    expect(await response.json()).toEqual({ ok: true, users: 2, started: 1 });
    expect(start.mock.calls as unknown[]).toEqual([
      [{ userId: 'user-1', workIds: ['w1', 'w3'], trigger: 'conductor' }],
      [{ userId: 'user-2', workIds: ['w2'], trigger: 'conductor' }],
    ]);
  });

  test('caps the candidates at 20', async () => {
    const { deps, start } = makeDeps();
    const candidates = Array.from({ length: 30 }, (_, index) => ({ userId: 'user-1', workId: `w${index}` }));
    await createStepRunsCronPost(deps)(post(url, { candidates }));
    expect((start.mock.calls[0][0] as any).workIds).toHaveLength(20);
  });

  test('a failed start counts as none, and a body without candidates has no users', async () => {
    const start = mock(async () => {
      throw new Error('down');
    });
    const { deps } = makeDeps(start);
    const response = await createStepRunsCronPost(deps)(
      post(url, { candidates: [{ userId: 'u', workId: 'w' }] }),
    );
    expect(await response.json()).toEqual({ ok: true, users: 1, started: 0 });

    for (const body of [{ candidates: 'nope' }, 'not json']) {
      const empty = await createStepRunsCronPost(makeDeps().deps)(post(url, body));
      expect(await empty.json()).toEqual({ ok: true, users: 0, started: 0 });
    }
  });
});

describe('GET /api/albatross/handoffs', () => {
  test('returns the open handoffs of the user', async () => {
    const items = [{ workId: 'work-1', workTitle: 'Dispute', run: { id: 'run-1' } }];
    const convexQuery = mock(async () => items);
    const response = await createHandoffsGet({ requireCurrentUser: async () => user, convexQuery } as any)();
    expect(await response.json()).toEqual({ ok: true, items });
    const [fn, args] = convexQuery.mock.calls[0] as any;
    expect(nameOf(fn)).toBe('albatrossStepRuns:openHandoffs');
    expect(args).toEqual({ userId: 'user-1', limit: 8 });
  });

  test('a null answer is an empty list', async () => {
    const response = await createHandoffsGet({
      requireCurrentUser: async () => user,
      convexQuery: async () => null,
    } as any)();
    expect(await response.json()).toEqual({ ok: true, items: [] });
  });

  test('signed out is 401 and a failure is 500', async () => {
    const signedOut = await createHandoffsGet({
      requireCurrentUser: async () => {
        throw new AuthRequiredError('Sign in first.');
      },
      convexQuery: async () => [],
    } as any)();
    expect(signedOut.status).toBe(401);
    const failed = await createHandoffsGet({
      requireCurrentUser: async () => user,
      convexQuery: async () => {
        throw new Error('internal');
      },
    } as any)();
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({ ok: false, error: 'Handoffs failed.' });
  });
});

describe('/api/albatross/browser-context', () => {
  function routes(overrides: Record<string, unknown> = {}) {
    return createBrowserContextRoutes({
      requireCurrentUser: async () => user,
      savedSignInState: mock(async () => ({ saved: true, createdAt: 1, lastUsedAt: 2 })),
      forgetSavedSignIns: mock(async () => ({ forgotten: 1 })),
      ...overrides,
    } as any);
  }

  test('GET says whether sign-ins are saved', async () => {
    const response = await routes().GET();
    expect(await response.json()).toEqual({ ok: true, saved: true, createdAt: 1, lastUsedAt: 2 });
  });

  test('DELETE forgets the sign-ins', async () => {
    const forgetSavedSignIns = mock(async () => ({ forgotten: 2 }));
    const response = await routes({ forgetSavedSignIns }).DELETE();
    expect(await response.json()).toEqual({ ok: true, saved: false, forgotten: 2 });
    expect(forgetSavedSignIns).toHaveBeenCalledWith('user-1');
  });

  test('signed out is 401 for both', async () => {
    const signedOut = routes({
      requireCurrentUser: async () => {
        throw new AuthRequiredError('Sign in first.');
      },
    });
    expect((await signedOut.GET()).status).toBe(401);
    expect((await signedOut.DELETE()).status).toBe(401);
  });

  test('a failure is 500 with a fixed message', async () => {
    const failing = routes({
      savedSignInState: async () => {
        throw new Error('internal');
      },
      forgetSavedSignIns: async () => {
        throw new Error('internal');
      },
    });
    const read = await failing.GET();
    expect(read.status).toBe(500);
    expect(await read.json()).toEqual({ ok: false, error: 'Saved sign-ins failed.' });
    const forget = await failing.DELETE();
    expect(forget.status).toBe(500);
    expect(await forget.json()).toEqual({ ok: false, error: 'Saved sign-ins could not be forgotten.' });
  });
});
