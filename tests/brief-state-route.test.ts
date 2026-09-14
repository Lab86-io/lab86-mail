import { expect, test } from 'bun:test';
import { createBriefStatePost } from '../app/api/brief/state/route';
import { AuthRequiredError } from '../lib/auth/current-user';

test('brief state is owner scoped, bounded and does not leak backend errors', async () => {
  const calls: any[] = [];
  const deps: any = {
    requireCurrentUser: async () => ({ userId: 'owner' }),
    enforceUserRateLimit: async () => {},
    convexQuery: async (_fn: any, args: any) => {
      calls.push(args);
      return ['done'];
    },
  };
  const request = (body: unknown) =>
    new Request('https://local/api/brief/state', { method: 'POST', body: JSON.stringify(body) });
  let response = await createBriefStatePost(deps)(
    request({ userId: 'intruder', refs: [{ kind: 'work', id: 'done' }] }),
  );
  expect(await response.json()).toEqual({ inactive: ['done'] });
  expect(calls[0]).toEqual({ userId: 'owner', refs: [{ kind: 'work', id: 'done' }] });
  for (const refs of [
    [{ kind: 'mail', id: 'mail' }],
    Array.from({ length: 101 }, () => ({ kind: 'work', id: 'done' })),
  ]) {
    response = await createBriefStatePost(deps)(request({ refs }));
    expect(response.status).toBe(400);
  }
  deps.convexQuery = async () => {
    throw new Error('private details');
  };
  response = await createBriefStatePost(deps)(request({ refs: [] }));
  expect(response.status).toBe(500);
  expect(await response.text()).not.toContain('private details');
  deps.requireCurrentUser = async () => {
    throw new AuthRequiredError('Sign in');
  };
  expect((await createBriefStatePost(deps)(request({ refs: [] }))).status).toBe(401);
});
