// File pull: a file from the web into Files, through Browserbase only
// (docs/research/browserbase-auth-files-2026-10-15.md sections 5.5 and 5.6).
//
// Tier 1: Fetch with `format: "raw"` (a public file up to 5 MB, about 1.3 s).
// Tier 2: a short session with no saved sign-ins. The browser downloads the
//         file and the Downloads API gives the bytes (up to 25 MB).
// Tier 3: the same, with the user's saved sign-ins, read only. When the site
//         shows the file in the page, an in-page fetch() reads it on that site.
// Our server never requests the file itself, and never uses
// `context.request.get()` (it runs from our server's address).
//
// Each file: max 25 MB; PDF, DOCX, XLSX, PPTX, CSV, PNG, or JPEG; the first
// bytes must agree with the type; private hosts are refused.

import { createHash } from 'node:crypto';
import { type SavedFile, savedFileName, saveFileBytes } from '../files/saved-files';
import { type BrowserbaseCallOptions, BrowserbaseRequestError, browserbaseFetch } from './browserbase-client';
import { publicWebUrl, WebUrlError } from './read';
import {
  collectDownload,
  DownloadError,
  deleteSessionDownloads,
  type InPageFile,
  savedSignInContextId,
  sessionDownloadIds,
  withShortSession,
} from './session';

export const WEB_FILE_MAX_BYTES = 25 * 1024 * 1024;
/** Fetch gives at most 5 MB. A larger file goes through a session. */
export const FETCH_RAW_MAX_BYTES = 5 * 1024 * 1024;

export const WEB_FILE_KINDS = {
  pdf: { contentType: 'application/pdf', extension: 'pdf', label: 'PDF' },
  docx: {
    contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    extension: 'docx',
    label: 'Word (DOCX)',
  },
  xlsx: {
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    extension: 'xlsx',
    label: 'Excel (XLSX)',
  },
  pptx: {
    contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    extension: 'pptx',
    label: 'PowerPoint (PPTX)',
  },
  csv: { contentType: 'text/csv', extension: 'csv', label: 'CSV' },
  png: { contentType: 'image/png', extension: 'png', label: 'PNG' },
  jpeg: { contentType: 'image/jpeg', extension: 'jpg', label: 'JPEG' },
  txt: { contentType: 'text/plain', extension: 'txt', label: 'plain text' },
} as const;
export type WebFileKind = keyof typeof WEB_FILE_KINDS;

/** web_file_save and browser_download: the seven types of the design. */
export const SAVE_FILE_KINDS: readonly WebFileKind[] = ['pdf', 'docx', 'xlsx', 'pptx', 'csv', 'png', 'jpeg'];
/** A mail or task attachment from a URL: the same, plus plain text. Never a zip. */
export const ATTACHMENT_FILE_KINDS: readonly WebFileKind[] = [...SAVE_FILE_KINDS, 'txt'];

function allowedLabel(kinds: readonly WebFileKind[]) {
  return kinds.map((kind) => WEB_FILE_KINDS[kind].label).join(', ');
}

export type WebFileErrorCode =
  | 'bad_url'
  | 'private_host'
  | 'not_found'
  | 'page'
  | 'sign_in'
  | 'type'
  | 'mismatch'
  | 'size'
  | 'failed';

export class WebFileError extends Error {
  constructor(
    readonly code: WebFileErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'WebFileError';
  }
}

function startsWith(bytes: Uint8Array, signature: readonly number[]) {
  return bytes.length >= signature.length && signature.every((byte, index) => bytes[index] === byte);
}

function containsAscii(bytes: Uint8Array, text: string) {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).includes(text, 0, 'latin1');
}

/** An HTML page (a sign-in page, a landing page) where a file was expected. */
export function looksLikeHtml(bytes: Uint8Array): boolean {
  const head = new TextDecoder().decode(bytes.subarray(0, 1_024)).replace(/^﻿/, '').trimStart().toLowerCase();
  return (
    head.startsWith('<!doctype html') || head.startsWith('<html') || /^<(head|body|script|meta)\b/.test(head)
  );
}

function isPlainText(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, 64 * 1_024);
  if (sample.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(sample.subarray(0, Math.max(0, sample.length - 4)));
    return true;
  } catch {
    return false;
  }
}

/** The kind that a declared type or a file name says, if it is one we accept. */
function declaredKind(contentType: string, name: string): WebFileKind | null {
  const type = contentType.split(';')[0].trim().toLowerCase();
  const extension = name.toLowerCase().split('.').pop() || '';
  // Servers often send a CSV file as text/plain: the name decides.
  if (type === 'text/plain') return extension === 'csv' ? 'csv' : 'txt';
  for (const [kind, info] of Object.entries(WEB_FILE_KINDS) as [
    WebFileKind,
    (typeof WEB_FILE_KINDS)[WebFileKind],
  ][])
    if (type === info.contentType) return kind;
  if (type === 'image/jpg' || type === 'image/pjpeg') return 'jpeg';
  if (type === 'application/csv' || type === 'text/comma-separated-values') return 'csv';
  if (extension === 'jpeg') return 'jpeg';
  return (
    (Object.keys(WEB_FILE_KINDS) as WebFileKind[]).find(
      (kind) => WEB_FILE_KINDS[kind].extension === extension,
    ) ?? null
  );
}

/**
 * The kind of a file from its first bytes. The bytes decide; a declared type
 * of an accepted kind that the bytes do not agree with is refused.
 */
export function detectWebFile(
  bytes: Uint8Array,
  hints: { contentType?: string; name?: string } = {},
  allowed: readonly WebFileKind[] = SAVE_FILE_KINDS,
): WebFileKind {
  const declared = declaredKind(hints.contentType || '', hints.name || '');
  let kind: WebFileKind | null = null;
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) kind = 'pdf';
  else if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) kind = 'png';
  else if (startsWith(bytes, [0xff, 0xd8, 0xff])) kind = 'jpeg';
  else if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) {
    // Office Open XML is a zip. The local file headers hold the part names in clear text.
    if (containsAscii(bytes, '[Content_Types].xml')) {
      if (containsAscii(bytes, 'word/document.xml')) kind = 'docx';
      else if (containsAscii(bytes, 'xl/workbook.xml')) kind = 'xlsx';
      else if (containsAscii(bytes, 'ppt/presentation.xml')) kind = 'pptx';
    }
    if (!kind)
      throw new WebFileError(
        'type',
        `This zip file is not an Office file. Allowed: ${allowedLabel(allowed)}.`,
      );
  } else if (looksLikeHtml(bytes)) {
    throw new WebFileError('page', 'The address gives a web page, not a file.');
  } else if ((declared === 'csv' || declared === 'txt') && isPlainText(bytes)) kind = declared;
  if (!kind || !allowed.includes(kind))
    throw new WebFileError('type', `This file type is not allowed. Allowed: ${allowedLabel(allowed)}.`);
  if (declared && declared !== kind)
    throw new WebFileError(
      'mismatch',
      `The file says it is ${WEB_FILE_KINDS[declared].label}, but its contents are ${WEB_FILE_KINDS[kind].label}.`,
    );
  return kind;
}

/** A name that ends with the kind's extension. */
export function webFileName(name: string, kind: WebFileKind): string {
  const extension = WEB_FILE_KINDS[kind].extension;
  const base = savedFileName(name || '', 'download');
  const lower = base.toLowerCase();
  if (lower.endsWith(`.${extension}`) || (kind === 'jpeg' && lower.endsWith('.jpeg'))) return base;
  const stem = base.replace(/\.[a-z0-9]{1,5}$/i, '');
  return `${stem || 'download'}.${extension}`;
}

function nameFromUrl(url: URL): string {
  try {
    return decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() || '');
  } catch {
    return '';
  }
}

function nameFromDisposition(value: string | undefined): string {
  if (!value) return '';
  const star = value.match(/filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ''));
    } catch {}
  }
  const plain = value.match(/filename\s*=\s*"?([^";]+)"?/i);
  return plain ? plain[1].trim() : '';
}

/** The address kept with a file: no fragment, and no query (it can hold a token). */
export function sourceAddress(raw: string, keepQuery = true): string {
  try {
    const url = new URL(raw);
    url.hash = '';
    url.username = '';
    url.password = '';
    if (!keepQuery) url.search = '';
    return url.toString();
  } catch {
    return '';
  }
}

export type PullTier = 'fetch' | 'session' | 'signed_in';

export interface PulledFile {
  bytes: Uint8Array;
  name: string;
  kind: WebFileKind;
  contentType: string;
  size: number;
  sha256: string;
  sourceUrl: string;
  tier: PullTier;
}

const defaults = {
  fetchRaw: (url: string, options?: BrowserbaseCallOptions) =>
    browserbaseFetch({ url, format: 'raw', allowRedirects: true }, options),
  withShortSession,
  collectDownload,
  deleteSessionDownloads,
  sessionDownloadIds,
  savedContextId: savedSignInContextId,
  saveFileBytes,
};
let deps = defaults;
export function __setFilePullDepsForTest(overrides: Partial<typeof defaults> = {}) {
  deps = { ...defaults, ...overrides };
}

function finish(
  bytes: Uint8Array,
  hints: { contentType?: string; name: string },
  requestedName: string | undefined,
  sourceUrl: string,
  tier: PullTier,
  kinds: readonly WebFileKind[] = SAVE_FILE_KINDS,
): PulledFile {
  if (!bytes.byteLength) throw new WebFileError('failed', 'The file is empty.');
  if (bytes.byteLength > WEB_FILE_MAX_BYTES) throw new WebFileError('size', 'The file is larger than 25 MB.');
  const kind = detectWebFile(bytes, hints, kinds);
  return {
    bytes,
    kind,
    name: webFileName(requestedName?.trim() || hints.name, kind),
    contentType: WEB_FILE_KINDS[kind].contentType,
    size: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    sourceUrl,
    tier,
  };
}

type TierOneResult = { file: PulledFile } | { fallback: string };

async function pullWithFetch(
  url: URL,
  name: string | undefined,
  kinds: readonly WebFileKind[],
  signal?: AbortSignal,
): Promise<TierOneResult> {
  let raw: Awaited<ReturnType<typeof deps.fetchRaw>>;
  try {
    raw = await deps.fetchRaw(url.toString(), { signal });
  } catch (error) {
    // 502: the body is larger than 5 MB. 504: slower than 60 s. 5xx/429: try the browser.
    if (error instanceof BrowserbaseRequestError && (error.status >= 500 || error.status === 429))
      return { fallback: `fetch ${error.status}` };
    throw error;
  }
  if (raw.statusCode === 404 || raw.statusCode === 410)
    throw new WebFileError('not_found', `The site has no file at this address (${raw.statusCode}).`);
  if (raw.statusCode >= 400) return { fallback: `site ${raw.statusCode}` };
  const declared = Number(raw.headers['content-length']);
  if (Number.isFinite(declared) && declared > WEB_FILE_MAX_BYTES)
    throw new WebFileError('size', 'The file is larger than 25 MB.');
  const bytes =
    raw.encoding === 'base64'
      ? new Uint8Array(Buffer.from(raw.content, 'base64'))
      : new TextEncoder().encode(raw.content);
  const hintName = nameFromDisposition(raw.headers['content-disposition']) || nameFromUrl(url);
  try {
    return {
      file: finish(
        bytes,
        { contentType: raw.contentType, name: hintName },
        name,
        url.toString(),
        'fetch',
        kinds,
      ),
    };
  } catch (error) {
    // A page where a file was expected: a sign-in page, or a page that needs JavaScript.
    if (error instanceof WebFileError && error.code === 'page') return { fallback: 'page' };
    throw error;
  }
}

async function pullWithSession(
  url: URL,
  name: string | undefined,
  contextId: string | null,
  kinds: readonly WebFileKind[],
  signal?: AbortSignal,
): Promise<PulledFile> {
  const tier: PullTier = contextId ? 'signed_in' : 'session';
  return deps.withShortSession({ contextId, timeoutSeconds: 120, signal }, async (page, sessionId) => {
    try {
      const opened = await page.open(url.toString());
      if (opened.kind === 'download') {
        const { download, bytes } = await deps.collectDownload(sessionId, {
          filename: opened.filename,
          maxBytes: WEB_FILE_MAX_BYTES,
        });
        return finish(
          bytes,
          { contentType: download.mimeType, name: download.filename || opened.filename || nameFromUrl(url) },
          name,
          url.toString(),
          tier,
          kinds,
        );
      }
      if (opened.status === 404 || opened.status === 410)
        throw new WebFileError('not_found', `The site has no file at this address (${opened.status}).`);
      // The browser shows the file (an image, a CSV) or a page. Read the
      // address inside the page, on the same site, with the page's cookies.
      const shown = await page.fetchInPage(url.toString(), WEB_FILE_MAX_BYTES);
      if (shown.tooLarge) throw new WebFileError('size', 'The file is larger than 25 MB.');
      if (!shown.bytes || shown.status >= 400 || looksLikeHtml(shown.bytes))
        throw contextId
          ? new WebFileError(
              'sign_in',
              'The site shows a page, not a file. If the site needs a sign-in, the user signs in once in the shared browser; then try again.',
            )
          : new WebFileError(
              'page',
              'The address opens a web page, not a file. Find the direct link to the file.',
            );
      return finish(
        shown.bytes,
        { contentType: shown.contentType, name: nameFromUrl(url) },
        name,
        url.toString(),
        tier,
        kinds,
      );
    } catch (error) {
      if (error instanceof DownloadError)
        throw new WebFileError(error.code === 'size' ? 'size' : 'failed', error.message);
      throw error;
    } finally {
      await deps.deleteSessionDownloads(sessionId).catch(() => undefined);
    }
  });
}

export interface PullOptions {
  name?: string;
  /** The accepted types. Default: SAVE_FILE_KINDS. */
  kinds?: readonly WebFileKind[];
  /** The user whose saved sign-ins tier 3 reads. Without it, tier 2 runs. */
  userId?: string;
  signal?: AbortSignal;
}

/** One web file: tier 1, then one session (tier 3 when the user has saved sign-ins, else tier 2). */
export async function pullWebFile(rawUrl: string, options: PullOptions = {}): Promise<PulledFile> {
  let url: URL;
  try {
    url = publicWebUrl(rawUrl);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Use a full http or https address.';
    throw new WebFileError(/private/.test(message) ? 'private_host' : 'bad_url', message);
  }
  const kinds = options.kinds ?? SAVE_FILE_KINDS;
  const first = await pullWithFetch(url, options.name, kinds, options.signal);
  if ('file' in first) return first.file;
  const contextId = options.userId ? await deps.savedContextId(options.userId).catch(() => null) : null;
  return pullWithSession(url, options.name, contextId, kinds, options.signal);
}

export interface SaveWebFileInput {
  userId: string;
  url: string;
  name?: string;
  workId?: string;
  signal?: AbortSignal;
}

/** Pull a web file and save it in Files (origin `web`, with its source address and SHA-256). */
export async function saveWebFile(input: SaveWebFileInput): Promise<SavedFile & { tier: PullTier }> {
  const file = await pullWebFile(input.url, { name: input.name, userId: input.userId, signal: input.signal });
  const saved = await deps.saveFileBytes({
    userId: input.userId,
    bytes: file.bytes,
    name: file.name,
    contentType: file.contentType,
    origin: 'web',
    sourceUrl: sourceAddress(file.sourceUrl),
    ...(input.workId ? { workId: input.workId } : {}),
  });
  return { ...saved, tier: file.tier };
}

/** The run's browser, as browser_download sees it (lib/albatross/browser-agent.ts AgentBrowser). */
export interface DownloadingBrowser {
  sessionId(): string | null;
  download(input: {
    ref?: string;
    url?: string;
  }): Promise<
    | { via: 'download'; filename: string; sourceUrl: string }
    | { via: 'page'; file: InPageFile; sourceUrl: string }
  >;
}

export interface SaveBrowserDownloadInput {
  userId: string;
  browser: DownloadingBrowser;
  ref?: string;
  url?: string;
  name?: string;
  workId?: string;
}

/**
 * browser_download: the file a page links to, a file URL, or the file the
 * current page shows, from the run's own browser (with the user's saved
 * sign-ins), into Files. A download comes through the Downloads API.
 */
export async function saveBrowserDownload(
  input: SaveBrowserDownloadInput,
): Promise<SavedFile & { sourceUrl: string }> {
  const sessionId = input.browser.sessionId();
  if (!sessionId) throw new WebFileError('failed', 'This browser cannot save files.');
  const known = await deps.sessionDownloadIds(sessionId);
  const started = await input.browser.download({ ref: input.ref, url: input.url });
  // A download address can hold a token in its query; Files keeps the path only.
  const sourceUrl = sourceAddress(started.sourceUrl, false);
  let file: PulledFile;
  if (started.via === 'download') {
    try {
      const { download, bytes } = await deps.collectDownload(sessionId, {
        known,
        filename: started.filename,
        maxBytes: WEB_FILE_MAX_BYTES,
      });
      file = finish(
        bytes,
        { contentType: download.mimeType, name: download.filename || started.filename },
        input.name,
        sourceUrl,
        'signed_in',
      );
    } catch (error) {
      if (error instanceof DownloadError)
        throw new WebFileError(error.code === 'size' ? 'size' : 'failed', error.message);
      throw error;
    }
  } else {
    const shown = started.file;
    if (shown.tooLarge) throw new WebFileError('size', 'The file is larger than 25 MB.');
    if (!shown.bytes || shown.status >= 400 || looksLikeHtml(shown.bytes))
      throw new WebFileError('page', 'The page is not a file. Find the link to the file, then pass its ref.');
    let pathName = '';
    try {
      pathName = nameFromUrl(new URL(started.sourceUrl));
    } catch {}
    file = finish(
      shown.bytes,
      { contentType: shown.contentType, name: pathName },
      input.name,
      sourceUrl,
      'signed_in',
    );
  }
  const saved = await deps.saveFileBytes({
    userId: input.userId,
    bytes: file.bytes,
    name: file.name,
    contentType: file.contentType,
    origin: 'web',
    ...(sourceUrl ? { sourceUrl } : {}),
    ...(input.workId ? { workId: input.workId } : {}),
  });
  return { ...saved, sourceUrl };
}

export { WebUrlError };
