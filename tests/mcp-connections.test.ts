import { describe, expect, test } from 'bun:test';
import { Buffer } from 'node:buffer';

describe('MCP connection auth', () => {
  test('builds bearer headers defensively', async () => {
    const { buildAuthorizationHeader } = await import('../lib/mcp/auth');

    expect(buildAuthorizationHeader(' Bearer abc\n123 ')).toBe('Bearer abc123');
    expect(buildAuthorizationHeader('token ghp_123')).toBe('Bearer ghp_123');
  });

  test('builds Basic auth for Atlassian-style email token pairs', async () => {
    const { buildAuthorizationHeader } = await import('../lib/mcp/auth');

    expect(buildAuthorizationHeader('person@example.com:api-token', 'basic-or-bearer')).toBe(
      `Basic ${Buffer.from('person@example.com:api-token', 'utf8').toString('base64')}`,
    );
    expect(buildAuthorizationHeader('Basic cGVyc29uOmFwaS10b2tlbg==', 'basic-or-bearer')).toBe(
      'Basic cGVyc29uOmFwaS10b2tlbg==',
    );
  });
});

describe('Bitbucket connection sync', () => {
  test('loads authored open pull requests from user workspaces', async () => {
    const originalFetch = globalThis.fetch;
    const requests: Array<{ url: string; authorization: string | null }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      requests.push({ url, authorization: headers.get('authorization') });

      if (url.endsWith('/user')) {
        return jsonResponse({ account_id: 'acct-123', display_name: 'Ada Lovelace' });
      }
      if (url.includes('/user/workspaces')) {
        return jsonResponse({ values: [{ slug: 'lab86' }] });
      }
      if (url.includes('/workspaces/lab86/pullrequests/acct-123') && !url.includes('page=2')) {
        return jsonResponse({
          next: 'https://api.bitbucket.org/2.0/workspaces/lab86/pullrequests/acct-123?page=2',
          values: [
            {
              id: 42,
              title: 'Add Bitbucket access',
              state: 'OPEN',
              updated_on: '2026-06-25T16:00:00.000Z',
              links: { html: { href: 'https://bitbucket.org/lab86/mail/pull-requests/42' } },
              author: { display_name: 'Ada Lovelace' },
              source: {
                branch: { name: 'bitbucket-access' },
                repository: { full_name: 'lab86/mail' },
              },
              destination: {
                branch: { name: 'main' },
                repository: { full_name: 'lab86/mail' },
              },
            },
          ],
        });
      }
      if (url.includes('/workspaces/lab86/pullrequests/acct-123') && url.includes('page=2')) {
        return jsonResponse({
          values: [
            {
              id: 43,
              title: 'Review staged rollout',
              state: 'OPEN',
              links: { html: { href: 'https://bitbucket.org/lab86/mail/pull-requests/43' } },
              author: { display_name: 'Ada Lovelace' },
              source: {
                branch: { name: 'staged-rollout' },
                repository: { full_name: 'lab86/mail' },
              },
              destination: {
                branch: { name: 'main' },
                repository: { full_name: 'lab86/mail' },
              },
            },
          ],
        });
      }
      return jsonResponse({ error: 'unexpected' }, 404);
    }) as typeof fetch;

    try {
      const { loadBitbucketItems } = await import('../lib/mcp/bitbucket');
      const result = await loadBitbucketItems(
        'https://api.bitbucket.org/2.0',
        'person@example.com:api-token',
      );

      expect(requests[0]?.authorization).toBe(
        `Basic ${Buffer.from('person@example.com:api-token', 'utf8').toString('base64')}`,
      );
      expect(result.displayName).toBe('Ada Lovelace');
      expect(result.items).toHaveLength(2);
      expect(result.items[0]).toMatchObject({
        externalId: 'https://bitbucket.org/lab86/mail/pull-requests/42',
        kind: 'pull_request',
        title: 'Add Bitbucket access',
        state: 'open',
        author: 'Ada Lovelace',
        assignedToUser: true,
      });
      expect(result.items[0]?.searchText).toContain('bitbucket-access');
      expect(result.items[1]?.title).toBe('Review staged rollout');
      expect(requests.some((request) => request.url.includes('page=2'))).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('surfaces partial workspace failures instead of returning a partial success', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);

      if (url.endsWith('/user')) {
        return jsonResponse({ account_id: 'acct-123', display_name: 'Ada Lovelace' });
      }
      if (url.includes('/user/workspaces')) {
        return jsonResponse({ values: [{ slug: 'lab86' }, { slug: 'other' }] });
      }
      if (url.includes('/workspaces/lab86/pullrequests/acct-123')) {
        return jsonResponse({
          values: [
            {
              id: 42,
              title: 'Add Bitbucket access',
              state: 'OPEN',
            },
          ],
        });
      }
      if (url.includes('/workspaces/other/pullrequests/acct-123')) {
        return jsonResponse({ error: 'workspace unavailable' }, 500);
      }
      return jsonResponse({ error: 'unexpected' }, 404);
    }) as typeof fetch;

    try {
      const { loadBitbucketItems } = await import('../lib/mcp/bitbucket');

      await expect(
        loadBitbucketItems('https://api.bitbucket.org/2.0', 'person@example.com:api-token'),
      ).rejects.toThrow(/Bitbucket list pull requests for other failed with HTTP 500/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
