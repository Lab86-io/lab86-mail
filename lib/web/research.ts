// web_research (docs/albatross-goal-runs.md G5): searches in parallel, reads
// the best pages in parallel, and gives numbered sources with short passages.
//
// Each page is read with Fetch first. A page that needs JavaScript, or that
// gives an error to Fetch, is read in one short session. A page on one of
// the given sites that shows a sign-in wall is read in a session with the
// user's saved sign-ins, read only. Everything goes through Browserbase.
//
// Cost bounds: at most 6 searches (plus one for each of 2 sites), 6 pages,
// 3 of them in a browser (at most 2 sessions), and about 60 seconds.

import { truncateText } from '../shared/text';
import { BrowserbaseRequestError } from './browserbase-client';
import { displayHost, publicWebUrl, readPage, searchWeb, type WebSearchHit } from './read';
import { savedSignInContextId, withShortSession } from './session';

export const RESEARCH_LIMITS = {
  maxQueries: 6,
  maxSites: 6,
  siteSearches: 2,
  resultsPerQuery: 8,
  maxPages: 6,
  maxBrowserPages: 3,
  pageTimeoutMs: 20_000,
  totalMs: 60_000,
  pageChars: 40_000,
  passageChars: 700,
} as const;

export interface ResearchSource {
  n: number;
  title: string;
  url: string;
  passage: string;
  signedIn?: true;
}

export interface ResearchResult {
  ok: true;
  sources: ResearchSource[];
  failed: string[];
}

export interface ResearchInput {
  question: string;
  queries: string[];
  sites?: string[];
  /** The user whose saved sign-ins a signed-in site reads. */
  userId?: string | null;
  signal?: AbortSignal;
}

const STOP_WORDS = new Set(
  'the and for with that this from what when where which who how are was were has have had does did not you your our their them they its can will would should could into about than then there here also only more most some any all per via use used using form forms page'.split(
    ' ',
  ),
);

const WALLED = /(^|\.)(facebook|instagram|tiktok|linkedin|x|twitter|pinterest)\.com$/;
const JS_SHELL =
  /enable javascript|javascript is (disabled|required)|please turn on javascript|you need to enable javascript/i;
const SIGN_IN_WALL = /\b(sign in|log in|login)\b.{0,80}\b(continue|password|account)\b/i;

/** A host from "irs.gov", "https://www.irs.gov/forms", or "www.irs.gov". */
export function siteHost(raw: string): string {
  const text = String(raw || '')
    .trim()
    .toLowerCase();
  if (!text) return '';
  try {
    return new URL(text.includes('://') ? text : `https://${text}`).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function onSite(url: string, sites: readonly string[]): boolean {
  const host = displayHost(url);
  return sites.some((site) => host === site || host.endsWith(`.${site}`));
}

function urlKey(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    return `${parsed.hostname.replace(/^www\./, '')}${parsed.pathname.replace(/\/$/, '')}${parsed.search}`;
  } catch {
    return url;
  }
}

/** The words that make a passage relevant. */
export function researchTerms(question: string, queries: readonly string[]): string[] {
  const words = `${question} ${queries.join(' ')}`
    .toLowerCase()
    .split(/[^a-z0-9$%.-]+/)
    .map((word) => word.replace(/^[.-]+|[.-]+$/g, ''))
    .filter((word) => (word.length >= 3 || /\d/.test(word)) && !STOP_WORDS.has(word));
  return [...new Set(words)].slice(0, 40);
}

function plainText(markdown: string): string {
  return markdown
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/^[#>*\-\s|]+/gm, '')
    .replace(/[ \t]+/g, ' ');
}

/**
 * Up to two short passages of a page, the ones that hold the most terms, in
 * page order. With no match, the first real paragraph.
 */
export function pickPassage(
  text: string,
  terms: readonly string[],
  maxChars: number = RESEARCH_LIMITS.passageChars,
) {
  const blocks: string[] = [];
  for (const paragraph of plainText(text).split(/\n\s*\n|\n(?=\S)/)) {
    const clean = paragraph.replace(/\s+/g, ' ').trim();
    if (clean.length < 40) continue;
    if (clean.length <= 450) {
      blocks.push(clean);
      continue;
    }
    // A long paragraph becomes sentence groups of at most about 450 characters.
    let group = '';
    for (const sentence of clean.match(/[^.!?]+(?:[.!?]+|$)/g) || [clean]) {
      if (group && group.length + sentence.length > 450) {
        blocks.push(group.trim());
        group = '';
      }
      group += sentence;
    }
    if (group.trim()) blocks.push(group.trim());
    if (blocks.length > 400) break;
  }
  if (!blocks.length) return '';
  const scored = blocks.map((block, index) => {
    const lower = block.toLowerCase();
    return { block, index, score: terms.filter((term) => lower.includes(term)).length };
  });
  const best = scored
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, 2)
    .sort((a, b) => a.index - b.index);
  const chosen = best.length
    ? best.map((entry) => entry.block)
    : [blocks.find((block) => block.length >= 80) || blocks[0]];
  return truncateText(chosen.join(' … '), maxChars);
}

interface Candidate {
  hit: WebSearchHit;
  site: boolean;
}

interface PageText {
  title: string;
  text: string;
  signedIn?: true;
}

function thinPage(content: string) {
  const text = plainText(content).replace(/\s+/g, ' ').trim();
  return text.length < 400 || JS_SHELL.test(truncateText(text, 2_000));
}

function reason(error: unknown): string {
  if ((error as Error)?.name === 'TimeoutError' || (error as Error)?.name === 'AbortError')
    return 'no answer in time';
  if (error instanceof BrowserbaseRequestError) return `the reader answered ${error.status}`;
  return truncateText(String((error as Error)?.message || 'the read failed').split('\n')[0], 120);
}

const defaults = {
  searchWeb,
  readPage,
  withShortSession,
  savedContextId: savedSignInContextId,
};
let deps = defaults;
export function __setWebResearchDepsForTest(overrides: Partial<typeof defaults> = {}) {
  deps = { ...defaults, ...overrides };
}

async function readInBrowser(
  urls: string[],
  contextId: string | null,
  signal: AbortSignal,
  pages: Map<string, PageText>,
  failed: Map<string, string>,
) {
  if (!urls.length) return;
  try {
    await deps.withShortSession({ contextId, timeoutSeconds: 90, signal }, async (page) => {
      for (const url of urls) {
        if (signal.aborted) {
          failed.set(url, 'no answer in time');
          continue;
        }
        try {
          const opened = await page.open(url);
          if (opened.kind === 'download') {
            failed.set(url, 'it is a file; save it with web_file_save');
            continue;
          }
          const [title, text] = await Promise.all([page.title().catch(() => ''), page.text()]);
          if (!text.trim()) failed.set(url, 'the page has no text');
          else
            pages.set(url, {
              title,
              text: truncateText(text, RESEARCH_LIMITS.pageChars),
              ...(contextId ? { signedIn: true as const } : {}),
            });
        } catch (error) {
          failed.set(url, reason(error));
        }
      }
    });
  } catch (error) {
    for (const url of urls) if (!pages.has(url) && !failed.has(url)) failed.set(url, reason(error));
  }
}

export async function runWebResearch(input: ResearchInput): Promise<ResearchResult> {
  const deadline = AbortSignal.timeout(RESEARCH_LIMITS.totalMs);
  const signal = input.signal ? AbortSignal.any([input.signal, deadline]) : deadline;
  const queries = [...new Set(input.queries.map((query) => query.trim()).filter(Boolean))].slice(
    0,
    RESEARCH_LIMITS.maxQueries,
  );
  const sites = [...new Set((input.sites || []).map(siteHost).filter(Boolean))].slice(
    0,
    RESEARCH_LIMITS.maxSites,
  );
  const failed = new Map<string, string>();
  const searches = [
    ...queries,
    ...sites
      .slice(0, RESEARCH_LIMITS.siteSearches)
      .map((site) => `${queries[0] || input.question} site:${site}`),
  ];

  // 1. Searches in parallel. One that fails does not stop the others.
  const settled = await Promise.allSettled(
    searches.map((query) => deps.searchWeb(query, RESEARCH_LIMITS.resultsPerQuery, { signal })),
  );
  const lists: WebSearchHit[][] = settled.map((result, index) => {
    if (result.status === 'fulfilled') return result.value;
    failed.set(`search "${truncateText(searches[index], 60)}"`, reason(result.reason));
    return [];
  });

  // 2. Merge round robin (each search's best first), one entry for each page.
  const seen = new Set<string>();
  const merged: Candidate[] = [];
  for (let rank = 0; rank < RESEARCH_LIMITS.resultsPerQuery; rank += 1) {
    for (const list of lists) {
      const hit = list[rank];
      if (!hit?.url) continue;
      try {
        publicWebUrl(hit.url);
      } catch {
        continue;
      }
      const key = urlKey(hit.url);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push({ hit, site: onSite(hit.url, sites) });
    }
  }
  const ordered = [
    ...merged.filter((entry) => entry.site),
    ...merged.filter((entry) => !entry.site && !WALLED.test(displayHost(entry.hit.url))),
    ...merged.filter((entry) => !entry.site && WALLED.test(displayHost(entry.hit.url))),
  ].slice(0, RESEARCH_LIMITS.maxPages);

  // 3. Fetch reads in parallel, each with its own time limit.
  const pages = new Map<string, PageText>();
  const browserPlain: string[] = [];
  const browserSignedIn: string[] = [];
  await Promise.all(
    ordered.map(async ({ hit, site }) => {
      try {
        const page = await deps.readPage(hit.url, {
          maxChars: RESEARCH_LIMITS.pageChars,
          signal: AbortSignal.any([signal, AbortSignal.timeout(RESEARCH_LIMITS.pageTimeoutMs)]),
        });
        const walled =
          page.status === 401 || page.status === 403 || SIGN_IN_WALL.test(truncateText(page.content, 3_000));
        if (site && walled) browserSignedIn.push(hit.url);
        else if (page.status && page.status >= 400) failed.set(hit.url, `the site answered ${page.status}`);
        else if (thinPage(page.content)) browserPlain.push(hit.url);
        else pages.set(hit.url, { title: hit.title, text: page.content });
      } catch (error) {
        if (signal.aborted) failed.set(hit.url, 'no answer in time');
        else if (error instanceof BrowserbaseRequestError && error.status !== 400)
          (site ? browserSignedIn : browserPlain).push(hit.url);
        else failed.set(hit.url, reason(error));
      }
    }),
  );

  // 4. Pages that need a browser: one session each for plain and signed-in reads.
  const contextId =
    browserSignedIn.length && input.userId ? await deps.savedContextId(input.userId).catch(() => null) : null;
  const signedInUrls = (contextId ? browserSignedIn : []).slice(0, RESEARCH_LIMITS.maxBrowserPages);
  const plainUrls = [...(contextId ? [] : browserSignedIn), ...browserPlain].slice(
    0,
    RESEARCH_LIMITS.maxBrowserPages - signedInUrls.length,
  );
  for (const url of [...browserSignedIn, ...browserPlain])
    if (!signedInUrls.includes(url) && !plainUrls.includes(url))
      failed.set(url, 'over the browser page limit');
  await Promise.all([
    readInBrowser(signedInUrls, contextId, signal, pages, failed),
    readInBrowser(plainUrls, null, signal, pages, failed),
  ]);

  // 5. Numbered sources in rank order, each with its best passages.
  const terms = researchTerms(input.question, queries);
  const sources: ResearchSource[] = [];
  for (const { hit } of ordered) {
    const page = pages.get(hit.url);
    if (!page) continue;
    const passage = pickPassage(page.text, terms);
    if (!passage) {
      failed.set(hit.url, 'the page has no text');
      continue;
    }
    sources.push({
      n: sources.length + 1,
      title: truncateText((page.title || hit.title || displayHost(hit.url)).replace(/\s+/g, ' ').trim(), 160),
      url: hit.url,
      passage,
      ...(page.signedIn ? { signedIn: true as const } : {}),
    });
  }
  return {
    ok: true,
    sources,
    failed: [...failed.entries()].map(([what, why]) => `${what}: ${why}`).slice(0, 12),
  };
}
