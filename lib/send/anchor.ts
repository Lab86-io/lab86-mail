import { emailFromHeader } from '../shared/format';
import type { Message } from '../shared/types';
import { resolveMessage, resolveThreadMessages } from '../store/messages';

type AnchorLoaders = {
  resolveMessage: typeof resolveMessage;
  resolveThreadMessages: typeof resolveThreadMessages;
};

const defaultLoaders: AnchorLoaders = { resolveMessage, resolveThreadMessages };

/**
 * The message a reply or forward answers. With a message id, it is that exact
 * message from the corpus or the provider, and nothing else. With only a
 * thread id, it is the newest message of the full thread.
 */
export async function resolveSendAnchor(
  input: { account: string; messageId?: string; threadId?: string; userId?: string | null },
  loaders: AnchorLoaders = defaultLoaders,
): Promise<Message> {
  const { account, messageId, threadId, userId } = input;
  if (messageId) {
    const exact = await loaders.resolveMessage(account, messageId, { userId, threadId });
    if (!exact) {
      throw new Error(
        'Cannot find the original message. It may be deleted, or the mailbox may need reconnection.',
      );
    }
    return exact;
  }
  if (threadId) {
    const messages = await loaders.resolveThreadMessages(account, threadId, { userId });
    const newest = messages.reduce<Message | null>(
      (best, message) => (!best || Number(message.date || 0) >= Number(best.date || 0) ? message : best),
      null,
    );
    if (newest) return newest;
  }
  throw new Error(
    'Cannot find the original message. It may be deleted, or the mailbox may need reconnection.',
  );
}

function replySubject(subject?: string) {
  return /^re:/i.test(subject || '') ? String(subject) : `Re: ${subject || '(no subject)'}`;
}

export function replyTargetFor(anchor: Message) {
  const to = emailFromHeader(anchor.from) || anchor.from;
  if (!to) throw new Error('Cannot reply — original sender is missing.');
  return { to, subject: replySubject(anchor.subject), replyToMessageId: anchor._id };
}

export function replyAllTargetFor(anchor: Message, account: string) {
  const self = account.toLowerCase();
  const recipients = new Set<string>();
  for (const field of [anchor.from, anchor.to, anchor.cc]) {
    for (const item of String(field || '').split(/[,;]/)) {
      const email = emailFromHeader(item) || item.trim();
      if (!email || email.toLowerCase() === self) continue;
      recipients.add(email);
    }
  }
  return {
    to: [...recipients].join(', '),
    subject: replySubject(anchor.subject),
    replyToMessageId: anchor._id,
  };
}

export function buildForwardMessagePayload(
  original: Message,
  input: { body?: string; html?: string },
): { subject: string; body: string; html?: string } {
  const subject = original.subject?.startsWith('Fwd:')
    ? original.subject
    : `Fwd: ${original.subject || '(no subject)'}`;
  const headerBlock = [
    '---------- Forwarded message ----------',
    `From: ${original.from}`,
    `Date: ${new Date(original.date).toISOString()}`,
    `Subject: ${original.subject || ''}`,
    `To: ${original.to || ''}`,
    original.cc ? `Cc: ${original.cc}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  const quotedText = [input.body || '', '', headerBlock, '', original.textBody || ''].join('\n');
  const quotedHtml = input.html
    ? [
        input.html,
        '<br/><br/>',
        `<div style="border-left:2px solid currentColor;padding-left:.6em;opacity:.72">`,
        `<div>---------- Forwarded message ----------</div>`,
        `<div>From: ${escapeHtml(original.from)}</div>`,
        `<div>Date: ${new Date(original.date).toISOString()}</div>`,
        `<div>Subject: ${escapeHtml(original.subject || '')}</div>`,
        `<div>To: ${escapeHtml(original.to || '')}</div>`,
        original.cc ? `<div>Cc: ${escapeHtml(original.cc)}</div>` : '',
        `</div>`,
        original.htmlBody || `<pre>${escapeHtml(original.textBody || '')}</pre>`,
      ].join('')
    : undefined;
  return { subject, body: quotedText, html: quotedHtml };
}

function escapeHtml(s: string): string {
  return String(s || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
