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
  // Only the assignee id: it marks issues assigned to the user. No name of
  // another person is read or kept (Atlassian personal data reporting).
  'assignee',
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
/** Every issue that changed on the site in the last two weeks. */
export const JIRA_SITE_WINDOW_JQL = 'updated >= -14d';
export const JIRA_SITE_RECENT_JQL = `${JIRA_SITE_WINDOW_JQL} ORDER BY updated DESC`;
/**
 * A Jira site is quiet when at most this many issues changed in two weeks.
 * On a quiet site (a small team), each change is relevant to the user, so the
 * newest changes also go in the index. On a larger site, the index keeps to
 * the issues that involve the user, and the live search reaches the rest.
 */
export const JIRA_QUIET_SITE_LIMIT = 300;
/** Every page that changed on the site in the last 30 days. */
export const CONFLUENCE_SITE_RECENT_CQL =
  'type = page AND lastmodified >= now("-30d") ORDER BY lastmodified DESC';
/** A Confluence site is quiet when at most this many pages changed in 30 days. */
export const CONFLUENCE_QUIET_SITE_LIMIT = 100;
const CONFLUENCE_PAGE_SIZE = 25;

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
    assignee?: { accountId?: string } | null;
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
  totalSize?: number;
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
    const status = { httpStatus: response.status };
    throw Object.assign(error, status, authStatus ? { statusCode: response.status } : {});
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

/** The number of issues that match a JQL, or infinity when Jira gives no count. */
async function countJiraIssues(input: {
  baseUrl: string;
  token: string;
  site: AtlassianSite;
  jql: string;
  fetchFn: typeof fetch;
}): Promise<number> {
  const body = await atlassianJson<{ count?: number }>({
    url: `${apiBase(input.baseUrl)}/ex/jira/${encodeURIComponent(input.site.id)}/rest/api/3/search/approximate-count`,
    token: input.token,
    operation: `Jira count on ${input.site.name}`,
    body: { jql: input.jql },
    fetchFn: input.fetchFn,
  });
  return typeof body?.count === 'number' ? body.count : Number.POSITIVE_INFINITY;
}

function normalizeJiraPage(
  page: JiraSearchPage,
  site: AtlassianSite,
  options: { assigned?: boolean; accountId?: string },
): NormalizedMcpItem[] {
  return (page.issues || [])
    .map((issue) => normalizeJiraIssue(issue, site, options))
    .filter((item): item is NormalizedMcpItem => Boolean(item));
}

async function searchConfluencePages(input: {
  baseUrl: string;
  token: string;
  site: AtlassianSite;
  cql: string;
  limit?: number;
  fetchFn: typeof fetch;
}): Promise<{ items: NormalizedMcpItem[]; total: number }> {
  const limit = input.limit ?? CONFLUENCE_PAGE_SIZE;
  const url = new URL(
    `${apiBase(input.baseUrl)}/ex/confluence/${encodeURIComponent(input.site.id)}/wiki/rest/api/search`,
  );
  url.searchParams.set('cql', input.cql);
  url.searchParams.set('limit', String(limit));
  const page = await atlassianJson<ConfluenceSearchPage>({
    url: url.toString(),
    token: input.token,
    operation: `Confluence search on ${input.site.name}`,
    fetchFn: input.fetchFn,
  });
  const results = page.results || [];
  const items = results
    .map((result) => normalizeConfluencePage(result, input.site, page._links?.base))
    .filter((item): item is NormalizedMcpItem => Boolean(item));
  // A full page with no total can hide more pages, so it counts as not quiet.
  const total =
    typeof page.totalSize === 'number'
      ? page.totalSize
      : results.length < limit
        ? results.length
        : Number.POSITIVE_INFINITY;
  return { items, total };
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
          return normalizeJiraPage(page, site, { assigned: query.assigned, accountId: me?.account_id });
        });
      }
      // A quiet site: the newest changes of the team also go in the index.
      // Without them, a user that no issue names gets an empty index.
      await run(async () => {
        const changed = await countJiraIssues({ baseUrl, token, site, jql: JIRA_SITE_WINDOW_JQL, fetchFn });
        if (changed > JIRA_QUIET_SITE_LIMIT) return [];
        const page = await searchJiraIssues({
          baseUrl,
          token,
          site,
          jql: JIRA_SITE_RECENT_JQL,
          maxResults: 50,
          fetchFn,
        });
        return normalizeJiraPage(page, site, { accountId: me?.account_id });
      });
    }
    if (hasScope(site, 'search:confluence')) {
      await run(
        async () =>
          (await searchConfluencePages({ baseUrl, token, site, cql: CONFLUENCE_RECENT_CQL, fetchFn })).items,
      );
      await run(async () => {
        const recent = await searchConfluencePages({
          baseUrl,
          token,
          site,
          cql: CONFLUENCE_SITE_RECENT_CQL,
          fetchFn,
        });
        return recent.total > CONFLUENCE_QUIET_SITE_LIMIT ? [] : recent.items;
      });
    }
  }
  if (attempted > 0 && succeeded === 0 && firstError) throw firstError;

  return {
    items: dedupe(items),
    problems,
    accountEmail: me?.email?.trim() || undefined,
    // Atlassian lists a site once for each product, so a name can repeat.
    workspaceName: [...new Set(sites.map((site) => site.name))].join(', '),
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
  const items = normalizeJiraPage(page, site, { accountId });
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
    if (!complete) {
      // Pages remain and none of them reached the last check. The error
      // keeps the saved cursor and shows a sync problem; no issue is lost.
      if (newest <= sinceMs) {
        throw new Error(
          `Jira search on ${site.name} read ${JIRA_CHANGE_PAGE_LIMIT} pages without reaching issues newer than the last check`,
        );
      }
      // Pages remain: resume after the newest issue read.
      resumeAt = Math.min(resumeAt ?? now, newest);
    }
  }
  return { items: dedupe(items), ...(resumeAt !== undefined ? { resumeAt } : {}) };
}

// --- Live reads for the assistant. Nothing here is stored. ---

const JIRA_KEY = /^[A-Za-z][A-Za-z0-9_]*-\d+$/u;
const JIRA_ISSUE_FIELDS = [...JIRA_FIELDS, 'created', 'labels', 'duedate', 'parent', 'subtasks'];
const JIRA_COMMENT_LIMIT = 10;

function quoted(value: string) {
  return `"${value.trim().replace(/\\/gu, '\\\\').replace(/"/gu, '\\"')}"`;
}

/** The JQL for plain words: one issue for an issue key, else a text match. */
export function jiraTextJql(query: string): string {
  const text = query.trim();
  if (JIRA_KEY.test(text)) return `key = ${quoted(text.toUpperCase())}`;
  return `text ~ ${quoted(text)} ORDER BY updated DESC`;
}

/** The CQL for plain words, over pages and blog posts. */
export function confluenceTextCql(query: string): string {
  return `siteSearch ~ ${quoted(query)} AND type in (page, blogpost)`;
}

export interface AtlassianLiveSource {
  site: string;
  product: 'jira' | 'confluence';
  ok: boolean;
  error?: string;
}

export interface AtlassianLiveSearch {
  items: NormalizedMcpItem[];
  /** One entry for each site product that the search read. */
  sources: AtlassianLiveSource[];
}

/**
 * A live search of every Jira issue and Confluence page that the user can
 * see. `jql` and `cql` are complete queries; `query` is plain words for both
 * products.
 */
export async function searchAtlassianLive(input: {
  baseUrl: string;
  token: string;
  query?: string;
  jql?: string;
  cql?: string;
  product?: 'jira' | 'confluence';
  limit: number;
  fetchFn?: typeof fetch;
}): Promise<AtlassianLiveSearch> {
  const { baseUrl, token } = input;
  const fetchFn = input.fetchFn || fetch;
  const text = input.query?.trim();
  const jql = input.product === 'confluence' ? '' : input.jql?.trim() || (text ? jiraTextJql(text) : '');
  const cql = input.product === 'jira' ? '' : input.cql?.trim() || (text ? confluenceTextCql(text) : '');
  const sites = await listAtlassianSites(baseUrl, token, fetchFn);
  const accountId = jql ? (await readProfile(baseUrl, token, fetchFn))?.account_id : undefined;

  const items: NormalizedMcpItem[] = [];
  const sources: AtlassianLiveSource[] = [];
  const read = async (
    site: AtlassianSite,
    product: AtlassianLiveSource['product'],
    task: () => Promise<NormalizedMcpItem[]>,
  ) => {
    try {
      items.push(...(await task()));
      sources.push({ site: site.name, product, ok: true });
    } catch (error) {
      if (isAuthFailure(error)) throw error;
      // A site without the product is not a failed search.
      if (isMissingProduct(error)) return;
      sources.push({
        site: site.name,
        product,
        ok: false,
        error: truncateText(String((error as Error)?.message || 'Atlassian search failed'), 300),
      });
    }
  };
  for (const site of sites) {
    if (jql && hasScope(site, 'read:jira-work')) {
      await read(site, 'jira', async () =>
        normalizeJiraPage(
          await searchJiraIssues({ baseUrl, token, site, jql, maxResults: input.limit, fetchFn }),
          site,
          { accountId },
        ),
      );
    }
    if (cql && hasScope(site, 'search:confluence')) {
      await read(
        site,
        'confluence',
        async () =>
          (await searchConfluencePages({ baseUrl, token, site, cql, limit: input.limit, fetchFn })).items,
      );
    }
  }
  return { items: dedupe(items), sources };
}

interface JiraIssueDetailFields {
  summary?: string;
  status?: { name?: string; statusCategory?: { key?: string } };
  updated?: string;
  created?: string;
  assignee?: { accountId?: string } | null;
  project?: { key?: string; name?: string };
  issuetype?: { name?: string };
  priority?: { name?: string } | null;
  description?: unknown;
  labels?: string[];
  duedate?: string | null;
  parent?: { key?: string; fields?: { summary?: string } };
  subtasks?: Array<{ key?: string; fields?: { summary?: string; status?: { name?: string } } }>;
}

interface JiraCommentPage {
  total?: number;
  comments?: Array<{ created?: string; author?: { accountId?: string }; body?: unknown }>;
}

export interface JiraIssueDetail {
  site: string;
  key: string;
  title: string;
  url: string;
  state?: string;
  statusCategory?: string;
  project?: string;
  issueType?: string;
  priority?: string;
  /** An issue can have an assignee that is not the user. No name is read. */
  hasAssignee: boolean;
  assignedToUser: boolean;
  labels: string[];
  due?: string;
  createdAt?: number;
  updatedAt?: number;
  parent?: { key: string; title?: string };
  subtasks: Array<{ key: string; title?: string; state?: string }>;
  description: string;
  /** The newest comments, oldest first. `fromUser` marks the user's own. */
  comments: Array<{ createdAt?: number; fromUser: boolean; text: string }>;
  commentTotal: number;
  /** The comments did not load; the rest of the issue did. */
  commentsUnavailable?: boolean;
}

/**
 * One Jira issue with its description and newest comments, live. Returns null
 * when no connected site has the issue. No name of another person is read.
 */
export async function readJiraIssue(input: {
  baseUrl: string;
  token: string;
  key: string;
  /** The site of an issue link, to read that site first. */
  siteUrl?: string;
  fetchFn?: typeof fetch;
}): Promise<JiraIssueDetail | null> {
  const { baseUrl, token } = input;
  const fetchFn = input.fetchFn || fetch;
  const key = input.key.trim().toUpperCase();
  if (!JIRA_KEY.test(key)) return null;
  const all = jiraSites(await listAtlassianSites(baseUrl, token, fetchFn));
  const wanted = input.siteUrl ? all.filter((site) => siteBase(site) === input.siteUrl) : [];
  const sites = wanted.length ? wanted : all;
  const accountId = sites.length ? (await readProfile(baseUrl, token, fetchFn))?.account_id : undefined;
  for (const site of sites) {
    const issueUrl = `${apiBase(baseUrl)}/ex/jira/${encodeURIComponent(site.id)}/rest/api/3/issue/${encodeURIComponent(key)}`;
    let issue: { key?: string; fields?: JiraIssueDetailFields };
    try {
      issue = await atlassianJson({
        url: `${issueUrl}?fields=${JIRA_ISSUE_FIELDS.join(',')}`,
        token,
        operation: `Jira issue read on ${site.name}`,
        fetchFn,
      });
    } catch (error) {
      // This site does not have the issue: try the next site.
      if (isMissingProduct(error)) continue;
      throw error;
    }
    const fields = issue.fields || {};
    const comments = await atlassianJson<JiraCommentPage>({
      url: `${issueUrl}/comment?orderBy=-created&maxResults=${JIRA_COMMENT_LIMIT}`,
      token,
      operation: `Jira comment read on ${site.name}`,
      fetchFn,
    }).catch((error) => {
      if (isAuthFailure(error)) throw error;
      return null;
    });
    const issueKey = issue.key?.trim() || key;
    return {
      site: site.name,
      key: issueKey,
      title: fields.summary?.trim() || issueKey,
      url: `${siteBase(site)}/browse/${issueKey}`,
      state: fields.status?.name?.trim() || undefined,
      statusCategory: fields.status?.statusCategory?.key,
      project: fields.project?.name?.trim() || fields.project?.key?.trim() || undefined,
      issueType: fields.issuetype?.name?.trim() || undefined,
      priority: fields.priority?.name?.trim() || undefined,
      hasAssignee: Boolean(fields.assignee?.accountId),
      assignedToUser: Boolean(accountId && fields.assignee?.accountId === accountId),
      labels: (fields.labels || []).filter((label) => typeof label === 'string'),
      due: fields.duedate || undefined,
      createdAt: parseTimestamp(fields.created),
      updatedAt: parseTimestamp(fields.updated),
      ...(fields.parent?.key
        ? { parent: { key: fields.parent.key, title: fields.parent.fields?.summary?.trim() || undefined } }
        : {}),
      subtasks: (fields.subtasks || [])
        .filter(
          (subtask): subtask is { key: string; fields?: { summary?: string; status?: { name?: string } } } =>
            Boolean(subtask?.key),
        )
        .map((subtask) => ({
          key: subtask.key,
          title: subtask.fields?.summary?.trim() || undefined,
          state: subtask.fields?.status?.name?.trim() || undefined,
        })),
      description: atlassianDocumentText(fields.description, 6_000),
      comments: (comments?.comments || [])
        .map((comment) => ({
          createdAt: parseTimestamp(comment.created),
          fromUser: Boolean(accountId && comment.author?.accountId === accountId),
          text: atlassianDocumentText(comment.body, 1_500),
        }))
        .filter((comment) => comment.text)
        .reverse(),
      commentTotal: typeof comments?.total === 'number' ? comments.total : 0,
      ...(comments ? {} : { commentsUnavailable: true }),
    };
  }
  return null;
}
