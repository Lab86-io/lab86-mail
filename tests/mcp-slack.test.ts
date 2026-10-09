import { describe, expect, test } from 'bun:test';
import {
  loadSlackChangedMessages,
  loadSlackHistoryPage,
  loadSlackItems,
  normalizeSlackMatch,
  SLACK_CHANGE_PAGE_LIMIT,
  slackPlainText,
} from '../lib/mcp/slack';

const API = 'https://slack.com/api';
const NOW = Date.parse('2026-10-09T12:00:00.000Z');

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function match(ts: string, extra: Record<string, unknown> = {}) {
  return {
    ts,
    text: 'Can you review <https://acme.test/pr/1|the PR>, <@U1>?',
    permalink: `https://acme.slack.com/archives/C1/p${ts.replace('.', '')}`,
    team: 'T1',
    user: 'U2',
    username: 'jane',
    channel: { id: 'C1', name: 'eng' },
    ...extra,
  };
}

type Handler = (url: URL) => Response;

function slackFetch(handler: Handler) {
  const calls: URL[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(url);
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer xoxp-1');
    return handler(url);
  }) as typeof fetch;
  return { fetchFn, calls };
}

const auth = () => json({ ok: true, team: 'Acme', team_id: 'T1', user: 'jakob', user_id: 'U1' });

describe('Slack text and items', () => {
  test('turns Slack markup into plain text', () => {
    expect(
      slackPlainText(
        '<@U1|jakob> and <@U2> in <#C1|eng>: <!here> <!subteam^S1|@devs> see <https://a.test|docs> or <https://b.test> &amp; &lt;ok&gt;',
      ),
    ).toBe('@jakob and @U2 in #eng: @here @devs see docs or https://b.test & <ok>');
    expect(slackPlainText(undefined)).toBe('');
  });

  test('a match gets a stable id, its place, and the time from ts', () => {
    expect(
      normalizeSlackMatch(match('1760000000.000100'), { workspaceName: 'Acme', state: 'mentioned you' }),
    ).toMatchObject({
      externalId: 'slack:T1:C1:1760000000.000100',
      kind: 'message',
      title: '#eng · jane: Can you review the PR, @U1?',
      url: 'https://acme.slack.com/archives/C1/p1760000000000100',
      state: 'mentioned you',
      author: 'jane',
      organization: 'Acme',
      updatedAtSource: 1_760_000_000_000,
    });
    expect(
      normalizeSlackMatch(match('1.0', { channel: { id: 'D1', is_im: true }, team: undefined }), {
        teamId: 'T9',
      })?.externalId,
    ).toBe('slack:T9:D1:1.0');
    expect(
      normalizeSlackMatch(match('1.0', { channel: { id: 'G1', is_mpim: true } }), {})?.title,
    ).toStartWith('Group message');
    expect(normalizeSlackMatch(match('1.0', { text: '' }), {})).toBeNull();
    expect(normalizeSlackMatch(match('1.0', { channel: {} }), {})).toBeNull();
  });
});

describe('Slack sync', () => {
  test('reads recent mentions and direct messages and names the workspace', async () => {
    const mock = slackFetch((url) => {
      if (url.pathname === '/api/auth.test') return auth();
      const query = url.searchParams.get('query') || '';
      if (query.startsWith('<@U1>'))
        return json({ ok: true, messages: { matches: [match('1760000000.000100')] } });
      return json({
        ok: true,
        messages: {
          matches: [
            match('1760000000.000100'),
            match('1760000001.000200', { channel: { id: 'D1', is_im: true } }),
          ],
        },
      });
    });
    const result = await loadSlackItems(API, 'xoxp-1', NOW, mock.fetchFn);
    const searches = mock.calls.filter((url) => url.pathname === '/api/search.messages');
    expect(searches.map((url) => url.searchParams.get('query'))).toEqual([
      '<@U1> after:2026-09-25',
      'to:me after:2026-09-25',
    ]);
    expect(searches[0]?.searchParams.get('sort')).toBe('timestamp');
    expect(result.items.map((item) => item.state)).toEqual(['mentioned you', 'direct message']);
    expect(result).toMatchObject({ problems: [], workspaceName: 'Acme' });
  });

  test('keeps a partial sync, fails when both searches fail, and marks a revoked token', async () => {
    const partial = await loadSlackItems(
      API,
      'xoxp-1',
      NOW,
      slackFetch((url) => {
        if (url.pathname === '/api/auth.test') return auth();
        return (url.searchParams.get('query') || '').startsWith('to:me')
          ? new Response('slow down', { status: 429 })
          : json({ ok: true, messages: { matches: [match('1.0')] } });
      }).fetchFn,
    );
    expect(partial.items).toHaveLength(1);
    expect(partial.problems).toEqual(['Slack search hit a rate limit']);

    const failed = await loadSlackItems(
      API,
      'xoxp-1',
      NOW,
      slackFetch((url) =>
        url.pathname === '/api/auth.test' ? auth() : json({ ok: false, error: 'ratelimited' }),
      ).fetchFn,
    ).catch((error) => error);
    expect(failed.message).toBe('Slack search hit a rate limit');

    const revoked = await loadSlackItems(
      API,
      'xoxp-1',
      NOW,
      slackFetch(() => json({ ok: false, error: 'token_revoked' })).fetchFn,
    ).catch((error) => error);
    expect(revoked.message).toBe('Slack auth probe failed: token_revoked');
    expect(revoked.statusCode).toBe(401);

    const searchRevoked = await loadSlackItems(
      API,
      'xoxp-1',
      NOW,
      slackFetch((url) =>
        url.pathname === '/api/auth.test' ? auth() : json({ ok: false, error: 'missing_scope' }),
      ).fetchFn,
    ).catch((error) => error);
    expect(searchRevoked.statusCode).toBe(401);

    const other = await loadSlackItems(
      API,
      'xoxp-1',
      NOW,
      slackFetch((url) =>
        url.pathname === '/api/auth.test' ? auth() : json({ ok: false, error: 'internal_error' }),
      ).fetchFn,
    ).catch((error) => error);
    expect(other.statusCode).toBeUndefined();

    const http = await loadSlackItems(
      API,
      'xoxp-1',
      NOW,
      slackFetch(() => new Response('', { status: 401 })).fetchFn,
    ).catch((error) => error);
    expect(http.statusCode).toBe(401);
    const noUser = await loadSlackItems(
      API,
      'xoxp-1',
      NOW,
      slackFetch(() => json({ ok: true })).fetchFn,
    ).catch((error) => error);
    expect(noUser.message).toBe('Slack auth succeeded, but the user id was missing.');
  });
});

describe('Slack history walk', () => {
  test('pages each query over the last year and then ends', async () => {
    const mock = slackFetch((url) => {
      if (url.pathname === '/api/auth.test') return auth();
      const page = Number(url.searchParams.get('page'));
      const mention = (url.searchParams.get('query') || '').startsWith('<@U1>');
      return json({
        ok: true,
        messages: { matches: [match(`${page}.0`)], paging: { page, pages: mention ? 2 : 1 } },
      });
    });
    const first = await loadSlackHistoryPage(API, 'xoxp-1', { query: 0, page: 1 }, NOW, mock.fetchFn);
    expect(first.next).toEqual({ query: 0, page: 2 });
    expect(mock.calls.at(-1)?.searchParams.get('query')).toBe('<@U1> after:2025-10-09');
    expect(mock.calls.at(-1)?.searchParams.get('count')).toBe('100');
    const second = await loadSlackHistoryPage(API, 'xoxp-1', first.next!, NOW, mock.fetchFn);
    expect(second.next).toEqual({ query: 1, page: 1 });
    const last = await loadSlackHistoryPage(API, 'xoxp-1', second.next!, NOW, mock.fetchFn);
    expect(last.next).toBeUndefined();
    expect(await loadSlackHistoryPage(API, 'xoxp-1', { query: 5, page: 1 }, NOW, mock.fetchFn)).toEqual({
      items: [],
    });
  });

  test('a recheck keeps only messages newer than the last check', async () => {
    const since = Date.parse('2026-10-09T10:00:00.000Z');
    const mock = slackFetch((url) => {
      if (url.pathname === '/api/auth.test') return auth();
      return json({
        ok: true,
        messages: { matches: [match(String(since / 1000 - 60)), match(String(since / 1000 + 60))] },
      });
    });
    const changed = await loadSlackChangedMessages(API, 'xoxp-1', since, NOW, mock.fetchFn);
    expect(mock.calls[1]?.searchParams.get('query')).toBe('<@U1> after:2026-10-08');
    expect(mock.calls[1]?.searchParams.get('sort_dir')).toBe('asc');
    expect(changed.items.map((item) => item.updatedAtSource)).toEqual([since + 60_000]);
    expect(changed.resumeAt).toBeUndefined();
  });
});

describe('Slack change recheck pages', () => {
  const since = Date.parse('2026-10-09T10:00:00.000Z');
  const newer = (offset: number) => match(String(since / 1000 + offset));

  test('reads every page oldest first and keeps only the new messages', async () => {
    const pages: number[] = [];
    const mock = slackFetch((url) => {
      if (url.pathname === '/api/auth.test') return auth();
      const page = Number(url.searchParams.get('page'));
      if ((url.searchParams.get('query') || '').startsWith('to:me')) {
        return json({ ok: true, messages: { matches: [], paging: { page, pages: 1 } } });
      }
      pages.push(page);
      const matches = page === 1 ? [match(String(since / 1000 - 60)), newer(100)] : [newer(200), newer(300)];
      return json({ ok: true, messages: { matches, paging: { page, pages: 2 } } });
    });
    const changed = await loadSlackChangedMessages(API, 'xoxp-1', since, NOW, mock.fetchFn);
    expect(pages).toEqual([1, 2]);
    expect(changed.items).toHaveLength(3);
    expect(changed.resumeAt).toBeUndefined();
  });

  test('stops at the page limit', async () => {
    let mentionPages = 0;
    const mock = slackFetch((url) => {
      if (url.pathname === '/api/auth.test') return auth();
      const page = Number(url.searchParams.get('page'));
      if ((url.searchParams.get('query') || '').startsWith('<@U1>')) mentionPages += 1;
      return json({ ok: true, messages: { matches: [newer(1_000 - page)], paging: { page, pages: 50 } } });
    });
    const capped = await loadSlackChangedMessages(API, 'xoxp-1', since, NOW, mock.fetchFn);
    expect(mentionPages).toBe(SLACK_CHANGE_PAGE_LIMIT);
    // Pages remain, so the next recheck resumes after the newest message read.
    expect(capped.resumeAt).toBe(since + (1_000 - 1) * 1_000);

    // A capped read with no progress past the last check resumes at `now`.
    const old = slackFetch((url) => {
      if (url.pathname === '/api/auth.test') return auth();
      const page = Number(url.searchParams.get('page'));
      return json({
        ok: true,
        messages: { matches: [match(String(since / 1000 - 60))], paging: { page, pages: 50 } },
      });
    });
    expect((await loadSlackChangedMessages(API, 'xoxp-1', since, NOW, old.fetchFn)).resumeAt).toBe(NOW);
  });
});
