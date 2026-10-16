import { describe, expect, test } from 'bun:test';
import './tools/harness';
import { calendarListCalendars, calendarListEvents } from '../lib/tools/calendar';
import { corpusCount, corpusSearch, senderProfile, threadTimeline } from '../lib/tools/corpus';
import {
  listAccounts,
  listAttachments,
  readThread,
  readThreadOutput,
  searchThreads,
} from '../lib/tools/mail';
import { mcpCreateTask, mcpListItems, mcpSearch } from '../lib/tools/mcp';
import { listRecentOperationsTool, undoOperationTool } from '../lib/tools/operations-tools';
import { tasksCreateCard, tasksListBoards } from '../lib/tools/tasks';
import { browserbaseFetch, browserbaseSearch } from '../lib/tools/web';
import { runTool, seedThreadMessage, toolContext } from './tools/harness';

describe('hosted tool auth guards', () => {
  test('calendar tools require authentication', async () => {
    await expect(runTool(calendarListCalendars.handler, {}, toolContext({ userId: null }))).rejects.toThrow(
      /Not authenticated/,
    );
    await expect(
      runTool(
        calendarListEvents.handler,
        { fromIso: '2026-06-10T00:00:00', toIso: '2026-06-11T00:00:00' },
        toolContext({ userId: null }),
      ),
    ).rejects.toThrow(/Not authenticated/);
  });

  test('tasks and mcp tools require authentication', async () => {
    await expect(runTool(tasksListBoards.handler, {}, toolContext({ userId: null }))).rejects.toThrow(
      /Not authenticated/,
    );
    await expect(
      runTool(
        tasksCreateCard.handler,
        { title: 'Follow up', column: 'Inbox' },
        toolContext({ userId: null }),
      ),
    ).rejects.toThrow(/Not authenticated/);
    await expect(
      runTool(mcpSearch.handler, { query: 'open PRs' }, toolContext({ userId: null })),
    ).rejects.toThrow(/Not authenticated/);
    await expect(runTool(mcpListItems.handler, { limit: 5 }, toolContext({ userId: null }))).rejects.toThrow(
      /Not authenticated/,
    );
    await expect(
      runTool(
        mcpCreateTask.handler,
        {
          connectionId: 'conn_1',
          externalId: 'PR-1',
          server: 'github',
          title: 'Review PR',
        },
        toolContext({ userId: null }),
      ),
    ).rejects.toThrow(/Not authenticated/);
  });

  test('operations tools require authentication', async () => {
    await expect(
      runTool(listRecentOperationsTool.handler, { limit: 10 }, toolContext({ userId: null })),
    ).rejects.toThrow(/Not authenticated/);
    await expect(
      runTool(undoOperationTool.handler, { operationId: 'op_1' }, toolContext({ userId: null })),
    ).rejects.toThrow(/Not authenticated/);
  });
});

describe('hosted tool configuration guards', () => {
  test('corpus tools fail when no accounts or index are available', async () => {
    await expect(
      runTool(corpusSearch.handler, { query: 'invoice', max: 5, includeConnectedTools: false }),
    ).rejects.toThrow(/No connected accounts or tools to search|Convex is not configured/);
    await expect(runTool(senderProfile.handler, { sender: 'billing@example.test' })).rejects.toThrow(
      /Mail index is not available/,
    );
    await expect(runTool(corpusCount.handler, {})).rejects.toThrow(/Mail index is not available/);
    await expect(
      runTool(threadTimeline.handler, { account: 'jakob@example.test', threadId: 'thread_1' }),
    ).rejects.toThrow(/Mail index is not available/);
  });

  test('search_threads requires sign-in when user id is missing', async () => {
    await expect(
      runTool(
        searchThreads.handler,
        {
          account: 'jakob@example.test',
          query: 'from:alerts@example.test',
          max: 5,
        },
        { userId: null },
      ),
    ).rejects.toThrow(/Sign in required for hosted mail access/);
  });

  test('list_accounts returns empty without user id', async () => {
    const result = await runTool(listAccounts.handler, {}, { userId: null });
    expect(result.accounts).toEqual([]);
  });

  test('browserbase tools require API key', async () => {
    const previous = {
      BROWSERBASE_API_KEY: process.env.BROWSERBASE_API_KEY,
      LAB86_BROWSERBASE_API_KEY: process.env.LAB86_BROWSERBASE_API_KEY,
      BB_API_KEY: process.env.BB_API_KEY,
    };
    delete process.env.BROWSERBASE_API_KEY;
    delete process.env.LAB86_BROWSERBASE_API_KEY;
    delete process.env.BB_API_KEY;
    try {
      await expect(runTool(browserbaseSearch.handler, { query: 'lab86 mail', limit: 3 })).rejects.toThrow(
        /BROWSERBASE_API_KEY/,
      );
      await expect(runTool(browserbaseFetch.handler, { url: 'https://example.test/docs' })).rejects.toThrow(
        /BROWSERBASE_API_KEY/,
      );
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });
});

describe('read_thread formatting', () => {
  test('requires provider access when the hosted corpus is unavailable', async () => {
    const { account, threadId } = await seedThreadMessage({
      subject: 'Design review',
      textBody: 'Please review the attached mockups.',
    });
    await expect(runTool(readThread.handler, { account, threadId, maxMessages: 5 })).rejects.toThrow(
      /Nylas|Convex/,
    );
  });

  const options = { account: 'acct-dana', threadId: 'thread-1', maxCharsPerMessage: 200, maxMessages: 12 };

  test('each message carries its messageId, and each attachment its id, name, size, and mime type', () => {
    const out = readThreadOutput(
      {
        subject: 'Forms for your first payment',
        messages: [
          {
            _id: 'msg-1',
            from: 'Payroll Desk <payroll@example.com>',
            to: 'dana@example.com',
            date: 1_000,
            textBody: 'Please fill in both forms.',
            // The normalized shape (lib/nylas/normalize.ts).
            attachments: [
              { attachmentId: 'att-w9', filename: 'W-9.pdf', mimeType: 'application/pdf', size: 1_234 },
              {
                attachmentId: 'att-dd',
                filename: 'Subcontractor Direct Deposit Authorization.pdf',
                mimeType: 'application/pdf',
                size: 0,
              },
            ],
          },
          {
            _id: 'msg-2',
            from: 'Dana Example <dana@example.com>',
            date: 2_000,
            htmlBody: '<p>Thanks, I <b>will</b> send them.</p>',
            attachments: [],
          },
        ],
      },
      options,
    );
    expect(out).toEqual({
      account: 'acct-dana',
      threadId: 'thread-1',
      subject: 'Forms for your first payment',
      messageCount: 2,
      truncated: false,
      messages: [
        {
          messageId: 'msg-2',
          from: 'Dana Example <dana@example.com>',
          to: undefined,
          date: 2_000,
          body: 'Thanks, I will send them.',
        },
        {
          messageId: 'msg-1',
          from: 'Payroll Desk <payroll@example.com>',
          to: 'dana@example.com',
          date: 1_000,
          body: 'Please fill in both forms.',
          attachments: [
            { attachmentId: 'att-w9', filename: 'W-9.pdf', mimeType: 'application/pdf', size: 1_234 },
            {
              attachmentId: 'att-dd',
              filename: 'Subcontractor Direct Deposit Authorization.pdf',
              mimeType: 'application/pdf',
            },
          ],
        },
      ],
    });
    expect(readThread.output.safeParse(out).success).toBe(true);
  });

  test('raw provider attachment fields, a missing subject, and the caps', () => {
    const out = readThreadOutput(
      {
        messages: [
          {
            id: 'raw-1',
            date: 5,
            snippet: 'x'.repeat(400),
            attachments: [{ id: 'att-raw', name: 'scan.png', content_type: 'image/png' }, {}],
          },
          { _id: 'old', date: 1, textBody: 'older' },
          { _id: 'oldest', textBody: 'oldest' },
        ],
      },
      { ...options, maxMessages: 1 },
    );
    expect(out.subject).toBe('(no subject)');
    expect(out.messageCount).toBe(3);
    expect(out.truncated).toBe(true);
    expect(out.messages).toHaveLength(1);
    expect(out.messages[0].messageId).toBe('raw-1');
    expect(out.messages[0].from).toBe('');
    expect(out.messages[0].body.length).toBeLessThanOrEqual(201);
    expect(out.messages[0].body.endsWith('…')).toBe(true);
    expect(out.messages[0].attachments).toEqual([
      // The attachment with no id is left out: mail_attachment_save could not take it.
      { attachmentId: 'att-raw', filename: 'scan.png', mimeType: 'image/png' },
    ]);
    expect(readThreadOutput({}, options).messages).toEqual([]);
  });

  test('list_attachments and read_thread name the ids that mail_attachment_save takes', () => {
    expect(listAttachments.description).toContain('messageId comes from read_thread');
    expect(readThread.description).toContain('mail_attachment_save');
  });
});
