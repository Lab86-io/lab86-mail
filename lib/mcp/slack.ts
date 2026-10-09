// Slack messages through the Slack Web API with a user token (search:read),
// for a connection made with our Slack OAuth app. The token reads only what
// the signed-in member can see. Slack keeps MCP for Marketplace and internal
// apps, so an unlisted app uses search.messages.

import { truncateText } from '../shared/text';
import type { NormalizedMcpItem } from './servers';

const SLACK_REQUEST_TIMEOUT_MS = 15_000;
const RECENT_DAYS = 14;
/** The search history walk keeps to the last year of mentions and direct messages. */
export const SLACK_HISTORY_DAYS = 365;
/** The most search pages that one change recheck reads for each query (100 messages each). */
export const SLACK_CHANGE_PAGE_LIMIT = 10;
const DAY_MS = 86_400_000;

// Slack answers HTTP 200 with `ok: false`. These errors mean the sign-in no
// longer works, so the user must reconnect.
const SLACK_AUTH_ERRORS = new Set([
  'invalid_auth',
  'not_authed',
  'token_revoked',
  'token_expired',
  'account_inactive',
  'missing_scope',
  'no_permission',
  'user_removed_from_team',
  'team_access_not_granted',
]);

interface SlackAuthTest {
  ok?: boolean;
  team?: string;
  team_id?: string;
  user?: string;
  user_id?: string;
}

interface SlackMatch {
  iid?: string;
  ts?: string;
  text?: string;
  permalink?: string;
  team?: string;
  user?: string;
  username?: string;
  channel?: { id?: string; name?: string; is_im?: boolean; is_mpim?: boolean; is_private?: boolean };
}

interface SlackSearchResult {
  ok?: boolean;
  messages?: {
    matches?: SlackMatch[];
    paging?: { page?: number; pages?: number };
    pagination?: { page?: number; page_count?: number };
  };
}

export interface SlackSyncResult {
  items: NormalizedMcpItem[];
  problems: string[];
  workspaceName?: string;
}

/**
 * The new messages. `resumeAt` is set when the page limit ended the read
 * early: the next recheck starts there, so no later page is lost.
 */
export interface SlackChangedMessages {
  items: NormalizedMcpItem[];
  resumeAt?: number;
}

export interface SlackHistoryPosition {
  query: number;
  page: number;
}

type SlackQuery = { query: string; state: string };

function apiBase(baseUrl: string) {
  return (baseUrl || 'https://slack.com/api').replace(/\/+$/u, '');
}

async function slackGet<T extends { ok?: boolean }>(input: {
  baseUrl: string;
  token: string;
  method: string;
  params?: Record<string, string>;
  operation: string;
  fetchFn: typeof fetch;
}): Promise<T> {
  const url = new URL(`${apiBase(input.baseUrl)}/${input.method}`);
  for (const [key, value] of Object.entries(input.params || {})) url.searchParams.set(key, value);
  const response = await input.fetchFn(url.toString(), {
    headers: { accept: 'application/json', authorization: `Bearer ${input.token}` },
    cache: 'no-store',
    signal: AbortSignal.timeout(SLACK_REQUEST_TIMEOUT_MS),
  });
  if (response.status === 429) {
    throw new Error(`Slack ${input.operation} hit a rate limit`);
  }
  if (!response.ok) {
    throw Object.assign(new Error(`Slack ${input.operation} failed with HTTP ${response.status}`), {
      ...(response.status === 401 ? { statusCode: 401 } : {}),
    });
  }
  const body = (await response.json()) as T & { error?: string };
  if (body?.ok === false) {
    const reason = String(body.error || 'unknown_error');
    if (reason === 'ratelimited') throw new Error(`Slack ${input.operation} hit a rate limit`);
    throw Object.assign(
      new Error(`Slack ${input.operation} failed: ${reason}`),
      SLACK_AUTH_ERRORS.has(reason) ? { statusCode: 401 } : {},
    );
  }
  return body;
}

/** Slack message markup as plain text. */
export function slackPlainText(value: string | undefined): string {
  return (value || '')
    .replace(/<@([A-Z0-9]+)\|([^>]+)>/gu, '@$2')
    .replace(/<@([A-Z0-9]+)>/gu, '@$1')
    .replace(/<#[A-Z0-9]+\|([^>]*)>/gu, '#$1')
    .replace(/<!subteam\^[A-Z0-9]+\|([^>]+)>/gu, '$1')
    .replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/gu, '@$1')
    .replace(/<((?:https?|mailto):[^>|]+)\|([^>]+)>/gu, '$2')
    .replace(/<((?:https?|mailto):[^>]+)>/gu, '$1')
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&amp;/gu, '&')
    .trim();
}

export function normalizeSlackMatch(
  match: SlackMatch,
  options: { workspaceName?: string; teamId?: string; state?: string },
): NormalizedMcpItem | null {
  const channel = match.channel || {};
  const ts = match.ts?.trim();
  const text = slackPlainText(match.text);
  if (!ts || !channel.id || !text) return null;
  const where = channel.is_im
    ? 'Direct message'
    : channel.is_mpim
      ? 'Group message'
      : channel.name
        ? `#${channel.name}`
        : 'Slack';
  const author = match.username?.trim() || match.user?.trim() || undefined;
  const firstLine = text.split('\n')[0] || text;
  const seconds = Number(ts);
  return {
    externalId: `slack:${match.team || options.teamId || 'team'}:${channel.id}:${ts}`,
    kind: 'message',
    title: truncateText(`${where} · ${author ? `${author}: ` : ''}${firstLine}`, 160),
    summary: truncateText(text, 2_000),
    url: match.permalink,
    state: options.state,
    author,
    organization: options.workspaceName,
    updatedAtSource: Number.isFinite(seconds) ? Math.round(seconds * 1_000) : undefined,
    raw: {
      channel: channel.id,
      channelName: channel.name,
      ts,
      team: match.team || options.teamId,
      directMessage: Boolean(channel.is_im || channel.is_mpim),
    },
    searchText: [where, author, text, options.workspaceName, 'slack', options.state]
      .filter(Boolean)
      .join(' '),
  };
}

function isoDate(ms: number) {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Mentions of the user, and messages sent directly to the user. */
function directedQueries(userId: string, afterMs: number): SlackQuery[] {
  const after = `after:${isoDate(afterMs)}`;
  return [
    { query: `<@${userId}> ${after}`, state: 'mentioned you' },
    { query: `to:me ${after}`, state: 'direct message' },
  ];
}

async function authTest(baseUrl: string, token: string, fetchFn: typeof fetch) {
  const auth = await slackGet<SlackAuthTest>({
    baseUrl,
    token,
    method: 'auth.test',
    operation: 'auth probe',
    fetchFn,
  });
  if (!auth.user_id) {
    throw Object.assign(new Error('Slack auth succeeded, but the user id was missing.'), { statusCode: 401 });
  }
  return auth;
}

async function searchMessages(input: {
  baseUrl: string;
  token: string;
  query: SlackQuery;
  count: number;
  page?: number;
  /** Newest first by default; a change recheck reads oldest first. */
  sortDir?: 'asc' | 'desc';
  auth: SlackAuthTest;
  fetchFn: typeof fetch;
}) {
  const result = await slackGet<SlackSearchResult>({
    baseUrl: input.baseUrl,
    token: input.token,
    method: 'search.messages',
    params: {
      query: input.query.query,
      count: String(input.count),
      page: String(input.page || 1),
      sort: 'timestamp',
      sort_dir: input.sortDir || 'desc',
    },
    operation: 'search',
    fetchFn: input.fetchFn,
  });
  const items = (result.messages?.matches || [])
    .map((match) =>
      normalizeSlackMatch(match, {
        workspaceName: input.auth.team,
        teamId: input.auth.team_id,
        state: input.query.state,
      }),
    )
    .filter((item): item is NormalizedMcpItem => Boolean(item));
  const pages = Number(result.messages?.paging?.pages ?? result.messages?.pagination?.page_count ?? 1) || 1;
  return { items, pages };
}

function dedupe(items: NormalizedMcpItem[]) {
  const byId = new Map<string, NormalizedMcpItem>();
  for (const item of items) if (!byId.has(item.externalId)) byId.set(item.externalId, item);
  return [...byId.values()];
}

export async function loadSlackItems(
  baseUrl: string,
  token: string,
  now = Date.now(),
  fetchFn: typeof fetch = fetch,
): Promise<SlackSyncResult> {
  const auth = await authTest(baseUrl, token, fetchFn);
  const items: NormalizedMcpItem[] = [];
  const problems: string[] = [];
  let firstError: unknown;
  for (const query of directedQueries(auth.user_id!, now - RECENT_DAYS * DAY_MS)) {
    try {
      items.push(...(await searchMessages({ baseUrl, token, query, count: 50, auth, fetchFn })).items);
    } catch (error) {
      if ((error as { statusCode?: number })?.statusCode === 401) throw error;
      firstError ??= error;
      problems.push(truncateText(String((error as Error)?.message || 'Slack search failed'), 200));
    }
  }
  if (problems.length === 2 && firstError) throw firstError;
  return { items: dedupe(items), problems, workspaceName: auth.team?.trim() || undefined };
}

/** One page of the bounded history walk, and where the next page starts. */
export async function loadSlackHistoryPage(
  baseUrl: string,
  token: string,
  position: SlackHistoryPosition,
  now = Date.now(),
  fetchFn: typeof fetch = fetch,
): Promise<{ items: NormalizedMcpItem[]; next?: SlackHistoryPosition }> {
  const auth = await authTest(baseUrl, token, fetchFn);
  const queries = directedQueries(auth.user_id!, now - SLACK_HISTORY_DAYS * DAY_MS);
  const index = Math.max(0, Math.floor(position.query || 0));
  const query = queries[index];
  if (!query) return { items: [] };
  const page = Math.max(1, Math.floor(position.page || 1));
  const result = await searchMessages({ baseUrl, token, query, count: 100, page, auth, fetchFn });
  const next =
    page < result.pages && result.items.length
      ? { query: index, page: page + 1 }
      : index + 1 < queries.length
        ? { query: index + 1, page: 1 }
        : undefined;
  return { items: result.items, ...(next ? { next } : {}) };
}

/**
 * Mentions and direct messages newer than `sinceMs`. The read goes oldest
 * first, so a read that the page limit ends early can resume after the
 * newest message that it read.
 */
export async function loadSlackChangedMessages(
  baseUrl: string,
  token: string,
  sinceMs: number,
  now = Date.now(),
  fetchFn: typeof fetch = fetch,
): Promise<SlackChangedMessages> {
  const auth = await authTest(baseUrl, token, fetchFn);
  const items: NormalizedMcpItem[] = [];
  let resumeAt: number | undefined;
  // `after:` takes a day and excludes it, so search from the day before.
  for (const query of directedQueries(auth.user_id!, Math.min(now, sinceMs) - DAY_MS)) {
    let newest = sinceMs;
    let complete = false;
    for (let page = 1; page <= SLACK_CHANGE_PAGE_LIMIT; page += 1) {
      const result = await searchMessages({
        baseUrl,
        token,
        query,
        count: 100,
        page,
        sortDir: 'asc',
        auth,
        fetchFn,
      });
      for (const item of result.items) {
        newest = Math.max(newest, item.updatedAtSource ?? newest);
        if ((item.updatedAtSource ?? now) > sinceMs) items.push(item);
      }
      if (page >= result.pages || !result.items.length) {
        complete = true;
        break;
      }
    }
    if (!complete) {
      // Pages remain and none of them reached the last check. The error
      // keeps the saved cursor and shows a sync problem; no message is lost.
      if (newest <= sinceMs) {
        throw new Error(
          `Slack search read ${SLACK_CHANGE_PAGE_LIMIT} pages without reaching messages newer than the last check`,
        );
      }
      // Pages remain: resume after the newest message read.
      resumeAt = Math.min(resumeAt ?? now, newest);
    }
  }
  return { items: dedupe(items), ...(resumeAt !== undefined ? { resumeAt } : {}) };
}
