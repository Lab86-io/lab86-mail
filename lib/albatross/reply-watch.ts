/** Persisted independently of the plan: waiting for a person is not a plan step. */
export interface ReplyWatch {
  id: string;
  accountId: string;
  threadId: string;
  senderEmails: string[];
  requirement: string;
  after: number;
  startedAt: number;
}

export interface ReplyMessage {
  accountId: string;
  providerThreadId: string;
  from: string;
  receivedAt: number;
  subject: string;
  snippet: string;
  textBody?: string;
  labels: string[];
  headers?: unknown;
}

export function mailAddresses(header: string): string[] {
  return [
    ...new Set(header.toLowerCase().match(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}/g) || []),
  ];
}

/** A candidate must be new incoming mail from the expected person, never our sent copy. */
export function isReplyCandidate(watch: ReplyWatch, message: ReplyMessage, selfEmails: string[]): boolean {
  if (message.accountId !== watch.accountId || message.receivedAt <= watch.after) return false;
  const from = mailAddresses(message.from);
  if (!from.length || from.some((email) => selfEmails.includes(email))) return false;
  if (!from.some((email) => watch.senderEmails.includes(email))) return false;
  if (message.labels.some((label) => /^(sent|drafts?|trash|spam|junk)$/i.test(label))) return false;
  const headers = Array.isArray(message.headers)
    ? Object.fromEntries(
        message.headers
          .filter((row) => row && typeof row.name === 'string')
          .map((row) => [row.name.toLowerCase(), row.value]),
      )
    : Object.fromEntries(
        Object.entries(message.headers || {}).map(([key, value]) => [key.toLowerCase(), value]),
      );
  if (headers['auto-submitted'] && headers['auto-submitted'] !== 'no') return false;
  if (headers['list-id'] || /bulk|list|junk/i.test(String(headers.precedence || ''))) return false;
  if (
    /^(automatic reply|auto.?reply|out of (the )?office|undeliverable|delivery status notification)\b/i.test(
      message.subject,
    )
  )
    return false;
  return true;
}
