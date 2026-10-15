// Web search and page reads through Browserbase (docs/albatross-goal-runs.md G5).
//
// A page read asks Fetch for markdown first. Fetch answers 400 when it cannot
// convert the body (a PDF, a Word file), so the read then asks for the raw
// bytes and gets the text on our server: PDF text with pdfjs-dist, Office text
// from the document XML. Our server sends no request to the site itself.

import { extractContent } from '../content/extract';
import { isPrivateHost } from '../shared/private-host';
import { truncateText } from '../shared/text';
import {
  type BrowserbaseCallOptions,
  BrowserbaseRequestError,
  type BrowserbaseSearchResult,
  browserbaseFetch,
  browserbaseSearch,
} from './browserbase-client';

/** The most page text one read gives the model. */
export const PAGE_READ_MAX_CHARS = 80_000;

export class WebUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebUrlError';
  }
}

/**
 * A public http or https address: no user name or password in it, no private,
 * loopback, or single-label host. The fragment goes; it never reaches a site.
 */
export function publicWebUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(String(raw || '').trim());
  } catch {
    throw new WebUrlError('Use a full http or https address.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    throw new WebUrlError('Only http and https addresses are allowed.');
  if (url.username || url.password)
    throw new WebUrlError('An address with a user name or password is not allowed.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isPrivateHost(host) || (!host.includes('.') && !host.includes(':')))
    throw new WebUrlError('This address is on a private network. Only public sites are allowed.');
  url.hash = '';
  return url;
}

/** The host without a leading www, for display and for site matches. */
export function displayHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

const defaults = {
  fetch: (input: Parameters<typeof browserbaseFetch>[0], options?: BrowserbaseCallOptions) =>
    browserbaseFetch(input, options),
  search: (input: Parameters<typeof browserbaseSearch>[0], options?: BrowserbaseCallOptions) =>
    browserbaseSearch(input, options),
  extract: extractContent,
};
let deps = defaults;
export function __setWebReadDepsForTest(overrides: Partial<typeof defaults> = {}) {
  deps = { ...defaults, ...overrides };
}

export interface WebSearchHit {
  title: string;
  url: string;
  publishedDate?: string;
  author?: string;
}

/** Titles, addresses, and dates. Search gives no page text: read a page before a claim. */
export async function searchWeb(
  query: string,
  limit = 10,
  options?: BrowserbaseCallOptions,
): Promise<WebSearchHit[]> {
  const rows: BrowserbaseSearchResult[] = await deps.search({ query, numResults: limit }, options);
  return rows.slice(0, limit).map((row) => ({
    title: String(row.title || displayHost(row.url) || row.url),
    url: row.url,
    ...(row.publishedDate ? { publishedDate: String(row.publishedDate) } : {}),
    ...(row.author ? { author: String(row.author) } : {}),
  }));
}

/**
 * A JSON answer through Fetch raw (a small public API, for example the
 * Nominatim reverse geocode). Throws on a site error or bad JSON.
 */
export async function readJson(rawUrl: string, options: BrowserbaseCallOptions = {}): Promise<any> {
  const url = publicWebUrl(rawUrl);
  const answer = await deps.fetch({ url: url.toString(), format: 'raw' }, options);
  if (answer.statusCode >= 400) throw new Error(`GET ${url.toString()} failed (${answer.statusCode})`);
  return JSON.parse(new TextDecoder().decode(decodeBody(answer)));
}

export interface PageRead {
  url: string;
  content: string;
  contentType: string;
  /** The site's status when it is an error (404, 403). */
  status?: number;
  truncated?: boolean;
}

const OFFICE_TYPES = /openxmlformats-officedocument/;
const TEXT_TYPES = /^text\/|json|xml|csv/;

function startsWith(bytes: Uint8Array, signature: number[]) {
  return signature.every((byte, index) => bytes[index] === byte);
}

function decodeBody(result: { content: string; encoding?: string }): Uint8Array {
  return result.encoding === 'base64'
    ? new Uint8Array(Buffer.from(result.content, 'base64'))
    : new TextEncoder().encode(result.content);
}

function fileNameOf(url: URL) {
  const last = url.pathname.split('/').filter(Boolean).pop() || '';
  try {
    return decodeURIComponent(last);
  } catch {
    // A bad percent escape: keep the raw name, as file-pull.ts does.
    return last;
  }
}

function cut(text: string, maxChars: number): { content: string; truncated?: true } {
  const clean = text.trim();
  if (clean.length <= maxChars) return { content: clean };
  return { content: truncateText(clean, maxChars), truncated: true };
}

/**
 * The text of one page or file. Markdown for a web page; for a PDF or an
 * Office file, the raw bytes through Fetch and the text from them.
 */
export async function readPage(
  rawUrl: string,
  options: BrowserbaseCallOptions & { maxChars?: number } = {},
): Promise<PageRead> {
  const url = publicWebUrl(rawUrl);
  const maxChars = options.maxChars ?? PAGE_READ_MAX_CHARS;
  try {
    const page = await deps.fetch({ url: url.toString(), format: 'markdown' }, options);
    return {
      url: url.toString(),
      contentType: page.contentType || 'text/markdown',
      ...(page.statusCode >= 400 ? { status: page.statusCode } : {}),
      ...cut(page.content, maxChars),
    };
  } catch (error) {
    // 400: Fetch could not turn the body into markdown. Any other error stays.
    if (!(error instanceof BrowserbaseRequestError) || error.status !== 400) throw error;
  }
  let raw: Awaited<ReturnType<typeof deps.fetch>>;
  try {
    raw = await deps.fetch({ url: url.toString(), format: 'raw' }, options);
  } catch (error) {
    if (error instanceof BrowserbaseRequestError && error.status === 502)
      throw new Error('The file is larger than the 5 MB read limit.');
    throw error;
  }
  const bytes = decodeBody(raw);
  const name = fileNameOf(url);
  const type = raw.contentType || 'application/octet-stream';
  const status = raw.statusCode >= 400 ? { status: raw.statusCode } : {};
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d]) || /pdf/.test(type)) {
    const { text, partial } = await deps.extract(bytes, 'application/pdf', name || 'file.pdf');
    const read = cut(text, maxChars);
    if (!read.content.replace(/\[Page \d+\]/g, '').trim())
      throw new Error('This PDF has no text that can be read (it is probably a scan).');
    return {
      url: url.toString(),
      contentType: 'application/pdf',
      ...status,
      ...read,
      ...(partial ? { truncated: true } : {}),
    };
  }
  if (OFFICE_TYPES.test(type) || /\.(docx|xlsx|pptx)$/i.test(name)) {
    const { text, partial } = await deps.extract(bytes, type, name);
    return {
      url: url.toString(),
      contentType: type,
      ...status,
      ...cut(text, maxChars),
      ...(partial ? { truncated: true } : {}),
    };
  }
  if (TEXT_TYPES.test(type)) {
    return {
      url: url.toString(),
      contentType: type,
      ...status,
      ...cut(new TextDecoder().decode(bytes), maxChars),
    };
  }
  throw new Error(`This address gives a ${type} file, not text. Save it with web_file_save.`);
}
