import { afterAll, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dataDir = mkdtempSync(path.join(tmpdir(), 'lab86-mail-test-'));
process.env.LAB86_MAIL_DATA_DIR = dataDir;
process.env.MAIL_OS_DATA_DIR = dataDir;
process.env.OPENROUTER_API_KEY = '';
process.env.OPENAI_API_KEY = '';
process.env.ANTHROPIC_API_KEY = '';

const gogCalls: string[][] = [];

mock.module('../lib/gog/pool', () => ({
  runGogJson: async (args: string[]) => {
    gogCalls.push(args);
    if (args.includes('search')) {
      return {
        threads: [
          {
            threadId: 'thread-noreply-search',
            messageId: 'msg-noreply-search',
            from: 'No Reply <noreply@example.test>',
            subject: 'Account notice',
            snippet: 'This is a fake noreply search result.',
            date: new Date('2026-06-03T12:00:00.000Z').toISOString(),
            labels: ['INBOX', 'UNREAD', 'CATEGORY_UPDATES'],
          },
        ],
      };
    }
    if (args.includes('get')) {
      return {
        thread: {
          messages: [
            {
              id: 'msg-noreply-search',
              threadId: 'thread-noreply-search',
              from: 'No Reply <noreply@example.test>',
              to: 'Jakob <jakob@example.test>',
              subject: 'Account notice',
              snippet: 'Fake notice body.',
              date: new Date('2026-06-03T12:00:00.000Z').toISOString(),
              labels: ['INBOX', 'UNREAD'],
            },
          ],
        },
      };
    }
    return {};
  },
}));

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe('compose reply args', () => {
  test('uses only reply-to-message-id when both reply ids are available', async () => {
    const { buildReplyArgs } = await import('../lib/compose/gog-args');
    const args = buildReplyArgs({
      account: 'jakob@example.test',
      messageId: 'msg-123',
      threadId: 'thread-456',
      to: 'sender@example.test',
      body: 'fake reply',
    });

    expect(args).toContain('--reply-to-message-id');
    expect(args).toContain('msg-123');
    expect(args).toContain('--to');
    expect(args).toContain('sender@example.test');
    expect(args).not.toContain('--thread-id');
  });

  test('can fall back to thread-id when no message id exists', async () => {
    const { buildReplyArgs } = await import('../lib/compose/gog-args');
    const args = buildReplyArgs({
      account: 'jakob@example.test',
      threadId: 'thread-456',
      to: 'sender@example.test',
      body: 'fake reply',
    });

    expect(args).toContain('--thread-id');
    expect(args).toContain('thread-456');
    expect(args).toContain('--to');
    expect(args).toContain('sender@example.test');
    expect(args).not.toContain('--reply-to-message-id');
  });

  test('allows reply-all without explicit recipients', async () => {
    const { buildReplyArgs } = await import('../lib/compose/gog-args');
    const args = buildReplyArgs({
      account: 'jakob@example.test',
      messageId: 'msg-123',
      body: 'fake reply all',
      replyAll: true,
    });

    expect(args).toContain('--reply-to-message-id');
    expect(args).toContain('msg-123');
    expect(args).toContain('--reply-all');
    expect(args).not.toContain('--to');
  });
});

describe('agent mail lookup and prompt contract', () => {
  test('search_threads fetches and caches a fake noreply thread without opening it first', async () => {
    const { searchThreads } = await import('../lib/tools/mail');
    const { listThreadsForAccount } = await import('../lib/store/threads');

    const result = await searchThreads.handler(
      {
        account: 'jakob@example.test',
        query: 'from:noreply@example.test newer_than:30d',
        max: 5,
      },
      { agent: 'codex' },
    );

    expect(result.items).toHaveLength(1);
    expect(result.items[0]._id).toBe('thread-noreply-search');
    expect(gogCalls.at(-1)).toContain('--');
    expect(gogCalls.at(-1)).toContain('from:noreply@example.test newer_than:30d');

    const cached = await listThreadsForAccount('jakob@example.test', 5);
    expect(cached.map((thread) => thread._id)).toContain('thread-noreply-search');
  });

  test('system prompt directs named reply requests through search, not the focused thread', async () => {
    const { SYSTEM_PROMPT } = await import('../lib/ai/system-prompt');

    expect(SYSTEM_PROMPT).toContain('reply to this/open/current thread');
    expect(SYSTEM_PROMPT).toContain('search Gmail even if another thread is currently focused');
    expect(SYSTEM_PROMPT).toContain('Do not require the user to open the thread first');
  });
});

describe('AI tools on fake noreply mail with no provider configured', () => {
  test('local fallback paths stay available for all agent-facing AI helpers', async () => {
    const { upsertMessage } = await import('../lib/store/messages');
    const {
      bulkTriage,
      classifyThreads,
      draftReply,
      extractActionItems,
      nlSearch,
      preSendCritique,
      summarizeThread,
      translateThread,
      triageThread,
    } = await import('../lib/tools/ai');

    const account = 'jakob@example.test';
    const threadId = 'thread-noreply-ai';
    await upsertMessage({
      _id: 'msg-noreply-ai',
      threadId,
      account,
      subject: 'Automated account notice',
      from: 'No Reply <noreply@example.test>',
      to: 'Jakob <jakob@example.test>',
      cc: '',
      bcc: '',
      date: Date.parse('2026-06-03T12:00:00.000Z'),
      snippet: 'Your fake account notice is ready.',
      textBody: 'Your fake account notice is ready. No response is needed.',
      htmlBody: '',
      labels: ['INBOX', 'UNREAD', 'CATEGORY_UPDATES'],
      attachments: [],
      headers: {},
      cachedAt: Date.now(),
    });

    const summary = await summarizeThread.handler({ account, threadId }, { agent: 'codex' });
    expect(summary.model).toBe('local');
    expect(summary.summary).toContain('Automated account notice');

    const triage = await triageThread.handler({ account, threadId }, { agent: 'codex' });
    expect(triage.model).toBe('local');
    expect(triage.action).toBe('read');

    const draft = await draftReply.handler(
      {
        account,
        threadId,
        instructions: 'politely confirm no action is needed',
        tone: 'direct',
      },
      { agent: 'codex' },
    );
    expect(draft.model).toBe('local');
    expect(draft.draft).toContain('no action is needed');

    const batch = await bulkTriage.handler(
      {
        items: [
          {
            id: threadId,
            from: 'noreply@example.test',
            subject: 'Automated account notice',
            snippet: 'No response is needed.',
          },
        ],
      },
      { agent: 'codex' },
    );
    expect(batch.model).toBe('local');
    expect(batch.verdicts[0].id).toBe(threadId);

    const classified = await classifyThreads.handler(
      {
        threads: [
          {
            id: threadId,
            account,
            from: 'noreply@example.test',
            subject: 'Automated account notice',
            snippet: 'No response is needed.',
            labels: ['CATEGORY_UPDATES'],
            unread: true,
          },
        ],
      },
      { agent: 'codex' },
    );
    expect(classified.model).toBe('local');
    expect(classified.verdicts[0].id).toBe(threadId);

    const actions = await extractActionItems.handler({ account, threadId }, { agent: 'codex' });
    expect(actions.model).toBe('local');
    expect(actions.items).toEqual([]);

    const translation = await translateThread.handler(
      { account, threadId, language: 'english' },
      { agent: 'codex' },
    );
    expect(translation.model).toBe('none');
    expect(translation.translation).toBe('');

    const critique = await preSendCritique.handler(
      { draftBody: 'thanks, no action needed.', threadContext: 'fake noreply notice' },
      { agent: 'codex' },
    );
    expect(critique.model).toBe('local');
    expect(critique.verdict).toBe('ok');

    const search = await nlSearch.handler(
      { description: 'from noreply@example.test newer than 30 days' },
      { agent: 'codex' },
    );
    expect(search.model).toBe('local');
    expect(search.query).toBe('from noreply@example.test newer than 30 days');
  });
});
