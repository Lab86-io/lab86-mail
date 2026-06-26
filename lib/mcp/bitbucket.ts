import { buildAuthorizationHeader } from './auth';
import type { NormalizedMcpItem } from './servers';

const BITBUCKET_REQUEST_TIMEOUT_MS = 10_000;
const WORKSPACE_PAGE_SIZE = 12;
const PULL_REQUEST_PAGE_SIZE = 25;

interface BitbucketPage<T> {
  values?: T[];
  next?: string;
}

interface BitbucketUser {
  username?: string;
  display_name?: string;
  account_id?: string;
  uuid?: string;
}

interface BitbucketWorkspace {
  slug?: string;
  name?: string;
}

interface BitbucketPullRequest {
  id?: number;
  title?: string;
  state?: string;
  updated_on?: string;
  links?: { html?: { href?: string } };
  author?: { display_name?: string; nickname?: string; username?: string; account_id?: string };
  source?: {
    branch?: { name?: string };
    repository?: { full_name?: string; workspace?: { slug?: string } };
  };
  destination?: {
    branch?: { name?: string };
    repository?: { full_name?: string; workspace?: { slug?: string } };
  };
}

export interface BitbucketSyncResult {
  displayName?: string;
  items: NormalizedMcpItem[];
}

function apiUrl(baseUrl: string, pathOrUrl: string, params?: Record<string, string>) {
  const url = pathOrUrl.startsWith('http')
    ? new URL(pathOrUrl)
    : new URL(`${baseUrl.replace(/\/+$/u, '')}${pathOrUrl}`);
  for (const [key, value] of Object.entries(params ?? {})) {
    url.searchParams.set(key, value);
  }
  return url;
}

function parseTimestamp(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const time = Date.parse(value);
  return Number.isNaN(time) ? undefined : time;
}

function normalizeState(state: string | undefined) {
  switch (state?.trim().toUpperCase()) {
    case 'MERGED':
      return 'merged';
    case 'DECLINED':
    case 'SUPERSEDED':
      return 'closed';
    case 'OPEN':
      return 'open';
    default:
      return state?.trim().toLowerCase() || undefined;
  }
}

async function fetchJson<T>(
  baseUrl: string,
  token: string,
  operation: string,
  pathOrUrl: string,
  params?: Record<string, string>,
): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, BITBUCKET_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(apiUrl(baseUrl, pathOrUrl, params), {
      headers: {
        accept: 'application/json',
        authorization: buildAuthorizationHeader(token, 'basic-or-bearer'),
      },
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      const detail = body.trim() ? `: ${body.trim().slice(0, 500)}` : '';
      throw new Error(`Bitbucket ${operation} failed with HTTP ${response.status}${detail}`);
    }
    return (await response.json()) as T;
  } catch (err) {
    if (timedOut) {
      throw new Error(`Bitbucket ${operation} timed out after ${BITBUCKET_REQUEST_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchPagedValues<T>(
  baseUrl: string,
  token: string,
  operation: string,
  pathOrUrl: string,
  params?: Record<string, string>,
): Promise<T[]> {
  const values: T[] = [];
  let next: string | undefined = pathOrUrl;
  let nextParams: Record<string, string> | undefined = params;
  while (next) {
    const page: BitbucketPage<T> = await fetchJson(baseUrl, token, operation, next, nextParams);
    values.push(...(page.values || []));
    next = page.next;
    nextParams = undefined;
  }
  return values;
}

function selectedUser(user: BitbucketUser) {
  return user.account_id || user.username || user.uuid;
}

function normalizePullRequest(row: BitbucketPullRequest, workspace: string): NormalizedMcpItem | null {
  const title = row.title?.trim();
  const url = row.links?.html?.href?.trim();
  const repository =
    row.destination?.repository?.full_name?.trim() || row.source?.repository?.full_name?.trim() || workspace;
  const id = row.id !== undefined ? String(row.id) : url;
  if (!id || !title) return null;
  const state = normalizeState(row.state);
  const author =
    row.author?.display_name?.trim() ||
    row.author?.nickname?.trim() ||
    row.author?.username?.trim() ||
    row.author?.account_id?.trim();
  const sourceBranch = row.source?.branch?.name?.trim();
  const destinationBranch = row.destination?.branch?.name?.trim();
  const summary = [
    repository,
    sourceBranch && destinationBranch ? `${sourceBranch} -> ${destinationBranch}` : '',
  ]
    .filter(Boolean)
    .join(' - ');
  const externalId = url || `${repository}#${id}`;

  return {
    externalId,
    kind: 'pull_request',
    title,
    summary: summary || undefined,
    url,
    state,
    author,
    assignedToUser: true,
    updatedAtSource: parseTimestamp(row.updated_on),
    raw: row,
    searchText: [
      title,
      repository,
      state,
      author,
      sourceBranch,
      destinationBranch,
      'bitbucket',
      'pull request',
    ]
      .filter(Boolean)
      .join(' '),
  };
}

export async function loadBitbucketItems(baseUrl: string, token: string): Promise<BitbucketSyncResult> {
  const user = await fetchJson<BitbucketUser>(baseUrl, token, 'auth probe', '/user');
  const userSelector = selectedUser(user);
  if (!userSelector) throw new Error('Bitbucket auth succeeded, but the current user id was missing.');

  const workspaceRows = await fetchPagedValues<BitbucketWorkspace>(
    baseUrl,
    token,
    'list workspaces',
    '/user/workspaces',
    { pagelen: String(WORKSPACE_PAGE_SIZE) },
  );
  const workspaces = workspaceRows
    .map((workspace) => workspace.slug?.trim())
    .filter((slug): slug is string => Boolean(slug));

  const items: NormalizedMcpItem[] = [];
  for (const workspace of workspaces) {
    const rows = await fetchPagedValues<BitbucketPullRequest>(
      baseUrl,
      token,
      `list pull requests for ${workspace}`,
      `/workspaces/${encodeURIComponent(workspace)}/pullrequests/${encodeURIComponent(userSelector)}`,
      {
        pagelen: String(PULL_REQUEST_PAGE_SIZE),
        state: 'OPEN',
      },
    );
    for (const row of rows) {
      const item = normalizePullRequest(row, workspace);
      if (item) items.push(item);
    }
  }

  return {
    displayName: user.display_name || user.username || user.account_id,
    items,
  };
}
