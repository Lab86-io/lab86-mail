// Direct Google transport: RFC 2822 / MIME messages for `users.messages.send`.
//
// Headers are ASCII: a non-ASCII subject or display name becomes an RFC 2047
// encoded word, and a non-ASCII file name uses RFC 2231. Bodies and
// attachments are base64 with 76-character lines. Gmail adds the From
// header (the account's own name and address) and the Message-ID.

import { randomBytes } from 'node:crypto';
import { htmlToText } from 'html-to-text';

export interface MimeAddress {
  name?: string;
  email: string;
}

export interface MimeAttachment {
  filename?: string;
  contentType?: string;
  content: Uint8Array | string;
  contentId?: string;
  isInline?: boolean;
}

export interface MimeMessageInput {
  to?: MimeAddress[];
  cc?: MimeAddress[];
  bcc?: MimeAddress[];
  replyTo?: MimeAddress[];
  subject?: string;
  body?: string;
  isPlaintext?: boolean;
  inReplyTo?: string;
  references?: string;
  attachments?: MimeAttachment[];
  date?: Date;
  boundary?: () => string;
}

const ASCII_PRINTABLE = /^[\x20-\x7e]*$/;
const ENCODED_WORD_BYTES = 45;

/** A header text in RFC 2047 encoded words when it is not plain ASCII. */
export function encodeHeaderText(value: string): string {
  const text = String(value ?? '').replace(/[\r\n]+/g, ' ');
  if (ASCII_PRINTABLE.test(text)) return text;
  const words: string[] = [];
  let chunk = '';
  for (const char of text) {
    if (Buffer.byteLength(chunk + char, 'utf8') > ENCODED_WORD_BYTES) {
      words.push(chunk);
      chunk = '';
    }
    chunk += char;
  }
  if (chunk) words.push(chunk);
  return words.map((word) => `=?UTF-8?B?${Buffer.from(word, 'utf8').toString('base64')}?=`).join(' ');
}

function cleanEmail(email: string) {
  return String(email || '')
    .replace(/[\r\n<>]/g, '')
    .trim();
}

export function formatMimeAddress(address: MimeAddress): string {
  const email = cleanEmail(address.email);
  const name = String(address.name || '')
    .replace(/[\r\n]+/g, ' ')
    .trim();
  if (!name || name === email) return email;
  if (!ASCII_PRINTABLE.test(name)) return `${encodeHeaderText(name)} <${email}>`;
  if (/^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~ ]+$/.test(name)) return `${name} <${email}>`;
  return `"${name.replace(/(["\\])/g, '\\$1')}" <${email}>`;
}

const HEADER_FOLD_AT = 76;

/**
 * One header field, folded (RFC 5322, 2.2.3) so that each line stays near 76
 * characters and far below the 998 limit. An address list folds after each
 * comma. A longer part folds at its spaces, and the header name keeps its
 * first word. Unfolding (each CRLF removed) gives the field back.
 */
function header(name: string, value: string) {
  const line = `${name}: ${value}`;
  if (line.length <= HEADER_FOLD_AT) return line;
  const parts = value.includes(', ') ? value.split(', ') : [value];
  const lines: string[] = [];
  let current = `${name}:`;
  parts.forEach((part, partIndex) => {
    const words = (partIndex < parts.length - 1 ? `${part},` : part).split(' ');
    words.forEach((word, wordIndex) => {
      const newPart = partIndex > 0 && wordIndex === 0;
      const tooLong =
        word !== '' && current !== `${name}:` && current.length + 1 + word.length > HEADER_FOLD_AT;
      if (newPart || tooLong) {
        lines.push(current);
        current = ` ${word}`;
      } else current = `${current} ${word}`;
    });
  });
  lines.push(current);
  return lines.join('\r\n');
}

function addressHeader(name: string, list: MimeAddress[] | undefined) {
  const items = (list || []).filter((item) => cleanEmail(item.email));
  return items.length ? header(name, items.map(formatMimeAddress).join(', ')) : null;
}

function base64Lines(bytes: Uint8Array | Buffer) {
  const encoded = Buffer.from(bytes).toString('base64');
  return encoded.replace(/.{1,76}/g, '$&\r\n').replace(/\r\n$/, '');
}

function randomBoundary() {
  return `lab86_${randomBytes(12).toString('hex')}`;
}

function quotedParam(value: string) {
  return `"${value.replace(/[\r\n]+/g, ' ').replace(/(["\\])/g, '\\$1')}"`;
}

/** `name="x"`, or RFC 2231 `name*=UTF-8''...` for a non-ASCII name. */
function fileParam(param: string, filename: string) {
  if (ASCII_PRINTABLE.test(filename)) return `${param}=${quotedParam(filename)}`;
  return `${param}*=UTF-8''${encodeURIComponent(filename).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;
}

function textPart(type: 'text/plain' | 'text/html', text: string) {
  return [
    `Content-Type: ${type}; charset="UTF-8"`,
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(Buffer.from(text, 'utf8')),
  ].join('\r\n');
}

function attachmentBytes(content: Uint8Array | string): Buffer {
  if (typeof content === 'string') return Buffer.from(content, 'base64');
  return Buffer.from(content);
}

function attachmentPart(attachment: MimeAttachment) {
  const filename = String(attachment.filename || 'attachment').replace(/[\r\n]+/g, ' ');
  const type = String(attachment.contentType || 'application/octet-stream')
    .split(';')[0]
    .replace(/[\r\n]+/g, '')
    .trim();
  const inline = Boolean(attachment.isInline && attachment.contentId);
  const lines = [
    `Content-Type: ${type}; ${fileParam('name', filename)}`,
    `Content-Disposition: ${inline ? 'inline' : 'attachment'}; ${fileParam('filename', filename)}`,
    'Content-Transfer-Encoding: base64',
  ];
  if (attachment.contentId) lines.push(`Content-ID: <${attachment.contentId.replace(/[<>\r\n]/g, '')}>`);
  lines.push('', base64Lines(attachmentBytes(attachment.content)));
  return lines.join('\r\n');
}

function multipart(type: string, boundary: string, parts: string[]) {
  return [
    `Content-Type: ${type}; boundary="${boundary}"`,
    '',
    ...parts.map((part) => `--${boundary}\r\n${part}`),
    `--${boundary}--`,
  ].join('\r\n');
}

/** Builds the whole message. The result uses CRLF line ends. */
export function buildMimeMessage(input: MimeMessageInput): string {
  const boundary = input.boundary ?? randomBoundary;
  const headers = [
    addressHeader('To', input.to),
    addressHeader('Cc', input.cc),
    addressHeader('Bcc', input.bcc),
    addressHeader('Reply-To', input.replyTo),
    header('Subject', encodeHeaderText(input.subject || '')),
    `Date: ${(input.date ?? new Date()).toUTCString()}`,
    'MIME-Version: 1.0',
    input.inReplyTo ? header('In-Reply-To', input.inReplyTo.replace(/[\r\n]+/g, ' ')) : null,
    input.references ? header('References', input.references.replace(/[\r\n]+/g, ' ')) : null,
  ].filter((line): line is string => Boolean(line));

  const body = input.body || '';
  const content = input.isPlaintext
    ? textPart('text/plain', body)
    : multipart('multipart/alternative', boundary(), [
        textPart('text/plain', htmlToText(body, { wordwrap: 78 })),
        textPart('text/html', body),
      ]);
  const attachments = input.attachments || [];
  const top = attachments.length
    ? multipart('multipart/mixed', boundary(), [content, ...attachments.map(attachmentPart)])
    : content;
  return `${headers.join('\r\n')}\r\n${top}\r\n`;
}

/** The References value of a reply: the parent's References, then its Message-ID. */
export function replyReferences(parentMessageId: string | undefined, parentReferences: string | undefined) {
  const ids = String(parentReferences || '')
    .split(/\s+/)
    .filter(Boolean);
  if (parentMessageId && !ids.includes(parentMessageId)) ids.push(parentMessageId);
  return ids.length ? ids.join(' ') : undefined;
}

/** A reply subject: "Re: " unless the subject already starts with it. */
export function replySubject(subject: string) {
  return /^\s*re:/i.test(subject) ? subject : `Re: ${subject}`;
}
