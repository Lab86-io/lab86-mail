import { afterEach, describe, expect, test } from 'bun:test';
import { loadBitbucketItems } from '../lib/mcp/bitbucket';

const API = 'https://api.bitbucket.org/2.0';
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function pullRequest(id: number, state: string) {
  return {
    id,
    title: `Change ${id}`,
    state,
    updated_on: '2026-10-08T12:00:00.000Z',
    links: { html: { href: `https://bitbucket.org/acme/web/pull-requests/${id}` } },
    author: { display_name: 'Jakob' },
    source: { branch: { name: `feature-${id}` }, repository: { full_name: 'acme/web' } },
    destination: { branch: { name: 'main' }, repository: { full_name: 'acme/web' } },
  };
}

function mockBitbucket(handler: (url: URL) => Response) {
  const calls: Array<{ url: URL; authorization: string }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, authorization: (init?.headers as Record<string, string>).authorization });
    return handler(url);
  }) as typeof fetch;
  return calls;
}

describe('Bitbucket sync with an OAuth access token', () => {
  test('reads the pull requests of every workspace and names the workspaces', async () => {
    const calls = mockBitbucket((url) => {
      if (url.pathname === '/2.0/user') return json({ display_name: 'Jakob', account_id: 'acc-1' });
      if (url.pathname === '/2.0/user/workspaces') {
        return url.searchParams.get('page') === '2'
          ? json({ values: [{ slug: 'labs' }] })
          : json({
              // Bitbucket's real answer nests the workspace in a workspace_access row.
              values: [
                {
                  type: 'workspace_access',
                  administrator: true,
                  workspace: { slug: 'acme', type: 'workspace_base' },
                },
                { name: 'no slug' },
              ],
              next: `${API}/user/workspaces?page=2`,
            });
      }
      if (url.pathname === '/2.0/workspaces/acme/pullrequests/acc-1') {
        const state = url.searchParams.get('state');
        return json({
          values:
            state === 'OPEN'
              ? [pullRequest(1, 'OPEN')]
              : state === 'MERGED'
                ? [pullRequest(2, 'MERGED')]
                : [],
        });
      }
      if (url.pathname === '/2.0/workspaces/labs/pullrequests/acc-1') return json({ values: [{ id: 9 }] });
      throw new Error(`unexpected ${url}`);
    });

    const result = await loadBitbucketItems(API, 'oauth-access-token');

    expect(calls.every((call) => call.authorization === 'Bearer oauth-access-token')).toBe(true);
    expect(result.displayName).toBe('Jakob');
    expect(result.workspaces).toEqual(['acme', 'labs']);
    expect(result.items.map((item) => [item.title, item.state])).toEqual([
      ['Change 1', 'open'],
      ['Change 2', 'merged'],
    ]);
    expect(result.items[0]).toMatchObject({
      kind: 'pull_request',
      url: 'https://bitbucket.org/acme/web/pull-requests/1',
      summary: 'acme/web - feature-1 -> main',
      assignedToUser: true,
    });
  });

  test('marks a rejected sign-in on the profile probe only', async () => {
    mockBitbucket(() => new Response('expired', { status: 401 }));
    const rejected = await loadBitbucketItems(API, 'expired-token').catch((error) => error);
    expect(rejected.message).toBe('Bitbucket auth probe failed with HTTP 401: expired');
    expect(rejected.statusCode).toBe(401);

    mockBitbucket((url) =>
      url.pathname === '/2.0/user' ? json({ account_id: 'acc-1' }) : new Response('', { status: 403 }),
    );
    const forbidden = await loadBitbucketItems(API, 'access-2').catch((error) => error);
    expect(forbidden.message).toBe('Bitbucket list workspaces failed with HTTP 403');
    expect(forbidden.statusCode).toBeUndefined();

    mockBitbucket(() => json({}));
    const anonymous = await loadBitbucketItems(API, 'access-2').catch((error) => error);
    expect(anonymous.message).toBe('Bitbucket auth succeeded, but the current user id was missing.');
  });
});
