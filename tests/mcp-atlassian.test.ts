import { describe, expect, test } from 'bun:test';
import {
  atlassianDocumentText,
  CONFLUENCE_QUIET_SITE_LIMIT,
  CONFLUENCE_RECENT_CQL,
  CONFLUENCE_SITE_RECENT_CQL,
  confluenceTextCql,
  JIRA_ASSIGNED_JQL,
  JIRA_CHANGE_PAGE_LIMIT,
  JIRA_HISTORY_JQL,
  JIRA_QUIET_SITE_LIMIT,
  JIRA_SITE_RECENT_JQL,
  JIRA_SITE_WINDOW_JQL,
  jiraTextJql,
  loadAtlassianChangedIssues,
  loadAtlassianHistoryPage,
  loadAtlassianItems,
  normalizeConfluencePage,
  normalizeJiraIssue,
  readJiraIssue,
  searchAtlassianLive,
} from '../lib/mcp/atlassian';

const API = 'https://api.atlassian.com';
const site = {
  id: 'cloud-1',
  url: 'https://acme.atlassian.net',
  name: 'acme',
  scopes: ['read:jira-work', 'read:jira-user', 'search:confluence'],
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function issue(id: string, key: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    key,
    fields: {
      summary: `Fix ${key}`,
      status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } },
      updated: '2026-10-08T12:00:00.000+0000',
      assignee: { accountId: 'me-1', displayName: 'Jakob' },
      reporter: { displayName: 'Jane' },
      project: { key: 'PAY', name: 'Payments' },
      issuetype: { name: 'Bug' },
      priority: { name: 'High' },
      ...extra,
    },
  };
}

type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>;

function atlassianFetch(handler: Handler) {
  const calls: Array<{ url: URL; body?: any }> = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer token-1');
    return handler(url, init || {});
  }) as typeof fetch;
  return { fetchFn, calls };
}

function confluenceResult(id: string, title: string) {
  return {
    content: { id, type: 'page', title, _links: { webui: `/spaces/ENG/pages/${id}` } },
    lastModified: '2026-10-07T09:00:00.000Z',
    resultGlobalContainer: { title: 'Engineering' },
  };
}

/**
 * The default site is not quiet: many issues changed, and no page changed.
 * So the sync reads only the items that involve the user. `count` and
 * `sitePages` make the site quiet.
 */
function standardHandler(
  overrides: Partial<Record<'jira' | 'confluence' | 'me' | 'count' | 'sitePages' | 'sites', Handler>> = {},
): Handler {
  return (url, init) => {
    if (url.pathname === '/oauth/token/accessible-resources')
      return overrides.sites?.(url, init) ?? json([site]);
    if (url.pathname === '/me')
      return overrides.me?.(url, init) ?? json({ account_id: 'me-1', email: 'j@acme.test' });
    if (url.pathname.endsWith('/rest/api/3/search/approximate-count')) {
      if (overrides.count) return overrides.count(url, init);
      if (overrides.jira) return overrides.jira(url, init);
      return json({ count: JIRA_QUIET_SITE_LIMIT + 1 });
    }
    if (url.pathname.endsWith('/rest/api/3/search/jql')) {
      if (overrides.jira) return overrides.jira(url, init);
      const body = JSON.parse(String(init.body));
      if (body.jql === JIRA_SITE_RECENT_JQL) {
        return json({
          issues: [issue('10', 'PAY-1'), issue('12', 'PAY-3', { assignee: { accountId: 'other-1' } })],
        });
      }
      return json({
        issues:
          body.jql === JIRA_ASSIGNED_JQL
            ? [issue('10', 'PAY-1')]
            : [issue('10', 'PAY-1'), issue('11', 'PAY-2', { assignee: null })],
      });
    }
    if (url.pathname.endsWith('/wiki/rest/api/search')) {
      if (overrides.confluence) return overrides.confluence(url, init);
      if (url.searchParams.get('cql') === CONFLUENCE_SITE_RECENT_CQL) {
        return overrides.sitePages?.(url, init) ?? json({ results: [], totalSize: 0 });
      }
      return json({
        _links: { base: 'https://acme.atlassian.net/wiki' },
        results: [
          {
            content: {
              id: '77',
              type: 'page',
              title: 'Launch plan',
              _links: { webui: '/spaces/ENG/pages/77/Launch+plan' },
            },
            excerpt: 'The @@@hl@@@launch@@@endhl@@@ moves to Friday',
            lastModified: '2026-10-07T09:00:00.000Z',
            resultGlobalContainer: { title: 'Engineering' },
          },
        ],
      });
    }
    throw new Error(`unexpected ${url}`);
  };
}

describe('Atlassian document text', () => {
  test('reads ADF paragraphs, breaks, and plain strings', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'First line' },
            { type: 'hardBreak' },
            { type: 'text', text: 'second' },
          ],
        },
        {
          type: 'bulletList',
          content: [
            { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Item' }] }] },
          ],
        },
      ],
    };
    expect(atlassianDocumentText(doc)).toBe('First line\nsecond\nItem');
    expect(atlassianDocumentText('  plain  ')).toBe('plain');
    expect(atlassianDocumentText(null)).toBe('');
  });
});

describe('Atlassian item normalizers', () => {
  test('a Jira issue gets a stable id, the key in its title, and a browse link', () => {
    const item = normalizeJiraIssue(
      issue('10', 'PAY-1', {
        description: {
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Card fails' }] }],
        },
      }),
      site,
      { accountId: 'me-1' },
    );
    expect(item).toMatchObject({
      externalId: 'jira:cloud-1:10',
      kind: 'ticket',
      title: 'PAY-1: Fix PAY-1',
      url: 'https://acme.atlassian.net/browse/PAY-1',
      state: 'In Progress',
      organization: 'acme',
      assignedToUser: true,
      summary: 'Payments · Bug · High priority\nCard fails',
    });
    // No name of another person is kept (Atlassian personal data reporting).
    expect(item?.author).toBeUndefined();
    expect(JSON.stringify(item)).not.toContain('Jane');
    expect(JSON.stringify(item)).not.toContain('Jakob');
    expect(item?.updatedAtSource).toBe(Date.parse('2026-10-08T12:00:00.000+0000'));
    expect(normalizeJiraIssue({ id: '1' }, site)).toBeNull();
    expect(normalizeJiraIssue({ id: '2', key: 'X-2' }, site)).toMatchObject({
      title: 'X-2',
      assignedToUser: false,
    });
  });

  test('a Confluence page gets a wiki link and loses search highlight marks', () => {
    const item = normalizeConfluencePage(
      {
        content: { id: '77', title: 'Plan', _links: { webui: 'spaces/ENG/pages/77' } },
        excerpt: '@@@hl@@@Plan@@@endhl@@@ text',
        resultGlobalContainer: { title: 'Engineering' },
      },
      site,
    );
    expect(item).toMatchObject({
      externalId: 'confluence:cloud-1:77',
      kind: 'page',
      url: 'https://acme.atlassian.net/wiki/spaces/ENG/pages/77',
      summary: 'Engineering space · Plan text',
    });
    expect(
      normalizeConfluencePage(
        { content: { id: '1', _links: { webui: 'https://x.test/p' } }, title: 'T' },
        site,
      )?.url,
    ).toBe('https://x.test/p');
    expect(normalizeConfluencePage({ content: {} }, site)).toBeNull();
  });
});

describe('Atlassian sync', () => {
  test('reads assigned and involved Jira issues and recent Confluence pages for each site', async () => {
    const mock = atlassianFetch(standardHandler());
    const result = await loadAtlassianItems(API, 'token-1', mock.fetchFn);

    expect(result.items.map((item) => item.externalId)).toEqual([
      'jira:cloud-1:10',
      'jira:cloud-1:11',
      'confluence:cloud-1:77',
    ]);
    // The assigned query wins the duplicate, so the flag stays set.
    expect(result.items[0]?.assignedToUser).toBe(true);
    expect(result.items[1]?.assignedToUser).toBe(false);
    expect(result.items[2]?.url).toBe('https://acme.atlassian.net/wiki/spaces/ENG/pages/77/Launch+plan');
    expect(result).toMatchObject({ problems: [], accountEmail: 'j@acme.test', workspaceName: 'acme' });
    const jiraCall = mock.calls.find(
      (call) => call.url.pathname === '/ex/jira/cloud-1/rest/api/3/search/jql',
    );
    expect(jiraCall?.body).toMatchObject({ jql: JIRA_ASSIGNED_JQL, maxResults: 50 });
  });

  test('skips a site product that answers 404 and reports other failures as problems', async () => {
    const missing = await loadAtlassianItems(
      API,
      'token-1',
      atlassianFetch(standardHandler({ confluence: () => new Response('no', { status: 404 }) })).fetchFn,
    );
    expect(missing.problems).toEqual([]);
    expect(missing.items).toHaveLength(2);

    const partial = await loadAtlassianItems(
      API,
      'token-1',
      atlassianFetch(standardHandler({ confluence: () => new Response('boom', { status: 500 }) })).fetchFn,
    );
    expect(partial.items).toHaveLength(2);
    expect(partial.problems[0]).toContain('Atlassian Confluence search on acme failed with HTTP 500');
  });

  test('fails the sync when every query fails, and marks a 401 as a rejected sign-in', async () => {
    const down = await loadAtlassianItems(
      API,
      'token-1',
      atlassianFetch(
        standardHandler({
          jira: () => new Response('down', { status: 503 }),
          confluence: () => new Response('down', { status: 503 }),
        }),
      ).fetchFn,
    ).catch((error) => error);
    expect(down.message).toContain('HTTP 503');
    expect(down.statusCode).toBeUndefined();

    const rejected = await loadAtlassianItems(
      API,
      'token-1',
      atlassianFetch(standardHandler({ jira: () => new Response('expired', { status: 401 }) })).fetchFn,
    ).catch((error) => error);
    expect(rejected.statusCode).toBe(401);

    const profile = await loadAtlassianItems(
      API,
      'token-1',
      atlassianFetch(standardHandler({ me: () => new Response('nope', { status: 403 }) })).fetchFn,
    );
    expect(profile.accountEmail).toBeUndefined();
  });

  test('asks for a new sign-in when the grant reaches no site', async () => {
    const error = await loadAtlassianItems(API, 'token-1', atlassianFetch(() => json([])).fetchFn).catch(
      (err) => err,
    );
    expect(error.message).toBe('The Atlassian sign-in has no site access. Reconnect and choose a site.');
    expect(error.statusCode).toBe(403);
    const probe = await loadAtlassianItems(
      API,
      'token-1',
      atlassianFetch(() => new Response('bad', { status: 403 })).fetchFn,
    ).catch((err) => err);
    expect(probe.statusCode).toBe(403);
  });
});

describe('Atlassian quiet site', () => {
  test('adds the newest team changes when few issues changed on the site', async () => {
    const mock = atlassianFetch(standardHandler({ count: () => json({ count: JIRA_QUIET_SITE_LIMIT }) }));
    const result = await loadAtlassianItems(API, 'token-1', mock.fetchFn);
    expect(result.items.map((item) => item.externalId)).toEqual([
      'jira:cloud-1:10',
      'jira:cloud-1:11',
      'jira:cloud-1:12',
      'confluence:cloud-1:77',
    ]);
    // The issue of another person is in the index, but not as the user's own.
    expect(result.items[2]).toMatchObject({ title: 'PAY-3: Fix PAY-3', assignedToUser: false });
    expect(result.items[0]?.assignedToUser).toBe(true);
    const count = mock.calls.find((call) => call.url.pathname.endsWith('/search/approximate-count'));
    expect(count?.body).toEqual({ jql: JIRA_SITE_WINDOW_JQL });
    const recent = mock.calls.find((call) => call.body?.jql === JIRA_SITE_RECENT_JQL);
    expect(recent?.body).toMatchObject({ maxResults: 50 });
  });

  test('gives a user that no issue names the changes of the team', async () => {
    const mock = atlassianFetch(
      standardHandler({
        count: () => json({ count: 53 }),
        jira: (_url, init) =>
          json({
            issues:
              JSON.parse(String(init.body)).jql === JIRA_SITE_RECENT_JQL
                ? [issue('12', 'PAY-3', { assignee: { accountId: 'other-1' } })]
                : [],
          }),
        confluence: () => json({ results: [], totalSize: 0 }),
      }),
    );
    const result = await loadAtlassianItems(API, 'token-1', mock.fetchFn);
    expect(result.items.map((item) => item.externalId)).toEqual(['jira:cloud-1:12']);
    expect(result.problems).toEqual([]);
  });

  test('keeps to the issues of the user on a site with many changes, or with no count', async () => {
    for (const answer of [{ count: JIRA_QUIET_SITE_LIMIT + 1 }, {}]) {
      const mock = atlassianFetch(standardHandler({ count: () => json(answer) }));
      const result = await loadAtlassianItems(API, 'token-1', mock.fetchFn);
      expect(result.items.map((item) => item.externalId)).not.toContain('jira:cloud-1:12');
      expect(mock.calls.some((call) => call.body?.jql === JIRA_SITE_RECENT_JQL)).toBe(false);
    }
  });

  test('reports a failed count as a problem and keeps the other items', async () => {
    const result = await loadAtlassianItems(
      API,
      'token-1',
      atlassianFetch(standardHandler({ count: () => new Response('no', { status: 400 }) })).fetchFn,
    );
    expect(result.items).toHaveLength(3);
    expect(result.problems[0]).toContain('Atlassian Jira count on acme failed with HTTP 400');
  });

  test('adds the newest pages of a quiet Confluence site only', async () => {
    const pages = (body: unknown) =>
      loadAtlassianItems(
        API,
        'token-1',
        atlassianFetch(standardHandler({ sitePages: () => json(body) })).fetchFn,
      ).then((result) => result.items.map((item) => item.externalId));
    const page = confluenceResult('78', 'Runbook');
    expect(await pages({ results: [page], totalSize: CONFLUENCE_QUIET_SITE_LIMIT })).toContain(
      'confluence:cloud-1:78',
    );
    expect(await pages({ results: [page], totalSize: CONFLUENCE_QUIET_SITE_LIMIT + 1 })).not.toContain(
      'confluence:cloud-1:78',
    );
    // No total: a short page is the whole answer, a full page can hide more.
    expect(await pages({ results: [page] })).toContain('confluence:cloud-1:78');
    const full = Array.from({ length: 25 }, (_, index) => confluenceResult(String(100 + index), `P${index}`));
    expect(await pages({ results: full })).not.toContain('confluence:cloud-1:100');
  });

  test('names a site once when Atlassian lists it for each product', async () => {
    const mock = atlassianFetch(
      standardHandler({
        sites: () =>
          json([
            { ...site, scopes: ['read:confluence-content.summary', 'search:confluence'] },
            { ...site, scopes: ['read:jira-user', 'read:jira-work'] },
          ]),
      }),
    );
    const result = await loadAtlassianItems(API, 'token-1', mock.fetchFn);
    expect(result.workspaceName).toBe('acme');
    expect(result.items.map((item) => item.externalId).sort()).toEqual([
      'confluence:cloud-1:77',
      'jira:cloud-1:10',
      'jira:cloud-1:11',
    ]);
    // Each product is read through the entry that has its scope.
    const cqls = mock.calls
      .filter((call) => call.url.pathname.endsWith('/wiki/rest/api/search'))
      .map((call) => call.url.searchParams.get('cql'));
    expect(cqls).toEqual([CONFLUENCE_RECENT_CQL, CONFLUENCE_SITE_RECENT_CQL]);
  });
});

describe('Atlassian live search', () => {
  test('writes JQL and CQL for plain words and for an issue key', () => {
    expect(jiraTextJql(' pay-12 ')).toBe('key = "PAY-12"');
    expect(jiraTextJql('refund "late" \\ fee')).toBe(
      'text ~ "refund \\"late\\" \\\\ fee" ORDER BY updated DESC',
    );
    expect(confluenceTextCql('launch plan')).toBe('siteSearch ~ "launch plan" AND type in (page, blogpost)');
  });

  test('searches both products with plain words and keeps no stored state', async () => {
    const mock = atlassianFetch(
      standardHandler({
        jira: () => json({ issues: [issue('12', 'PAY-3', { assignee: { accountId: 'other-1' } })] }),
        confluence: () => json({ results: [confluenceResult('78', 'Runbook')], totalSize: 1 }),
      }),
    );
    const found = await searchAtlassianLive({
      baseUrl: API,
      token: 'token-1',
      query: 'refund',
      limit: 7,
      fetchFn: mock.fetchFn,
    });
    expect(found.items.map((item) => item.externalId)).toEqual(['jira:cloud-1:12', 'confluence:cloud-1:78']);
    expect(found.sources).toEqual([
      { site: 'acme', product: 'jira', ok: true },
      { site: 'acme', product: 'confluence', ok: true },
    ]);
    const jira = mock.calls.find((call) => call.url.pathname.endsWith('/search/jql'));
    expect(jira?.body).toMatchObject({ jql: 'text ~ "refund" ORDER BY updated DESC', maxResults: 7 });
    const wiki = mock.calls.find((call) => call.url.pathname.endsWith('/wiki/rest/api/search'));
    expect(wiki?.url.searchParams.get('cql')).toBe('siteSearch ~ "refund" AND type in (page, blogpost)');
    expect(wiki?.url.searchParams.get('limit')).toBe('7');
  });

  test('takes a complete JQL or CQL, and one product on request', async () => {
    const run = async (input: Record<string, unknown>) => {
      const mock = atlassianFetch(
        standardHandler({
          jira: () => json({ issues: [] }),
          confluence: () => json({ results: [], totalSize: 0 }),
        }),
      );
      const found = await searchAtlassianLive({
        baseUrl: API,
        token: 'token-1',
        limit: 5,
        fetchFn: mock.fetchFn,
        ...input,
      });
      return {
        products: found.sources.map((source) => source.product),
        jql: mock.calls.find((call) => call.url.pathname.endsWith('/search/jql'))?.body?.jql,
        cql: mock.calls
          .find((call) => call.url.pathname.endsWith('/wiki/rest/api/search'))
          ?.url.searchParams.get('cql'),
        profile: mock.calls.some((call) => call.url.pathname === '/me'),
      };
    };
    expect(await run({ jql: 'project = PAY' })).toEqual({
      products: ['jira'],
      jql: 'project = PAY',
      cql: undefined,
      profile: true,
    });
    expect(await run({ cql: 'space = ENG' })).toEqual({
      products: ['confluence'],
      jql: undefined,
      cql: 'space = ENG',
      profile: false,
    });
    expect((await run({ query: 'x', product: 'jira' })).products).toEqual(['jira']);
    expect((await run({ query: 'x', product: 'confluence', jql: 'project = PAY' })).products).toEqual([
      'confluence',
    ]);
  });

  test('reports a failed product, skips a missing one, and passes a rejected sign-in', async () => {
    const search = (overrides: Parameters<typeof standardHandler>[0]) =>
      searchAtlassianLive({
        baseUrl: API,
        token: 'token-1',
        query: 'x',
        limit: 5,
        fetchFn: atlassianFetch(standardHandler(overrides)).fetchFn,
      });
    const partial = await search({
      jira: () => new Response('The JQL is not valid.', { status: 400 }),
      confluence: () => new Response('gone', { status: 404 }),
    });
    expect(partial.items).toEqual([]);
    expect(partial.sources).toEqual([
      {
        site: 'acme',
        product: 'jira',
        ok: false,
        error: 'Atlassian Jira search on acme failed with HTTP 400: The JQL is not valid.',
      },
    ]);
    const rejected = await search({ jira: () => new Response('expired', { status: 401 }) }).catch(
      (error) => error,
    );
    expect(rejected.statusCode).toBe(401);
  });
});

describe('Jira issue read', () => {
  const detail = {
    key: 'PAY-3',
    fields: {
      summary: 'Refund fails',
      status: { name: 'In Review', statusCategory: { key: 'indeterminate' } },
      created: '2026-10-01T08:00:00.000+0000',
      updated: '2026-10-08T12:00:00.000+0000',
      assignee: { accountId: 'other-1', displayName: 'Jane Roe' },
      project: { key: 'PAY', name: 'Payments' },
      issuetype: { name: 'Bug' },
      priority: { name: 'High' },
      labels: ['billing'],
      duedate: '2026-10-20',
      parent: { key: 'PAY-1', fields: { summary: 'Refunds' } },
      subtasks: [{ key: 'PAY-4', fields: { summary: 'Add test', status: { name: 'To Do' } } }, {}],
      description: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'Card refund fails for ' },
              { type: 'mention', attrs: { id: 'other-1', text: '@Jane Roe' } },
            ],
          },
        ],
      },
    },
  };
  const comments = {
    total: 14,
    comments: [
      { created: '2026-10-08T11:00:00.000+0000', author: { accountId: 'me-1' }, body: 'I can take it' },
      {
        created: '2026-10-07T10:00:00.000+0000',
        author: { accountId: 'other-1', displayName: 'Jane Roe' },
        body: 'Seen on prod',
      },
      {
        created: '2026-10-06T10:00:00.000+0000',
        author: { accountId: 'other-1' },
        body: { type: 'doc', content: [] },
      },
    ],
  };

  function issueFetch(overrides: { issue?: Handler; comment?: Handler; sites?: unknown[] } = {}) {
    return atlassianFetch((url, init) => {
      if (url.pathname === '/oauth/token/accessible-resources') return json(overrides.sites ?? [site]);
      if (url.pathname === '/me') return json({ account_id: 'me-1' });
      if (url.pathname.endsWith('/comment')) return overrides.comment?.(url, init) ?? json(comments);
      if (url.pathname.includes('/rest/api/3/issue/')) return overrides.issue?.(url, init) ?? json(detail);
      throw new Error(`unexpected ${url}`);
    });
  }

  test('reads the issue and its newest comments with no name of another person', async () => {
    const mock = issueFetch();
    const read = await readJiraIssue({ baseUrl: API, token: 'token-1', key: 'pay-3', fetchFn: mock.fetchFn });
    expect(read).toEqual({
      site: 'acme',
      key: 'PAY-3',
      title: 'Refund fails',
      url: 'https://acme.atlassian.net/browse/PAY-3',
      state: 'In Review',
      statusCategory: 'indeterminate',
      project: 'Payments',
      issueType: 'Bug',
      priority: 'High',
      hasAssignee: true,
      assignedToUser: false,
      labels: ['billing'],
      due: '2026-10-20',
      createdAt: Date.parse('2026-10-01T08:00:00.000+0000'),
      updatedAt: Date.parse('2026-10-08T12:00:00.000+0000'),
      parent: { key: 'PAY-1', title: 'Refunds' },
      subtasks: [{ key: 'PAY-4', title: 'Add test', state: 'To Do' }],
      description: 'Card refund fails for',
      comments: [
        { createdAt: Date.parse('2026-10-07T10:00:00.000+0000'), fromUser: false, text: 'Seen on prod' },
        { createdAt: Date.parse('2026-10-08T11:00:00.000+0000'), fromUser: true, text: 'I can take it' },
      ],
      commentTotal: 14,
    });
    expect(JSON.stringify(read)).not.toContain('Jane');
    const issueCall = mock.calls.find((call) => call.url.pathname.endsWith('/issue/PAY-3'));
    expect(issueCall?.url.searchParams.get('fields')).toContain('subtasks');
    const commentCall = mock.calls.find((call) => call.url.pathname.endsWith('/comment'));
    expect(commentCall?.url.search).toBe('?orderBy=-created&maxResults=10');
  });

  test('tries each Jira site, and the site of a link first', async () => {
    const second = { ...site, id: 'cloud-2', url: 'https://beta.atlassian.net', name: 'beta' };
    const read: string[] = [];
    const mock = issueFetch({
      sites: [site, second, { ...site, id: 'c3', scopes: ['search:confluence'] }],
      issue: (url) => {
        read.push(url.pathname.split('/')[3] || '');
        return url.pathname.includes('cloud-2') ? json(detail) : new Response('none', { status: 404 });
      },
    });
    const found = await readJiraIssue({
      baseUrl: API,
      token: 'token-1',
      key: 'PAY-3',
      fetchFn: mock.fetchFn,
    });
    expect(found?.site).toBe('beta');
    expect(read).toEqual(['cloud-1', 'cloud-2']);
    read.length = 0;
    const linked = await readJiraIssue({
      baseUrl: API,
      token: 'token-1',
      key: 'PAY-3',
      siteUrl: 'https://beta.atlassian.net',
      fetchFn: mock.fetchFn,
    });
    expect(linked?.url).toBe('https://beta.atlassian.net/browse/PAY-3');
    expect(read).toEqual(['cloud-2']);
  });

  test('answers null for no issue or a bad key, and keeps the issue when comments fail', async () => {
    const none = issueFetch({ issue: () => new Response('none', { status: 404 }) });
    expect(
      await readJiraIssue({ baseUrl: API, token: 'token-1', key: 'PAY-9', fetchFn: none.fetchFn }),
    ).toBeNull();
    expect(
      await readJiraIssue({ baseUrl: API, token: 'token-1', key: 'not a key', fetchFn: none.fetchFn }),
    ).toBeNull();
    expect(none.calls.filter((call) => call.url.pathname.includes('/issue/'))).toHaveLength(1);

    const bare = issueFetch({
      issue: () => json({ fields: {} }),
      comment: () => new Response('no', { status: 403 }),
    });
    expect(
      await readJiraIssue({ baseUrl: API, token: 'token-1', key: 'PAY-3', fetchFn: bare.fetchFn }),
    ).toMatchObject({
      key: 'PAY-3',
      title: 'PAY-3',
      hasAssignee: false,
      subtasks: [],
      comments: [],
      commentTotal: 0,
      commentsUnavailable: true,
    });

    const down = issueFetch({ issue: () => new Response('down', { status: 500 }) });
    await expect(
      readJiraIssue({ baseUrl: API, token: 'token-1', key: 'PAY-3', fetchFn: down.fetchFn }),
    ).rejects.toThrow('Atlassian Jira issue read on acme failed with HTTP 500');
    const expired = issueFetch({ comment: () => new Response('expired', { status: 401 }) });
    const rejected = await readJiraIssue({
      baseUrl: API,
      token: 'token-1',
      key: 'PAY-3',
      fetchFn: expired.fetchFn,
    }).catch((error) => error);
    expect(rejected.statusCode).toBe(401);
  });
});

describe('Atlassian history walk', () => {
  test('pages through each Jira site and then ends', async () => {
    const second = { ...site, id: 'cloud-2', url: 'https://beta.atlassian.net', name: 'beta' };
    const mock = atlassianFetch((url, init) => {
      if (url.pathname === '/oauth/token/accessible-resources') {
        return json([
          site,
          second,
          { id: 'c3', url: 'https://wiki.atlassian.net', name: 'wiki', scopes: ['search:confluence'] },
        ]);
      }
      if (url.pathname === '/me') return json({ account_id: 'me-1' });
      const body = JSON.parse(String(init.body));
      expect(body.jql).toBe(JIRA_HISTORY_JQL);
      if (url.pathname.includes('cloud-1')) {
        return json(
          body.nextPageToken
            ? { issues: [issue('12', 'PAY-3')], isLast: true }
            : { issues: [issue('10', 'PAY-1')], nextPageToken: 'n1' },
        );
      }
      return json({ issues: [issue('20', 'OPS-1')] });
    });

    const first = await loadAtlassianHistoryPage(API, 'token-1', { site: 0 }, mock.fetchFn);
    expect(first.items[0]).toMatchObject({ externalId: 'jira:cloud-1:10', assignedToUser: true });
    expect(first.next).toEqual({ site: 0, token: 'n1' });
    const next = await loadAtlassianHistoryPage(API, 'token-1', first.next!, mock.fetchFn);
    expect(next.next).toEqual({ site: 1 });
    const last = await loadAtlassianHistoryPage(API, 'token-1', next.next!, mock.fetchFn);
    expect(last.items[0]?.externalId).toBe('jira:cloud-2:20');
    expect(last.next).toBeUndefined();
    expect(await loadAtlassianHistoryPage(API, 'token-1', { site: 9 }, mock.fetchFn)).toEqual({ items: [] });
  });

  test('reads changed issues with a relative minute window on every site', async () => {
    const jqls: string[] = [];
    const mock = atlassianFetch((url, init) => {
      if (url.pathname === '/oauth/token/accessible-resources') return json([site]);
      if (url.pathname === '/me') return json({ account_id: 'me-1' });
      jqls.push(JSON.parse(String(init.body)).jql);
      return json({ issues: [issue('10', 'PAY-1'), { id: 'x' }] });
    });
    const now = 1_000_000_000;
    const changed = await loadAtlassianChangedIssues(
      API,
      'token-1',
      now - 90 * 60_000 - 1,
      now,
      mock.fetchFn,
    );
    expect(jqls[0]).toContain('updated >= -91m');
    expect(jqls[0]).toEndWith('ORDER BY updated ASC');
    expect(jqls[0]).not.toContain('-365d');
    expect(changed).toEqual({ items: [expect.objectContaining({ externalId: 'jira:cloud-1:10' })] });
  });
});

describe('Atlassian page guards', () => {
  function pagedFetch(pages: (body: any, url: URL) => unknown) {
    return atlassianFetch((url, init) => {
      if (url.pathname === '/oauth/token/accessible-resources') return json([site]);
      if (url.pathname === '/me') return json({ account_id: 'me-1' });
      return json(pages(JSON.parse(String(init.body)), url));
    });
  }

  test('the history walk stops on a repeated page token and keeps its cursor', async () => {
    const mock = pagedFetch(() => ({ issues: [issue('10', 'PAY-1')], nextPageToken: 'same' }));
    const error = await loadAtlassianHistoryPage(
      API,
      'token-1',
      { site: 0, token: 'same' },
      mock.fetchFn,
    ).catch((err) => err);
    expect(error.message).toBe('Jira search on acme returned the same page token again');
  });

  test('a change recheck reads every page of the window', async () => {
    const tokens: Array<string | undefined> = [];
    const mock = pagedFetch((body) => {
      tokens.push(body.nextPageToken);
      return body.nextPageToken === 'p2'
        ? { issues: [issue('11', 'PAY-2')], isLast: true }
        : { issues: [issue('10', 'PAY-1')], nextPageToken: 'p2' };
    });
    const changed = await loadAtlassianChangedIssues(API, 'token-1', 0, 60_000, mock.fetchFn);
    expect(tokens).toEqual([undefined, 'p2']);
    expect(changed.items.map((item) => item.externalId)).toEqual(['jira:cloud-1:10', 'jira:cloud-1:11']);
    // Every page was read, so the next recheck starts at the current time.
    expect(changed.resumeAt).toBeUndefined();
  });

  test('a change recheck stops on a repeated token and at the page limit', async () => {
    const repeated = pagedFetch((body) => ({
      issues: [issue('10', 'PAY-1')],
      nextPageToken: body.nextPageToken ? body.nextPageToken : 'loop',
    }));
    const error = await loadAtlassianChangedIssues(API, 'token-1', 0, 60_000, repeated.fetchFn).catch(
      (err) => err,
    );
    expect(error.message).toBe('Jira search on acme returned the same page token again');

    let calls = 0;
    const endless = pagedFetch(() => {
      calls += 1;
      return { issues: [issue(String(calls), `PAY-${calls}`)], nextPageToken: `p${calls + 1}` };
    });
    const capped = await loadAtlassianChangedIssues(
      API,
      'token-1',
      Date.parse('2026-10-01T00:00:00.000Z'),
      Date.parse('2026-10-09T00:00:00.000Z'),
      endless.fetchFn,
    );
    expect(calls).toBe(JIRA_CHANGE_PAGE_LIMIT);
    expect(capped.items).toHaveLength(JIRA_CHANGE_PAGE_LIMIT);
    // Pages remain, so the next recheck resumes after the newest issue read.
    expect(capped.resumeAt).toBe(Date.parse('2026-10-08T12:00:00.000+0000'));

    // A capped read with no progress past the last check fails and keeps the cursor.
    const stale = pagedFetch((body) => ({
      issues: [issue('1', 'PAY-1', { updated: '2020-01-01T00:00:00.000+0000' })],
      nextPageToken: `t${(Number(String(body.nextPageToken || 't0').slice(1)) || 0) + 1}`,
    }));
    const since = Date.parse('2026-10-08T00:00:00.000Z');
    await expect(
      loadAtlassianChangedIssues(API, 'token-1', since, since + 60_000, stale.fetchFn),
    ).rejects.toThrow('Jira search on acme read 10 pages without reaching issues newer than the last check');
  });
});
