import { describe, expect, mock, test } from 'bun:test';
import { NextRequest } from 'next/server';
import { createBrowserContextsCronPost } from '../app/api/cron/browser-contexts/route';

function request(body: unknown) {
  return new NextRequest('http://localhost/api/cron/browser-contexts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('saved sign-in deletion retry', () => {
  test('refuses a caller without the cron secret', async () => {
    const deleteContexts = mock(async () => ({ deleted: 0, pending: 0 }));
    const post = createBrowserContextsCronPost({ authorized: () => false, deleteContexts });
    expect((await post(request({ contextIds: ['a'] }))).status).toBe(401);
    expect(deleteContexts).not.toHaveBeenCalled();
  });

  test('deletes only string ids, at most 50, and reports the counts', async () => {
    const deleteContexts = mock(async (ids: readonly string[]) => ({ deleted: ids.length - 1, pending: 1 }));
    const post = createBrowserContextsCronPost({ authorized: () => true, deleteContexts });
    const ids = Array.from({ length: 60 }, (_, index) => `ctx-${index}`);
    const response = await post(request({ contextIds: [...ids, '', 7, null] }));
    expect(await response.json()).toEqual({ ok: true, deleted: 49, pending: 1 });
    expect((deleteContexts.mock.calls[0] as any)[0]).toHaveLength(50);
    const empty = await post(request('not json'));
    expect(await empty.json()).toMatchObject({ ok: true });
    expect((deleteContexts.mock.calls[1] as any)[0]).toEqual([]);
  });
});
