import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { convexTest } from 'convex-test';
import { NextRequest } from 'next/server';
import { createBrowserSessionSweepPost } from '../app/api/cron/browser-sessions/route';
import { internal } from '../convex/_generated/api';
import { BROWSER_SESSION_STALE_AFTER_MS } from '../convex/albatrossBrowserSessions';
import schema from '../convex/schema';

const modules = {
  '../convex/_generated/api.js': () => import('../convex/_generated/api.js'),
  '../convex/albatrossBrowserSessions.ts': () => import('../convex/albatrossBrowserSessions'),
};

const SECRET = 'browser-session-sweep-secret';
let previousSecret: string | undefined;
beforeAll(() => {
  previousSecret = process.env.LAB86_CONVEX_INTERNAL_SECRET;
  process.env.LAB86_CONVEX_INTERNAL_SECRET = SECRET;
});
afterAll(() => {
  if (previousSecret === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
  else process.env.LAB86_CONVEX_INTERNAL_SECRET = previousSecret;
});

function sweepRequest(body: unknown) {
  return new NextRequest('http://localhost/api/cron/browser-sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('WRK-8 stale browser sessions', () => {
  test('the target query returns only old live sessions', async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    const row = (sessionId: string, status: string, createdAt: number) =>
      t.run((ctx) =>
        ctx.db.insert('albatrossBrowserSessions', {
          userId: 'user_1',
          workId: 'work_1',
          sessionId,
          liveViewUrl: 'https://live.example.test',
          replayUrl: 'https://replay.example.test',
          status,
          createdAt,
          updatedAt: createdAt,
        } as any),
      );
    const old = now - BROWSER_SESSION_STALE_AFTER_MS - 60_000;
    await row('old-user', 'user', old);
    await row('old-agent', 'agent', old);
    await row('old-ended', 'ended', old);
    await row('fresh', 'user', now);
    const targets = await t.query(internal.albatrossBrowserSessions.staleSessionTargets, {
      before: now - BROWSER_SESSION_STALE_AFTER_MS,
    });
    expect(targets.map((target) => target.sessionId).sort()).toEqual(['old-agent', 'old-user']);
  });

  test('the sweep route ends each session at Browserbase and in the ledger', async () => {
    const released: string[] = [];
    const mutations: any[] = [];
    const post = createBrowserSessionSweepPost({
      isInternalCronRequest: () => true,
      browserSessionsConfigured: () => true,
      releaseBrowserSession: (async (sessionId: string) => {
        released.push(sessionId);
        if (sessionId === 'gone') throw new Error('Browserbase 404');
      }) as any,
      convexMutation: (async (_fn: any, args: any) => {
        mutations.push(args);
      }) as any,
      reportError: mock(() => undefined),
    });
    const response = await post(
      sweepRequest({
        sessions: [
          { userId: 'user_1', sessionId: 'live' },
          { userId: 'user_1', sessionId: 'gone' },
          { userId: '', sessionId: 'no-user' },
        ],
      }),
    );
    expect(await response.json()).toEqual({ ok: true, released: 1, ended: 2 });
    expect(released).toEqual(['live', 'gone']);
    expect(mutations.map((args) => [args.sessionId, args.status])).toEqual([
      ['live', 'ended'],
      ['gone', 'ended'],
    ]);
  });

  test('the sweep route rejects calls that are not internal', async () => {
    const post = createBrowserSessionSweepPost({ isInternalCronRequest: () => false });
    expect((await post(sweepRequest({ sessions: [] }))).status).toBe(401);
  });
});
