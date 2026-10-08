import { describe, expect, test } from 'bun:test';
import { StepRunStartError } from '../lib/albatross/step-run-start';
import { AuthRequiredError } from '../lib/auth/current-user';
import { RateLimitError } from '../lib/rate-limit';
import { SecureKeyError } from '../lib/secure/crypto';
import { verifyIdentityResponse } from '../lib/secure/identity';
import { SecurePolicyError } from '../lib/secure/policy';
import { allowNote, createSecureDetailsRoutes, secureRouteDefaults } from '../lib/secure/routes';
import { SecureStoreError } from '../lib/secure/store';

// The Passwords and IDs routes (docs/albatross-secure-store.md).

const ITEM = 'si_licen00000000000000000';
const allowRun = {
  id: 'run_1',
  workId: 'work_1',
  stepKey: 'step_2',
  state: 'handed_off',
  next: {
    kind: 'allow_secure',
    allow: {
      itemId: ITEM,
      kind: 'id_number',
      itemLabel: "Driver's license",
      fieldLabels: ['Number'],
      site: 'ny.gov',
      host: 'dmv.ny.gov',
    },
    allowAnswer: null,
  },
};

function routes(overrides: Partial<typeof secureRouteDefaults> = {}) {
  const calls: Array<[string, unknown]> = [];
  const record =
    <T>(name: string, value: T) =>
    async (...args: unknown[]) => {
      calls.push([name, args.length === 1 ? args[0] : args]);
      return value;
    };
  const deps = {
    ...secureRouteDefaults,
    requireCurrentUser: async () => ({
      userId: 'user_1',
      email: 'sam.rivera@example.com',
      name: 'Sam Rivera',
      source: 'clerk' as const,
    }),
    enforceUserRateLimit: async () => ({ ok: true }) as any,
    enabled: () => true,
    identityChecked: async () => true,
    listSecureItems: record('list', []),
    createSecureItem: record('create', { id: ITEM }),
    updateSecureItem: record('update', { id: ITEM }),
    deleteSecureItem: record('delete', true),
    listSecureUses: record('uses', []),
    recordSecureUse: record('recordUse', undefined),
    getRun: record('getRun', allowRun),
    answerAllow: record('answerAllow', true),
    grantOnce: record('grantOnce', { granted: true }),
    addSite: record('addSite', { added: true }),
    resumeStepRun: record('resume', { runId: 'run_2', created: true }),
    ...overrides,
  } as typeof secureRouteDefaults;
  return { routes: createSecureDetailsRoutes(deps), calls };
}

const post = (body: unknown, type = 'application/json') =>
  new Request('https://mail.lab86.io/api/secure-details', {
    method: 'POST',
    headers: { 'content-type': type },
    body: JSON.stringify(body),
  });

describe('list and writes', () => {
  test('off answers enabled:false with no items; on lists; nothing is cached', async () => {
    const off = await routes({ enabled: () => false }).routes.list();
    expect(await off.json()).toEqual({ ok: true, enabled: false, items: [] });
    expect(off.headers.get('cache-control')).toBe('no-store');
    const on = await routes().routes.list();
    expect(await on.json()).toEqual({ ok: true, enabled: true, items: [] });
  });

  test('create takes JSON only and answers 201', async () => {
    const { routes: r, calls } = routes();
    const created = await r.create(post({ kind: 'date_of_birth', values: { date: '1990-04-02' } }));
    expect(created.status).toBe(201);
    expect(calls[0]).toEqual([
      'create',
      ['user_1', { kind: 'date_of_birth', values: { date: '1990-04-02' } }],
    ]);
    expect((await r.create(post({ kind: 'date_of_birth', values: {} }, 'text/plain'))).status).toBe(400);
    expect((await r.create(post({ kind: 'card', values: {} }))).status).toBe(400);
  });

  test('errors map to their status and code; no value leaks into an answer', async () => {
    const cases: Array<[unknown, number, Record<string, unknown>]> = [
      [
        new SecurePolicyError('refused', 'Albatross does not keep card numbers yet.', 'number', 'card'),
        400,
        { code: 'refused', reason: 'card', field: 'number' },
      ],
      [new SecurePolicyError('limit', 'Too many sites.'), 409, { code: 'limit' }],
      [new SecureStoreError('off', 'off'), 404, { code: 'off' }],
      [new SecureStoreError('limit', 'Your date of birth is saved.'), 409, { code: 'limit' }],
      [new SecureKeyError('no key'), 503, { code: 'off' }],
      [new StepRunStartError('Step runs are off.', 403), 403, { error: 'Step runs are off.' }],
      [new AuthRequiredError('Sign in required.'), 401, { ok: false }],
    ];
    for (const [error, status, body] of cases) {
      const { routes: r } = routes({
        createSecureItem: async () => {
          throw error;
        },
      });
      const answer = await r.create(post({ kind: 'date_of_birth', values: { date: '1990-04-02' } }));
      expect(answer.status).toBe(status);
      expect(await answer.json()).toMatchObject(body);
    }
    const limited = routes({
      enforceUserRateLimit: async () => {
        throw new RateLimitError('Too many requests.', 30_000, 30);
      },
    });
    expect((await limited.routes.list()).status).toBe(429);
  });

  test('update asks for the identity check only when sites change; a refusal answers the reverification body', async () => {
    let checks = 0;
    const { routes: r, calls } = routes({
      identityChecked: async () => {
        checks += 1;
        return false;
      },
    });
    await r.update(post({ label: 'NY license' }), ITEM);
    expect(checks).toBe(0);
    await r.update(post({ sites: ['dmv.ny.gov'] }), ITEM);
    expect(checks).toBe(1);
    expect(calls.map((call) => call[0])).toEqual(['update', 'update']);
    expect((calls[1][1] as unknown[])[3]).toEqual({ identityChecked: false });
    const blocked = await routes({
      updateSecureItem: async () => {
        throw new SecureStoreError('verify_identity', 'x');
      },
    }).routes.update(post({ sites: ['dmv.ny.gov'] }), ITEM);
    expect(blocked.status).toBe(403);
    expect(await blocked.json()).toMatchObject({
      code: 'verify_identity',
      clerk_error: {
        type: 'forbidden',
        reason: 'reverification-error',
        metadata: { reverification: { level: 'first_factor', afterMinutes: 10 } },
      },
    });
  });

  test('delete and uses pass the item id', async () => {
    const { routes: r, calls } = routes();
    expect(await (await r.remove(ITEM)).json()).toEqual({ ok: true, deleted: true });
    expect(await (await r.uses(ITEM)).json()).toEqual({ ok: true, uses: [] });
    expect(calls).toEqual([
      ['delete', ['user_1', ITEM]],
      ['uses', ['user_1', ITEM]],
    ]);
  });
});

describe('allow', () => {
  const body = (scope: string) => post({ runId: 'run_1', itemId: ITEM, site: 'ny.gov', scope });

  test('Allow once grants the step, records the use, and resumes the run', async () => {
    const { routes: r, calls } = routes();
    const answer = await r.allow(body('once'));
    expect(await answer.json()).toEqual({ ok: true, runId: 'run_2' });
    expect(calls.map((call) => call[0])).toEqual([
      'getRun',
      'answerAllow',
      'grantOnce',
      'recordUse',
      'resume',
    ]);
    expect(calls[2][1]).toEqual({
      userId: 'user_1',
      itemId: ITEM,
      site: 'ny.gov',
      workId: 'work_1',
      stepKey: 'step_2',
    });
    expect(calls[3][1]).toMatchObject({ outcome: 'allowed_once', host: 'dmv.ny.gov', runId: 'run_1' });
    expect(calls[4][1]).toEqual({
      userId: 'user_1',
      workId: 'work_1',
      runId: 'run_1',
      note: allowNote('once', "Driver's license", 'ny.gov'),
    });
  });

  test('Always adds the site; Do not allow needs no check and resumes with the refusal', async () => {
    const always = routes();
    await always.routes.allow(body('always'));
    expect(always.calls.map((call) => call[0])).toContain('addSite');
    let checked = false;
    const deny = routes({
      identityChecked: async () => {
        checked = true;
        return false;
      },
    });
    expect((await deny.routes.allow(body('deny'))).status).toBe(200);
    expect(checked).toBe(false);
    expect(deny.calls.find((call) => call[0] === 'recordUse')?.[1]).toMatchObject({ outcome: 'denied' });
    expect(allowNote('deny', "Driver's license", 'ny.gov')).toContain('Do not use it there');
  });

  test('Allow needs the identity check first; nothing is granted before it', async () => {
    const { routes: r, calls } = routes({ identityChecked: async () => false });
    const answer = await r.allow(body('once'));
    expect(answer.status).toBe(403);
    expect(calls.map((call) => call[0])).toEqual(['getRun']);
  });

  test('a closed, changed, or answered question gets 409; the second answer loses', async () => {
    for (const run of [
      null,
      { ...allowRun, state: 'closed' },
      { ...allowRun, next: { ...allowRun.next, kind: 'sign_in' } },
      { ...allowRun, next: { ...allowRun.next, allow: { ...allowRun.next.allow, site: 'evil.example' } } },
      { ...allowRun, next: { ...allowRun.next, allowAnswer: { scope: 'once', at: 1 } } },
    ]) {
      const answer = await routes({ getRun: async () => run }).routes.allow(body('once'));
      expect(answer.status).toBe(409);
    }
    const lost = routes({ answerAllow: async () => false });
    expect((await lost.routes.allow(body('once'))).status).toBe(409);
    expect(lost.calls.map((call) => call[0])).not.toContain('grantOnce');
    expect((await routes({ enabled: () => false }).routes.allow(body('once'))).status).toBe(404);
    expect(
      (await routes().routes.allow(post({ runId: 'r', itemId: ITEM, site: 'ny.gov', scope: 'forever' })))
        .status,
    ).toBe(400);
    const gone = routes({ grantOnce: async () => ({ granted: false }) });
    expect((await gone.routes.allow(body('once'))).status).toBe(404);
  });
});

test('the identity answer is a 403 with Clerk reverification and our code, uncached', async () => {
  const answer = verifyIdentityResponse();
  expect(answer.status).toBe(403);
  expect(answer.headers.get('cache-control')).toBe('no-store');
  const json = await answer.json();
  expect(json.code).toBe('verify_identity');
  expect(json.error).not.toMatch(/confirm|verify/i);
});
