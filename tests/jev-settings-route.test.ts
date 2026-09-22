import { describe, expect, mock, test } from 'bun:test';
import { NextRequest } from 'next/server';
import { POST as cronPost } from '../app/api/cron/jev/route';
import { createJevSettingsRoutes } from '../app/api/jev/settings/route';
import { AuthRequiredError } from '../lib/auth/current-user';
import { DEFAULT_JEV_PREFERENCES } from '../lib/jev/contract';
import { RateLimitError } from '../lib/rate-limit';
import { policy } from './fixtures/jev';

const req = (body: unknown) =>
  new NextRequest('http://localhost/api/jev/settings', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
const save = { action: 'save', preferences: DEFAULT_JEV_PREFERENCES, corrections: [], revision: 0 };
function deps(extra: Record<string, unknown> = {}) {
  return {
    requireCurrentUser: async () => ({ userId: 'owner' }),
    convexQuery: mock(async () => ({
      ...policy,
      counts: { accepted: 1, uncertain: 0, pending: 0, unavailable: 0 },
    })),
    convexMutation: mock(async (_ref: unknown, args: any) => ({
      preferences: args.preferences,
      corrections: args.corrections,
      revision: 1,
    })),
    resolveJevRuntime: async () => ({ userId: 'owner', apiKey: 'private-secret' }),
    runWithAiRequestContext: async (_ctx: any, fn: () => Promise<unknown>) => fn(),
    enforceUserRateLimit: mock(async () => undefined),
    kickLlmClassification: mock(() => undefined),
    ...extra,
  } as any;
}
describe('Jev settings HTTP contract', () => {
  test('read returns the fixed model, scoped state and availability without credentials', async () => {
    const dependencies = deps();
    const routes = createJevSettingsRoutes(dependencies);
    const response = await routes.GET();
    const value = await response.json();
    expect(value.model).toBe('typesafe/jev-1.13');
    expect(value.configured).toBe(true);
    expect(JSON.stringify(value)).not.toContain('private-secret');
    expect(dependencies.convexQuery.mock.calls[0][1]).toEqual({ userId: 'owner' });
    const unavailable = await createJevSettingsRoutes(
      deps({
        resolveJevRuntime: async () => {
          throw new Error('Add an OpenRouter key.');
        },
      }),
    ).GET();
    expect(await unavailable.json()).toMatchObject({
      configured: false,
      configurationMessage: 'Add an OpenRouter key.',
    });
  });
  test('authentication and strict input validation prevent cross-user writes and a model picker', async () => {
    const routes = createJevSettingsRoutes(
      deps({
        requireCurrentUser: async () => {
          throw new AuthRequiredError();
        },
      }),
    );
    expect((await routes.GET()).status).toBe(401);
    expect((await routes.POST(req(save))).status).toBe(401);
    const dependencies = deps();
    const authenticated = createJevSettingsRoutes(dependencies);
    for (const invalid of [
      { ...save, userId: 'someone-else' },
      { ...save, model: 'other' },
      { ...save, preferences: { followUpDays: 99 } },
      { action: 'delete' },
      { ...save, revision: -1 },
    ])
      expect((await authenticated.POST(req(invalid))).status).toBe(400);
    expect(dependencies.convexMutation).not.toHaveBeenCalled();
  });
  test('saves with an owner-scoped optimistic revision and schedules explicit rechecks', async () => {
    const dependencies = deps();
    const routes = createJevSettingsRoutes(dependencies);
    expect((await routes.POST(req(save))).status).toBe(200);
    expect(dependencies.convexMutation.mock.calls[0][1]).toEqual({
      userId: 'owner',
      preferences: save.preferences,
      corrections: [],
      revision: 0,
    });
    expect((await routes.POST(req({ action: 'reprocess' }))).status).toBe(200);
    expect(dependencies.kickLlmClassification).toHaveBeenCalledWith('owner', 2000);
    expect(dependencies.enforceUserRateLimit.mock.calls[3][0]).toMatchObject({ userId: 'owner', limit: 1 });
  });
  test('conflicting edits and unavailable storage return actionable, sanitized errors', async () => {
    const conflict = createJevSettingsRoutes(
      deps({
        convexMutation: async () => {
          throw new Error('JEV_SETTINGS_CONFLICT');
        },
      }),
    );
    expect((await conflict.POST(req(save))).status).toBe(409);
    const unavailable = createJevSettingsRoutes(
      deps({
        convexMutation: async () => {
          throw new Error('private database content');
        },
      }),
    );
    const response = await unavailable.POST(req(save));
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('private database');
  });
  test('cron rejects missing, wrong-length and wrong-content internal secrets before work', async () => {
    const previous = process.env.LAB86_CONVEX_INTERNAL_SECRET;
    process.env.LAB86_CONVEX_INTERNAL_SECRET = 'jev-cron-test';
    try {
      for (const secret of ['', 'wrong', 'jev-cron-tesx']) {
        const response = await cronPost(
          new NextRequest('http://localhost/api/cron/jev', {
            method: 'POST',
            headers: { 'x-lab86-internal-secret': secret },
            body: JSON.stringify({ userId: 'owner' }),
          }),
        );
        expect(response.status).toBe(401);
      }
      expect(
        (
          await cronPost(
            new NextRequest('http://localhost/api/cron/jev', {
              method: 'POST',
              headers: { 'x-lab86-internal-secret': 'jev-cron-test' },
              body: JSON.stringify({ userId: '' }),
            }),
          )
        ).status,
      ).toBe(400);
    } finally {
      if (previous === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
      else process.env.LAB86_CONVEX_INTERNAL_SECRET = previous;
    }
  });
});

test('settings rate limits before reading and rejects streamed bodies over 64 KiB', async () => {
  const blocked = req(save);
  const routes = createJevSettingsRoutes(
    deps({
      enforceUserRateLimit: async () => {
        throw new RateLimitError('Too many requests', 60, 30);
      },
    }),
  );
  expect((await routes.POST(blocked)).status).toBe(429);
  expect(blocked.bodyUsed).toBe(false);
  const dependencies = deps();
  const allowed = createJevSettingsRoutes(dependencies);
  expect((await allowed.POST(req({ ...save, padding: 'x'.repeat(65 * 1024) }))).status).toBe(400);
  expect(dependencies.convexMutation).not.toHaveBeenCalled();
  expect(dependencies.enforceUserRateLimit).toHaveBeenCalledTimes(1);
});
