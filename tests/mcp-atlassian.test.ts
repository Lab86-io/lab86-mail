import { describe, expect, test } from 'bun:test';
import {
  atlassianDocumentText,
  JIRA_ASSIGNED_JQL,
  JIRA_HISTORY_JQL,
  loadAtlassianChangedIssues,
  loadAtlassianHistoryPage,
  loadAtlassianItems,
  normalizeConfluencePage,
  normalizeJiraIssue,
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

function standardHandler(overrides: Partial<Record<'jira' | 'confluence' | 'me', Handler>> = {}): Handler {
  return (url, init) => {
    if (url.pathname === '/oauth/token/accessible-resources') return json([site]);
    if (url.pathname === '/me')
      return overrides.me?.(url, init) ?? json({ account_id: 'me-1', email: 'j@acme.test' });
    if (url.pathname.endsWith('/rest/api/3/search/jql')) {
      if (overrides.jira) return overrides.jira(url, init);
      const body = JSON.parse(String(init.body));
      return json({
        issues:
          body.jql === JIRA_ASSIGNED_JQL
            ? [issue('10', 'PAY-1')]
            : [issue('10', 'PAY-1'), issue('11', 'PAY-2', { assignee: null })],
      });
    }
    if (url.pathname.endsWith('/wiki/rest/api/search')) {
      if (overrides.confluence) return overrides.confluence(url, init);
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
      author: 'Jane',
      organization: 'acme',
      assignedToUser: true,
      summary: 'Payments · Bug · High priority\nCard fails',
    });
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
    const items = await loadAtlassianChangedIssues(API, 'token-1', now - 90 * 60_000 - 1, now, mock.fetchFn);
    expect(jqls[0]).toContain('updated >= -91m');
    expect(jqls[0]).not.toContain('-365d');
    expect(items.map((item) => item.externalId)).toEqual(['jira:cloud-1:10']);
  });
});
