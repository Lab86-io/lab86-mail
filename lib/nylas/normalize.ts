import { htmlToText } from 'html-to-text';
import type { Message as NylasMessage, Thread as NylasThread } from 'nylas';
import type { Account, Attachment, LabelRecord, Message, Thread } from '@/lib/shared/types';

interface ConnectedAccount {
  accountId: string;
  email: string;
  provider: 'google' | 'microsoft' | 'icloud' | 'imap';
  status: string;
  displayName?: string;
  grantId: string;
  scopes?: string[];
}

export function normalizeNylasAccount(row: ConnectedAccount): Account {
  return {
    accountId: row.accountId,
    email: row.email,
    provider: row.provider,
    authed: row.status === 'connected',
    primary: false,
    displayName: row.displayName,
    services: ['nylas', row.provider],
  };
}

export function normalizeNylasThread(
  thread: NylasThread,
  account: string,
): Partial<Thread> & { _id: string } {
  const latest = thread.latestDraftOrMessage;
  const date =
    Number(
      thread.latestMessageReceivedDate ||
        thread.latestMessageSentDate ||
        latest?.date ||
        thread.earliestMessageDate,
    ) * 1000;
  return {
    _id: thread.id,
    account,
    subject: thread.subject || latest?.subject || '(no subject)',
    fromAddress: formatEmailList(latest?.from || thread.participants || []),
    lastDate: date || Date.now(),
    snippet: thread.snippet || latest?.snippet || '',
    labels: thread.folders || [],
    unread: Boolean(thread.unread),
    starred: Boolean(thread.starred),
    cachedAt: Date.now(),
  };
}

export function normalizeNylasMessage(message: NylasMessage, account: string): Message {
  const body = message.body || '';
  const headers: Record<string, string> = {};
  for (const header of message.headers || []) headers[header.name.toLowerCase()] = header.value;
  return {
    _id: message.id,
    threadId: message.threadId || message.id,
    account,
    subject: message.subject || '(no subject)',
    from: formatEmailList(message.from || []),
    to: formatEmailList(message.to || []),
    cc: formatEmailList(message.cc || []),
    bcc: formatEmailList(message.bcc || []),
    date: Number(message.date || 0) * 1000 || Date.now(),
    snippet: message.snippet || '',
    textBody: htmlToText(body, {
      wordwrap: false,
      selectors: [{ selector: 'a', options: { ignoreHref: false } }],
    }),
    htmlBody: body,
    labels: message.folders || [],
    attachments: (message.attachments || []).map(normalizeNylasAttachment),
    headers,
    cachedAt: Date.now(),
  };
}

export function normalizeNylasAttachment(attachment: any): Attachment {
  return {
    filename: attachment.filename || attachment.name || 'attachment',
    mimeType: attachment.contentType || attachment.content_type || 'application/octet-stream',
    size: Number(attachment.size || 0),
    attachmentId: attachment.id || attachment.attachmentId || attachment.attachment_id || '',
  };
}

export function normalizeNylasFolder(folder: any): LabelRecord {
  return {
    id: folder.id,
    name: folder.name,
    type: folder.systemFolder || folder.attributes?.length ? 'system' : 'user',
    messagesTotal: folder.totalCount,
    threadsTotal: folder.totalCount,
  };
}

export function emailList(value: string | undefined): Array<{ email: string; name?: string }> {
  return String(value || '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const match = part.match(/^(.*?)<([^>]+)>$/);
      if (match) return { name: match[1].trim().replace(/^"|"$/g, '') || undefined, email: match[2].trim() };
      return { email: part };
    });
}

function formatEmailList(items: Array<{ email?: string; name?: string }>) {
  return items
    .map((item) => {
      const email = item.email || '';
      const name = item.name || '';
      return name && email ? `${name} <${email}>` : email || name;
    })
    .filter(Boolean)
    .join(', ');
}
