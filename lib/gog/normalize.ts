import { dateToEpoch } from '../shared/format';
import type { Attachment, Message, Thread } from '../shared/types';

function decodeBodyData(data: string | undefined): string {
  if (!data) return '';
  return Buffer.from(String(data).replaceAll('-', '+').replaceAll('_', '/'), 'base64').toString('utf8');
}

function headerMap(raw: any): Record<string, string> {
  const headers = raw?.payload?.headers || raw?.headers || [];
  const map: Record<string, string> = {};
  for (const item of headers) {
    const name = item.name || item.key;
    if (name) map[name.toLowerCase()] = item.value || '';
  }
  return map;
}

interface Bodies {
  html: string;
  text: string;
  attachments: Attachment[];
}

function collectParts(part: any, out: Bodies): Bodies {
  if (!part) return out;
  const mime = part.mimeType || part.mime_type || '';
  const body = part.body || {};
  const decoded = decodeBodyData(body.data);
  if (decoded && mime.includes('text/html')) out.html += decoded;
  if (decoded && mime.includes('text/plain')) out.text += decoded;
  // attachments
  if (body.attachmentId || body.attachment_id) {
    out.attachments.push({
      filename: part.filename || 'attachment',
      mimeType: mime,
      size: body.size || 0,
      attachmentId: body.attachmentId || body.attachment_id,
    });
  }
  for (const child of part.parts || []) collectParts(child, out);
  return out;
}

export function normalizeGogMessage(raw: any, account: string): Message {
  const message = raw?.message || raw?.result || raw?.data || raw;
  const headers = headerMap(message);
  const bodies = collectParts(message.payload || message, { html: '', text: '', attachments: [] });
  const text =
    (typeof message.text === 'string' && message.text) ||
    (typeof message.bodyText === 'string' && message.bodyText) ||
    bodies.text ||
    message.snippet ||
    '';
  const html = (typeof message.html === 'string' && message.html) || message.bodyHtml || bodies.html || '';
  const labels: string[] = message.labelIds || message.labels || [];
  return {
    _id: message.id || message.messageId || message.message_id || '',
    threadId: message.threadId || message.thread_id || '',
    account,
    subject: headers.subject || message.subject || '(no subject)',
    from: headers.from || message.from || '',
    to: headers.to || message.to || '',
    cc: headers.cc || message.cc || '',
    bcc: headers.bcc || message.bcc || '',
    date: dateToEpoch(headers.date || message.date || message.internalDate || message.internal_date),
    snippet: message.snippet || '',
    textBody: text,
    htmlBody: html,
    labels,
    attachments: bodies.attachments,
    headers,
    cachedAt: Date.now(),
  };
}

export function normalizeGogSearchItem(raw: any, account: string): Partial<Thread> & { _id: string } {
  const id = raw.threadId || raw.thread_id || raw.id || raw.messageId || raw.message_id || '';
  const labels: string[] = raw.labels || raw.labelIds || raw.label_ids || [];
  return {
    _id: String(id),
    account,
    subject: raw.subject || raw.Subject || '(no subject)',
    fromAddress: raw.from || raw.From || raw.sender || '',
    lastDate: dateToEpoch(raw.date || raw.Date || raw.internalDate || raw.internal_date),
    snippet: raw.snippet || raw.preview || '',
    labels: Array.isArray(labels) ? labels : String(labels).split(',').filter(Boolean),
    unread: (Array.isArray(labels) ? labels : []).includes('UNREAD'),
  };
}
