import { describe, expect, mock, test } from 'bun:test';
import { NextRequest } from 'next/server';
import { createWorkConductorPost } from '../app/api/cron/work-conductor/route';

function request(body: unknown) {
  return new NextRequest('http://localhost/api/cron/work-conductor', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function dependencies() {
  return {
    isInternalCronRequest: mock(() => true),
    advanceWork: mock(async () => ({ status: 'ready' as const, workId: 'work-1', planId: 'plan-1' })),
    resolveTimezone: mock(
      async (_userId: string | null | undefined, _context: string | undefined): Promise<string | undefined> =>
        'America/New_York',
    ),
    reportError: mock(() => undefined),
  };
}

describe('Work conductor route', () => {
  test('rejects unauthorized requests before reading work', async () => {
    const deps = dependencies();
    deps.isInternalCronRequest.mockImplementation(() => false);
    const response = await createWorkConductorPost(deps as any)(request({ userId: 'u', workId: 'w' }));
    expect(response.status).toBe(401);
    expect(deps.advanceWork).not.toHaveBeenCalled();
  });

  test('rejects invalid bodies', async () => {
    const deps = dependencies();
    const response = await createWorkConductorPost(deps as any)(request({ userId: 'u' }));
    expect(response.status).toBe(400);
    expect(deps.advanceWork).not.toHaveBeenCalled();
  });

  test('advances the named work item', async () => {
    const deps = dependencies();
    const response = await createWorkConductorPost(deps as any)(request({ userId: 'u', workId: 'w' }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, status: 'ready' });
    // The cron is the conductor. The quiet rule reads this trigger. The
    // planner gets the user's stored zone, so holds use the user's hours.
    expect(deps.resolveTimezone).toHaveBeenCalledWith('u', undefined);
    expect(deps.advanceWork).toHaveBeenCalledWith({
      userId: 'u',
      workId: 'w',
      trigger: 'conductor',
      timezone: 'America/New_York',
    });
  });

  test('a user with no stored zone still advances, with no zone', async () => {
    const deps = dependencies();
    deps.resolveTimezone.mockImplementation(async () => undefined);
    const response = await createWorkConductorPost(deps as any)(request({ userId: 'u', workId: 'w' }));
    expect(response.status).toBe(200);
    expect(deps.advanceWork).toHaveBeenCalledWith({
      userId: 'u',
      workId: 'w',
      trigger: 'conductor',
      timezone: undefined,
    });
  });

  test('returns a controlled execution error', async () => {
    const deps = dependencies();
    deps.advanceWork.mockImplementation(async () => {
      throw new Error('planner unavailable');
    });
    const response = await createWorkConductorPost(deps as any)(request({ userId: 'u', workId: 'w' }));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      ok: false,
      error: 'planner unavailable',
      workId: 'w',
    });
    expect(deps.reportError).toHaveBeenCalled();
  });
});
