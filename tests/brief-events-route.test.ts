import { expect, test } from 'bun:test';
import { createBriefEventsPost } from '../app/api/brief/events/route';
import { AuthRequiredError } from '../lib/auth/current-user';

test('brief events are owner scoped, validated, and never leak backend errors', async () => {
  const calls: any[] = [];
  const deps: any = {
    requireCurrentUser: async () => ({ userId: 'owner' }),
    enforceUserRateLimit: async () => {},
    convexMutation: async (_fn: any, args: any) => {
      calls.push(args);
      return { id: 'event_1' };
    },
  };
  const request = (body: unknown) =>
    new Request('https://local/api/brief/events', { method: 'POST', body: JSON.stringify(body) });
  const post = createBriefEventsPost(deps);

  let response = await post(
    request({
      userId: 'intruder',
      reportId: 'report_1',
      surface: 'daily',
      regionId: 'answer',
      action: 'draft_reply',
      ref: { kind: 'thread', id: 't1', account: 'jakob@example.com' },
      outcome: 'done',
    }),
  );
  expect(response.status).toBe(200);
  expect(calls[0]).toEqual({
    userId: 'owner',
    reportId: 'report_1',
    surface: 'daily',
    regionId: 'answer',
    action: 'draft_reply',
    refKind: 'thread',
    refId: 't1',
    refAccount: 'jakob@example.com',
    outcome: 'done',
  });

  // The surface defaults to daily and reportId may be absent.
  response = await post(
    request({
      regionId: 'mail',
      action: 'open_thread',
      ref: { kind: 'thread', id: 't2' },
      outcome: 'opened',
    }),
  );
  expect(response.status).toBe(200);
  expect(calls[1].surface).toBe('daily');
  expect(calls[1].reportId).toBeUndefined();

  for (const body of [
    { regionId: '', action: 'x', ref: { kind: 'thread', id: 't' }, outcome: 'done' },
    { regionId: 'answer', action: 'x', ref: { kind: 'thread', id: 't' }, outcome: 'maybe' },
    { regionId: 'answer', action: 'x', outcome: 'done' },
    'not json',
  ]) {
    response = await post(request(body));
    expect(response.status).toBe(400);
  }

  deps.convexMutation = async () => {
    throw new Error('private details');
  };
  response = await post(
    request({ regionId: 'answer', action: 'x', ref: { kind: 'thread', id: 't' }, outcome: 'done' }),
  );
  expect(response.status).toBe(500);
  expect(await response.text()).not.toContain('private details');

  deps.requireCurrentUser = async () => {
    throw new AuthRequiredError('Sign in');
  };
  response = await post(
    request({ regionId: 'answer', action: 'x', ref: { kind: 'thread', id: 't' }, outcome: 'done' }),
  );
  expect(response.status).toBe(401);
});
