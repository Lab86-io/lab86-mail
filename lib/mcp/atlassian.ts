// Jira issues and Confluence pages through the Atlassian REST API, for a
// connection made with our Atlassian OAuth (3LO) app. One sign-in can cover
// several sites; each site lists the scopes that the user granted to it.

import { truncateText } from '../shared/text';
import type { NormalizedMcpItem } from './servers';

const ATLASSIAN_REQUEST_TIMEOUT_MS = 15_000;
const JIRA_FIELDS = [
  'summary',
  'status',
  'updated',
  'assignee',
  'reporter',
  'project',
  'issuetype',
  'priority',
  'description',
];

/** Open issues assigned to the user: the core of the Brief. */
export const JIRA_ASSIGNED_JQL = 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC';
/** Issues the user reported or watches that changed in the last two weeks. */
export const JIRA_INVOLVED_JQL =
  '(reporter = currentUser() OR watcher = currentUser()) AND updated >= -14d ORDER BY updated DESC';
/**
 * The search history walk takes only the issues that involve the user in the
 * last year. A whole-site walk can reach hundreds of thousands of issues.
 */
export const JIRA_HISTORY_JQL =
  '(assignee = currentUser() OR assignee was currentUser() OR reporter = currentUser() OR watcher = currentUser()) AND updated >= -365d ORDER BY updated DESC';
/** The most Jira pages that one change recheck reads on a site (100 issues each). */
export const JIRA_CHANGE_PAGE_LIMIT = 10;
export const CONFLUENCE_RECENT_CQL =
  'type = page AND (contributor = currentUser() OR mention = currentUser()) AND lastmodified >= now("-30d") ORDER BY lastmodified DESC';

export interface AtlassianSite {
  id: string;
  url: string;
  name: string;
  scopes?: string[];
}

interface AtlassianMe {
  account_id?: string;
  email?: string;
  name?: string;
}

interface JiraIssue {
  id?: string;
  key?: string;
  fields?: {
    summary?: string;
    status?: { name?: string; statusCategory?: { key?: string } };
    updated?: string;
    assignee?: { accountId?: string; displayName?: string } | null;
    reporter?: { displayName?: string } | null;
    project?: { key?: string; name?: string };
    issuetype?: { name?: string };
    priority?: { name?: string } | null;
    description?: unknown;
  };
}

interface JiraSearchPage {
  issues?: JiraIssue[];
  nextPageToken?: string;
  isLast?: boolean;
}

interface ConfluenceSearchResult {
  content?: { id?: string; type?: string; title?: string; _links?: { webui?: string } };
  title?: string;
  excerpt?: string;
  url?: string;
  lastModified?: string;
  resultGlobalContainer?: { title?: string };
}

interface ConfluenceSearchPage {
  results?: ConfluenceSearchResult[];
  _links?: { base?: string };
}

export interface AtlassianSyncResult {
  items: NormalizedMcpItem[];
  /** Part of the sync failed, but at least one query worked. */
  problems: string[];
  accountEmail?: string;
  workspaceName?: string;
}

/**
 * The changed issues. `resumeAt` is set when the page limit ended the read
 * early: the next recheck starts there, so no later page is lost.
 */
export interface AtlassianChangedIssues {
  items: NormalizedMcpItem[];
  resumeAt?: number;
}

export interface AtlassianHistoryPosition {
  site: number;
  token?: string;
}

function apiBase(baseUrl: string) {
  return (baseUrl || 'https://api.atlassian.com').replace(/\/+$/u, '');
}

function siteBase(site: AtlassianSite) {
  return site.url.replace(/\/+$/u, '');
}

function parseTimestamp(value: unknown) {
  if (typeof value !== 'string') return undefined;
  const time = Date.parse(value);
  return Number.isNaN(time) ? undefined : time;
}

async function atlassianJson<T>(input: {
  url: string;
  token: string;
  operation: string;
  body?: unknown;
  fetchFn: typeof fetch;
}): Promise<T> {
  const response = await input.fetchFn(input.url, {
    method: input.body === undefined ? 'GET' : 'POST',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${input.token}`,
      ...(input.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
    cache: 'no-store',
    signal: AbortSignal.timeout(ATLASSIAN_REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    const detail = text.trim() ? `: ${truncateText(text.trim(), 300)}` : '';
    const error = new Error(`Atlassian ${input.operation} failed with HTTP ${response.status}${detail}`);
    // A 401 anywhere means the sign-in no longer works. Other statuses on a
    // later call are sync problems; the sign-in probe owns the rest.
    const authStatus = response.status === 401 || input.operation === 'auth probe';
    throw Object.assign(
      error,
      { httpStatus: response.status },
      authStatus ? { statusCode: response.status } : {},
    );
  }
  return (await response.json()) as T;
}

/** The plain text of an Atlassian document (ADF) or a v2 string description. */
export function atlassianDocumentText(value: unknown, max = 2_000): string {
  if (typeof value === 'string') return truncateText(value.trim(), max);
  const parts: string[] = [];
  let length = 0;
  const visit = (node: any) => {
    if (!node || typeof node !== 'object' || length > max) return;
    if (node.type === 'text' && typeof node.text === 'string') {
      parts.push(node.text);
      length += node.text.length;
    } else if (node.type === 'hardBreak') {
      parts.push('\n');
    }
    if (Array.isArray(node.content)) for (const child of node.content) visit(child);
    if (['paragraph', 'heading', 'listItem', 'blockquote', 'codeBlock'].includes(node.type)) parts.push('\n');
  };
  visit(value);
  return truncateText(
    parts
      .join('')
      .replace(/\n{3,}/gu, '\n\n')
      .trim(),
    max,
  );
}

export function normalizeJiraIssue(
  issue: JiraIssue,
  site: AtlassianSite,
  options: { assigned?: boolean; accountId?: string } = {},
): NormalizedMcpItem | null {
  const fields = issue.fields || {};
  const key = issue.key?.trim();
  if (!issue.id || !key) return null;
  const summaryText = fields.summary?.trim();
  const title = summaryText ? `${key}: ${summaryText}` : key;
  const project = fields.project?.name?.trim() || fields.project?.key?.trim();
  const issueType = fields.issuetype?.name?.trim();
  const priority = fields.priority?.name?.trim();
  const state = fields.status?.name?.trim() || undefined;
  const description = atlassianDocumentText(fields.description, 1_500);
  const facts = [project, issueType, priority ? `${priority} priority` : ''].filter(Boolean).join(' · ');
  const summary = [facts, description].filter(Boolean).join('\n') || undefined;
  const assignedToUser =
    options.assigned === true ||
    Boolean(options.accountId && fields.assignee?.accountId === options.accountId);
  return {
    externalId: `jira:${site.id}:${issue.id}`,
    kind: 'ticket',
    title,
    summary,
    url: `${siteBase(site)}/browse/${key}`,
    state,
    author: fields.reporter?.displayName?.trim() || undefined,
    organization: site.name,
    assignedToUser,
    updatedAtSource: parseTimestamp(fields.updated),
    raw: {
      key,
      site: siteBase(site),
      project: fields.project?.key,
      status: state,
      statusCategory: fields.status?.statusCategory?.key,
      issueType,
      priority,
      assignee: fields.assignee?.displayName,
    },
    searchText: [key, summaryText, project, state, issueType, priority, site.name, 'jira', description]
      .filter(Boolean)
      .join(' '),
  };
}

function stripHighlights(value: string | undefined) {
  return (value || '')
    .replace(/@@@(?:end)?hl@@@/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

export function normalizeConfluencePage(
  result: ConfluenceSearchResult,
  site: AtlassianSite,
  wikiBase?: string,
): NormalizedMcpItem | null {
  const content = result.content || {};
  const id = content.id?.trim();
  const title = stripHighlights(content.title || result.title);
  if (!id || !title) return null;
  const path = content._links?.webui || result.url;
  const base = (wikiBase || `${siteBase(site)}/wiki`).replace(/\/+$/u, '');
  const url = path
    ? /^https?:\/\//u.test(path)
      ? path
      : `${base}${path.startsWith('/') ? '' : '/'}${path}`
    : undefined;
  const space = result.resultGlobalContainer?.title?.trim();
  const excerpt = stripHighlights(result.excerpt);
  return {
    externalId: `confluence:${site.id}:${id}`,
    kind: 'page',
    title,
    summary: [space ? `${space} space` : '', excerpt].filter(Boolean).join(' · ') || undefined,
    url,
    organization: site.name,
    updatedAtSource: parseTimestamp(result.lastModified),
    raw: { id, site: siteBase(site), space, type: content.type },
    searchText: [title, space, excerpt, site.name, 'confluence', 'page'].filter(Boolean).join(' '),
  };
}

export async function listAtlassianSites(
  baseUrl: string,
  token: string,
  fetchFn: typeof fetch = fetch,
): Promise<AtlassianSite[]> {
  const rows = await atlassianJson<AtlassianSite[]>({
    url: `${apiBase(baseUrl)}/oauth/token/accessible-resources`,
    token,
    operation: 'auth probe',
    fetchFn,
  });
  const sites = (Array.isArray(rows) ? rows : []).filter(
    (site): site is AtlassianSite =>
      typeof site?.id === 'string' && typeof site.url === 'string' && Boolean(site.id && site.url),
  );
  if (!sites.length) {
    // The grant reaches no site, so a sync can never work: ask for a new sign-in.
    throw Object.assign(new Error('The Atlassian sign-in has no site access. Reconnect and choose a site.'), {
      statusCode: 403,
    });
  }
  return sites.map((site) => ({ ...site, name: site.name?.trim() || new URL(site.url).hostname }));
}

function hasScope(site: AtlassianSite, scope: string) {
  return Array.isArray(site.scopes) && site.scopes.includes(scope);
}

export async function searchJiraIssues(input: {
  baseUrl: string;
  token: string;
  site: AtlassianSite;
  jql: string;
  maxResults: number;
  nextPageToken?: string;
  fetchFn?: typeof fetch;
}): Promise<JiraSearchPage> {
  return atlassianJson<JiraSearchPage>({
    url: `${apiBase(input.baseUrl)}/ex/jira/${encodeURIComponent(input.site.id)}/rest/api/3/search/jql`,
    token: input.token,
    operation: `Jira search on ${input.site.name}`,
    body: {
      jql: input.jql,
      maxResults: input.maxResults,
      fields: JIRA_FIELDS,
      ...(input.nextPageToken ? { nextPageToken: input.nextPageToken } : {}),
    },
    fetchFn: input.fetchFn || fetch,
  });
}

async function searchConfluencePages(input: {
  baseUrl: string;
  token: string;
  site: AtlassianSite;
  fetchFn: typeof fetch;
}): Promise<NormalizedMcpItem[]> {
  const url = new URL(
    `${apiBase(input.baseUrl)}/ex/confluence/${encodeURIComponent(input.site.id)}/wiki/rest/api/search`,
  );
  url.searchParams.set('cql', CONFLUENCE_RECENT_CQL);
  url.searchParams.set('limit', '25');
  const page = await atlassianJson<ConfluenceSearchPage>({
    url: url.toString(),
    token: input.token,
    operation: `Confluence search on ${input.site.name}`,
    fetchFn: input.fetchFn,
  });
  return (page.results || [])
    .map((result) => normalizeConfluencePage(result, input.site, page._links?.base))
    .filter((item): item is NormalizedMcpItem => Boolean(item));
}

function isAuthFailure(error: unknown) {
  return (error as { statusCode?: number })?.statusCode === 401;
}

/** A site without the product answers 404; that is not a sync problem. */
function isMissingProduct(error: unknown) {
  return (error as { httpStatus?: number })?.httpStatus === 404;
}

function dedupe(items: NormalizedMcpItem[]) {
  const byId = new Map<string, NormalizedMcpItem>();
  for (const item of items) if (!byId.has(item.externalId)) byId.set(item.externalId, item);
  return [...byId.values()];
}

/** The signed-in Atlassian account, or null when the profile is not readable. */
async function readProfile(baseUrl: string, token: string, fetchFn: typeof fetch) {
  return atlassianJson<AtlassianMe>({
    url: `${apiBase(baseUrl)}/me`,
    token,
    operation: 'profile',
    fetchFn,
  }).catch((error) => {
    if (isAuthFailure(error)) throw error;
    return null;
  });
}

export async function loadAtlassianItems(
  baseUrl: string,
  token: string,
  fetchFn: typeof fetch = fetch,
): Promise<AtlassianSyncResult> {
  const sites = await listAtlassianSites(baseUrl, token, fetchFn);
  const me = await readProfile(baseUrl, token, fetchFn);

  const items: NormalizedMcpItem[] = [];
  const problems: string[] = [];
  let firstError: unknown;
  let attempted = 0;
  let succeeded = 0;
  const run = async (task: () => Promise<NormalizedMcpItem[]>) => {
    attempted += 1;
    try {
      items.push(...(await task()));
      succeeded += 1;
    } catch (error) {
      if (isAuthFailure(error)) throw error;
      if (isMissingProduct(error)) {
        attempted -= 1;
        return;
      }
      firstError ??= error;
      problems.push(truncateText(String((error as Error)?.message || 'Atlassian query failed'), 200));
    }
  };

  for (const site of sites) {
    if (hasScope(site, 'read:jira-work')) {
      for (const query of [
        { jql: JIRA_ASSIGNED_JQL, assigned: true, maxResults: 50 },
        { jql: JIRA_INVOLVED_JQL, assigned: false, maxResults: 30 },
      ]) {
        await run(async () => {
          const page = await searchJiraIssues({ baseUrl, token, site, ...query, fetchFn });
          return (page.issues || [])
            .map((issue) =>
              normalizeJiraIssue(issue, site, { assigned: query.assigned, accountId: me?.account_id }),
            )
            .filter((item): item is NormalizedMcpItem => Boolean(item));
        });
      }
    }
    if (hasScope(site, 'search:confluence')) {
      await run(() => searchConfluencePages({ baseUrl, token, site, fetchFn }));
    }
  }
  if (attempted > 0 && succeeded === 0 && firstError) throw firstError;

  return {
    items: dedupe(items),
    problems,
    accountEmail: me?.email?.trim() || undefined,
    workspaceName: sites.map((site) => site.name).join(', '),
  };
}

function jiraSites(sites: AtlassianSite[]) {
  return sites.filter((site) => hasScope(site, 'read:jira-work'));
}

/** One page of the bounded Jira history walk, and where the next page starts. */
export async function loadAtlassianHistoryPage(
  baseUrl: string,
  token: string,
  position: AtlassianHistoryPosition,
  fetchFn: typeof fetch = fetch,
): Promise<{ items: NormalizedMcpItem[]; next?: AtlassianHistoryPosition }> {
  const sites = jiraSites(await listAtlassianSites(baseUrl, token, fetchFn));
  const index = Math.max(0, Math.floor(position.site || 0));
  const site = sites[index];
  if (!site) return { items: [] };
  // The walk sets `assignedToUser` from the account, so it never clears the
  // flag that the main sync set on an assigned issue.
  const accountId = (await readProfile(baseUrl, token, fetchFn))?.account_id;
  const page = await searchJiraIssues({
    baseUrl,
    token,
    site,
    jql: JIRA_HISTORY_JQL,
    maxResults: 100,
    nextPageToken: position.token,
    fetchFn,
  });
  const items = (page.issues || [])
    .map((issue) => normalizeJiraIssue(issue, site, { accountId }))
    .filter((item): item is NormalizedMcpItem => Boolean(item));
  // A repeated token would walk the same page forever. The error keeps the
  // saved cursor, so the next pass tries the same page again.
  if (page.nextPageToken && page.isLast !== true && page.nextPageToken === position.token) {
    throw new Error(`Jira search on ${site.name} returned the same page token again`);
  }
  const next =
    page.nextPageToken && page.isLast !== true
      ? { site: index, token: page.nextPageToken }
      : index + 1 < sites.length
        ? { site: index + 1 }
        : undefined;
  return { items, ...(next ? { next } : {}) };
}

/**
 * The issues that involve the user and changed since `sinceMs`, on every site.
 * The read goes oldest first, so a read that the page limit ends early can
 * resume after the newest issue that it read.
 */
export async function loadAtlassianChangedIssues(
  baseUrl: string,
  token: string,
  sinceMs: number,
  now = Date.now(),
  fetchFn: typeof fetch = fetch,
): Promise<AtlassianChangedIssues> {
  const minutes = Math.max(1, Math.ceil((now - sinceMs) / 60_000));
  const jql = JIRA_HISTORY_JQL.replace('updated >= -365d', `updated >= -${minutes}m`).replace(
    'ORDER BY updated DESC',
    'ORDER BY updated ASC',
  );
  const items: NormalizedMcpItem[] = [];
  let resumeAt: number | undefined;
  const sites = jiraSites(await listAtlassianSites(baseUrl, token, fetchFn));
  const accountId = sites.length ? (await readProfile(baseUrl, token, fetchFn))?.account_id : undefined;
  for (const site of sites) {
    // Read every page of the change window, up to the page limit.
    const requested = new Set<string>();
    let nextPageToken: string | undefined;
    let newest = sinceMs;
    let complete = false;
    for (let pageNumber = 0; pageNumber < JIRA_CHANGE_PAGE_LIMIT; pageNumber += 1) {
      const page = await searchJiraIssues({
        baseUrl,
        token,
        site,
        jql,
        maxResults: 100,
        nextPageToken,
        fetchFn,
      });
      for (const issue of page.issues || []) {
        const item = normalizeJiraIssue(issue, site, { accountId });
        if (!item) continue;
        items.push(item);
        newest = Math.max(newest, item.updatedAtSource ?? newest);
      }
      if (!page.nextPageToken || page.isLast === true) {
        complete = true;
        break;
      }
      if (requested.has(page.nextPageToken)) {
        throw new Error(`Jira search on ${site.name} returned the same page token again`);
      }
      requested.add(page.nextPageToken);
      nextPageToken = page.nextPageToken;
    }
    // Pages remain: resume after the newest issue read. A read with no
    // progress at all takes `now`, so it cannot repeat the same pages.
    if (!complete) resumeAt = Math.min(resumeAt ?? now, newest > sinceMs ? newest : now);
  }
  return { items: dedupe(items), ...(resumeAt !== undefined ? { resumeAt } : {}) };
}
