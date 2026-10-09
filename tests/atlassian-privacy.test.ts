import { describe, expect, mock, test } from 'bun:test';
import { NextRequest } from 'next/server';
import { createAtlassianPrivacyPost } from '../app/api/cron/atlassian-privacy/route';
import {
  ATLASSIAN_REPORT_URL,
  reportAtlassianAccount,
  reportAtlassianPersonalData,
} from '../lib/mcp/atlassian-privacy';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function row(connectionId: string, extra: Record<string, unknown> = {}) {
  return {
    connectionId,
    server: 'jira',
    authKind: 'oauth',
    status: 'connected',
    serverUrl: 'https://api.atlassian.com',
    scopes: [],
    includeInBrief: true,
    includeInSearch: true,
    lastSyncOkAt: Date.parse('2026-10-09T08:00:00.000Z'),
    ...extra,
  } as any;
}

function atlassian(reports: Record<string, Response | (() => Response)>, accounts: Record<string, string>) {
  const posts: Array<{ token: string; body: any }> = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const token = String((init?.headers as Record<string, string>).authorization).replace('Bearer ', '');
    if (url === 'https://api.atlassian.com/me') {
      return accounts[token] ? json({ account_id: accounts[token] }) : new Response('', { status: 401 });
    }
    if (url === ATLASSIAN_REPORT_URL) {
      posts.push({ token, body: JSON.parse(String(init?.body)) });
      const answer = reports[token];
      return typeof answer === 'function' ? answer() : (answer ?? new Response(null, { status: 204 }));
    }
    throw new Error(`unexpected ${url}`);
  }) as typeof fetch;
  return { fetchFn, posts };
}

describe('Atlassian account report', () => {
  test('sends the account and the time of its profile read', async () => {
    const mock = atlassian({ t: new Response(null, { status: 204 }) }, {});
    expect(
      await reportAtlassianAccount({ token: 't', accountId: 'acc-1', updatedAt: 0, fetchFn: mock.fetchFn }),
    ).toBe('ok');
    expect(mock.posts[0]?.body).toEqual({
      accounts: [{ accountId: 'acc-1', updatedAt: '1970-01-01T00:00:00.000Z' }],
    });
  });

  test('reads closed and updated answers, and reports a failure', async () => {
    const answers = {
      closed: json({ accounts: [{ accountId: 'acc-1', status: 'closed' }] }),
      updated: json({ accounts: [{ accountId: 'acc-1', status: 'updated' }] }),
      other: json({ accounts: [{ accountId: 'someone-else', status: 'closed' }] }),
      down: new Response('try later', { status: 503 }),
    };
    const mock = atlassian(answers, {});
    const run = (token: string) =>
      reportAtlassianAccount({ token, accountId: 'acc-1', updatedAt: 0, fetchFn: mock.fetchFn });
    expect(await run('closed')).toBe('closed');
    expect(await run('updated')).toBe('updated');
    expect(await run('other')).toBe('ok');
    await expect(run('down')).rejects.toThrow('Atlassian account report failed with HTTP 503: try later');
  });
});

describe('Atlassian personal data report for one user', () => {
  test('reports each Atlassian sign-in, erases a closed account, and refreshes an updated one', async () => {
    const rows = [
      row('jira_ok'),
      row('jira_closed'),
      row('jira_updated', { lastSyncOkAt: undefined, lastSyncedAt: 5 }),
      row('jira_token', { authKind: 'token' }),
      row('jira_gone', { status: 'disconnected' }),
      row('slack_1', { server: 'slack' }),
    ];
    const mock = atlassian(
      {
        'tok-closed': json({ accounts: [{ accountId: 'acc-closed', status: 'closed' }] }),
        'tok-updated': json({ accounts: [{ accountId: 'acc-updated', status: 'updated' }] }),
      },
      { 'tok-ok': 'acc-ok', 'tok-closed': 'acc-closed', 'tok-updated': 'acc-updated' },
    );
    const disconnectConnection = mock_((_user: string, _id: string) => undefined);
    const syncConnection = mock_((_user: string, _id: string) => ({ ok: true, count: 1 }));
    const results = await reportAtlassianPersonalData('user_1', {
      listUserConnections: async () => rows,
      getConnectionToken: (async (_user: string, connectionId: string) => ({
        row: rows.find((entry) => entry.connectionId === connectionId),
        token: `tok-${connectionId.replace('jira_', '')}`,
      })) as any,
      disconnectConnection: disconnectConnection as any,
      syncConnection: syncConnection as any,
      fetchFn: mock.fetchFn,
      now: () => 9,
    });
    expect(results).toEqual([
      { connectionId: 'jira_ok', outcome: 'reported' },
      { connectionId: 'jira_closed', outcome: 'erased' },
      { connectionId: 'jira_updated', outcome: 'refreshed' },
    ]);
    expect(mock.posts.map((post) => post.body.accounts[0])).toEqual([
      { accountId: 'acc-ok', updatedAt: '2026-10-09T08:00:00.000Z' },
      { accountId: 'acc-closed', updatedAt: '2026-10-09T08:00:00.000Z' },
      { accountId: 'acc-updated', updatedAt: '1970-01-01T00:00:00.005Z' },
    ]);
    expect(disconnectConnection.mock.calls).toEqual([['user_1', 'jira_closed']]);
    expect(syncConnection.mock.calls).toEqual([['user_1', 'jira_updated']]);
  });

  test('skips a connection with no working sign-in or no readable profile, and records a failure', async () => {
    const rows = [
      row('jira_expired'),
      row('jira_noprofile'),
      row('jira_down'),
      row('jira_new', { lastSyncOkAt: 0 }),
    ];
    const mock = atlassian(
      { 'tok-down': new Response('', { status: 500 }) },
      { 'tok-down': 'acc-down', 'tok-new': 'acc-new' },
    );
    const results = await reportAtlassianPersonalData('user_1', {
      listUserConnections: async () => rows,
      getConnectionToken: (async (_user: string, connectionId: string) =>
        connectionId === 'jira_expired'
          ? null
          : { row: rows[0], token: `tok-${connectionId.replace('jira_', '')}` }) as any,
      fetchFn: mock.fetchFn,
      now: () => 42,
    });
    expect(results).toEqual([
      { connectionId: 'jira_expired', outcome: 'skipped', detail: 'no working sign-in' },
      { connectionId: 'jira_noprofile', outcome: 'skipped', detail: 'profile not readable' },
      {
        connectionId: 'jira_down',
        outcome: 'failed',
        detail: 'Atlassian account report failed with HTTP 500',
      },
      { connectionId: 'jira_new', outcome: 'reported' },
    ]);
    // A connection with no sync time reports the time of this run.
    expect(mock.posts.at(-1)?.body.accounts[0].updatedAt).toBe('1970-01-01T00:00:00.042Z');
  });
});

describe('Atlassian privacy cron route', () => {
  function request(body: unknown) {
    return new NextRequest('http://localhost/api/cron/atlassian-privacy', {
      method: 'POST',
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  }

  test('runs the report for the user of an internal cron call', async () => {
    const report = mock_(async (_userId: string) => [{ connectionId: 'jira_1', outcome: 'reported' }]);
    const post = createAtlassianPrivacyPost({
      isInternalCronRequest: () => true,
      reportAtlassianPersonalData: report as any,
    });
    const response = await post(request({ userId: ' user_1 ' }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      userId: 'user_1',
      results: [{ connectionId: 'jira_1', outcome: 'reported' }],
    });
    expect(report.mock.calls).toEqual([['user_1']]);
  });

  test('refuses other callers, needs a user, and hides a failure', async () => {
    const failing = createAtlassianPrivacyPost({
      isInternalCronRequest: () => true,
      reportAtlassianPersonalData: async () => {
        throw new Error('private detail');
      },
    });
    expect((await failing(request({ userId: 'user_1' }))).status).toBe(500);
    expect(await (await failing(request({ userId: 'user_1' }))).json()).toEqual({
      ok: false,
      error: 'Report failed.',
    });
    expect((await failing(request('not json'))).status).toBe(400);
    const outside = createAtlassianPrivacyPost({
      isInternalCronRequest: () => false,
      reportAtlassianPersonalData: async () => [],
    });
    expect((await outside(request({ userId: 'user_1' }))).status).toBe(401);
  });
});

// bun:test's mock with a typed call list.
function mock_<T extends (...args: any[]) => any>(fn: T) {
  return mock(fn);
}
