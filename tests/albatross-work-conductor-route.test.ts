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
    expect(deps.advanceWork).toHaveBeenCalledWith({ userId: 'u', workId: 'w' });
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
