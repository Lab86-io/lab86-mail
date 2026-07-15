import { describe, expect, test } from 'bun:test';
import { convexTest } from 'convex-test';
import { api } from '../convex/_generated/api';
import schema from '../convex/schema';

const convexModules = {
  '../convex/_generated/api.js': () => import('../convex/_generated/api.js'),
  '../convex/albatross.ts': () => import('../convex/albatross'),
  '../convex/mcp.ts': () => import('../convex/mcp'),
};

describe('connection-scoped MCP Area identity', () => {
  test('separates duplicate external IDs and keeps rejected evidence unassigned after resync', async () => {
    const previousSecret = process.env.LAB86_CONVEX_INTERNAL_SECRET;
    process.env.LAB86_CONVEX_INTERNAL_SECRET = 'test-internal-secret';
    try {
      const t = convexTest(schema, convexModules);
      const areaId = await t.run(async (ctx) => {
        const ts = Date.now();
        const id = await ctx.db.insert('areas', {
          userId: 'user_1',
          name: 'Workspace',
          kind: 'project',
          status: 'active',
          createdAt: ts,
          updatedAt: ts,
        });
        await ctx.db.insert('areaFacts', {
          userId: 'user_1',
          areaId: id,
          kind: 'repository',
          value: 'Lab86-io/lab86-mail',
          status: 'verified',
          sourceRefs: [],
          confirmationRefs: [],
          createdAt: ts,
          updatedAt: ts,
          verifiedAt: ts,
        });
        return id;
      });
      const item = {
        externalId: 'issue:42',
        kind: 'issue',
        title: 'Area evidence',
        repository: 'Lab86-io/lab86-mail',
        searchText: 'Lab86-io/lab86-mail issue 42',
      };
      for (const connectionId of ['github_one', 'github_two']) {
        await t.mutation(api.mcp.upsertItems as any, {
          internalSecret: 'test-internal-secret',
          userId: 'user_1',
          connectionId,
          server: 'github',
          items: [item],
        });
      }

      const links = await t.run((ctx) => ctx.db.query('areaArtifactLinks').collect());
      expect(links.map((link) => link.artifactId).sort()).toEqual([
        'github_one:issue:42',
        'github_two:issue:42',
      ]);

      const rejected = links.find((link) => link.accountId === 'github_one')!;
      await t.mutation(api.albatross.setAreaArtifactLinkStatus as any, {
        internalSecret: 'test-internal-secret',
        userId: 'user_1',
        linkId: rejected._id,
        status: 'rejected',
      });
      await t.mutation(api.mcp.upsertItems as any, {
        internalSecret: 'test-internal-secret',
        userId: 'user_1',
        connectionId: 'github_one',
        server: 'github',
        items: [item],
      });

      const evidence = await t.run(async (ctx) =>
        ctx.db
          .query('albatrossEvidence')
          .withIndex('by_user_connection', (q) => q.eq('userId', 'user_1').eq('connectionId', 'github_one'))
          .unique(),
      );
      expect(evidence?.targetKind).toBeUndefined();
      expect(evidence?.targetId).toBeUndefined();
      expect(String(rejected.areaId)).toBe(String(areaId));
    } finally {
      if (previousSecret === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
      else process.env.LAB86_CONVEX_INTERNAL_SECRET = previousSecret;
    }
  });
});
