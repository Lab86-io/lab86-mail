import type { NormalizedMcpItem } from './servers';

interface GitHubUser {
  login: string;
}

interface GitHubRepository {
  full_name: string;
  owner?: { login?: string };
}

interface GitHubIssueLike {
  id?: number | string;
  number?: number;
  title?: string;
  body?: string | null;
  html_url?: string;
  repository_url?: string;
  state?: string;
  updated_at?: string;
  user?: { login?: string };
  assignees?: Array<{ login?: string }>;
  merged_at?: string | null;
  pull_request?: { merged_at?: string | null } | unknown;
  base?: { repo?: { full_name?: string } };
}

interface GitHubCommitLike {
  sha?: string;
  html_url?: string;
  repository?: { full_name?: string };
  author?: { login?: string } | null;
  commit?: {
    message?: string;
    author?: { name?: string; date?: string | null } | null;
    committer?: { date?: string | null } | null;
  };
}

interface GitHubProjectLike {
  id?: string;
  number?: number;
  title?: string;
  shortDescription?: string | null;
  url?: string;
  closed?: boolean;
  updatedAt?: string;
  owner?: { login?: string } | null;
}

interface GitHubProjectItemLike {
  id?: string;
  type?: string;
  updatedAt?: string;
  content?: {
    __typename?: string;
    id?: string;
    number?: number;
    title?: string;
    body?: string | null;
    url?: string;
    state?: string;
    updatedAt?: string;
    repository?: { nameWithOwner?: string } | null;
  } | null;
}

interface GitHubProjectsResponse {
  data?: {
    user?: { projectsV2?: { nodes?: GitHubProjectLike[] } } | null;
    viewer?: {
      organizations?: {
        nodes?: Array<{ login?: string; projectsV2?: { nodes?: GitHubProjectLike[] } }>;
      };
    };
    node?: { items?: { nodes?: GitHubProjectItemLike[] } } | null;
  };
  errors?: Array<{ message?: string }>;
}

const DEEP_REPOSITORY_LIMIT = 25;
const GITHUB_ITEM_LIMIT = 5_000;
const REPOSITORY_HISTORY_DAYS = 365;
const OPTIONAL_GITHUB_STATUSES = new Set([403, 404, 409, 422]);

function timestamp(value: string | null | undefined) {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function repositoryFromUrl(url?: string) {
  const match = url?.match(/\/repos\/([^/]+\/[^/]+)(?:\/|$)/);
  return match?.[1];
}

function compactSummary(value: string | null | undefined, max = 1_200) {
  const clean = String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
  return clean ? clean.slice(0, max) : undefined;
}

export function normalizeGitHubIssue(
  row: GitHubIssueLike,
  viewerLogin: string,
  forcedKind?: 'issue' | 'pull_request',
  forcedState?: string,
): NormalizedMcpItem | null {
  const kind = forcedKind || (row.pull_request ? 'pull_request' : 'issue');
  const repository =
    repositoryFromUrl(row.repository_url) || row.base?.repo?.full_name || repositoryFromUrl(row.html_url);
  const number = row.number ?? row.id;
  const title = compactSummary(row.title, 500);
  if (!number || !title) return null;
  const externalId = `github:${kind}:${repository || 'unknown'}#${number}`;
  const organization = repository?.split('/')[0];
  const author = row.user?.login;
  const summary = compactSummary(row.body);
  const pullRequest = row.pull_request as { merged_at?: string | null } | undefined;
  const state =
    forcedState ||
    (kind === 'pull_request' && (row.merged_at || pullRequest?.merged_at) ? 'merged' : row.state);
  return {
    externalId,
    kind,
    title,
    summary,
    url: row.html_url,
    state,
    author,
    repository,
    organization,
    assignedToUser: row.assignees?.some((assignee) => assignee.login === viewerLogin),
    updatedAtSource: timestamp(row.updated_at),
    searchText: [title, summary, kind, repository, organization, author, state].filter(Boolean).join(' '),
  };
}

export function normalizeGitHubCommit(
  row: GitHubCommitLike,
  repositoryHint?: string,
): NormalizedMcpItem | null {
  const sha = row.sha;
  const repository = row.repository?.full_name || repositoryHint;
  const rawMessage = row.commit?.message?.trim();
  const message = compactSummary(rawMessage, 2_000);
  const title = compactSummary(rawMessage?.split(/\r?\n/, 1)[0], 500);
  if (!sha || !title) return null;
  const organization = repository?.split('/')[0];
  const author = row.author?.login || row.commit?.author?.name;
  return {
    externalId: `github:commit:${repository || 'unknown'}:${sha}`,
    kind: 'commit',
    title,
    summary: message,
    url: row.html_url,
    state: 'committed',
    author,
    repository,
    organization,
    sha,
    updatedAtSource: timestamp(row.commit?.committer?.date || row.commit?.author?.date),
    searchText: [title, message, 'commit', repository, organization, author, sha].filter(Boolean).join(' '),
  };
}

export function normalizeGitHubProject(row: GitHubProjectLike): NormalizedMcpItem | null {
  if (!row.id || !row.title) return null;
  const organization = row.owner?.login;
  const summary = compactSummary(row.shortDescription);
  return {
    externalId: `github:project:${row.id}`,
    kind: 'project',
    title: row.title.slice(0, 500),
    summary,
    url: row.url,
    state: row.closed ? 'closed' : 'open',
    organization,
    updatedAtSource: timestamp(row.updatedAt),
    searchText: [row.title, summary, 'project', organization, row.closed ? 'closed' : 'open']
      .filter(Boolean)
      .join(' '),
  };
}

export function normalizeGitHubProjectItem(
  row: GitHubProjectItemLike,
  project: GitHubProjectLike,
): NormalizedMcpItem | null {
  const content = row.content;
  const title = compactSummary(content?.title, 500);
  if (!row.id || !title || !project.id) return null;
  const repository = content?.repository?.nameWithOwner;
  const organization = repository?.split('/')[0] || project.owner?.login;
  const summary = compactSummary(content?.body);
  return {
    externalId: `github:project_item:${project.id}:${row.id}`,
    kind: 'project_item',
    title,
    summary,
    url: content?.url || project.url,
    state: content?.state || row.type?.toLowerCase(),
    repository,
    organization,
    parentExternalId: `github:project:${project.id}`,
    updatedAtSource: timestamp(content?.updatedAt || row.updatedAt),
    searchText: [title, summary, 'project item', project.title, repository, organization, content?.state]
      .filter(Boolean)
      .join(' '),
  };
}

class GitHubApiError extends Error {
  statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = 'GitHubApiError';
    this.statusCode = statusCode;
  }
}

async function githubJson<T>(
  token: string,
  path: string,
  baseUrl: string,
  fetchImpl: typeof fetch,
  init: RequestInit = {},
): Promise<T> {
  const target = path.startsWith('http') ? path : `${baseUrl.replace(/\/$/, '')}${path}`;
  const response = await fetchImpl(target, {
    ...init,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'Lab86-Albatross',
      ...(init.headers || {}),
    },
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new GitHubApiError(`GitHub ${response.status}: ${detail.slice(0, 180)}`, response.status);
  }
  return (await response.json()) as T;
}

async function optional<T>(task: Promise<T>, fallback: T): Promise<T> {
  try {
    return await task;
  } catch (error) {
    const status = Number((error as { statusCode?: number }).statusCode);
    const message = String((error as { message?: string }).message || '');
    const isRateLimit = /rate limit|secondary rate|abuse detection/i.test(message);
    if (!OPTIONAL_GITHUB_STATUSES.has(status) || isRateLimit) throw error;
    return fallback;
  }
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(values[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

export function rankGitHubItems(items: NormalizedMcpItem[], limit = GITHUB_ITEM_LIMIT): NormalizedMcpItem[] {
  return [...new Map(items.map((item) => [item.externalId, item])).values()]
    .sort((left, right) => (right.updatedAtSource ?? 0) - (left.updatedAtSource ?? 0))
    .slice(0, Math.max(0, limit));
}

function githubEndpoints(configuredBaseUrl: string) {
  const rest = String(configuredBaseUrl || 'https://api.github.com').replace(/\/$/, '');
  const graphql = /\/api\/v3$/i.test(rest) ? rest.replace(/\/api\/v3$/i, '/api/graphql') : `${rest}/graphql`;
  return { rest, graphql };
}

const PROJECTS_QUERY = `
query AlbatrossProjects($login: String!) {
  user(login: $login) {
    projectsV2(first: 50, orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes { id number title shortDescription url closed updatedAt owner { ... on User { login } ... on Organization { login } } }
    }
  }
  viewer {
    organizations(first: 20) {
      nodes {
        login
        projectsV2(first: 50, orderBy: {field: UPDATED_AT, direction: DESC}) {
          nodes { id number title shortDescription url closed updatedAt owner { ... on User { login } ... on Organization { login } } }
        }
      }
    }
  }
}`;

const PROJECT_ITEMS_QUERY = `
query AlbatrossProjectItems($id: ID!) {
  node(id: $id) {
    ... on ProjectV2 {
      items(first: 100) {
        nodes {
          id type updatedAt
          content {
            __typename
            ... on Issue { id number title body url state updatedAt repository { nameWithOwner } }
            ... on PullRequest { id number title body url state updatedAt repository { nameWithOwner } }
            ... on DraftIssue { id title body updatedAt }
          }
        }
      }
    }
  }
}`;

async function graphql(
  token: string,
  query: string,
  variables: Record<string, unknown>,
  graphqlUrl: string,
  fetchImpl: typeof fetch,
) {
  const result = await githubJson<GitHubProjectsResponse>(token, graphqlUrl, '', fetchImpl, {
    method: 'POST',
    body: JSON.stringify({ query, variables }),
  });
  if (result.errors?.length) {
    throw new GitHubApiError(
      result.errors
        .map((error) => error.message)
        .filter(Boolean)
        .join('; '),
      422,
    );
  }
  return result;
}

export async function loadGitHubItems(
  baseUrl: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ items: NormalizedMcpItem[]; viewer: string }> {
  const endpoints = githubEndpoints(baseUrl);
  const viewer = await githubJson<GitHubUser>(token, '/user', endpoints.rest, fetchImpl);
  if (!viewer.login) throw new GitHubApiError('GitHub did not return the authenticated user.', 401);

  const issueQueries: Array<{
    query: string;
    kind: 'issue' | 'pull_request';
    state?: string;
  }> = [
    { query: 'involves:@me is:issue', kind: 'issue' as const },
    { query: 'author:@me is:pr', kind: 'pull_request' as const },
    { query: 'reviewed-by:@me is:pr', kind: 'pull_request' as const },
    { query: 'review-requested:@me is:open is:pr', kind: 'pull_request' as const },
    { query: 'involves:@me is:merged is:pr', kind: 'pull_request' as const, state: 'merged' },
  ];
  const issueResults = await Promise.all(
    issueQueries.map(({ query }) =>
      optional(
        githubJson<{ items?: GitHubIssueLike[] }>(
          token,
          `/search/issues?q=${encodeURIComponent(query)}&sort=updated&order=desc&per_page=100`,
          endpoints.rest,
          fetchImpl,
        ),
        { items: [] },
      ),
    ),
  );

  const repositories = await optional(
    githubJson<GitHubRepository[]>(
      token,
      '/user/repos?affiliation=owner,collaborator,organization_member&sort=pushed&direction=desc&per_page=100',
      endpoints.rest,
      fetchImpl,
    ),
    [],
  );
  const since = new Date(Date.now() - REPOSITORY_HISTORY_DAYS * 86_400_000).toISOString();
  const repositoryResults = await mapWithConcurrency(
    repositories.slice(0, DEEP_REPOSITORY_LIMIT),
    6,
    async (repository) => {
      const encodedRepository = repository.full_name.split('/').map(encodeURIComponent).join('/');
      const [issues, pulls, commits] = await Promise.all([
        optional(
          githubJson<GitHubIssueLike[]>(
            token,
            `/repos/${encodedRepository}/issues?state=all&sort=updated&direction=desc&per_page=100`,
            endpoints.rest,
            fetchImpl,
          ),
          [],
        ),
        optional(
          githubJson<GitHubIssueLike[]>(
            token,
            `/repos/${encodedRepository}/pulls?state=all&sort=updated&direction=desc&per_page=100`,
            endpoints.rest,
            fetchImpl,
          ),
          [],
        ),
        optional(
          githubJson<GitHubCommitLike[]>(
            token,
            `/repos/${encodedRepository}/commits?since=${encodeURIComponent(since)}&per_page=100`,
            endpoints.rest,
            fetchImpl,
          ),
          [],
        ),
      ]);
      return { repository: repository.full_name, issues, pulls, commits };
    },
  );

  const authoredCommits = await optional(
    githubJson<{ items?: GitHubCommitLike[] }>(
      token,
      `/search/commits?q=${encodeURIComponent(`author:${viewer.login}`)}&sort=author-date&order=desc&per_page=100`,
      endpoints.rest,
      fetchImpl,
    ),
    { items: [] },
  );

  const projectsResponse = await optional(
    graphql(token, PROJECTS_QUERY, { login: viewer.login }, endpoints.graphql, fetchImpl),
    {} as GitHubProjectsResponse,
  );
  const projectRows = [
    ...(projectsResponse.data?.user?.projectsV2?.nodes || []),
    ...(projectsResponse.data?.viewer?.organizations?.nodes || []).flatMap(
      (organization) => organization.projectsV2?.nodes || [],
    ),
  ];
  const projects = [...new Map(projectRows.filter((row) => row?.id).map((row) => [row.id, row])).values()];
  const projectItems = await mapWithConcurrency(projects.slice(0, 25), 6, async (project) => ({
    project,
    rows:
      (
        await optional(
          graphql(token, PROJECT_ITEMS_QUERY, { id: project.id }, endpoints.graphql, fetchImpl),
          {} as GitHubProjectsResponse,
        )
      ).data?.node?.items?.nodes || [],
  }));

  const items: NormalizedMcpItem[] = [];
  for (const result of repositoryResults) {
    for (const row of result.issues) {
      if (row.pull_request) continue;
      const item = normalizeGitHubIssue(row, viewer.login, 'issue');
      if (item) items.push(item);
    }
    for (const row of result.pulls) {
      const item = normalizeGitHubIssue(row, viewer.login, 'pull_request');
      if (item) items.push(item);
    }
    for (const row of result.commits) {
      const item = normalizeGitHubCommit(row, result.repository);
      if (item) items.push(item);
    }
  }
  issueResults.forEach((result, index) => {
    for (const row of result.items || []) {
      const query = issueQueries[index];
      const item = normalizeGitHubIssue(row, viewer.login, query.kind, query.state);
      if (item) items.push(item);
    }
  });
  for (const row of authoredCommits.items || []) {
    const item = normalizeGitHubCommit(row);
    if (item) items.push(item);
  }
  for (const project of projects) {
    const item = normalizeGitHubProject(project);
    if (item) items.push(item);
  }
  for (const result of projectItems) {
    for (const row of result.rows) {
      const item = normalizeGitHubProjectItem(row, result.project);
      if (item) items.push(item);
    }
  }
  return { items: rankGitHubItems(items), viewer: viewer.login };
}
