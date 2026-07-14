import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { detachedMcpSource } from '../lib/mcp/disconnect';

describe('MCP disconnect provenance', () => {
  test('turns a live connector source into a stable external snapshot', () => {
    expect(
      detachedMcpSource({
        source: {
          kind: 'mcp',
          server: 'github',
          connectionId: 'github_old',
          externalId: 'github:pull_request:Lab86-io/lab86-mail#96',
          title: 'Old title',
          url: 'https://github.com/Lab86-io/lab86-mail/pull/96',
        },
        connectionId: 'github_old',
        server: 'github',
        externalId: 'github:pull_request:Lab86-io/lab86-mail#96',
        itemTitle: 'Render Area inbox',
        fallbackTitle: 'Track GitHub work',
        disconnectedAt: 1_786_000_000_000,
      }),
    ).toEqual({
      kind: 'external_snapshot',
      server: 'github',
      externalId: 'github:pull_request:Lab86-io/lab86-mail#96',
      title: 'Render Area inbox',
      url: 'https://github.com/Lab86-io/lab86-mail/pull/96',
      disconnectedAt: 1_786_000_000_000,
    });
  });

  test('does not detach provenance owned by another connection', () => {
    expect(
      detachedMcpSource({
        source: { kind: 'mcp', connectionId: 'github_new' },
        connectionId: 'github_old',
        server: 'github',
        externalId: 'issue-1',
        fallbackTitle: 'Keep me',
        disconnectedAt: 1,
      }),
    ).toBeNull();
  });

  test('disconnect schedules a resumable cascade over links, evidence, items, and credentials', () => {
    const mutation = readFileSync(path.join(process.cwd(), 'convex/mcp.ts'), 'utf8');
    const schema = readFileSync(path.join(process.cwd(), 'convex/schema.ts'), 'utf8');
    const helper = readFileSync(path.join(process.cwd(), 'lib/mcp/disconnect.ts'), 'utf8');

    expect(mutation).toContain('cleanupDisconnectedConnection');
    expect(mutation).toContain('sweepDisconnectedConnections');
    expect(mutation).toContain(".query('albatrossEvidence')");
    expect(mutation).toContain(".query('mcpTaskLinks')");
    expect(helper).toContain("kind: 'external_snapshot'");
    expect(
      schema.match(/\.index\('by_user_connection', \['userId', 'connectionId'\]\)/g)?.length,
    ).toBeGreaterThanOrEqual(5);
  });
});
