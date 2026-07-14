import { describe, expect, test } from 'bun:test';
import {
  loadGitHubItems,
  normalizeGitHubCommit,
  normalizeGitHubIssue,
  normalizeGitHubProject,
  normalizeGitHubProjectItem,
} from '../lib/mcp/github';

describe('GitHub evidence normalization', () => {
  test('keeps issue and PR identity repository-scoped', () => {
    const issue = normalizeGitHubIssue(
      {
        number: 42,
        title: 'Build the Area inbox',
        body: 'Area-scoped mail with a small view switcher.',
        html_url: 'https://github.com/Lab86-io/lab86-mail/issues/42',
        repository_url: 'https://api.github.com/repos/Lab86-io/lab86-mail',
        state: 'open',
        updated_at: '2026-07-14T12:00:00Z',
        user: { login: 'jakob' },
        assignees: [{ login: 'jakob' }],
      },
      'jakob',
      'issue',
    );
    const pull = normalizeGitHubIssue(
      {
        number: 42,
        title: 'Render Area inbox',
        repository_url: 'https://api.github.com/repos/Lab86-io/lab86-mail',
        pull_request: {},
      },
      'jakob',
    );

    expect(issue).toMatchObject({
      externalId: 'github:issue:Lab86-io/lab86-mail#42',
      repository: 'Lab86-io/lab86-mail',
      organization: 'Lab86-io',
      assignedToUser: true,
    });
    expect(pull?.externalId).toBe('github:pull_request:Lab86-io/lab86-mail#42');
    expect(pull?.externalId).not.toBe(issue?.externalId);
  });

  test('normalizes commits as activity without a completion claim', () => {
    const commit = normalizeGitHubCommit(
      {
        sha: 'abc123',
        html_url: 'https://github.com/Lab86-io/lab86-mail/commit/abc123',
        author: { login: 'jakob' },
        commit: {
          message: 'Add living routines\n\nMaterialize one task per local day.',
          committer: { date: '2026-07-14T15:00:00Z' },
        },
      },
      'Lab86-io/lab86-mail',
    );
    expect(commit).toMatchObject({
      kind: 'commit',
      sha: 'abc123',
      repository: 'Lab86-io/lab86-mail',
      state: 'committed',
      title: 'Add living routines',
    });
  });

  test('links project items back to their project and repository', () => {
    const project = {
      id: 'PVT_1',
      title: 'Albatross 1.0',
      shortDescription: 'Intent layer release',
      owner: { login: 'Lab86-io' },
      url: 'https://github.com/orgs/Lab86-io/projects/1',
      updatedAt: '2026-07-14T12:00:00Z',
    };
    expect(normalizeGitHubProject(project)).toMatchObject({
      externalId: 'github:project:PVT_1',
      kind: 'project',
      organization: 'Lab86-io',
    });
    expect(
      normalizeGitHubProjectItem(
        {
          id: 'PVTI_9',
          type: 'ISSUE',
          content: {
            title: 'Ask once, remember forever',
            url: 'https://github.com/Lab86-io/lab86-mail/issues/99',
            state: 'OPEN',
            repository: { nameWithOwner: 'Lab86-io/lab86-mail' },
          },
        },
        project,
      ),
    ).toMatchObject({
      externalId: 'github:project_item:PVT_1:PVTI_9',
      parentExternalId: 'github:project:PVT_1',
      repository: 'Lab86-io/lab86-mail',
    });
  });

  test('indexes repository-wide issues, merged pull requests, and commits from other authors', async () => {
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/user')) {
        return new Response(JSON.stringify({ login: 'jakob' }), { status: 200 });
      }
      if (url.includes('/search/issues')) {
        const query = new URL(url).searchParams.get('q') || '';
        return new Response(
          JSON.stringify({
            items: query.includes('is:merged')
              ? [
                  {
                    number: 96,
                    title: 'Render Areas as artifacts',
                    repository_url: 'https://api.github.com/repos/Lab86-io/lab86-mail',
                    state: 'closed',
                    pull_request: {},
                  },
                ]
              : [],
          }),
          { status: 200 },
        );
      }
      if (url.includes('/search/commits')) {
        return new Response(JSON.stringify({ items: [] }), { status: 200 });
      }
      if (url.includes('/user/repos')) {
        return new Response(JSON.stringify([{ full_name: 'Lab86-io/lab86-mail' }]), { status: 200 });
      }
      if (url.includes('/repos/Lab86-io/lab86-mail/issues?')) {
        return new Response(
          JSON.stringify([
            {
              number: 120,
              title: 'Connector migration',
              body: 'Preserve evidence when credentials are revoked.',
              repository_url: 'https://api.github.com/repos/Lab86-io/lab86-mail',
              state: 'closed',
              user: { login: 'grace' },
            },
          ]),
          { status: 200 },
        );
      }
      if (url.includes('/repos/Lab86-io/lab86-mail/pulls?')) {
        return new Response(
          JSON.stringify([
            {
              number: 96,
              title: 'Render Areas as artifacts',
              state: 'closed',
              merged_at: '2026-07-14T16:00:00Z',
              base: { repo: { full_name: 'Lab86-io/lab86-mail' } },
              user: { login: 'jakob' },
            },
          ]),
          { status: 200 },
        );
      }
      if (url.includes('/repos/Lab86-io/lab86-mail/commits?')) {
        return new Response(
          JSON.stringify([
            {
              sha: 'other-author-sha',
              html_url: 'https://github.com/Lab86-io/lab86-mail/commit/other-author-sha',
              author: { login: 'grace' },
              commit: {
                message: 'Review evidence cleanup',
                committer: { date: '2026-07-14T15:00:00Z' },
              },
            },
          ]),
          { status: 200 },
        );
      }
      if (url.endsWith('/graphql') && init?.method === 'POST') {
        return new Response(
          JSON.stringify({
            data: {
              user: { projectsV2: { nodes: [] } },
              viewer: { organizations: { nodes: [] } },
            },
          }),
          { status: 200 },
        );
      }
      return new Response('not found', { status: 404 });
    }) as typeof fetch;

    const result = await loadGitHubItems('https://api.github.com', 'token', fetchImpl);

    expect(result.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          externalId: 'github:issue:Lab86-io/lab86-mail#120',
          state: 'closed',
        }),
        expect.objectContaining({
          externalId: 'github:pull_request:Lab86-io/lab86-mail#96',
          state: 'merged',
        }),
        expect.objectContaining({
          externalId: 'github:commit:Lab86-io/lab86-mail:other-author-sha',
          author: 'grace',
        }),
      ]),
    );
  });

  test('uses configured enterprise REST and GraphQL endpoints', async () => {
    const urls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      urls.push(url);
      if (url.endsWith('/user')) {
        return new Response(JSON.stringify({ login: 'jakob' }), { status: 200 });
      }
      if (url.includes('/search/issues')) {
        return new Response(JSON.stringify({ items: [] }), { status: 200 });
      }
      if (url.includes('/user/repos')) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (url.endsWith('/api/graphql') && init?.method === 'POST') {
        return new Response(
          JSON.stringify({
            data: {
              user: { projectsV2: { nodes: [] } },
              viewer: { organizations: { nodes: [] } },
            },
          }),
          { status: 200 },
        );
      }
      return new Response('not found', { status: 404 });
    }) as typeof fetch;

    const result = await loadGitHubItems(
      'https://github.enterprise.test/api/v3',
      'enterprise-token',
      fetchImpl,
    );

    expect(result).toEqual({ items: [], viewer: 'jakob' });
    expect(
      urls
        .filter((url) => !url.endsWith('/api/graphql'))
        .every((url) => url.startsWith('https://github.enterprise.test/api/v3/')),
    ).toBe(true);
    expect(urls).toContain('https://github.enterprise.test/api/graphql');
  });

  test('propagates operational endpoint failures instead of publishing a partial ready sync', async () => {
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/user')) {
        return new Response(JSON.stringify({ login: 'jakob' }), { status: 200 });
      }
      return new Response('rate limited', { status: 429 });
    }) as typeof fetch;

    await expect(loadGitHubItems('https://api.github.com', 'token', fetchImpl)).rejects.toThrow('GitHub 429');
  });
});
