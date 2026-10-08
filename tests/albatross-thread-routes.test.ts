import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { getFunctionName } from 'convex/server';
import { NextRequest } from 'next/server';
import { createStepRunPost } from '../app/api/albatross/work/[workId]/run/route';
import { createThreadRunsGet } from '../app/api/albatross/work/[workId]/runs/route';
import { createPersonalDetailsRoutes } from '../app/api/personal-details/route';
import { AuthRequiredError } from '../lib/auth/current-user';
import { PersonalDetailError } from '../lib/personal-details/store';
import { RateLimitError } from '../lib/rate-limit';

// The thread's HTTP routes (docs/albatross-thread.md): personal details,
// the run history, and the steer action.

let errorSpy: ReturnType<typeof spyOn>;
beforeEach(() => {
  errorSpy = spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => errorSpy.mockRestore());

const user = { userId: 'user-1', email: 'sam.rivera@example.com', name: 'Sam Rivera' };
const detail = {
  key: 'phone' as const,
  label: 'Phone',
  value: '+15555550100',
  display: '(555) 555-0100',
  source: 'settings' as const,
  saved: true,
  updatedAt: 1,
};

function routes(overrides: Record<string, unknown> = {}) {
  const calls: Array<[string, unknown[]]> = [];
  const record =
    (name: string, result: (...args: any[]) => unknown) =>
    async (...args: any[]) => {
      calls.push([name, args]);
      return result(...args);
    };
  const deps = {
    requireCurrentUser: async () => user,
    enforceUserRateLimit: record('rate', () => ({ ok: true })),
    listPersonalDetails: record('list', () => [detail]),
    savePersonalDetail: record('save', () => detail),
    deletePersonalDetail: record('delete', () => true),
    undoPersonalDetailSave: record('undo', () => 'restored'),
    ...overrides,
  } as any;
  return { handlers: createPersonalDetailsRoutes(deps), calls };
}

const json = (method: string, body: unknown, url = 'http://localhost/api/personal-details') =>
  new Request(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('/api/personal-details', () => {
  test('GET lists the details with the missing keys and no caching', async () => {
    const { handlers } = routes();
    const response = await handlers.GET();
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      ok: true,
      details: [detail],
      missing: ['name', 'email', 'home_address', 'emergency_contact'],
    });
  });

  test('PUT saves from Settings and needs JSON', async () => {
    const { handlers, calls } = routes();
    const saved = await handlers.PUT(json('PUT', { key: 'phone', value: '555 555 0100' }));
    expect(await saved.json()).toEqual({ ok: true, detail });
    expect(calls.find(([name]) => name === 'save')?.[1]).toEqual([
      user,
      { key: 'phone', value: '555 555 0100' },
      'settings',
    ]);

    const form = await handlers.PUT(
      new Request('http://localhost/api/personal-details', {
        method: 'PUT',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'key=phone&value=1',
      }),
    );
    expect(form.status).toBe(400);
    expect(calls.filter(([name]) => name === 'save')).toHaveLength(1);
  });

  test('a refused or invalid value is 400 with its code, and the limit is 409', async () => {
    const refused = routes({
      savePersonalDetail: async () => {
        throw new PersonalDetailError(
          'refused',
          'custom:passport',
          'Albatross does not keep ID numbers in Personal details.',
        );
      },
    });
    const response = await refused.handlers.PUT(
      json('PUT', { key: 'custom', label: 'Passport', value: 'X1' }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      ok: false,
      code: 'refused',
      key: 'custom:passport',
      error: 'Albatross does not keep ID numbers in Personal details.',
    });
    const full = routes({
      savePersonalDetail: async () => {
        throw new PersonalDetailError(
          'limit',
          'custom:x',
          'You keep the most personal details allowed. Delete one first.',
        );
      },
    });
    expect((await full.handlers.PUT(json('PUT', { key: 'custom', label: 'X', value: 'y' }))).status).toBe(
      409,
    );
    expect((await routes().handlers.PUT(json('PUT', { value: 'no key' }))).status).toBe(400);
  });

  test('DELETE and the undo POST', async () => {
    const { handlers, calls } = routes();
    expect(
      await (
        await handlers.DELETE(
          new Request('http://localhost/api/personal-details?key=phone', { method: 'DELETE' }),
        )
      ).json(),
    ).toEqual({
      ok: true,
      removed: true,
    });
    expect(await (await handlers.POST(json('POST', { action: 'undo', key: 'phone' }))).json()).toEqual({
      ok: true,
      undone: 'restored',
    });
    expect(calls.map(([name]) => name).filter((name) => name !== 'rate')).toEqual(['delete', 'undo']);
    expect((await handlers.POST(json('POST', { action: 'other', key: 'phone' }))).status).toBe(400);
  });

  test('sign-in, rate limits, and server errors', async () => {
    const signedOut = routes({
      requireCurrentUser: async () => {
        throw new AuthRequiredError('Sign in required.');
      },
    });
    expect((await signedOut.handlers.GET()).status).toBe(401);
    const limited = routes({
      enforceUserRateLimit: async () => {
        throw new RateLimitError('Too many requests.', 30_000, 120);
      },
    });
    expect((await limited.handlers.GET()).status).toBe(429);
    const broken = routes({
      listPersonalDetails: async () => {
        throw new Error('secret detail: +15555550100');
      },
    });
    const response = await broken.handlers.GET();
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain('5555550100');
  });
});

describe('GET /api/albatross/work/[workId]/runs', () => {
  test('it returns the history for the signed-in user', async () => {
    const queried: any[] = [];
    const GET = createThreadRunsGet({
      requireCurrentUser: async () => user,
      enforceUserRateLimit: async () => ({ ok: true }),
      convexQuery: (async (fn: any, args: any) => {
        queried.push([getFunctionName(fn), args]);
        return [{ id: 'run-1' }];
      }) as any,
    } as any);
    const response = await GET(new NextRequest('http://localhost/api/albatross/work/work-1/runs'), {
      params: Promise.resolve({ workId: 'work-1' }),
    });
    expect(await response.json()).toEqual({ ok: true, runs: [{ id: 'run-1' }] });
    expect(queried).toEqual([
      ['albatrossStepRuns:runsForWorkHistory', { userId: 'user-1', workId: 'work-1' }],
    ]);
  });
});

describe('POST /run { action: steer }', () => {
  const context = { params: Promise.resolve({ workId: 'work-1' }) };
  const post = (body: unknown) =>
    new NextRequest('http://localhost/api/albatross/work/work-1/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const deps = (steer: () => Promise<unknown>) => ({
    requireCurrentUser: async () => user,
    enforceUserRateLimit: async () => ({ ok: true }),
    convexMutation: (async (fn: any) => {
      if (getFunctionName(fn) === 'albatrossStepRuns:steer') return steer();
      return null;
    }) as any,
  });

  test('a note reaches a run in progress', async () => {
    const response = await createStepRunPost(deps(async () => true) as any)(
      post({ action: 'steer', runId: 'run-1', note: 'Use the Monday class.' }),
      context,
    );
    expect(await response.json()).toEqual({ ok: true, runId: 'run-1' });
  });

  test('a secret in a note never reaches the run (docs/albatross-secure-store.md)', async () => {
    let text = '';
    const response = await createStepRunPost({
      requireCurrentUser: async () => user,
      enforceUserRateLimit: async () => ({ ok: true }),
      convexMutation: (async (fn: any, args: any) => {
        if (getFunctionName(fn) === 'albatrossStepRuns:steer') text = args.text;
        return true;
      }) as any,
    } as any)(
      post({ action: 'steer', runId: 'run-1', note: `My SSN is ${['123', '-45-', '6789'].join('')}` }),
      context,
    );
    expect(response.status).toBe(200);
    expect(text).toBe('My SSN is [removed: looks like a Social Security number]');
  });

  test('a run that is not working is 409, an unknown run 404, a missing note 400', async () => {
    expect(
      (
        await createStepRunPost(deps(async () => false) as any)(
          post({ action: 'steer', runId: 'run-1', note: 'x' }),
          context,
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await createStepRunPost(
          deps(async () => {
            throw new Error('Run not found.');
          }) as any,
        )(post({ action: 'steer', runId: 'run-x', note: 'x' }), context)
      ).status,
    ).toBe(404);
    expect(
      (
        await createStepRunPost(deps(async () => true) as any)(
          post({ action: 'steer', runId: 'run-1' }),
          context,
        )
      ).status,
    ).toBe(400);
  });
});
