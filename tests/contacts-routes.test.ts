import { describe, expect, test } from 'bun:test';
import { NextRequest } from 'next/server';
import { createContactsResyncPost } from '../app/api/contacts/resync/route';
import { createContactsCronPost } from '../app/api/cron/contacts-sync/route';
import { AuthRequiredError } from '../lib/auth/current-user';
import { RateLimitError } from '../lib/rate-limit';

const post = (url: string, body: unknown) =>
  new NextRequest(url, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });

describe('POST /api/cron/contacts-sync', () => {
  test('rejects a caller without the internal secret', async () => {
    const handler = createContactsCronPost({
      isInternalCronRequest: () => false,
      syncUserContacts: async () => [],
    });
    const response = await handler(post('http://localhost/api/cron/contacts-sync', { userId: 'u' }));
    expect(response.status).toBe(401);
  });

  test('needs a user and starts the pass in the background', async () => {
    const started: string[] = [];
    const handler = createContactsCronPost({
      isInternalCronRequest: () => true,
      syncUserContacts: async (userId, options) => {
        started.push(`${userId}:${options?.reason}`);
        return [];
      },
    });
    expect((await handler(post('http://localhost/api/cron/contacts-sync', {}))).status).toBe(400);
    const response = await handler(post('http://localhost/api/cron/contacts-sync', { userId: 'user_1' }));
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ ok: true, started: true, userId: 'user_1' });
    expect(started).toEqual(['user_1:cron']);
  });

  test('a failed pass is logged, not thrown', async () => {
    const handler = createContactsCronPost({
      isInternalCronRequest: () => true,
      syncUserContacts: async () => {
        throw new Error('boom');
      },
    });
    const response = await handler(post('http://localhost/api/cron/contacts-sync', { userId: 'user_1' }));
    expect(response.status).toBe(202);
    await Bun.sleep(1);
  });
});

describe('POST /api/contacts/resync', () => {
  const user = { userId: 'user_1', email: 'me@acme.com', name: 'Me', source: 'clerk' as const };
  const accounts = [
    { accountId: 'a1', status: 'connected' },
    { accountId: 'a2', status: 'error' },
  ] as any[];

  function handler(overrides: Record<string, unknown> = {}) {
    const kicks: any[] = [];
    const post = createContactsResyncPost({
      requireCurrentUser: async () => user,
      enforceUserRateLimit: async () => undefined as any,
      listAccounts: async () => accounts,
      kick: ((row: any, options: any) => {
        kicks.push({ ...row, ...options });
        return true;
      }) as any,
      ...overrides,
    } as any);
    return { post, kicks };
  }

  test('starts one forced pass for a connected mailbox', async () => {
    const { post: run, kicks } = handler();
    const response = await run(post('http://localhost/api/contacts/resync', { accountId: 'a1' }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, started: true });
    expect(kicks).toEqual([{ userId: 'user_1', accountId: 'a1', force: true, reason: 'manual_resync' }]);
  });

  test('checks the input, the mailbox, and its state', async () => {
    const { post: run, kicks } = handler();
    expect((await run(post('http://localhost/api/contacts/resync', {}))).status).toBe(400);
    expect((await run(post('http://localhost/api/contacts/resync', { accountId: 'nope' }))).status).toBe(404);
    expect((await run(post('http://localhost/api/contacts/resync', { accountId: 'a2' }))).status).toBe(409);
    expect(kicks).toEqual([]);
  });

  test('maps sign-in and rate limits', async () => {
    const signedOut = handler({
      requireCurrentUser: async () => {
        throw new AuthRequiredError('Sign in required.');
      },
    });
    expect(
      (await signedOut.post(post('http://localhost/api/contacts/resync', { accountId: 'a1' }))).status,
    ).toBe(401);
    const limited = handler({
      enforceUserRateLimit: async () => {
        throw new RateLimitError('Too many requests.', 30_000, 10);
      },
    });
    expect(
      (await limited.post(post('http://localhost/api/contacts/resync', { accountId: 'a1' }))).status,
    ).toBe(429);
    const broken = handler({
      listAccounts: async () => {
        throw new Error('down');
      },
    });
    await expect(
      broken.post(post('http://localhost/api/contacts/resync', { accountId: 'a1' })),
    ).rejects.toThrow('down');
  });
});
