// Direct Google transport: Gmail API objects in the Nylas v3 shape.
//
// The corpus stores what Nylas returned for Gmail, and the corpus writer
// compares content fields (subject, from, to, cc, attachments, text body) to
// decide if a thread needs a new classification. So the mapping copies what
// Nylas does for Gmail, not what would be nicest:
// - `folders` are the Gmail label ids, as they are (INBOX, UNREAD, Label_12).
// - `date` is Gmail's internalDate in seconds.
// - `body` is the HTML part; a message with only text gets its text as it is.
// - `snippet` is Gmail's snippet with the HTML entities decoded.
// - An attachment id is `v0:<b64url file name>:<b64url Content-Type>:<size>`,
//   where the content type is the part's whole Content-Type header value and
//   the size is the decoded byte count (Gmail `body.size`). Gmail attachment
//   ids change between requests, so they are never stored.

export interface GmailHeader {
  name: string;
  value: string;
}

export interface GmailPart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { attachmentId?: string; size?: number; data?: string };
  parts?: GmailPart[];
}

export interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  historyId?: string;
  internalDate?: string;
  sizeEstimate?: number;
  payload?: GmailPart;
}

export interface GmailThread {
  id: string;
  snippet?: string;
  historyId?: string;
  messages?: GmailMessage[];
}

export interface NylasEmailName {
  name: string;
  email: string;
}

export interface NylasAttachmentShape {
  id: string;
  grantId: string;
  filename: string;
  contentType: string;
  size: number;
  contentId?: string;
  isInline: boolean;
  contentDisposition?: string;
}

// ---------------------------------------------------------------------------
// Bytes, charsets, and encoded words
// ---------------------------------------------------------------------------

export function decodeBase64Url(data: string | undefined): Buffer {
  if (!data) return Buffer.alloc(0);
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

const CHARSET_ALIASES: Record<string, string> = {
  'us-ascii': 'utf-8',
  ascii: 'utf-8',
  utf8: 'utf-8',
  latin1: 'iso-8859-1',
  'x-unknown': 'utf-8',
  unknown: 'utf-8',
};

export function decodeCharset(bytes: Uint8Array, charset: string | undefined): string {
  const label = String(charset || 'utf-8')
    .trim()
    .replace(/^["']|["']$/g, '')
    .toLowerCase();
  const name = CHARSET_ALIASES[label] || label || 'utf-8';
  try {
    return new TextDecoder(name).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

function qDecode(text: string): Buffer {
  const bytes: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '_') bytes.push(0x20);
    else if (char === '=' && /^[0-9a-fA-F]{2}$/.test(text.slice(index + 1, index + 3))) {
      bytes.push(Number.parseInt(text.slice(index + 1, index + 3), 16));
      index += 2;
    } else bytes.push(char.charCodeAt(0) & 0xff);
  }
  return Buffer.from(bytes);
}

const ENCODED_WORD = /=\?([^?\s]+)\?([bBqQ])\?([^?\s]*)\?=/g;

/**
 * Decodes RFC 2047 encoded words. Adjacent words of one charset are joined
 * before decoding, so a character split across two words stays whole.
 */
export function decodeMimeWords(value: string | undefined): string {
  const input = String(value ?? '');
  if (!input.includes('=?')) return input;
  let out = '';
  let last = 0;
  let pending: { charset: string; bytes: Buffer[] } | null = null;
  const flush = () => {
    if (pending) out += decodeCharset(Buffer.concat(pending.bytes), pending.charset);
    pending = null;
  };
  for (const match of input.matchAll(ENCODED_WORD)) {
    const between = input.slice(last, match.index);
    // Whitespace between two encoded words is not part of the text.
    if (!(pending && /^\s*$/.test(between))) {
      flush();
      out += between;
    }
    const charset = match[1].split('*')[0].toLowerCase();
    const bytes = match[2].toUpperCase() === 'B' ? Buffer.from(match[3], 'base64') : qDecode(match[3]);
    const current = pending as { charset: string; bytes: Buffer[] } | null;
    if (current && current.charset === charset) current.bytes.push(bytes);
    else {
      flush();
      pending = { charset, bytes: [bytes] };
    }
    last = (match.index ?? 0) + match[0].length;
  }
  flush();
  return out + input.slice(last);
}

// ---------------------------------------------------------------------------
// Headers and addresses
// ---------------------------------------------------------------------------

export function headerValue(headers: GmailHeader[] | undefined, name: string): string | undefined {
  const lower = name.toLowerCase();
  const found = (headers || []).find((header) => header?.name?.toLowerCase() === lower);
  return found ? String(found.value ?? '').replace(/\r?\n(?=[ \t])/g, '') : undefined;
}

/** Splits an address list on the commas that are outside quotes, brackets, and comments. */
function splitAddressList(value: string): string[] {
  const out: string[] = [];
  let current = '';
  let quoted = false;
  let angle = 0;
  let comment = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quoted) {
      current += char;
      if (char === '\\' && index + 1 < value.length) current += value[++index];
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === '<') angle += 1;
    else if (char === '>') angle = Math.max(0, angle - 1);
    else if (char === '(') comment += 1;
    else if (char === ')') comment = Math.max(0, comment - 1);
    if ((char === ',' || char === ';') && !angle && !comment) {
      out.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  out.push(current);
  return out;
}

function unquote(name: string) {
  const trimmed = name.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\(.)/g, '$1');
  }
  return trimmed;
}

/** Parses an address header into Nylas `{ name, email }` items. */
export function parseAddressList(value: string | undefined): NylasEmailName[] {
  if (!value) return [];
  const out: NylasEmailName[] = [];
  for (const raw of splitAddressList(value)) {
    let token = raw.trim();
    if (!token) continue;
    // Group syntax: "Team: a@b.c, d@e.f;" and "undisclosed-recipients:;".
    const group = token.match(/^[^"<>@]*?:\s*(.*)$/s);
    if (group) token = group[1].trim();
    if (!token) continue;
    const angle = token.match(/^(.*?)<([^<>]*)>\s*(?:\(.*\))?\s*$/s);
    if (angle) {
      const email = angle[2].trim();
      if (!email) continue;
      out.push({ name: decodeMimeWords(unquote(angle[1])).trim(), email });
      continue;
    }
    const bare = token.replace(/\(.*?\)/g, '').trim();
    if (!bare.includes('@')) continue;
    out.push({ name: '', email: bare });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Parts: bodies and attachments
// ---------------------------------------------------------------------------

function contentTypeParam(contentType: string | undefined, param: string): string | undefined {
  if (!contentType) return undefined;
  const match = contentType.match(
    new RegExp(`(?:^|;)\\s*${param}\\s*=\\s*("(?:[^"\\\\]|\\\\.)*"|[^;\\s]+)`, 'i'),
  );
  return match ? unquote(match[1]) : undefined;
}

function partMimeType(part: GmailPart): string {
  return String(part.mimeType || 'application/octet-stream').toLowerCase();
}

function dispositionOf(part: GmailPart) {
  return (headerValue(part.headers, 'Content-Disposition') || '').trim();
}

/** A leaf part that Nylas lists as an attachment. */
export function isAttachmentPart(part: GmailPart): boolean {
  if (part.parts?.length) return false;
  const type = partMimeType(part);
  if (type.startsWith('multipart/')) return false;
  if (part.filename) return true;
  const disposition = dispositionOf(part).toLowerCase();
  const isText = type === 'text/plain' || type === 'text/html';
  if (disposition.startsWith('attachment')) return true;
  if (isText) return false;
  return Boolean(
    disposition.startsWith('inline') || headerValue(part.headers, 'Content-ID') || part.body?.attachmentId,
  );
}

function walk(part: GmailPart | undefined, visit: (part: GmailPart) => void) {
  if (!part) return;
  visit(part);
  for (const child of part.parts || []) walk(child, visit);
}

export function attachmentParts(payload: GmailPart | undefined): GmailPart[] {
  const out: GmailPart[] = [];
  walk(payload, (part) => {
    if (isAttachmentPart(part)) out.push(part);
  });
  return out;
}

function partContentType(part: GmailPart): string {
  const header = headerValue(part.headers, 'Content-Type');
  return header?.trim() || part.mimeType || 'application/octet-stream';
}

function partSize(part: GmailPart): number {
  const size = Number(part.body?.size);
  if (Number.isFinite(size) && size >= 0) return size;
  return decodeBase64Url(part.body?.data).length;
}

export function encodeAttachmentId(input: { filename: string; contentType: string; size: number }): string {
  const name = Buffer.from(input.filename || '', 'utf8').toString('base64url');
  const type = Buffer.from(input.contentType || '', 'utf8').toString('base64url');
  return `v0:${name}:${type}:${Math.max(0, Math.floor(Number(input.size) || 0))}`;
}

export function decodeAttachmentId(
  id: string,
): { filename: string; contentType: string; size: number | null } | null {
  const parts = String(id || '').split(':');
  if (parts[0] !== 'v0' || parts.length < 3) return null;
  try {
    const filename = Buffer.from(parts[1], 'base64url').toString('utf8');
    const contentType = Buffer.from(parts[2], 'base64url').toString('utf8');
    const size = parts.length > 3 && /^\d+$/.test(parts[3]) ? Number(parts[3]) : null;
    return { filename, contentType, size };
  } catch {
    return null;
  }
}

export function attachmentIdForPart(part: GmailPart): string {
  return encodeAttachmentId({
    filename: part.filename || '',
    contentType: partContentType(part),
    size: partSize(part),
  });
}

function sameType(a: string, b: string) {
  return a.replace(/\s+/g, '').toLowerCase() === b.replace(/\s+/g, '').toLowerCase();
}

/**
 * The MIME part that a stored attachment id names. The id holds the file
 * name, the Content-Type value, and the size, so the lookup tries the most
 * exact match first. A raw Gmail attachment id also works.
 */
export function resolveAttachmentPart(payload: GmailPart | undefined, id: string): GmailPart | null {
  const parts = attachmentParts(payload);
  const direct = parts.find((part) => part.body?.attachmentId && part.body.attachmentId === id);
  if (direct) return direct;
  const wanted = decodeAttachmentId(id);
  if (!wanted) return null;
  const exact = parts.find((part) => attachmentIdForPart(part) === id);
  if (exact) return exact;
  const named = parts.filter((part) => (part.filename || '') === wanted.filename);
  const tries: Array<(part: GmailPart) => boolean> = [
    (part) => sameType(partContentType(part), wanted.contentType) && partSize(part) === wanted.size,
    (part) => partSize(part) === wanted.size,
    (part) => sameType(partContentType(part), wanted.contentType),
  ];
  for (const test of tries) {
    const found = named.filter(test);
    if (found.length) return found[0];
  }
  if (named.length === 1) return named[0];
  return null;
}

function nylasAttachment(part: GmailPart, grantId: string): NylasAttachmentShape {
  const disposition = dispositionOf(part);
  const contentIdHeader = headerValue(part.headers, 'Content-ID');
  const contentId = contentIdHeader ? contentIdHeader.trim().replace(/^<|>$/g, '') : undefined;
  const isInline = disposition
    ? disposition.toLowerCase().startsWith('inline')
    : Boolean(contentId) && !part.filename;
  return {
    id: attachmentIdForPart(part),
    grantId,
    filename: part.filename || '',
    contentType: partContentType(part),
    size: partSize(part),
    ...(contentId ? { contentId } : {}),
    isInline,
    ...(disposition ? { contentDisposition: disposition } : {}),
  };
}

function textOfPart(part: GmailPart): string {
  const charset = contentTypeParam(headerValue(part.headers, 'Content-Type'), 'charset');
  return decodeCharset(decodeBase64Url(part.body?.data), charset);
}

/** The HTML and text bodies of a message, the way Nylas picks them. */
export function messageBodies(payload: GmailPart | undefined): { html?: string; text?: string } {
  if (!payload) return {};
  const type = partMimeType(payload);
  if (!payload.parts?.length) {
    if (isAttachmentPart(payload)) return {};
    if (type === 'text/html') return { html: textOfPart(payload) };
    if (type === 'text/plain') return { text: textOfPart(payload) };
    return {};
  }
  const children = payload.parts.map((child) => messageBodies(child));
  if (type === 'multipart/alternative') {
    // The last alternative is the richest one (RFC 2046).
    const html = [...children].reverse().find((child) => child.html !== undefined)?.html;
    const text = children.find((child) => child.text !== undefined)?.text;
    return { ...(html !== undefined ? { html } : {}), ...(text !== undefined ? { text } : {}) };
  }
  const htmls = children.map((child) => child.html).filter((html): html is string => html !== undefined);
  const texts = children.map((child) => child.text).filter((text): text is string => text !== undefined);
  return {
    ...(htmls.length ? { html: htmls.join('') } : {}),
    ...(texts.length ? { text: texts.join('\n') } : {}),
  };
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

export function decodeHtmlEntities(value: string | undefined): string {
  return String(value ?? '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === '#') {
      const code =
        entity[1] === 'x' || entity[1] === 'X'
          ? Number.parseInt(entity.slice(2), 16)
          : Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

// ---------------------------------------------------------------------------
// Messages and threads
// ---------------------------------------------------------------------------

export interface NylasMessageShape {
  id: string;
  object: 'message';
  grantId: string;
  threadId: string;
  subject: string;
  from: NylasEmailName[];
  to: NylasEmailName[];
  cc: NylasEmailName[];
  bcc: NylasEmailName[];
  replyTo: NylasEmailName[];
  date: number;
  createdAt: number;
  snippet: string;
  body?: string;
  unread: boolean;
  starred: boolean;
  folders: string[];
  attachments: NylasAttachmentShape[];
  headers?: GmailHeader[];
}

function secondsOf(message: GmailMessage): number {
  const ms = Number(message.internalDate);
  if (Number.isFinite(ms) && ms > 0) return Math.floor(ms / 1000);
  const header = Date.parse(headerValue(message.payload?.headers, 'Date') || '');
  return Number.isFinite(header) ? Math.floor(header / 1000) : 0;
}

/** A Gmail message (format full, metadata, or minimal) in the Nylas message shape. */
export function gmailMessageToNylas(
  message: GmailMessage,
  grantId: string,
  options: { includeHeaders?: boolean } = {},
): NylasMessageShape {
  const headers = message.payload?.headers || [];
  const labels = [...(message.labelIds || [])];
  const bodies = messageBodies(message.payload);
  const hasBodyData = Boolean(message.payload?.body?.data || message.payload?.parts?.length);
  const date = secondsOf(message);
  return {
    id: message.id,
    object: 'message',
    grantId,
    threadId: message.threadId || message.id,
    subject: decodeMimeWords(headerValue(headers, 'Subject') || ''),
    from: parseAddressList(headerValue(headers, 'From')),
    to: parseAddressList(headerValue(headers, 'To')),
    cc: parseAddressList(headerValue(headers, 'Cc')),
    bcc: parseAddressList(headerValue(headers, 'Bcc')),
    replyTo: parseAddressList(headerValue(headers, 'Reply-To')),
    date,
    createdAt: date,
    snippet: decodeHtmlEntities(message.snippet),
    ...(hasBodyData ? { body: bodies.html ?? bodies.text ?? '' } : {}),
    unread: labels.includes('UNREAD'),
    starred: labels.includes('STARRED'),
    folders: labels,
    attachments: attachmentParts(message.payload).map((part) => nylasAttachment(part, grantId)),
    ...(options.includeHeaders
      ? { headers: headers.map((header) => ({ name: header.name, value: header.value })) }
      : {}),
  };
}

function uniqueAddresses(items: NylasEmailName[]) {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = item.email.toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** A Gmail thread in the Nylas thread shape. Drafts do not count as messages. */
export function gmailThreadToNylas(thread: GmailThread, grantId: string) {
  const all = (thread.messages || []).map((message) => gmailMessageToNylas(message, grantId));
  const messages = all.filter((message) => !message.folders.includes('DRAFT'));
  const drafts = all.filter((message) => message.folders.includes('DRAFT'));
  const ordered = [...messages].sort((a, b) => a.date - b.date);
  const latest = ordered.at(-1) ?? [...drafts].sort((a, b) => a.date - b.date).at(-1);
  const received = ordered.filter((message) => !message.folders.includes('SENT'));
  const sent = ordered.filter((message) => message.folders.includes('SENT'));
  const folders = [...new Set(all.flatMap((message) => message.folders))];
  return {
    id: thread.id,
    object: 'thread' as const,
    grantId,
    subject: ordered[0]?.subject || latest?.subject || '',
    snippet: decodeHtmlEntities(thread.snippet) || latest?.snippet || '',
    folders,
    unread: all.some((message) => message.unread),
    starred: all.some((message) => message.starred),
    hasAttachments: all.some((message) => message.attachments.length > 0),
    hasDrafts: drafts.length > 0,
    participants: uniqueAddresses(all.flatMap((message) => [...message.from, ...message.to, ...message.cc])),
    messageIds: messages.map((message) => message.id),
    draftIds: drafts.map((message) => message.id),
    earliestMessageDate: ordered[0]?.date,
    latestMessageReceivedDate: received.at(-1)?.date,
    latestMessageSentDate: sent.at(-1)?.date,
    latestDraftOrMessage: latest,
  };
}

/** Gmail label ids of all the messages of a thread (Nylas thread folders). */
export function threadLabelIds(thread: GmailThread): string[] {
  return [...new Set((thread.messages || []).flatMap((message) => message.labelIds || []))];
}

export interface GmailLabel {
  id: string;
  name: string;
  type?: 'system' | 'user';
  messagesTotal?: number;
  messagesUnread?: number;
  threadsTotal?: number;
  threadsUnread?: number;
  color?: { textColor?: string; backgroundColor?: string };
}

/** A Gmail label in the Nylas folder shape. */
export function gmailLabelToNylasFolder(label: GmailLabel, grantId: string) {
  return {
    id: label.id,
    object: 'folder' as const,
    grantId,
    name: label.name,
    systemFolder: label.type === 'system',
    ...(typeof label.messagesTotal === 'number' ? { totalCount: label.messagesTotal } : {}),
    ...(typeof label.messagesUnread === 'number' ? { unreadCount: label.messagesUnread } : {}),
    ...(label.color?.backgroundColor ? { backgroundColor: label.color.backgroundColor } : {}),
    ...(label.color?.textColor ? { textColor: label.color.textColor } : {}),
  };
}
