import { describe, expect, test } from 'bun:test';
import './tools/harness';
import { calendarListCalendars, calendarListEvents } from '../lib/tools/calendar';
import { corpusCount, corpusSearch, senderProfile, threadTimeline } from '../lib/tools/corpus';
import { listAccounts, readThread, searchThreads } from '../lib/tools/mail';
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
    await expect(runTool(mcpSearch.handler, { query: 'open PRs' }, toolContext({ userId: null }))).rejects.toThrow(
      /Not authenticated/,
    );
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
    await expect(runTool(listRecentOperationsTool.handler, { limit: 10 }, toolContext({ userId: null }))).rejects.toThrow(
      /Not authenticated/,
    );
    await expect(runTool(undoOperationTool.handler, { operationId: 'op_1' }, toolContext({ userId: null }))).rejects.toThrow(
      /Not authenticated/,
    );
  });
});

describe('hosted tool configuration guards', () => {
  test('corpus tools fail when no accounts or index are available', async () => {
    await expect(runTool(corpusSearch.handler, { query: 'invoice', max: 5, includeConnectedTools: false })).rejects.toThrow(
      /No connected accounts or tools to search|Convex is not configured/,
    );
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
    const previous = process.env.BROWSERBASE_API_KEY;
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
      if (previous !== undefined) process.env.BROWSERBASE_API_KEY = previous;
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
});
