import { describe, expect, mock, test } from 'bun:test';
import type { NextRequest } from 'next/server';
import { briefQueryWindow, createBriefQueryPost } from '../app/api/mobile/briefs/query/route';

function request(body: unknown, timeZone = 'America/New_York') {
  return new Request('https://example.test/api/mobile/briefs/query', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', 'x-user-timezone': timeZone },
  }) as NextRequest;
}

function deps() {
  return {
    currentUser: mock(async () => ({
      userId: 'user-1',
      email: 'person@example.test',
      name: 'Person',
      source: 'clerk' as const,
    })),
    query: mock(async () => [
      {
        kind: 'task' as const,
        id: 'task-1',
        title: 'Ship brief',
        dueAt: Date.parse('2026-07-23T15:00:00Z'),
        completed: false,
        gone: false,
      },
    ]),
    now: () => new Date('2026-07-23T16:00:00Z'),
  };
}

describe('mobile brief query route', () => {
  test('runs an enumerated query with a timezone-correct day window', async () => {
    const dependencies = deps();
    const response = await createBriefQueryPost(dependencies)(
      request({ query: { name: 'tasks_due_today' }, limit: 8 }),
    );
    expect(response.status).toBe(200);
    expect((await response.json()).count).toBe(1);
    expect(dependencies.query).toHaveBeenCalledWith({
      userId: 'user-1',
      name: 'tasks_due_today',
      startAt: Date.parse('2026-07-23T04:00:00Z'),
      endAt: Date.parse('2026-07-24T04:00:00Z'),
      limit: 8,
    });
  });

  test('uses seven days for the week query and rejects unknown queries', async () => {
    const window = briefQueryWindow('events_next_7d', new Date('2026-07-23T16:00:00Z'), 'America/New_York');
    expect(window.endAt - window.startAt).toBe(7 * 86_400_000);

    const dependencies = deps();
    const response = await createBriefQueryPost(dependencies)(
      request({ query: { name: 'everything_important' } }),
    );
    expect(response.status).toBe(400);
    expect(dependencies.query).not.toHaveBeenCalled();
  });
});
