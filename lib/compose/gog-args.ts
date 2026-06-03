// Builders for the `gog gmail send` argv used by both the user-facing compose
// route and the agent-callable tools. Keeping them here means HTML/attachment
// support stays in one place — the send tool, the reply tool, and the
// /api/compose multipart route all emit identical args.

export interface BaseFields {
  account: string;
  subject?: string;
  body?: string;
  html?: string;
  from?: string;
  attachmentPaths?: string[];
}

export interface SendFields extends BaseFields {
  to: string;
  cc?: string;
  bcc?: string;
}

export interface ReplyFields extends BaseFields {
  messageId?: string;
  threadId?: string;
  to?: string;
  replyAll?: boolean;
}

function pushCommon(args: string[], fields: BaseFields) {
  if (fields.subject !== undefined) args.push('--subject', fields.subject);
  if (fields.body !== undefined) args.push('--body', fields.body);
  if (fields.html) args.push('--body-html', fields.html);
  if (fields.from) args.push('--from', fields.from);
  for (const p of fields.attachmentPaths || []) args.push('--attach', p);
}

export function buildSendArgs(fields: SendFields): string[] {
  const args = ['--account', fields.account, '--json', 'gmail', 'send', '--to', fields.to, '--no-input'];
  if (fields.cc) args.push('--cc', fields.cc);
  if (fields.bcc) args.push('--bcc', fields.bcc);
  pushCommon(args, fields);
  return args;
}

export function buildReplyArgs(fields: ReplyFields): string[] {
  if (!fields.messageId && !fields.threadId) {
    throw new Error('messageId or threadId is required for reply');
  }
  const args = ['--account', fields.account, '--json', 'gmail', 'send', '--no-input'];
  if (fields.messageId) args.push('--reply-to-message-id', fields.messageId);
  else if (fields.threadId) args.push('--thread-id', fields.threadId);
  if (fields.replyAll) args.push('--reply-all');
  else if (fields.to) args.push('--to', fields.to);
  else throw new Error('to is required for reply unless replyAll is true');
  pushCommon(args, fields);
  return args;
}
