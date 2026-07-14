import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  __setMcpToolDepsForTest,
  githubSearch,
  mcpCreateTask,
  mcpListItems,
  mcpSearch,
} from '../lib/tools/mcp';
import { runTool, TEST_USER } from './tools/harness';

const queryCalls: Array<{ fn: unknown; args: any }> = [];
const mutationCalls: Array<{ fn: unknown; args: any }> = [];
const operations: any[] = [];

const item = {
  server: 'github',
  kind: 'commit',
  title: 'Living index',
  state: 'committed',
  author: 'jakob',
  repository: 'Lab86-io/lab86-mail',
  organization: 'Lab86-io',
  parentExternalId: 'github:project:PVT_1',
  sha: 'abc',
  url: 'https://github.com/Lab86-io/lab86-mail/commit/abc',
  updatedAtSource: 123,
  connectionId: 'conn_1',
  externalId: 'github:commit:Lab86-io/lab86-mail:abc',
};

beforeEach(() => {
  queryCalls.length = 0;
  mutationCalls.length = 0;
  operations.length = 0;
  __setMcpToolDepsForTest({
    convexQuery: (async (fn: unknown, args: any) => {
      queryCalls.push({ fn, args });
      return [item];
    }) as any,
    convexMutation: (async (fn: unknown, args: any) => {
      mutationCalls.push({ fn, args });
      return 'card_1';
    }) as any,
    resolveBoardAndColumn: (async () => ({
      board: { boardId: 'board_1', title: 'Personal' },
      column: { columnId: 'column_1', name: 'Inbox' },
    })) as any,
    recordOperation: (async (input: any) => {
      operations.push(input);
      return 'operation_1';
    }) as any,
  });
});

afterAll(() => __setMcpToolDepsForTest());

describe('MCP tools', () => {
  test('maps general and GitHub-filtered search results into actionable evidence', async () => {
    const general = await runTool(mcpSearch.handler, { query: 'living', server: 'github', limit: 5 });
    const github = await runTool(githubSearch.handler, {
      query: 'living',
      repository: 'Lab86-io/lab86-mail',
      organization: 'Lab86-io',
      kind: 'commit',
      state: 'committed',
      limit: 7,
    });

    expect(general.items[0]).toMatchObject({ sha: 'abc', connectionId: 'conn_1' });
    expect(github.items[0]).toMatchObject({ repository: 'Lab86-io/lab86-mail' });
    expect(queryCalls[0]?.args).toMatchObject({
      userId: TEST_USER.userId,
      query: 'living',
      server: 'github',
      limit: 5,
    });
    expect(queryCalls[1]?.args).toMatchObject({
      server: 'github',
      repository: 'Lab86-io/lab86-mail',
      organization: 'Lab86-io',
      kind: 'commit',
      state: 'committed',
      limit: 7,
    });
  });

  test('lists brief items and creates a linked, undoable task', async () => {
    const listed = await runTool(mcpListItems.handler, { limit: 3 });
    const created = await runTool(mcpCreateTask.handler, {
      connectionId: 'conn_1',
      externalId: item.externalId,
      server: 'github',
      title: 'Follow the living-index commit',
      url: item.url,
      boardId: 'board_1',
      column: 'Inbox',
    });

    expect(listed.items).toHaveLength(1);
    expect(created).toEqual({ ok: true, cardId: 'card_1', operationId: 'operation_1' });
    expect(mutationCalls).toHaveLength(2);
    expect(mutationCalls[0]?.args.source).toMatchObject({
      kind: 'mcp',
      server: 'github',
      externalId: item.externalId,
    });
    expect(mutationCalls[1]?.args).toMatchObject({ cardId: 'card_1', externalId: item.externalId });
    expect(operations[0]).toMatchObject({
      userId: TEST_USER.userId,
      tool: 'mcp_create_task',
      target: { kind: 'card', id: 'card_1', boardId: 'board_1' },
      inverse: { kind: 'tasks.delete_card', payload: { cardId: 'card_1' } },
    });
  });

  test('still requires authentication for the GitHub-specific search', async () => {
    await expect(
      runTool(githubSearch.handler, { query: 'anything', limit: 1 }, { userId: null }),
    ).rejects.toThrow('Not authenticated');
  });
});
