import { describe, expect, test } from 'bun:test';
import { convexTest } from 'convex-test';
import { api } from '../convex/_generated/api';
import schema from '../convex/schema';
import { detachedMcpSource } from '../lib/mcp/disconnect';

const convexModules = {
  '../convex/_generated/api.js': () => import('../convex/_generated/api.js'),
  '../convex/mcp.ts': () => import('../convex/mcp'),
};

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
    expect(
      detachedMcpSource({
        source: { kind: 'mcp', connectionId: 'github_old', externalId: 'issue-2' },
        connectionId: 'github_old',
        server: 'github',
        externalId: 'issue-1',
        fallbackTitle: 'Keep me',
        disconnectedAt: 1,
      }),
    ).toBeNull();
  });

  test('revokes credentials and completes the resumable cascade without orphaning linked tasks', async () => {
    const previousSecret = process.env.LAB86_CONVEX_INTERNAL_SECRET;
    process.env.LAB86_CONVEX_INTERNAL_SECRET = 'test-internal-secret';
    try {
      const t = convexTest(schema, convexModules);
      const seeded = await t.run(async (ctx) => {
        const ts = 1_786_000_000_000;
        const boardId = await ctx.db.insert('boards', {
          ownerUserId: 'user_1',
          title: 'Personal',
          createdAt: ts,
          updatedAt: ts,
        });
        const columnId = await ctx.db.insert('boardColumns', {
          boardId,
          name: 'Today',
          order: 0,
          createdAt: ts,
          updatedAt: ts,
        });
        await ctx.db.insert('mcpConnections', {
          userId: 'user_1',
          connectionId: 'github_old',
          server: 'github',
          serverUrl: 'https://api.github.com',
          authKind: 'token',
          status: 'connected',
          scopes: ['issues:read'],
          includeInBrief: true,
          includeInSearch: true,
          createdAt: ts,
          updatedAt: ts,
        });
        await ctx.db.insert('mcpCredentials', {
          userId: 'user_1',
          connectionId: 'github_old',
          server: 'github',
          accessTokenEncrypted: 'encrypted-token',
          createdAt: ts,
          updatedAt: ts,
        });
        await ctx.db.insert('mcpSyncStates', {
          userId: 'user_1',
          connectionId: 'github_old',
          server: 'github',
          status: 'ready',
          createdAt: ts,
          updatedAt: ts,
        });
        for (let index = 0; index < 101; index += 1) {
          const issueNumber = 120 + index;
          const externalId = `github:issue:Lab86-io/lab86-mail#${issueNumber}`;
          const title = `Connector cleanup ${issueNumber}`;
          const cardId = await ctx.db.insert('cards', {
            boardId,
            columnId,
            userId: 'user_1',
            title: `Track ${title.toLowerCase()}`,
            order: index,
            source: {
              kind: 'mcp',
              connectionId: 'github_old',
              externalId,
            },
            createdAt: ts,
            updatedAt: ts,
          });
          await ctx.db.insert('mcpItems', {
            userId: 'user_1',
            connectionId: 'github_old',
            server: 'github',
            externalId,
            kind: 'issue',
            title,
            url: `https://github.com/Lab86-io/lab86-mail/issues/${issueNumber}`,
            searchText: title,
            createdAt: ts,
            updatedAt: ts,
          });
          await ctx.db.insert('mcpTaskLinks', {
            userId: 'user_1',
            connectionId: 'github_old',
            server: 'github',
            externalId,
            cardId: String(cardId),
            createdAt: ts,
            updatedAt: ts,
          });
          await ctx.db.insert('albatrossEvidence', {
            userId: 'user_1',
            sourceKind: 'github_issue',
            sourceId: externalId,
            connectionId: 'github_old',
            title,
            occurredAt: ts,
            weight: 1,
            confidence: 1,
            trust: 'observed',
            dedupeKey: `mcp:github:github_old:issue-${issueNumber}`,
            searchText: title,
            createdAt: ts,
            updatedAt: ts,
          });
        }
        return { boardId };
      });

      expect(
        await t.mutation(api.mcp.disconnectConnection, {
          internalSecret: 'test-internal-secret',
          userId: 'user_1',
          connectionId: 'github_old',
        }),
      ).toEqual({ ok: true, cleanupScheduled: true });

      const immediateCredentials = await t.run((ctx) =>
        ctx.db
          .query('mcpCredentials')
          .withIndex('by_user_connection', (q) => q.eq('userId', 'user_1').eq('connectionId', 'github_old'))
          .collect(),
      );
      expect(immediateCredentials).toEqual([]);

      let settled = false;
      for (let attempt = 0; attempt < 50; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        await t.finishInProgressScheduledFunctions();
        const connection = await t.run((ctx) =>
          ctx.db
            .query('mcpConnections')
            .withIndex('by_user_connection', (q) => q.eq('userId', 'user_1').eq('connectionId', 'github_old'))
            .unique(),
        );
        if (!connection) {
          settled = true;
          break;
        }
      }
      expect(settled).toBe(true);

      const finalState = await t.run(async (ctx) => ({
        cards: await ctx.db
          .query('cards')
          .withIndex('by_board', (q) => q.eq('boardId', seeded.boardId))
          .collect(),
        credentials: await ctx.db
          .query('mcpCredentials')
          .withIndex('by_user_connection', (q) => q.eq('userId', 'user_1').eq('connectionId', 'github_old'))
          .collect(),
        items: await ctx.db
          .query('mcpItems')
          .withIndex('by_user_connection', (q) => q.eq('userId', 'user_1').eq('connectionId', 'github_old'))
          .collect(),
        evidence: await ctx.db
          .query('albatrossEvidence')
          .withIndex('by_user_connection', (q) => q.eq('userId', 'user_1').eq('connectionId', 'github_old'))
          .collect(),
        links: await ctx.db
          .query('mcpTaskLinks')
          .withIndex('by_user_connection', (q) => q.eq('userId', 'user_1').eq('connectionId', 'github_old'))
          .collect(),
        syncStates: await ctx.db
          .query('mcpSyncStates')
          .withIndex('by_user_connection', (q) => q.eq('userId', 'user_1').eq('connectionId', 'github_old'))
          .collect(),
      }));

      expect(finalState.cards).toHaveLength(101);
      for (const card of finalState.cards) {
        const issueNumber = 120 + card.order;
        expect(card.source).toMatchObject({
          kind: 'external_snapshot',
          server: 'github',
          externalId: `github:issue:Lab86-io/lab86-mail#${issueNumber}`,
          title: `Connector cleanup ${issueNumber}`,
          url: `https://github.com/Lab86-io/lab86-mail/issues/${issueNumber}`,
          disconnectedAt: expect.any(Number),
        });
      }
      expect(finalState.credentials).toEqual([]);
      expect(finalState.items).toEqual([]);
      expect(finalState.evidence).toEqual([]);
      expect(finalState.links).toEqual([]);
      expect(finalState.syncStates).toEqual([]);
    } finally {
      if (previousSecret === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
      else process.env.LAB86_CONVEX_INTERNAL_SECRET = previousSecret;
    }
  });
});
