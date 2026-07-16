import { describe, expect, test } from 'bun:test';
import { mcpSyncStateFields } from '../lib/mcp/sync-state';

describe('MCP sync-state patch fields', () => {
  test('omits absent account metadata so a patch preserves stored values', () => {
    const fields = mcpSyncStateFields(
      { userId: 'user_1', connectionId: 'granola_1', server: 'granola', status: 'syncing' },
      1_000,
    );
    expect(fields).not.toHaveProperty('accountEmail');
    expect(fields).not.toHaveProperty('workspaceName');
  });

  test('persists account metadata when a sync supplies it', () => {
    expect(
      mcpSyncStateFields(
        {
          userId: 'user_1',
          connectionId: 'granola_1',
          server: 'granola',
          status: 'ready',
          accountEmail: 'josh@example.com',
          workspaceName: 'Lab86',
        },
        1_000,
      ),
    ).toMatchObject({ accountEmail: 'josh@example.com', workspaceName: 'Lab86' });
  });
});
