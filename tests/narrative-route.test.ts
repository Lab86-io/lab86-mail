import { describe, expect, test } from 'bun:test';
import { NextRequest } from 'next/server';
import { createNarrativeRoutes } from '../app/api/narrative/route';
import { AuthRequiredError } from '../lib/auth/current-user';
import { RateLimitError } from '../lib/rate-limit';

function setup(overrides: Record<string, unknown> = {}) {
  const writes: any[] = [],
    reads: any[] = [],
    queued: any[] = [];
  const routes = createNarrativeRoutes({
    requireCurrentUser: async () =>
      ({ userId: 'owner', email: 'owner@example.test', source: 'clerk' }) as any,
    enabled: () => true,
    rateLimit: async () => ({ ok: true }) as any,
    query: (async (_fn: any, args: any) => {
      reads.push(args);
      return { sources: [{ id: 'chat' }], settings: { enabled: false } };
    }) as any,
    search: async (userId: string, args: any) => {
      reads.push({ userId, ...args });
      return { enabled: true, entries: [], revision: 0 };
    },
    mutation: (async (_fn: any, args: any) => {
      writes.push(args);
      return { ok: true };
    }) as any,
    after: ((callback: unknown) => queued.push(callback)) as any,
    ...overrides,
  });
  return { ...routes, writes, reads, queued };
}
const req = (body: unknown) =>
  new NextRequest('https://example.test/api/narrative', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
const configure = {
  action: 'configure',
  enabled: true,
  sources: ['chat'],
  timezone: 'America/New_York',
  model: 'z-ai/glm-5.3-flash',
};
describe('narrative API boundary', () => {
  test('saving enabled preferences requests a fresh manual brief', async () => {
    const calls: unknown[][] = [];
    const state = setup({
      refresh: async (...args: unknown[]) => {
        calls.push(args);
      },
    });
    expect((await state.POST(req(configure))).status).toBe(200);
    await state.queued[0]();
    expect(calls).toEqual([['owner', 'manual']]);
  });
  test('enabled reads have a separate quota and background failures are contained', async () => {
    const state = setup({
      rateLimit: async ({ key }: { key: string }) => {
        expect(key).toBe('narrative-read');
        throw new RateLimitError('Slow down', 1000, 120);
      },
    });
    expect((await state.GET(new NextRequest('https://example.test/api/narrative?op=status'))).status).toBe(
      429,
    );
    expect(state.reads).toEqual([]);
    const disabled = setup({
      enabled: () => false,
      rateLimit: async () => {
        throw new Error('must not run');
      },
    });
    expect((await disabled.GET(new NextRequest('https://example.test/api/narrative'))).status).toBe(200);
    for (const body of [configure, { action: 'refresh' }]) {
      const failing = setup({
        refresh: async () => {
          throw new Error('synthetic finish failure');
        },
      });
      await failing.POST(req(body));
      await expect(failing.queued[0]()).resolves.toBeUndefined();
    }
  });
  test('requires authentication and rejects nonpilot writes without touching data', async () => {
    const anonymous = setup({
      requireCurrentUser: async () => {
        throw new AuthRequiredError('Sign in');
      },
    });
    expect((await anonymous.POST(req(configure))).status).toBe(401);
    const excluded = setup({ enabled: () => false });
    expect((await excluded.POST(req(configure))).status).toBe(403);
    expect(excluded.writes).toEqual([]);
  });
  test('only authenticated ownership and available sources can be configured', async () => {
    const state = setup();
    expect((await state.POST(req({ ...configure, sources: ['mcp:someone-else'] }))).status).toBe(400);
    expect((await state.POST(req({ ...configure, timezone: 'invented' }))).status).toBe(400);
    expect(state.writes).toEqual([]);
    expect((await state.POST(req({ ...configure, userId: 'forged' }))).status).toBe(200);
    expect(state.writes[0].userId).toBe('owner');
    expect(state.queued).toHaveLength(1);
  });
  test('erase requires explicit confirmation and edits cannot be empty no-ops', async () => {
    const state = setup();
    expect((await state.POST(req({ action: 'erase' }))).status).toBe(400);
    expect((await state.POST(req({ action: 'edit', id: 'one' }))).status).toBe(400);
    expect((await state.POST(req({ action: 'edit', id: 'one', pinned: false }))).status).toBe(200);
    expect(state.writes[0]).toMatchObject({ userId: 'owner', id: 'one', pinned: false });
    expect(state.writes[0].text).toBeUndefined();
  });
  test('refresh is queued and query routing ignores forged user ids', async () => {
    const calls: unknown[][] = [];
    const state = setup({
      refresh: async (...args: unknown[]) => {
        calls.push(args);
      },
    });
    expect((await state.POST(req({ action: 'refresh' }))).status).toBe(202);
    expect(state.queued).toHaveLength(1);
    await state.queued[0]();
    expect(calls).toEqual([['owner', 'manual']]);
    expect(
      (
        await state.GET(
          new NextRequest('https://example.test/api/narrative?q=review&userId=forged&level=week'),
        )
      ).status,
    ).toBe(200);
    expect(state.reads[0]).toMatchObject({ userId: 'owner', query: 'review', level: 'week' });
  });
});
