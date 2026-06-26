import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runWithAiRequestContext } from '../../lib/ai/context';
import type { ToolContext } from '../../lib/tools/registry';

const dataDir = mkdtempSync(path.join(tmpdir(), 'lab86-mail-tools-'));
process.env.LAB86_MAIL_DATA_DIR = dataDir;
process.env.MAIL_OS_DATA_DIR = dataDir;
process.env.OPENROUTER_API_KEY = '';
process.env.OPENAI_API_KEY = '';
process.env.ANTHROPIC_API_KEY = '';
delete process.env.NEXT_PUBLIC_CONVEX_URL;
delete process.env.CONVEX_URL;

export const TEST_USER = {
  userId: 'test_user_tools',
  userEmail: 'jakob@example.test',
  userName: 'Jakob',
  agent: 'codex' as const,
  userTimezone: 'America/New_York',
};

export function toolContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    agent: 'codex',
    userId: TEST_USER.userId,
    userEmail: TEST_USER.userEmail,
    userName: TEST_USER.userName,
    userTimezone: TEST_USER.userTimezone,
    ...overrides,
  };
}

export async function withToolContext<T>(
  fn: () => Promise<T>,
  overrides: Partial<typeof TEST_USER> = {},
): Promise<T> {
  return runWithAiRequestContext({ ...TEST_USER, ...overrides }, fn);
}

export async function runTool<T>(
  handler: (args: any, ctx: ToolContext) => Promise<T>,
  args: unknown,
  overrides: Partial<ToolContext> = {},
): Promise<T> {
  return withToolContext(() => handler(args as any, toolContext(overrides)));
}

export async function seedThreadMessage(input: {
  account?: string;
  threadId?: string;
  messageId?: string;
  subject?: string;
  from?: string;
  to?: string;
  textBody?: string;
  labels?: string[];
  unread?: boolean;
} = {}) {
  return withToolContext(async () => {
    const account = input.account ?? 'jakob@example.test';
    const threadId = input.threadId ?? 'thread_seed';
    const messageId = input.messageId ?? 'msg_seed';
    const labels = input.labels ?? (input.unread ? ['INBOX', 'UNREAD'] : ['INBOX']);
    const { upsertMessage } = await import('../../lib/store/messages');
    const { upsertThread } = await import('../../lib/store/threads');
    await upsertMessage({
      _id: messageId,
      threadId,
      account,
      subject: input.subject ?? 'Seed subject',
      from: input.from ?? 'Sender <sender@example.test>',
      to: input.to ?? 'Jakob <jakob@example.test>',
      cc: '',
      bcc: '',
      date: Date.parse('2026-06-10T12:00:00.000Z'),
      snippet: input.textBody?.slice(0, 120) ?? 'Seed snippet',
      textBody: input.textBody ?? 'Seed body',
      htmlBody: '',
      labels,
      attachments: [],
      headers: {},
      cachedAt: Date.now(),
    });
    await upsertThread(account, {
      _id: threadId,
      subject: input.subject ?? 'Seed subject',
      fromAddress: input.from ?? 'Sender <sender@example.test>',
      lastDate: Date.parse('2026-06-10T12:00:00.000Z'),
      snippet: input.textBody?.slice(0, 120) ?? 'Seed snippet',
      labels,
      unread: input.unread ?? true,
      cachedAt: Date.now(),
    });
    return { account, threadId, messageId };
  });
}
