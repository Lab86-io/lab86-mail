// The mail corpus keeps each message in two documents (IO-1):
//
// - `mailCorpusMessages` holds the small fields: headers, a short snippet,
//   labels, flags, dates, hashes, and a short `searchText`. Lists, search,
//   sorting, Jev, and the content index read only these documents.
// - `mailCorpusBodies` holds the plain text body and the HTML body. Only the
//   thread reader and the tools that show a full message read it.
//
// Convex bills each read and each write by the size of the whole document, so
// a reader that needs a subject must not pay for a 200 kB HTML body.
//
// `searchText` is the header line, then a body excerpt. `excerptAt` is the
// index where the excerpt starts. The excerpt is the start and the end of the
// plain text body (see clipClassifierBody), with its line breaks, so the
// sorting rules still see an unsubscribe footer and Jev still sees the first
// 2,400 characters as they are in the body.

import { truncateText } from '../shared/text';
import { clipClassifierBody } from './smart-categories';

/** Plain text body cap. The value is the same as before the split. */
export const CORPUS_TEXT_BODY_MAX_CHARS = 32_000;
/** HTML body cap. The value is the same as before the split. */
export const CORPUS_HTML_BODY_MAX_CHARS = 200_000;
/** Snippet cap on the small document. */
export const CORPUS_SNIPPET_MAX_CHARS = 500;
/** Cap of the header part of `searchText` (subject, addresses, snippet, labels). */
export const CORPUS_SEARCH_HEADER_MAX_CHARS = 1_500;

/** The hash of an absent body part. */
export const ABSENT_BODY_PART = '-';

/**
 * A 53-bit hash of one body part, with its length. It only detects a change,
 * so a fast non-cryptographic hash is sufficient.
 */
export function bodyPartHash(value: string | undefined | null): string {
  if (value === undefined || value === null) return ABSENT_BODY_PART;
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const hash = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return `${hash.toString(36)}:${value.length.toString(36)}`;
}

export interface BodyHashParts {
  text: string;
  html: string;
}

/** `bodyHash` on the small document: the text hash, a dot, the HTML hash. */
export function joinBodyHash(parts: BodyHashParts): string {
  return `${parts.text}.${parts.html}`;
}

export function splitBodyHash(value: string | undefined | null): BodyHashParts {
  const [text, html] = String(value || '').split('.');
  return { text: text || ABSENT_BODY_PART, html: html || ABSENT_BODY_PART };
}

/** True when the hash says that the message has a body document. */
export function bodyHashHasBody(value: string | undefined | null) {
  const parts = splitBodyHash(value);
  return parts.text !== ABSENT_BODY_PART || parts.html !== ABSENT_BODY_PART;
}

export function capTextBody(value: unknown) {
  return truncateText(String(value ?? ''), CORPUS_TEXT_BODY_MAX_CHARS);
}

/** HTML keeps its whitespace: it is significant in markup. */
export function capHtmlBody(value: unknown) {
  return truncateText(String(value ?? ''), CORPUS_HTML_BODY_MAX_CHARS);
}

function collapse(value: unknown) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The body excerpt that `searchText` keeps: the start and the end of the
 * plain text. It keeps the line breaks, so the first 2,400 characters that Jev
 * reads are the same as the first 2,400 characters of the full body.
 */
export function bodyExcerpt(textBody: string | undefined | null) {
  return clipClassifierBody(String(textBody ?? ''));
}

export interface SmallSearchInput {
  subject?: string | null;
  from?: string | null;
  to?: string | null;
  cc?: string | null;
  bcc?: string | null;
  snippet?: string | null;
  labels?: string[] | null;
}

/** The small `searchText`: the header line, one space, then the body excerpt. */
export function buildSmallSearchText(input: SmallSearchInput, excerpt: string) {
  const header = truncateText(
    collapse(
      [input.subject, input.from, input.to, input.cc, input.bcc, input.snippet, ...(input.labels || [])]
        .filter(Boolean)
        .join(' '),
    ),
    CORPUS_SEARCH_HEADER_MAX_CHARS,
  );
  if (!excerpt) return { searchText: header, excerptAt: header.length };
  return { searchText: `${header} ${excerpt}`, excerptAt: header.length + 1 };
}

/** The fields of a message document that the body helpers read. */
export interface CorpusMessageBodyFields {
  snippet?: string | null;
  textBody?: string | null;
  htmlBody?: string | null;
  searchText?: string | null;
  excerptAt?: number | null;
  bodyHash?: string | null;
}

/** True when the document still holds its body inline (written before the split). */
export function isLegacyCorpusMessage(doc: CorpusMessageBodyFields | null | undefined) {
  if (!doc) return false;
  return doc.textBody !== undefined || doc.htmlBody !== undefined || doc.bodyHash === undefined;
}

/**
 * The plain text that a reader of the small document can use as the body.
 * A document from before the split gives its full inline text. A split
 * document gives its stored excerpt. Callers cut it to their own limit.
 */
export function storedBodyText(doc: CorpusMessageBodyFields | null | undefined): string {
  if (!doc) return '';
  if (typeof doc.textBody === 'string') return doc.textBody;
  const searchText = String(doc.searchText || '');
  if (typeof doc.excerptAt === 'number') return searchText.slice(Math.min(doc.excerptAt, searchText.length));
  return '';
}

/** The body excerpt of a stored document, as the search results and previews use it. */
export function storedBodyExcerpt(doc: CorpusMessageBodyFields | null | undefined, maxChars: number) {
  return truncateText(storedBodyText(doc), maxChars);
}
