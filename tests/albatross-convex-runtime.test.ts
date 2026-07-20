import { describe, expect, test } from 'bun:test';
import { convexTest } from 'convex-test';
import { api, internal } from '../convex/_generated/api';
import type { Id } from '../convex/_generated/dataModel';
import schema from '../convex/schema';

const convexModules = {
  '../convex/_generated/api.js': () => import('../convex/_generated/api.js'),
  '../convex/albatross.ts': () => import('../convex/albatross'),
  '../convex/dailyReports.ts': () => import('../convex/dailyReports'),
};

const SECRET = 'albatross-convex-runtime-secret';

async function withSecret<T>(run: () => Promise<T>): Promise<T> {
  const previous = process.env.LAB86_CONVEX_INTERNAL_SECRET;
  process.env.LAB86_CONVEX_INTERNAL_SECRET = SECRET;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
    else process.env.LAB86_CONVEX_INTERNAL_SECRET = previous;
  }
}

const caller = (userId: string) => ({ internalSecret: SECRET, userId });

const userConfirmation = (id: string, confirmedBy = 'user') => ({
  kind: 'userConfirmation',
  id,
  confirmedAt: Date.now(),
  confirmedBy,
});

function corpusThread(userId: string, providerThreadId: string, overrides: Record<string, any> = {}) {
  const ts = Date.now();
  return {
    userId,
    accountId: 'account_1',
    grantId: 'grant_1',
    provider: 'google' as const,
    providerThreadId,
    subject: `Subject ${providerThreadId}`,
    fromAddress: 'sender@example.com',
    lastDate: ts,
    snippet: `Snippet ${providerThreadId}`,
    labels: ['inbox'],
    unread: false,
    yearMonth: '2026-07',
    createdAt: ts,
    updatedAt: ts,
    ...overrides,
  };
}

function corpusMessage(userId: string, providerThreadId: string, providerMessageId: string, over: any = {}) {
  const ts = Date.now();
  return {
    userId,
    accountId: 'account_1',
    grantId: 'grant_1',
    provider: 'google' as const,
    providerMessageId,
    providerThreadId,
    subject: `Message ${providerMessageId}`,
    from: 'sender@example.com',
    to: 'user@example.com',
    receivedAt: ts,
    snippet: `Message snippet ${providerMessageId}`,
    textBody: `Body of ${providerMessageId}`,
    searchText: `body of ${providerMessageId}`,
    labels: ['inbox'],
    yearMonth: '2026-07',
    createdAt: ts,
    updatedAt: ts,
    ...over,
  };
}

function bareLink(userId: string, areaId: Id<'areas'>, over: Record<string, any> = {}): Record<string, any> {
  const ts = Date.now();
  return {
    userId,
    areaId,
    artifactKind: 'mailThread',
    artifactId: 'thread_x',
    role: 'supporting',
    status: 'candidate',
    sourceRefs: [],
    confirmationRefs: [],
    createdAt: ts,
    updatedAt: ts,
    ...over,
  };
}

function queuedRun(userId: string, over: Record<string, any> = {}) {
  const ts = Date.now();
  return {
    userId,
    status: 'queued' as const,
    scanned: 0,
    inserted: 0,
    matched: 0,
    retired: 0,
    skipped: 0,
    pages: 0,
    createdAt: ts,
    updatedAt: ts,
    ...over,
  };
}

describe('Area CRUD lifecycle', () => {
  test('createArea normalizes branding, creates a board, and revives by name', () =>
    withSecret(async () => {
      const t = convexTest(schema, convexModules);
      const userId = 'crud_user';
      const areaId = await t.mutation(api.albatross.createArea, {
        ...caller(userId),
        externalId: 'ext-acme',
        name: '  Acme   Ops ',
        kind: 'client',
        description: 'Acme consulting engagement',
        priority: 2,
        primaryDomain: 'https://www.acme.com/portal',
      });
      const area = await t.run((ctx) => ctx.db.get(areaId));
      expect(area).toMatchObject({
        name: 'Acme Ops',
        kind: 'client',
        status: 'active',
        priority: 2,
        primaryDomain: 'acme.com',
        externalId: 'ext-acme',
      });
      expect(area?.faviconUrl).toContain('acme.com');
      expect(area?.boardId).toBeDefined();
      const columns = await t.run((ctx) =>
        ctx.db
          .query('boardColumns')
          .withIndex('by_board', (q) => q.eq('boardId', area!.boardId!))
          .collect(),
      );
      expect(columns.length).toBeGreaterThan(0);
      const runs = await t.run((ctx) => ctx.db.query('areaReindexRuns').collect());
      expect(runs).toHaveLength(1);
      expect(runs[0].status).toBe('queued');

      const revivedId = await t.mutation(api.albatross.createArea, {
        ...caller(userId),
        name: 'acme ops',
        kind: 'consulting',
      });
      expect(revivedId).toBe(areaId);
      const boards = await t.run((ctx) => ctx.db.query('boards').collect());
      expect(boards).toHaveLength(1);
      expect(await t.run((ctx) => ctx.db.query('areaReindexRuns').collect())).toHaveLength(1);

      await expect(
        t.mutation(api.albatross.createArea, {
          ...caller(userId),
          name: 'Beta',
          externalId: 'ext-acme',
        }),
      ).rejects.toThrow(/externalId already exists/);
    }));

  test('updateArea, archiveArea, listAreas, getArea, and areaBriefTarget round-trip', () =>
    withSecret(async () => {
      const t = convexTest(schema, convexModules);
      const userId = 'crud_user_2';
      const areaId = await t.mutation(api.albatross.createArea, {
        ...caller(userId),
        name: 'Household',
        priority: 5,
      });
      const otherAreaId = await t.mutation(api.albatross.createArea, {
        ...caller(userId),
        name: 'Aardvark rescue',
        priority: 1,
      });
      await t.mutation(api.albatross.updateArea, {
        ...caller(userId),
        areaId,
        name: 'Household admin',
        description: 'Bills and repairs',
        kind: 'life',
        status: 'archived',
      });
      let area = await t.run((ctx) => ctx.db.get(areaId));
      expect(area).toMatchObject({ name: 'Household admin', kind: 'life', status: 'archived' });
      expect(area?.archivedAt).toBeNumber();

      await t.mutation(api.albatross.updateArea, { ...caller(userId), areaId, status: 'active' });
      area = await t.run((ctx) => ctx.db.get(areaId));
      expect(area?.status).toBe('active');
      expect(area?.archivedAt).toBeUndefined();
      // Unarchiving reuses the existing board instead of spawning a duplicate.
      expect(await t.run((ctx) => ctx.db.query('boards').collect())).toHaveLength(2);

      const active = await t.query(api.albatross.listAreas, { ...caller(userId), status: 'active' });
      expect(active.map((row) => row.name)).toEqual(['Aardvark rescue', 'Household admin']);

      await t.mutation(api.albatross.archiveArea, { ...caller(userId), areaId });
      const archived = await t.query(api.albatross.listAreas, { ...caller(userId), status: 'archived' });
      expect(archived.map((row) => String(row._id))).toEqual([String(areaId)]);

      const fetched = await t.query(api.albatross.getArea, { ...caller(userId), areaId });
      expect(fetched?.name).toBe('Household admin');
      await expect(t.query(api.albatross.getArea, { ...caller('someone_else'), areaId })).rejects.toThrow(
        /Area not found/,
      );

      expect(
        await t.query(api.albatross.areaBriefTarget, { ...caller(userId), areaId: String(otherAreaId) }),
      ).toEqual({ _id: otherAreaId });
      expect(
        await t.query(api.albatross.areaBriefTarget, { ...caller(userId), areaId: 'not-a-real-id' }),
      ).toBeNull();
      expect(
        await t.query(api.albatross.areaBriefTarget, {
          ...caller('someone_else'),
          areaId: String(areaId),
        }),
      ).toBeNull();
    }));

  test('reindexMyAreas and areaIndexStatus report the latest run and mailbox states', () =>
    withSecret(async () => {
      const t = convexTest(schema, convexModules);
      const userId = 'status_user';
      const areaId = await t.mutation(api.albatross.createArea, { ...caller(userId), name: 'Ops' });
      const result = await t.mutation(api.albatross.reindexMyAreas, { ...caller(userId), areaId });
      expect(result.ok).toBe(true);
      const ts = Date.now();
      await t.run(async (ctx) => {
        const base = {
          userId,
          grantId: 'grant_1',
          provider: 'google' as const,
          createdAt: ts,
          updatedAt: ts,
        };
        await ctx.db.insert('mailSyncStates', {
          ...base,
          accountId: 'acct_ready',
          status: 'ready',
          corpusReady: true,
          messagesSynced: 120,
        });
        await ctx.db.insert('mailSyncStates', {
          ...base,
          accountId: 'acct_backfill',
          status: 'backfilling',
          corpusReady: false,
          messagesSynced: 5,
        });
        await ctx.db.insert('mailSyncStates', {
          ...base,
          accountId: 'acct_error',
          status: 'error',
          corpusReady: false,
          error: 'boom',
        });
      });
      const status = await t.query(api.albatross.areaIndexStatus, { ...caller(userId) });
      expect(status.latestRun).toMatchObject({
        runId: String(result.runId),
        reason: 'Manual area brief refresh',
      });
      expect(status.mail).toMatchObject({ total: 3, ready: 1, indexing: 1, errored: 1 });
      expect(status.mail.messagesSynced).toBe(125);
    }));

  test('resolveUserId enforces auth in every mode', () =>
    withSecret(async () => {
      const t = convexTest(schema, convexModules);
      await expect(t.query(api.albatross.listAreas, {})).rejects.toThrow(/Not authenticated/);
      await expect(t.query(api.albatross.listAreas, { internalSecret: SECRET })).rejects.toThrow(
        /userId required with internal secret/,
      );
      await expect(
        t.query(api.albatross.listAreas, { internalSecret: 'wrong', userId: 'x' }),
      ).rejects.toThrow(/Invalid Convex internal secret/);
      const asUser = t.withIdentity({ subject: 'identity_user' });
      await t.mutation(api.albatross.createArea, { ...caller('identity_user'), name: 'Mine' });
      const rows = await asUser.query(api.albatross.listAreas, {});
      expect(rows.map((row) => row.name)).toEqual(['Mine']);
    }));
});

describe('Area facts lifecycle', () => {
  test('add, verify, reject, and supersede facts with confirmation enforcement', () =>
    withSecret(async () => {
      const t = convexTest(schema, convexModules);
      const userId = 'facts_user';
      const areaId = await t.mutation(api.albatross.createArea, { ...caller(userId), name: 'Acme' });

      const candidateId = await t.mutation(api.albatross.addAreaFact, {
        ...caller(userId),
        areaId,
        kind: 'note',
        value: '  Weekly   sync on Fridays ',
      });
      expect(await t.run((ctx) => ctx.db.get(candidateId))).toMatchObject({
        status: 'candidate',
        kind: 'note',
        value: 'Weekly sync on Fridays',
      });

      await expect(
        t.mutation(api.albatross.addAreaFact, {
          ...caller(userId),
          areaId,
          kind: 'email',
          value: 'ops@acme.com',
          status: 'verified',
        }),
      ).rejects.toThrow(/require confirmation refs/);

      const verifiedId = await t.mutation(api.albatross.addAreaFact, {
        ...caller(userId),
        areaId,
        kind: 'email',
        value: 'ops@acme.com',
        status: 'verified',
        confirmationRefs: [userConfirmation('confirm-email', userId)],
      });
      const verifiedFact = await t.run((ctx) => ctx.db.get(verifiedId));
      expect(verifiedFact?.status).toBe('verified');
      expect(verifiedFact?.verifiedAt).toBeNumber();

      // Verifying the candidate patches the same evidence row (dedupe upsert).
      await t.mutation(api.albatross.verifyAreaFact, {
        ...caller(userId),
        factId: candidateId,
        confirmationRefs: [userConfirmation('confirm-note', userId)],
        sourceRefs: [{ kind: 'mailThread', id: 'thread_1', label: 'Original evidence' }],
      });
      const verifiedNote = await t.run((ctx) => ctx.db.get(candidateId));
      expect(verifiedNote?.status).toBe('verified');
      expect(verifiedNote?.sourceRefs.map((ref) => ref.id)).toContain('thread_1');
      const evidence = await t.run((ctx) =>
        ctx.db
          .query('albatrossEvidence')
          .withIndex('by_user_dedupe', (q) =>
            q.eq('userId', userId).eq('dedupeKey', `area-fact:${String(candidateId)}`),
          )
          .collect(),
      );
      expect(evidence).toHaveLength(1);
      expect(evidence[0]).toMatchObject({ trust: 'confirmed', confidence: 1 });

      const rejectableId = await t.mutation(api.albatross.addAreaFact, {
        ...caller(userId),
        areaId,
        kind: 'domain',
        value: 'wrong.example',
      });
      await t.mutation(api.albatross.rejectAreaFact, {
        ...caller(userId),
        factId: rejectableId,
        reason: 'Not actually related',
      });
      expect(await t.run((ctx) => ctx.db.get(rejectableId))).toMatchObject({
        status: 'rejected',
        rejectedReason: 'Not actually related',
      });
      await expect(
        t.mutation(api.albatross.verifyAreaFact, {
          ...caller(userId),
          factId: rejectableId,
          confirmationRefs: [userConfirmation('confirm-late', userId)],
        }),
      ).rejects.toThrow(/Invalid area fact transition/);

      const superseded = await t.mutation(api.albatross.supersedeAreaFact, {
        ...caller(userId),
        factId: verifiedId,
        replacement: {
          kind: 'email',
          value: 'newops@acme.com',
          confirmationRefs: [userConfirmation('confirm-replacement', userId)],
        },
      });
      expect(superseded.ok).toBe(true);
      const oldFact = await t.run((ctx) => ctx.db.get(verifiedId));
      expect(oldFact).toMatchObject({
        status: 'superseded',
        supersededByFactId: superseded.replacementFactId,
      });
      const replacement = await t.run((ctx) => ctx.db.get(superseded.replacementFactId!));
      expect(replacement).toMatchObject({
        status: 'verified',
        value: 'newops@acme.com',
        supersedesFactId: verifiedId,
      });

      const all = await t.query(api.albatross.listAreaFacts, { ...caller(userId), areaId });
      expect(all).toHaveLength(4);
      const verifiedOnly = await t.query(api.albatross.listAreaFacts, {
        ...caller(userId),
        areaId,
        status: 'verified',
      });
      expect(verifiedOnly.map((fact) => fact.value).sort()).toEqual([
        'Weekly sync on Fridays',
        'newops@acme.com',
      ]);
      const scopedVerified = await t.query(api.albatross.listVerifiedFacts, { ...caller(userId), areaId });
      expect(scopedVerified).toHaveLength(2);
      const globalVerified = await t.query(api.albatross.listVerifiedFacts, { ...caller(userId) });
      expect(globalVerified).toHaveLength(2);
      const rejectedUserFacts = await t.query(api.albatross.listUserAreaFacts, {
        ...caller(userId),
        status: 'rejected',
      });
      expect(rejectedUserFacts.map((fact) => fact.value)).toEqual(['wrong.example']);
      expect(await t.query(api.albatross.listUserAreaFacts, { ...caller(userId) })).toHaveLength(4);
    }));
});

describe('Artifact links', () => {
  test('linkArtifactToArea upserts by identity and lists in both scopes', () =>
    withSecret(async () => {
      const t = convexTest(schema, convexModules);
      const userId = 'links_user';
      const areaId = await t.mutation(api.albatross.createArea, { ...caller(userId), name: 'Ops' });
      const linkId = await t.mutation(api.albatross.linkArtifactToArea, {
        ...caller(userId),
        areaId,
        artifactKind: 'mailThread',
        artifactId: '  thread_1 ',
        accountId: 'account_1',
        confidence: 0.5,
        reason: 'Looks related',
      });
      const again = await t.mutation(api.albatross.linkArtifactToArea, {
        ...caller(userId),
        areaId,
        artifactKind: 'mailThread',
        artifactId: 'thread_1',
        accountId: 'account_1',
        confidence: 0.8,
      });
      expect(again).toBe(linkId);
      expect(await t.run((ctx) => ctx.db.get(linkId))).toMatchObject({
        artifactId: 'thread_1',
        accountId: 'account_1',
        status: 'candidate',
        confidence: 0.8,
        role: 'primary',
      });

      await t.mutation(api.albatross.linkArtifactToArea, {
        ...caller(userId),
        areaId,
        artifactKind: 'manual',
        artifactId: 'manual_note_1',
      });
      await expect(
        t.mutation(api.albatross.linkArtifactToArea, {
          ...caller(userId),
          areaId,
          artifactKind: 'manual',
          artifactId: 'manual_note_2',
          status: 'verified',
        }),
      ).rejects.toThrow(/require explicit user confirmation/);

      const accountScoped = await t.query(api.albatross.listArtifactLinks, {
        ...caller(userId),
        artifactKind: 'mailThread',
        artifactId: 'thread_1',
        accountId: 'account_1',
      });
      expect(accountScoped).toHaveLength(1);
      const accountless = await t.query(api.albatross.listArtifactLinks, {
        ...caller(userId),
        artifactKind: 'manual',
        artifactId: 'manual_note_1',
      });
      expect(accountless).toHaveLength(1);
      expect(accountless[0].accountId).toBeUndefined();
      const areaLinks = await t.query(api.albatross.listAreaArtifactLinks, { ...caller(userId), areaId });
      expect(areaLinks).toHaveLength(2);
      const candidates = await t.query(api.albatross.listAreaArtifactLinks, {
        ...caller(userId),
        areaId,
        status: 'candidate',
      });
      expect(candidates).toHaveLength(2);
    }));

  test('setAreaArtifactLinkStatus verifies, rejects, and detaches mcp evidence', () =>
    withSecret(async () => {
      const t = convexTest(schema, convexModules);
      const userId = 'link_status_user';
      const areaId = await t.mutation(api.albatross.createArea, { ...caller(userId), name: 'Repo' });
      const mailLinkId = await t.mutation(api.albatross.linkArtifactToArea, {
        ...caller(userId),
        areaId,
        artifactKind: 'mailThread',
        artifactId: 'thread_verify',
        accountId: 'account_1',
        reason: 'classifier guess',
      });
      await expect(
        t.mutation(api.albatross.setAreaArtifactLinkStatus, {
          ...caller(userId),
          linkId: mailLinkId,
          status: 'verified',
        }),
      ).rejects.toThrow(/require explicit user confirmation/);
      const verified = await t.mutation(api.albatross.setAreaArtifactLinkStatus, {
        ...caller(userId),
        linkId: mailLinkId,
        status: 'verified',
        reason: 'Yes, this is the client thread',
        confirmationRefs: [userConfirmation('teach-confirm-1', userId)],
      });
      expect(verified).toEqual({ linkId: String(mailLinkId), status: 'verified' });
      const verifiedRow = await t.run((ctx) => ctx.db.get(mailLinkId));
      expect(verifiedRow).toMatchObject({ status: 'verified', confidence: 1 });
      expect(verifiedRow?.reason).toBe('classifier guess; user response: Yes, this is the client thread');

      const mcpLinkId = await t.mutation(api.albatross.linkArtifactToArea, {
        ...caller(userId),
        areaId,
        artifactKind: 'mcpItem',
        artifactId: 'conn_1:ext_9',
        accountId: 'conn_1',
      });
      const strayEvidenceId = await t.run((ctx) =>
        ctx.db.insert('albatrossEvidence', {
          userId,
          targetKind: 'area',
          targetId: String(areaId),
          sourceKind: 'mcp_item',
          sourceId: 'ext_9',
          connectionId: 'conn_1',
          title: 'Synced item evidence',
          occurredAt: Date.now(),
          weight: 1,
          confidence: 1,
          trust: 'observed',
          dedupeKey: 'external-mcp-evidence-1',
          searchText: 'synced item evidence',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }),
      );
      await t.mutation(api.albatross.setAreaArtifactLinkStatus, {
        ...caller(userId),
        linkId: mcpLinkId,
        status: 'rejected',
        reason: 'Wrong repo',
      });
      expect(await t.run((ctx) => ctx.db.get(mcpLinkId))).toMatchObject({
        status: 'rejected',
        confidence: 0,
      });
      const stray = await t.run((ctx) => ctx.db.get(strayEvidenceId));
      expect(stray?.targetKind).toBeUndefined();
      expect(stray?.targetId).toBeUndefined();
    }));
});

describe('moveMailThreadsToArea', () => {
  test('rejects malformed batches before touching links', () =>
    withSecret(async () => {
      const t = convexTest(schema, convexModules);
      const userId = 'move_guard_user';
      const sourceAreaId = await t.mutation(api.albatross.createArea, { ...caller(userId), name: 'A' });
      const destinationAreaId = await t.mutation(api.albatross.createArea, { ...caller(userId), name: 'B' });
      await expect(
        t.mutation(api.albatross.moveMailThreadsToArea, {
          ...caller(userId),
          sourceAreaId,
          destinationAreaId,
          threads: Array.from({ length: 51 }, (_, index) => ({
            accountId: 'account_1',
            threadId: `thread_${index}`,
          })),
        }),
      ).rejects.toThrow(/at most 50/);
      await expect(
        t.mutation(api.albatross.moveMailThreadsToArea, {
          ...caller(userId),
          sourceAreaId,
          destinationAreaId: sourceAreaId,
          threads: [],
        }),
      ).rejects.toThrow(/different Area/);
      await t.mutation(api.albatross.archiveArea, { ...caller(userId), areaId: destinationAreaId });
      await expect(
        t.mutation(api.albatross.moveMailThreadsToArea, {
          ...caller(userId),
          sourceAreaId,
          destinationAreaId,
          threads: [],
        }),
      ).rejects.toThrow(/archived/);
    }));

  test('moves threads atomically: source rejected, destination verified, evidence recorded', () =>
    withSecret(async () => {
      const t = convexTest(schema, convexModules);
      const userId = 'move_user';
      const sourceAreaId = await t.mutation(api.albatross.createArea, { ...caller(userId), name: 'Old' });
      const destinationAreaId = await t.mutation(api.albatross.createArea, {
        ...caller(userId),
        name: 'New',
      });
      await t.run(async (ctx) => {
        await ctx.db.insert(
          'areaArtifactLinks',
          bareLink(userId, sourceAreaId, { artifactId: 'thread_move_1', accountId: 'account_1' }) as any,
        );
        await ctx.db.insert(
          'areaArtifactLinks',
          bareLink(userId, sourceAreaId, { artifactId: 'thread_move_2', accountId: 'account_1' }) as any,
        );
        await ctx.db.insert(
          'areaArtifactLinks',
          bareLink(userId, destinationAreaId, {
            artifactId: 'thread_move_2',
            accountId: 'account_1',
          }) as any,
        );
      });
      const result = await t.mutation(api.albatross.moveMailThreadsToArea, {
        ...caller(userId),
        sourceAreaId,
        destinationAreaId,
        threads: [
          { accountId: '', threadId: 'thread_move_1' },
          { accountId: 'account_1', threadId: 'thread_without_link' },
          { accountId: 'account_1', threadId: 'thread_move_1' },
          { accountId: 'account_1', threadId: 'thread_move_2' },
        ],
      });
      expect(result).toEqual({ moved: 2, skipped: 2 });

      const links = await t.run((ctx) => ctx.db.query('areaArtifactLinks').collect());
      const sourceLinks = links.filter((link) => link.areaId === sourceAreaId);
      const destinationLinks = links.filter((link) => link.areaId === destinationAreaId);
      expect(sourceLinks).toHaveLength(2);
      for (const link of sourceLinks) {
        expect(link).toMatchObject({ status: 'rejected', confidence: 0 });
        expect(link.reason).toContain('Moved by the user');
        expect(link.confirmationRefs.some((ref) => ref.kind === 'userConfirmation')).toBe(true);
      }
      expect(destinationLinks).toHaveLength(2);
      for (const link of destinationLinks) {
        expect(link).toMatchObject({ status: 'verified', confidence: 1, role: 'primary' });
      }
      const evidence = await t.run((ctx) => ctx.db.query('albatrossEvidence').collect());
      const trusts = evidence.map((row) => row.trust).sort();
      expect(trusts).toEqual(['confirmed', 'confirmed', 'rejected', 'rejected']);
    }));
});

describe('listAreasOverview', () => {
  test('aggregates facts, links, cards, intents, and projects per area', () =>
    withSecret(async () => {
      const t = convexTest(schema, convexModules);
      const userId = 'overview_user';
      const areaId = await t.mutation(api.albatross.createArea, {
        ...caller(userId),
        name: 'Client work',
        priority: 1,
      });
      const archivedAreaId = await t.mutation(api.albatross.createArea, {
        ...caller(userId),
        name: 'Retired area',
        priority: 9,
      });
      await t.mutation(api.albatross.archiveArea, { ...caller(userId), areaId: archivedAreaId });
      const area = await t.run((ctx) => ctx.db.get(areaId));
      const ts = Date.now();
      const { cardIds } = await t.run(async (ctx) => {
        const column = await ctx.db
          .query('boardColumns')
          .withIndex('by_board', (q) => q.eq('boardId', area!.boardId!))
          .first();
        const cardBase = {
          boardId: area!.boardId!,
          columnId: column!._id,
          userId,
          createdAt: ts,
          updatedAt: ts,
        };
        const card1 = await ctx.db.insert('cards', { ...cardBase, title: 'Linked task', order: 1 });
        const card2 = await ctx.db.insert('cards', {
          ...cardBase,
          title: 'Done task',
          order: 2,
          completedAt: ts - 10,
        });
        const card3 = await ctx.db.insert('cards', {
          ...cardBase,
          title: 'Overdue task',
          order: 3,
          dueAt: ts - 60_000,
        });
        await ctx.db.insert('areaFacts', {
          userId,
          areaId,
          kind: 'email',
          value: 'ops@client.com',
          status: 'verified',
          sourceRefs: [],
          confirmationRefs: [userConfirmation('conf-overview', userId)],
          verifiedAt: ts,
          createdAt: ts,
          updatedAt: ts,
        });
        await ctx.db.insert('areaFacts', {
          userId,
          areaId,
          kind: 'note',
          value: 'Renewal in Q3',
          status: 'candidate',
          sourceRefs: [],
          confirmationRefs: [],
          createdAt: ts,
          updatedAt: ts,
        });
        await ctx.db.insert(
          'areaArtifactLinks',
          bareLink(userId, areaId, { artifactId: 'thread_ov_1', accountId: 'account_1' }) as any,
        );
        await ctx.db.insert(
          'areaArtifactLinks',
          bareLink(userId, areaId, {
            artifactKind: 'calendarEvent',
            artifactId: 'event_ov_1',
            status: 'verified',
          }) as any,
        );
        await ctx.db.insert(
          'areaArtifactLinks',
          bareLink(userId, areaId, {
            artifactKind: 'task',
            artifactId: String(card1),
            status: 'verified',
          }) as any,
        );
        await ctx.db.insert(
          'areaArtifactLinks',
          bareLink(userId, areaId, { artifactId: 'thread_ov_rejected', status: 'rejected' }) as any,
        );
        await ctx.db.insert(
          'areaArtifactLinks',
          bareLink(userId, archivedAreaId, { artifactId: 'thread_archived_area' }) as any,
        );
        const intentBase = { userId, rawText: 'raw', source: 'text' as const, createdAt: ts, updatedAt: ts };
        await ctx.db.insert('albatrossIntents', {
          ...intentBase,
          title: 'Needs an answer',
          status: 'needs_answers',
          areaId: String(areaId),
        });
        await ctx.db.insert('albatrossIntents', {
          ...intentBase,
          title: 'Finished plan',
          status: 'done',
          areaId: String(areaId),
        });
        await ctx.db.insert('albatrossProjects', {
          userId,
          title: 'Migration',
          status: 'active',
          areaId: String(areaId),
          createdAt: ts,
          updatedAt: ts,
        });
        await ctx.db.insert('albatrossProjects', {
          userId,
          title: 'Archived project',
          status: 'archived',
          areaId: String(areaId),
          createdAt: ts,
          updatedAt: ts,
        });
        return { cardIds: [card1, card2, card3] };
      });
      expect(cardIds).toHaveLength(3);

      const overview = await t.query(api.albatross.listAreasOverview, { ...caller(userId) });
      expect(overview.map((row) => row.name)).toEqual(['Client work', 'Retired area']);
      const clientRow = overview[0];
      expect(clientRow.factCounts).toEqual({ verified: 1, candidate: 1 });
      expect(clientRow.workCounts).toMatchObject({
        mail: 1,
        events: 1,
        tasks: 3,
        plans: 1,
        needsYou: 1,
        projects: 1,
        overdueTasks: 1,
        suggestedLinks: 1,
      });
      expect(clientRow.lastSignalAt).toBeNumber();
      expect(clientRow.primaryDomain).toBe('client.com');

      const activeOnly = await t.query(api.albatross.listAreasOverview, {
        ...caller(userId),
        status: 'active',
      });
      expect(activeOnly.map((row) => row.name)).toEqual(['Client work']);
    }));
});

describe('domainActivity', () => {
  test('aggregates senders per domain and per exact address', () =>
    withSecret(async () => {
      const t = convexTest(schema, convexModules);
      const userId = 'domain_user';
      const ts = Date.now();
      await t.run(async (ctx) => {
        await ctx.db.insert(
          'mailCorpusThreads',
          corpusThread(userId, 'd1', {
            fromAddress: 'Jane Roe <jane@acme.com>',
            subject: 'Kickoff agenda',
            lastDate: ts - 10,
          }) as any,
        );
        await ctx.db.insert(
          'mailCorpusThreads',
          corpusThread(userId, 'd2', {
            fromAddress: 'jane@acme.com',
            subject: 'Follow-up notes',
            lastDate: ts - 5,
          }) as any,
        );
        await ctx.db.insert(
          'mailCorpusThreads',
          corpusThread(userId, 'd3', {
            fromAddress: 'bob@acme.com',
            subject: 'Invoice',
            lastDate: ts - 2,
          }) as any,
        );
        await ctx.db.insert(
          'mailCorpusThreads',
          corpusThread(userId, 'd4', { fromAddress: 'other@else.com', lastDate: ts - 1 }) as any,
        );
      });
      const byDomain = await t.query(api.albatross.domainActivity, {
        ...caller(userId),
        domain: '@Acme.com',
      });
      expect(byDomain).toMatchObject({
        domain: 'acme.com',
        senderEmail: null,
        threadsScanned: 4,
        threadsMatched: 3,
      });
      expect(byDomain.senders).toHaveLength(2);
      expect(byDomain.senders[0]).toMatchObject({ email: 'jane@acme.com', threads: 2 });
      expect(byDomain.senders[0].recentSubjects).toEqual(['Follow-up notes', 'Kickoff agenda']);

      const bySender = await t.query(api.albatross.domainActivity, {
        ...caller(userId),
        senderEmail: 'bob@acme.com',
        max: 1,
      });
      expect(bySender.threadsMatched).toBe(1);
      expect(bySender.senders[0]).toMatchObject({ email: 'bob@acme.com', threads: 1 });

      await expect(t.query(api.albatross.domainActivity, { ...caller(userId) })).rejects.toThrow(
        /Provide domain or senderEmail/,
      );
    }));
});

describe('areaHome', () => {
  test('resolves facts, mail, events, tasks, mcp items, plans, projects, and places', () =>
    withSecret(async () => {
      const t = convexTest(schema, convexModules);
      const userId = 'home_user';
      const areaId = await t.mutation(api.albatross.createArea, { ...caller(userId), name: 'Launch' });
      const area = await t.run((ctx) => ctx.db.get(areaId));
      const ts = Date.now();
      await t.run(async (ctx) => {
        await ctx.db.insert('areaFacts', {
          userId,
          areaId,
          kind: 'email',
          value: 'team@launch.dev',
          status: 'verified',
          sourceRefs: [],
          confirmationRefs: [userConfirmation('conf-home', userId)],
          verifiedAt: ts,
          createdAt: ts,
          updatedAt: ts,
        });
        await ctx.db.insert('areaFacts', {
          userId,
          areaId,
          kind: 'note',
          value: 'Ship by August',
          status: 'candidate',
          sourceRefs: [],
          confirmationRefs: [],
          createdAt: ts,
          updatedAt: ts,
        });

        // Mail: two resolvable threads, one dangling link, one accountless link.
        await ctx.db.insert(
          'mailCorpusThreads',
          corpusThread(userId, 'home_m1', { lastDate: ts - 100, unread: true, starred: true }) as any,
        );
        await ctx.db.insert('mailCorpusThreads', corpusThread(userId, 'home_m2', { lastDate: ts }) as any);
        for (const artifactId of ['home_m1', 'home_m2', 'home_missing']) {
          await ctx.db.insert(
            'areaArtifactLinks',
            bareLink(userId, areaId, { artifactId, accountId: 'account_1' }) as any,
          );
        }
        await ctx.db.insert(
          'areaArtifactLinks',
          bareLink(userId, areaId, { artifactId: 'home_accountless' }) as any,
        );

        // Events: one upcoming linked by doc id, one past linked by provider id,
        // one belonging to another user (filtered out).
        const eventBase = {
          userId,
          accountId: 'account_1',
          grantId: 'grant_1',
          provider: 'google' as const,
          providerCalendarId: 'cal_1',
          createdAt: ts,
          updatedAt: ts,
        };
        const upcomingId = await ctx.db.insert('calendarEvents', {
          ...eventBase,
          providerEventId: 'evt_up',
          title: 'Launch review',
          startAt: ts + 3_600_000,
          endAt: ts + 7_200_000,
        });
        await ctx.db.insert('calendarEvents', {
          ...eventBase,
          providerEventId: 'evt_past',
          title: 'Retro',
          startAt: ts - 7_200_000,
          endAt: ts - 3_600_000,
        });
        const foreignEventId = await ctx.db.insert('calendarEvents', {
          ...eventBase,
          userId: 'other_user',
          providerEventId: 'evt_foreign',
          title: 'Not yours',
          startAt: ts,
          endAt: ts + 1,
        });
        await ctx.db.insert(
          'areaArtifactLinks',
          bareLink(userId, areaId, {
            artifactKind: 'calendarEvent',
            artifactId: String(upcomingId),
          }) as any,
        );
        await ctx.db.insert(
          'areaArtifactLinks',
          bareLink(userId, areaId, {
            artifactKind: 'calendarEvent',
            artifactId: 'evt_past',
            accountId: 'account_1',
          }) as any,
        );
        await ctx.db.insert(
          'areaArtifactLinks',
          bareLink(userId, areaId, {
            artifactKind: 'calendarEvent',
            artifactId: String(foreignEventId),
          }) as any,
        );

        // Tasks: one linked card plus two board cards (one completed).
        const column = await ctx.db
          .query('boardColumns')
          .withIndex('by_board', (q) => q.eq('boardId', area!.boardId!))
          .first();
        const cardBase = {
          boardId: area!.boardId!,
          columnId: column!._id,
          userId,
          createdAt: ts,
          updatedAt: ts,
        };
        const linkedCard = await ctx.db.insert('cards', {
          ...cardBase,
          title: 'Linked card',
          order: 1,
          updatedAt: ts - 50,
        });
        await ctx.db.insert('cards', {
          ...cardBase,
          title: 'Board card open',
          order: 2,
          updatedAt: ts - 10,
        });
        await ctx.db.insert('cards', {
          ...cardBase,
          title: 'Board card done',
          order: 3,
          completedAt: ts - 5,
          updatedAt: ts,
        });
        await ctx.db.insert(
          'areaArtifactLinks',
          bareLink(userId, areaId, { artifactKind: 'task', artifactId: String(linkedCard) }) as any,
        );
        await ctx.db.insert(
          'areaArtifactLinks',
          bareLink(userId, areaId, { artifactKind: 'task', artifactId: 'not-a-card-id' }) as any,
        );

        // MCP: connection-scoped and user-scoped resolution paths.
        const mcpBase = {
          userId,
          server: 'github' as const,
          kind: 'issue',
          createdAt: ts,
          updatedAt: ts,
        };
        await ctx.db.insert('mcpItems', {
          ...mcpBase,
          connectionId: 'conn_1',
          externalId: 'ext_1',
          title: 'Fix login bug',
          searchText: 'fix login bug',
          updatedAtSource: ts - 20,
        });
        await ctx.db.insert('mcpItems', {
          ...mcpBase,
          connectionId: 'conn_2',
          externalId: 'ext_2',
          title: 'Release checklist',
          searchText: 'release checklist',
        });
        await ctx.db.insert(
          'areaArtifactLinks',
          bareLink(userId, areaId, {
            artifactKind: 'mcpItem',
            artifactId: 'conn_1:ext_1',
            accountId: 'conn_1',
          }) as any,
        );
        await ctx.db.insert(
          'areaArtifactLinks',
          bareLink(userId, areaId, { artifactKind: 'mcpItem', artifactId: 'ext_2' }) as any,
        );

        // Plans: one intent with a plan carrying structured places, one legacy
        // intent with answer options carrying an address, one done intent.
        const intentBase = { userId, rawText: 'raw', source: 'text' as const, createdAt: ts, updatedAt: ts };
        const intent1 = await ctx.db.insert('albatrossIntents', {
          ...intentBase,
          title: 'Book venue',
          status: 'ready',
          primaryAreaId: areaId,
          updatedAt: ts - 1,
        });
        const planId = await ctx.db.insert('albatrossIntentPlans', {
          userId,
          intentId: intent1,
          status: 'ready',
          outcome: 'Venue booked',
          summary: 'Plan summary',
          proposedProjectTitle: 'Launch party',
          digitalActions: [],
          physicalActions: [],
          assumptions: [],
          sourceRefs: [],
          places: [{ name: 'Cafe X', address: '1 Main St' }],
          createdAt: ts,
          updatedAt: ts,
        });
        await ctx.db.patch(intent1, { latestPlanId: planId });
        await ctx.db.insert('albatrossIntents', {
          ...intentBase,
          title: 'Choose caterer',
          status: 'needs_answers',
          areaId: String(areaId),
          questions: [
            {
              id: 'q1',
              prompt: 'Which caterer?',
              options: [
                { id: 'o1', title: 'Harbor Cafe', address: '2 Dock St' },
                { id: 'o2', title: 'No address option' },
              ],
            },
          ],
        });
        await ctx.db.insert('albatrossIntents', {
          ...intentBase,
          title: 'Old work',
          status: 'done',
          primaryAreaId: areaId,
        });

        // Projects with task links and an active sprint.
        const projectId = await ctx.db.insert('albatrossProjects', {
          userId,
          title: 'Launch project',
          status: 'active',
          areaId: String(areaId),
          createdAt: ts,
          updatedAt: ts,
        });
        const sprintId = await ctx.db.insert('albatrossSprints', {
          userId,
          projectId,
          title: 'Sprint 1',
          cadence: 'weekly',
          status: 'active',
          endAt: ts + 86_400_000,
          createdAt: ts,
          updatedAt: ts,
        });
        await ctx.db.patch(projectId, { activeSprintId: sprintId });
        const doneCard = await ctx.db.insert('cards', {
          ...cardBase,
          title: 'Project done card',
          order: 4,
          completedAt: ts,
        });
        const projectLinkBase = {
          userId,
          projectId,
          role: 'supporting' as const,
          createdAt: ts,
          updatedAt: ts,
        };
        await ctx.db.insert('albatrossProjectLinks', {
          ...projectLinkBase,
          artifactKind: 'task',
          artifactId: String(doneCard),
        });
        await ctx.db.insert('albatrossProjectLinks', {
          ...projectLinkBase,
          artifactKind: 'task',
          artifactId: 'nope-not-an-id',
        });
        await ctx.db.insert('albatrossProjectLinks', {
          ...projectLinkBase,
          artifactKind: 'mailThread',
          artifactId: 'home_m1',
        });
        await ctx.db.insert('albatrossProjects', {
          userId,
          title: 'Done project',
          status: 'done',
          areaId: String(areaId),
          createdAt: ts,
          updatedAt: ts,
        });

        await ctx.db.insert('albatrossAreaBriefs', {
          userId,
          areaId,
          status: 'ready',
          lede: 'Area lede',
          summary: 'Area summary',
          sourceRefs: [],
          basedOnRevision: 'rev-1',
          generatedAt: ts,
          createdAt: ts,
          updatedAt: ts,
        });
      });

      const home = await t.query(api.albatross.areaHome, { ...caller(userId), areaId });
      expect(home.area.name).toBe('Launch');
      expect(home.area.primaryDomain).toBe('launch.dev');
      expect(home.livingBrief?.lede).toBe('Area lede');
      expect(home.counts.facts).toEqual({ verified: 1, candidate: 1 });

      expect(home.mail.map((row) => row.providerThreadId)).toEqual(['home_m2', 'home_m1']);
      expect(home.mail[1]).toMatchObject({ unread: true, starred: true, linkStatus: 'candidate' });

      expect(home.events.map((row) => row.providerEventId)).toEqual(['evt_up', 'evt_past']);

      // Incomplete tasks lead; completed board cards (including the project's
      // done card, which lives on the same board) trail by recency.
      expect(home.tasks.map((row) => row.title)).toEqual([
        'Board card open',
        'Linked card',
        'Project done card',
        'Board card done',
      ]);

      expect(home.mcpItems.map((row) => row.externalId).sort()).toEqual(['ext_1', 'ext_2']);

      expect(home.plans).toHaveLength(2);
      const bookVenue = home.plans.find((plan) => plan.title === 'Book venue');
      expect(bookVenue).toMatchObject({
        status: 'ready',
        planStatus: 'ready',
        summary: 'Plan summary',
        proposedProjectTitle: 'Launch party',
      });
      expect(bookVenue?.planId).toBeTruthy();

      expect(home.places.map((place) => place.name).sort()).toEqual(['Cafe X', 'Harbor Cafe']);

      expect(home.projects).toHaveLength(1);
      expect(home.projects[0]).toMatchObject({
        title: 'Launch project',
        taskCount: 2,
        completedTaskCount: 1,
      });
      expect(home.projects[0].activeSprint).toMatchObject({ title: 'Sprint 1', status: 'active' });

      expect(home.counts.evidence.mail).toEqual({ shown: 2, hasMore: false });
      expect(home.counts.evidence.tasks.hasMore).toBe(false);
      expect(home.counts.needsYouBounded).toBe(false);
      expect(home.counts.plans).toBe(2);
      expect(home.counts.projects).toBe(1);
    }));
});

describe('areaDiscoveryBrief', () => {
  test('returns resolved candidates and filters weak context matches', () =>
    withSecret(async () => {
      const t = convexTest(schema, convexModules);
      const userId = 'discovery_user';
      const areaId = await t.mutation(api.albatross.createArea, { ...caller(userId), name: 'Realm' });
      const archivedId = await t.mutation(api.albatross.createArea, { ...caller(userId), name: 'Gone' });
      await t.mutation(api.albatross.archiveArea, { ...caller(userId), areaId: archivedId });
      const ts = Date.now();
      await t.run(async (ctx) => {
        await ctx.db.insert(
          'mailCorpusThreads',
          corpusThread(userId, 'disc_m1', { subject: 'Realm contract' }) as any,
        );
        const eventId = await ctx.db.insert('calendarEvents', {
          userId,
          accountId: 'account_1',
          grantId: 'grant_1',
          provider: 'google',
          providerEventId: 'disc_e1',
          providerCalendarId: 'cal_1',
          title: 'Realm sync',
          startAt: ts,
          endAt: ts + 1000,
          createdAt: ts,
          updatedAt: ts,
        });
        const boardId = await ctx.db.insert('boards', {
          ownerUserId: userId,
          title: 'Loose board',
          createdAt: ts,
          updatedAt: ts,
        });
        const columnId = await ctx.db.insert('boardColumns', {
          boardId,
          name: 'Todo',
          order: 1,
          createdAt: ts,
          updatedAt: ts,
        });
        const cardId = await ctx.db.insert('cards', {
          boardId,
          columnId,
          userId,
          title: 'Realm task',
          order: 1,
          createdAt: ts,
          updatedAt: ts,
        });
        await ctx.db.insert('mcpItems', {
          userId,
          connectionId: 'conn_1',
          server: 'github',
          externalId: 'ext_d1',
          kind: 'pr',
          title: 'Realm PR',
          searchText: 'realm pr',
          createdAt: ts,
          updatedAt: ts,
        });
        await ctx.db.insert(
          'areaArtifactLinks',
          bareLink(userId, areaId, {
            artifactId: 'disc_m1',
            accountId: 'account_1',
            reason: 'sender matches',
          }) as any,
        );
        await ctx.db.insert(
          'areaArtifactLinks',
          bareLink(userId, areaId, {
            artifactKind: 'calendarEvent',
            artifactId: String(eventId),
          }) as any,
        );
        await ctx.db.insert(
          'areaArtifactLinks',
          bareLink(userId, areaId, { artifactKind: 'task', artifactId: String(cardId) }) as any,
        );
        await ctx.db.insert(
          'areaArtifactLinks',
          bareLink(userId, areaId, {
            artifactKind: 'mcpItem',
            artifactId: 'conn_1:ext_d1',
            accountId: 'conn_1',
          }) as any,
        );
        await ctx.db.insert(
          'areaArtifactLinks',
          bareLink(userId, areaId, {
            artifactId: 'disc_weak',
            reason: 'context match on general description overlap',
          }) as any,
        );
        await ctx.db.insert(
          'areaArtifactLinks',
          bareLink(userId, areaId, {
            artifactId: 'disc_durable',
            reason: 'context match; domain: realm.dev appears in the body',
          }) as any,
        );
        await ctx.db.insert(
          'areaArtifactLinks',
          bareLink(userId, archivedId, { artifactId: 'disc_archived_area' }) as any,
        );
        await ctx.db.insert('areaFacts', {
          userId,
          areaId,
          kind: 'domain',
          value: 'realm.dev',
          status: 'candidate',
          sourceRefs: [{ kind: 'mailThread', id: 'disc_m1' }],
          confirmationRefs: [],
          createdAt: ts,
          updatedAt: ts,
        });
      });

      const brief = await t.query(api.albatross.areaDiscoveryBrief, { ...caller(userId) });
      const byArtifact = new Map(brief.candidates.map((row) => [row.artifactId, row]));
      expect(byArtifact.has('disc_weak')).toBe(false);
      expect(byArtifact.has('disc_archived_area')).toBe(false);
      expect(byArtifact.get('disc_m1')).toMatchObject({
        source: 'mail',
        title: 'Realm contract',
        areaName: 'Realm',
      });
      expect(byArtifact.get('conn_1:ext_d1')).toMatchObject({ source: 'github', title: 'Realm PR' });
      expect(byArtifact.get('disc_durable')).toBeDefined();
      expect([...byArtifact.values()].map((row) => row.source)).toContain('calendar');
      expect([...byArtifact.values()].map((row) => row.source)).toContain('tasks');
      expect(brief.candidateFacts).toHaveLength(1);
      expect(brief.candidateFacts[0]).toMatchObject({ kind: 'domain', value: 'realm.dev' });

      const scoped = await t.query(api.albatross.areaDiscoveryBrief, {
        ...caller(userId),
        areaId,
        limit: 3,
      });
      expect(scoped.candidates).toHaveLength(3);
    }));
});

describe('unclassified discovery reads', () => {
  test('unclassifiedAreaArtifacts rotates sources and carries rejected tombstones', () =>
    withSecret(async () => {
      const t = convexTest(schema, convexModules);
      const userId = 'unclassified_artifacts_user';
      const areaId = await t.mutation(api.albatross.createArea, { ...caller(userId), name: 'Realm' });
      const ts = Date.now();
      await t.run(async (ctx) => {
        const connectionBase = {
          userId,
          serverUrl: 'https://mcp.example',
          authKind: 'token' as const,
          scopes: [],
          includeInBrief: true,
          createdAt: ts,
          updatedAt: ts,
        };
        await ctx.db.insert('mcpConnections', {
          ...connectionBase,
          connectionId: 'conn_live',
          server: 'github',
          status: 'connected',
          includeInSearch: true,
        });
        await ctx.db.insert('mcpConnections', {
          ...connectionBase,
          connectionId: 'conn_dead',
          server: 'jira',
          status: 'disconnected',
          includeInSearch: true,
        });
        await ctx.db.insert('mailCorpusThreads', corpusThread(userId, 'ua_mail_1') as any);
        const eventId = await ctx.db.insert('calendarEvents', {
          userId,
          accountId: 'account_1',
          grantId: 'grant_1',
          provider: 'google',
          providerEventId: 'ua_event_1',
          providerCalendarId: 'cal_1',
          title: 'Claimed event',
          startAt: ts,
          endAt: ts + 1000,
          createdAt: ts,
          updatedAt: ts,
        });
        const boardId = await ctx.db.insert('boards', {
          ownerUserId: userId,
          title: 'B',
          createdAt: ts,
          updatedAt: ts,
        });
        const columnId = await ctx.db.insert('boardColumns', {
          boardId,
          name: 'Todo',
          order: 1,
          createdAt: ts,
          updatedAt: ts,
        });
        await ctx.db.insert('cards', {
          boardId,
          columnId,
          userId,
          title: 'Unclaimed card',
          order: 1,
          createdAt: ts,
          updatedAt: ts,
        });
        await ctx.db.insert('mcpItems', {
          userId,
          connectionId: 'conn_live',
          server: 'github',
          externalId: 'ua_ext_1',
          kind: 'issue',
          title: 'Unclaimed issue',
          searchText: 'unclaimed issue',
          createdAt: ts,
          updatedAt: ts,
        });
        // Claimed event: excluded. Rejected mail link: included with tombstone.
        await ctx.db.insert(
          'areaArtifactLinks',
          bareLink(userId, areaId, {
            artifactKind: 'calendarEvent',
            artifactId: String(eventId),
            accountId: 'account_1',
          }) as any,
        );
        await ctx.db.insert(
          'areaArtifactLinks',
          bareLink(userId, areaId, {
            artifactId: 'ua_mail_1',
            accountId: 'account_1',
            status: 'rejected',
          }) as any,
        );
      });
      const result = await t.query(api.albatross.unclassifiedAreaArtifacts, {
        internalSecret: SECRET,
        userId,
      });
      const kinds = result.items.map((item) => item.artifactKind).sort();
      expect(kinds).toEqual(['mailThread', 'mcpItem', 'task']);
      const mailItem = result.items.find((item) => item.artifactKind === 'mailThread');
      expect(mailItem?.rejectedAreaIds).toEqual([String(areaId)]);
      expect(result.sources).toEqual(['mail', 'calendar', 'tasks', 'github']);
    }));

  test('unclassifiedThreads serves pending and legacy rows with canonical message bodies', () =>
    withSecret(async () => {
      const t = convexTest(schema, convexModules);
      const userId = 'unclassified_threads_user';
      const ts = Date.now();
      await t.run(async (ctx) => {
        await ctx.db.insert(
          'mailCorpusThreads',
          corpusThread(userId, 'ut_pending', { areaRoutingPending: true, lastDate: ts }) as any,
        );
        await ctx.db.insert(
          'mailCorpusMessages',
          corpusMessage(userId, 'ut_pending', 'ut_pending_m1', { receivedAt: ts }) as any,
        );
        await ctx.db.insert(
          'mailCorpusThreads',
          corpusThread(userId, 'ut_legacy', {
            lastDate: ts - 1000,
            latestMessageId: 'ut_legacy_watermark',
          }) as any,
        );
        await ctx.db.insert(
          'mailCorpusThreads',
          corpusThread(userId, 'ut_v1', {
            lastDate: ts - 2000,
            areaClassifierVersion: 1,
            latestMessageId: 'ut_v1_watermark',
          }) as any,
        );
        await ctx.db.insert(
          'mailCorpusThreads',
          corpusThread(userId, 'ut_orphan', { lastDate: ts - 3000 }) as any,
        );
        await ctx.db.insert(
          'mailCorpusThreads',
          corpusThread(userId, 'ut_ancient', {
            areaRoutingPending: true,
            lastDate: ts - 60 * 24 * 60 * 60 * 1000,
          }) as any,
        );
      });
      const rows = await t.query(api.albatross.unclassifiedThreads, {
        internalSecret: SECRET,
        userId,
        limit: 10,
      });
      const byThread = new Map(rows.map((row) => [row.providerThreadId, row]));
      expect([...byThread.keys()].sort()).toEqual(['ut_legacy', 'ut_pending', 'ut_v1']);
      expect(byThread.get('ut_pending')).toMatchObject({
        messageId: 'ut_pending_m1',
        toAddress: 'user@example.com',
        bodyText: 'Body of ut_pending_m1',
      });
      expect(byThread.get('ut_legacy')?.messageId).toBe('ut_legacy_watermark');
      expect(byThread.get('ut_v1')?.messageId).toBe('ut_v1_watermark');
    }));
});

describe('recordAreaVerdicts', () => {
  test('writes links, skips archived and duplicate areas, and watermarks empty verdicts', () =>
    withSecret(async () => {
      const t = convexTest(schema, convexModules);
      const userId = 'verdict_user';
      const ts = Date.now();
      const { activeAreaId, archivedAreaId } = await t.run(async (ctx) => {
        const base = { userId, kind: 'general', createdAt: ts, updatedAt: ts };
        return {
          activeAreaId: await ctx.db.insert('areas', { ...base, name: 'A', status: 'active' }),
          archivedAreaId: await ctx.db.insert('areas', { ...base, name: 'B', status: 'archived' }),
        };
      });
      await t.run(async (ctx) => {
        await ctx.db.insert(
          'mailCorpusThreads',
          corpusThread(userId, 'v_t1', { latestMessageId: 'v_m1' }) as any,
        );
        await ctx.db.insert(
          'mailCorpusThreads',
          corpusThread(userId, 'v_t2', { latestMessageId: 'v_m2' }) as any,
        );
      });
      const result = await t.mutation(api.albatross.recordAreaVerdicts, {
        internalSecret: SECRET,
        userId,
        verdicts: [
          {
            artifactId: 'v_t1',
            accountId: 'account_1',
            messageId: 'v_m1',
            links: [
              {
                areaId: activeAreaId,
                status: 'verified',
                confidence: 0.9,
                reason: 'llm: exact sender match',
                confirmationRefs: [userConfirmation('teach-verdict', userId)],
              },
              { areaId: activeAreaId, status: 'candidate' },
              { areaId: archivedAreaId, status: 'candidate' },
            ],
          },
          { artifactId: 'v_missing', accountId: '', messageId: 'x', links: [] },
          { artifactId: 'v_t2', accountId: 'account_1', messageId: 'v_m2', links: [] },
        ],
      });
      expect(result).toEqual({ inserted: 1, updated: 0, superseded: 0, skipped: 3, classified: 2 });
      const links = await t.run((ctx) => ctx.db.query('areaArtifactLinks').collect());
      expect(links).toHaveLength(1);
      expect(links[0]).toMatchObject({
        artifactId: 'v_t1',
        status: 'verified',
        classifierVersion: 2,
        role: 'supporting',
      });
      const threads = await t.run((ctx) => ctx.db.query('mailCorpusThreads').collect());
      for (const providerThreadId of ['v_t1', 'v_t2']) {
        const thread = threads.find((row) => row.providerThreadId === providerThreadId);
        expect(thread).toMatchObject({ areaClassifierVersion: 2 });
        expect(thread?.areaRoutingPending).toBeUndefined();
        expect(thread?.areaClassifiedAt).toBeNumber();
      }
    }));

  test('supersedes automatic links but never touches user-authored or rejected ones', () =>
    withSecret(async () => {
      const t = convexTest(schema, convexModules);
      const userId = 'verdict_supersede_user';
      const ts = Date.now();
      const { areaA, areaC, areaD } = await t.run(async (ctx) => {
        const base = { userId, kind: 'general', status: 'active' as const, createdAt: ts, updatedAt: ts };
        return {
          areaA: await ctx.db.insert('areas', { ...base, name: 'A' }),
          areaC: await ctx.db.insert('areas', { ...base, name: 'C' }),
          areaD: await ctx.db.insert('areas', { ...base, name: 'D' }),
        };
      });
      const { priorAutomaticId, staleAutomaticId, rejectedId, userAuthoredId } = await t.run(async (ctx) => {
        await ctx.db.insert(
          'mailCorpusThreads',
          corpusThread(userId, 's_t1', { latestMessageId: 's_m1' }) as any,
        );
        return {
          priorAutomaticId: await ctx.db.insert(
            'areaArtifactLinks',
            bareLink(userId, areaA, {
              artifactId: 's_t1',
              accountId: 'account_1',
              classifierVersion: 1,
              reason: 'llm: earlier guess',
            }) as any,
          ),
          staleAutomaticId: await ctx.db.insert(
            'areaArtifactLinks',
            bareLink(userId, areaC, {
              artifactId: 's_t1',
              accountId: 'account_1',
              classifierVersion: 1,
              reason: 'llm: stale guess',
            }) as any,
          ),
          rejectedId: await ctx.db.insert(
            'areaArtifactLinks',
            bareLink(userId, areaD, {
              artifactId: 's_t1',
              accountId: 'account_1',
              status: 'rejected',
            }) as any,
          ),
          userAuthoredId: await ctx.db.insert(
            'areaArtifactLinks',
            bareLink(userId, areaD, {
              artifactId: 's_t1_user',
              accountId: 'account_1',
              reason: 'my own filing note',
            }) as any,
          ),
        };
      });
      await t.run((ctx) =>
        ctx.db.insert(
          'mailCorpusThreads',
          corpusThread(userId, 's_t1_user', { latestMessageId: 's_mu' }) as any,
        ),
      );
      const result = await t.mutation(api.albatross.recordAreaVerdicts, {
        internalSecret: SECRET,
        userId,
        verdicts: [
          {
            artifactId: 's_t1',
            accountId: 'account_1',
            messageId: 's_m1',
            links: [
              { areaId: areaA, status: 'candidate', confidence: 0.7, reason: 'llm: still a match' },
              { areaId: areaD, status: 'candidate' },
            ],
          },
          {
            artifactId: 's_t1_user',
            accountId: 'account_1',
            messageId: 's_mu',
            links: [{ areaId: areaD, status: 'candidate' }],
          },
        ],
      });
      // areaA prior automatic: updated. areaD rejected tombstone: skipped.
      // areaC stale automatic dropped by the verdict: superseded.
      // s_t1_user: prior user-authored candidate for areaD is kept (skipped).
      expect(result).toEqual({ inserted: 0, updated: 1, superseded: 1, skipped: 2, classified: 2 });
      expect(await t.run((ctx) => ctx.db.get(priorAutomaticId))).toMatchObject({
        status: 'candidate',
        confidence: 0.7,
        reason: 'llm: still a match',
        classifierVersion: 2,
      });
      expect(await t.run((ctx) => ctx.db.get(staleAutomaticId))).toBeNull();
      expect(await t.run((ctx) => ctx.db.get(rejectedId))).toMatchObject({ status: 'rejected' });
      expect(await t.run((ctx) => ctx.db.get(userAuthoredId))).toMatchObject({
        reason: 'my own filing note',
      });
    }));
});

describe('recordAreaLinks', () => {
  test('inserts cross-source candidate links with mcp identity, skipping dupes and archived areas', () =>
    withSecret(async () => {
      const t = convexTest(schema, convexModules);
      const userId = 'record_links_user';
      const ts = Date.now();
      const { activeAreaId, archivedAreaId } = await t.run(async (ctx) => {
        const base = { userId, kind: 'general', createdAt: ts, updatedAt: ts };
        const activeId = await ctx.db.insert('areas', { ...base, name: 'Active', status: 'active' });
        await ctx.db.insert(
          'areaArtifactLinks',
          bareLink(userId, activeId, { artifactKind: 'task', artifactId: 'card_existing' }) as any,
        );
        return {
          activeAreaId: activeId,
          archivedAreaId: await ctx.db.insert('areas', { ...base, name: 'Frozen', status: 'archived' }),
        };
      });
      const result = await t.mutation(api.albatross.recordAreaLinks, {
        internalSecret: SECRET,
        userId,
        links: [
          {
            areaId: activeAreaId,
            artifactKind: 'calendarEvent',
            artifactId: 'evt_rl_1',
            accountId: 'account_1',
            status: 'candidate',
            confidence: 0.6,
            reason: 'Attendees overlap',
          },
          {
            areaId: activeAreaId,
            artifactKind: 'mcpItem',
            artifactId: 'conn_1:ext_rl',
            accountId: 'conn_1',
            status: 'candidate',
          },
          { areaId: activeAreaId, artifactKind: 'task', artifactId: 'card_existing', status: 'candidate' },
          { areaId: archivedAreaId, artifactKind: 'task', artifactId: 'card_new', status: 'candidate' },
          {
            areaId: activeAreaId,
            artifactKind: 'manual',
            artifactId: 'manual_verified',
            status: 'verified',
            role: 'secondary',
            confirmationRefs: [userConfirmation('teach-manual', userId)],
          },
        ],
      });
      expect(result).toEqual({ inserted: 3, skipped: 2 });
      const links = await t.run((ctx) => ctx.db.query('areaArtifactLinks').collect());
      const mcpLink = links.find((link) => link.artifactKind === 'mcpItem');
      expect(mcpLink).toMatchObject({
        artifactId: 'conn_1:ext_rl',
        externalId: 'ext_rl',
        accountId: 'conn_1',
      });
      const manualLink = links.find((link) => link.artifactKind === 'manual');
      expect(manualLink).toMatchObject({ status: 'verified', role: 'secondary' });
    }));
});

describe('area reindex runtime', () => {
  test('routes mail through a verified email fact, inherits confirmation, and honors rerun requests', () =>
    withSecret(async () => {
      const t = convexTest(schema, convexModules);
      const userId = 'reindex_route_user';
      const ts = Date.now();
      const { areaId, runId } = await t.run(async (ctx) => {
        const id = await ctx.db.insert('areas', {
          userId,
          name: 'Acme',
          kind: 'client',
          status: 'active',
          createdAt: ts,
          updatedAt: ts,
        });
        await ctx.db.insert('areaFacts', {
          userId,
          areaId: id,
          kind: 'email',
          value: 'ops@acme.com',
          status: 'verified',
          sourceRefs: [],
          confirmationRefs: [userConfirmation('conf-reindex', userId)],
          verifiedAt: ts,
          createdAt: ts,
          updatedAt: ts,
        });
        await ctx.db.insert(
          'mailCorpusThreads',
          corpusThread(userId, 'r_t1', { fromAddress: 'Acme Ops <ops@acme.com>' }) as any,
        );
        return {
          areaId: id,
          runId: await ctx.db.insert('areaReindexRuns', queuedRun(userId, { rerunRequestedAt: ts }) as any),
        };
      });
      const first = await t.mutation(internal.albatross.reindexUserAreaArtifacts, { userId, runId });
      expect(first).toMatchObject({ scanned: 1, inserted: 1, matched: 1, skipped: 0, done: true });
      const link = await t.run((ctx) => ctx.db.query('areaArtifactLinks').first());
      expect(link).toMatchObject({
        areaId,
        artifactId: 'r_t1',
        status: 'verified',
        classifierVersion: 2,
        reason: 'verified email ops@acme.com',
      });
      expect(link?.confirmationRefs[0]?.prompt).toBe('Inherited from a user-verified Area identity fact');
      expect(link?.sourceRefs[0]?.kind).toBe('areaFact');
      const thread = await t.run((ctx) => ctx.db.query('mailCorpusThreads').first());
      expect(thread).toMatchObject({ areaClassifierVersion: 2 });
      const runs = await t.run((ctx) => ctx.db.query('areaReindexRuns').collect());
      const finished = runs.find((run) => run._id === runId);
      expect(finished).toMatchObject({ status: 'done', matched: 1, inserted: 1, pages: 1 });
      const followUp = runs.find((run) => run._id !== runId);
      expect(followUp).toMatchObject({
        status: 'queued',
        reason: 'Area changes arrived during the previous reindex',
      });

      // Second pass refreshes the same automatic link instead of duplicating it.
      const secondRunId = await t.run((ctx) => ctx.db.insert('areaReindexRuns', queuedRun(userId) as any));
      const second = await t.mutation(internal.albatross.reindexUserAreaArtifacts, {
        userId,
        runId: secondRunId,
      });
      expect(second).toMatchObject({ scanned: 1, inserted: 0, matched: 1, done: true });
      expect(await t.run((ctx) => ctx.db.query('areaArtifactLinks').collect())).toHaveLength(1);
    }));

  test('retires weak automatic links and abstains on conflicting or shared-domain evidence', () =>
    withSecret(async () => {
      const t = convexTest(schema, convexModules);
      const userId = 'reindex_conflict_user';
      const ts = Date.now();
      const runId = await t.run(async (ctx) => {
        const base = { userId, kind: 'general', status: 'active' as const, createdAt: ts, updatedAt: ts };
        const areaOne = await ctx.db.insert('areas', { ...base, name: 'One' });
        const areaTwo = await ctx.db.insert('areas', { ...base, name: 'Two' });
        const factBase = {
          userId,
          kind: 'domain',
          status: 'verified' as const,
          sourceRefs: [],
          verifiedAt: ts,
          createdAt: ts,
          updatedAt: ts,
        };
        await ctx.db.insert('areaFacts', {
          ...factBase,
          areaId: areaOne,
          value: 'contested.com',
          confirmationRefs: [userConfirmation('conf-one', userId)],
        });
        await ctx.db.insert('areaFacts', {
          ...factBase,
          areaId: areaTwo,
          value: 'contested.com',
          confirmationRefs: [userConfirmation('conf-two', userId)],
        });
        await ctx.db.insert('areaFacts', {
          ...factBase,
          areaId: areaOne,
          value: 'gmail.com',
          confirmationRefs: [userConfirmation('conf-gmail', userId)],
        });
        await ctx.db.insert(
          'mailCorpusThreads',
          corpusThread(userId, 'c_t1', { fromAddress: 'anyone@contested.com' }) as any,
        );
        await ctx.db.insert(
          'mailCorpusThreads',
          corpusThread(userId, 'c_t2', { fromAddress: 'stranger@gmail.com', lastDate: ts - 1 }) as any,
        );
        await ctx.db.insert(
          'areaArtifactLinks',
          bareLink(userId, areaOne, {
            artifactId: 'c_t1',
            accountId: 'account_1',
            sourceRefs: [{ kind: 'areaContext', id: 'ctx_1' }],
          }) as any,
        );
        return ctx.db.insert('areaReindexRuns', queuedRun(userId) as any);
      });
      const result = await t.mutation(internal.albatross.reindexUserAreaArtifacts, { userId, runId });
      expect(result).toMatchObject({ scanned: 2, inserted: 0, matched: 0, retired: 1, skipped: 2 });
      expect(await t.run((ctx) => ctx.db.query('areaArtifactLinks').collect())).toEqual([]);
      const threads = await t.run((ctx) => ctx.db.query('mailCorpusThreads').collect());
      for (const thread of threads) {
        expect(thread.areaRoutingPending).toBe(true);
        expect(thread.areaClassifierVersion).toBeUndefined();
      }
    }));

  test('retires the unadopted legacy Personal area but preserves an adopted one', () =>
    withSecret(async () => {
      const t = convexTest(schema, convexModules);
      const ts = Date.now();
      const seedLegacy = (userId: string) => ({
        userId,
        externalId: 'system:personal',
        name: 'Personal',
        kind: 'personal',
        status: 'active' as const,
        createdAt: ts,
        updatedAt: ts,
      });
      const { unadoptedAreaId, unadoptedRunId, adoptedAreaId, adoptedRunId } = await t.run(async (ctx) => {
        const unadopted = await ctx.db.insert('areas', seedLegacy('legacy_unadopted_user'));
        const adopted = await ctx.db.insert('areas', seedLegacy('legacy_adopted_user'));
        await ctx.db.insert('areaFacts', {
          userId: 'legacy_adopted_user',
          areaId: adopted,
          kind: 'note',
          value: 'Kept on purpose',
          status: 'verified',
          sourceRefs: [],
          confirmationRefs: [userConfirmation('conf-legacy', 'legacy_adopted_user')],
          verifiedAt: ts,
          createdAt: ts,
          updatedAt: ts,
        });
        return {
          unadoptedAreaId: unadopted,
          adoptedAreaId: adopted,
          unadoptedRunId: await ctx.db.insert('areaReindexRuns', queuedRun('legacy_unadopted_user') as any),
          adoptedRunId: await ctx.db.insert('areaReindexRuns', queuedRun('legacy_adopted_user') as any),
        };
      });
      await t.mutation(internal.albatross.reindexUserAreaArtifacts, {
        userId: 'legacy_unadopted_user',
        runId: unadoptedRunId,
      });
      await t.mutation(internal.albatross.reindexUserAreaArtifacts, {
        userId: 'legacy_adopted_user',
        runId: adoptedRunId,
      });
      const unadopted = await t.run((ctx) => ctx.db.get(unadoptedAreaId));
      expect(unadopted?.status).toBe('archived');
      expect(unadopted?.externalId).toBeUndefined();
      const adopted = await t.run((ctx) => ctx.db.get(adoptedAreaId));
      expect(adopted?.status).toBe('active');
      expect(adopted?.externalId).toBeUndefined();
    }));

  test('stale invocations, coalescing, and safety budgets stop cleanly', () =>
    withSecret(async () => {
      const t = convexTest(schema, convexModules);
      const userId = 'reindex_guard_user';
      const ts = Date.now();
      // Pin the finished run's clock well before the queued pair: queuedRun()
      // stamps Date.now() at call time, and a millisecond tick would otherwise
      // make this done run the newest-by-updatedAt and steal the coalesce
      // target from newerRunId.
      const doneRunId = await t.run((ctx) =>
        ctx.db.insert(
          'areaReindexRuns',
          queuedRun(userId, { status: 'done', createdAt: ts - 60_000, updatedAt: ts - 60_000 }) as any,
        ),
      );
      expect(
        await t.mutation(internal.albatross.reindexUserAreaArtifacts, { userId, runId: doneRunId }),
      ).toMatchObject({ stale: true, done: true, scanned: 0 });

      const { olderRunId, newerRunId } = await t.run(async (ctx) => ({
        olderRunId: await ctx.db.insert(
          'areaReindexRuns',
          queuedRun(userId, { createdAt: ts - 5000, updatedAt: ts - 5000 }) as any,
        ),
        newerRunId: await ctx.db.insert(
          'areaReindexRuns',
          queuedRun(userId, { createdAt: ts, updatedAt: ts }) as any,
        ),
      }));
      expect(
        await t.mutation(internal.albatross.reindexUserAreaArtifacts, { userId, runId: olderRunId }),
      ).toMatchObject({ done: true, scanned: 0 });
      expect(await t.run((ctx) => ctx.db.get(olderRunId))).toMatchObject({
        status: 'done',
        coalescedInto: String(newerRunId),
      });

      const pageBudgetRunId = await t.run((ctx) =>
        ctx.db.insert(
          'areaReindexRuns',
          queuedRun('page_budget_user', { status: 'running', cursor: 'cursor_a', pages: 500 }) as any,
        ),
      );
      const pageBudget = await t.mutation(internal.albatross.reindexUserAreaArtifacts, {
        userId: 'page_budget_user',
        runId: pageBudgetRunId,
        cursor: 'cursor_a',
      });
      expect(pageBudget.done).toBe(false);
      expect(pageBudget.error).toContain('500 pages');
      expect(await t.run((ctx) => ctx.db.get(pageBudgetRunId))).toMatchObject({ status: 'error' });

      const scanBudgetRunId = await t.run((ctx) =>
        ctx.db.insert(
          'areaReindexRuns',
          queuedRun('scan_budget_user', {
            status: 'running',
            cursor: 'cursor_b',
            pages: 1,
            scanned: 50_000,
          }) as any,
        ),
      );
      const scanBudget = await t.mutation(internal.albatross.reindexUserAreaArtifacts, {
        userId: 'scan_budget_user',
        runId: scanBudgetRunId,
        cursor: 'cursor_b',
      });
      expect(scanBudget.done).toBe(false);
      expect(scanBudget.error).toContain('50000 threads');
    }));

  test('queueUserAreaReindex coalesces queued runs and marks running runs for rerun', () =>
    withSecret(async () => {
      const t = convexTest(schema, convexModules);
      const userId = 'queue_reindex_user';
      const first = await t.mutation(internal.albatross.queueUserAreaReindex, {
        userId,
        reason: 'First request',
        delayMs: 60_000,
      });
      const second = await t.mutation(internal.albatross.queueUserAreaReindex, {
        userId,
        reason: 'Second request',
        delayMs: 60_000,
      });
      expect(String(second.runId)).toBe(String(first.runId));
      expect(await t.run((ctx) => ctx.db.get(first.runId))).toMatchObject({
        status: 'queued',
        reason: 'Second request',
      });
      await t.run((ctx) => ctx.db.patch(first.runId, { status: 'running' }));
      const third = await t.mutation(internal.albatross.queueUserAreaReindex, {
        userId,
        reason: 'While running',
        delayMs: 60_000,
      });
      expect(String(third.runId)).toBe(String(first.runId));
      const run = await t.run((ctx) => ctx.db.get(first.runId));
      expect(run?.rerunRequestedAt).toBeNumber();
      expect(run?.reason).toBe('While running');
    }));
});

describe('seedContextGraphFromFixture', () => {
  test('replaces the user context graph from a fixture with normalized statuses', () =>
    withSecret(async () => {
      const t = convexTest(schema, convexModules);
      const userId = 'seed_user';
      const ts = Date.now();
      await t.run(async (ctx) => {
        const staleAreaId = await ctx.db.insert('areas', {
          userId,
          name: 'Stale area',
          kind: 'general',
          status: 'active',
          createdAt: ts,
          updatedAt: ts,
        });
        await ctx.db.insert('areaFacts', {
          userId,
          areaId: staleAreaId,
          kind: 'note',
          value: 'Old fact',
          status: 'candidate',
          sourceRefs: [],
          confirmationRefs: [],
          createdAt: ts,
          updatedAt: ts,
        });
        await ctx.db.insert(
          'areaArtifactLinks',
          bareLink(userId, staleAreaId, { artifactId: 'stale_thread' }) as any,
        );
      });
      const result = await t.mutation(api.albatross.seedContextGraphFromFixture, {
        internalSecret: SECRET,
        userId,
        fixture: {
          tables: {
            areas: [
              { id: 'area-1', name: 'Fixture area', kind: 'project', priority: 1 },
              { id: 'area-2', name: 'Archived fixture', status: 'archived' },
            ],
            areaFacts: [
              {
                id: 'fact-1',
                areaId: 'area-1',
                kind: 'domain',
                value: 'fixture.dev',
                status: 'verified',
                confirmationRefs: [
                  { kind: 'userConfirmation', id: 'seed-conf', confirmedAt: '2026-07-01T00:00:00Z' },
                ],
              },
              { id: 'fact-2', areaId: 'area-1', kind: 'note', value: 'Loose idea', status: 'weird' },
              { id: 'fact-orphan', areaId: 'missing-area', kind: 'note', value: 'Dropped' },
            ],
            areaArtifactLinks: [
              {
                id: 'link-1',
                areaId: 'area-1',
                artifactKind: 'mailThread',
                artifactId: 'seed_thread',
                accountId: 'account_1',
                role: 'primary',
                confidence: 0.4,
              },
              { id: 'link-2', areaId: 'area-2', artifactKind: 'not-a-kind', artifactId: 'weird_artifact' },
              { id: 'link-orphan', areaId: 'missing-area', artifactId: 'dropped' },
            ],
          },
        },
      });
      expect(result).toEqual({
        userId,
        counts: { areas: 2, areaFacts: 2, areaArtifactLinks: 2 },
      });
      const areas = await t.run((ctx) => ctx.db.query('areas').collect());
      expect(areas.map((area) => area.name).sort()).toEqual(['Archived fixture', 'Fixture area']);
      expect(areas.find((area) => area.name === 'Archived fixture')?.status).toBe('archived');
      const facts = await t.run((ctx) => ctx.db.query('areaFacts').collect());
      expect(facts).toHaveLength(2);
      const verifiedFact = facts.find((fact) => fact.value === 'fixture.dev');
      expect(verifiedFact?.status).toBe('verified');
      expect(verifiedFact?.verifiedAt).toBeNumber();
      expect(facts.find((fact) => fact.value === 'Loose idea')?.status).toBe('candidate');
      const links = await t.run((ctx) => ctx.db.query('areaArtifactLinks').collect());
      expect(links).toHaveLength(2);
      expect(links.find((link) => link.artifactId === 'weird_artifact')?.artifactKind).toBe('manual');
      expect(links.find((link) => link.artifactId === 'stale_thread')).toBeUndefined();
    }));
});

describe('classifyTick', () => {
  test('no-ops without an app url and fans out to zero targets with one', () =>
    withSecret(async () => {
      const previousUrl = process.env.LAB86_MAIL_PUBLIC_URL;
      try {
        delete process.env.LAB86_MAIL_PUBLIC_URL;
        const t = convexTest(schema, convexModules);
        await t.action(internal.albatross.classifyTick, {});

        process.env.LAB86_MAIL_PUBLIC_URL = 'https://app.example.test/';
        await t.action(internal.albatross.classifyTick, {});
      } finally {
        if (previousUrl === undefined) delete process.env.LAB86_MAIL_PUBLIC_URL;
        else process.env.LAB86_MAIL_PUBLIC_URL = previousUrl;
      }
    }));
});

describe('setAreaImage', () => {
  test('sets, replaces, and clears the area image with upload cleanup', () =>
    withSecret(async () => {
      const t = convexTest(schema, convexModules);
      const userId = 'image_user';
      const areaId = await t.mutation(api.albatross.createArea, { ...caller(userId), name: 'Gallery' });
      const makeUpload = async (name: string, contentType: string) => {
        return await t.run(async (ctx) => {
          const storageId = await ctx.storage.store(new Blob(['fake-bytes'], { type: contentType }));
          const uploadId = await ctx.db.insert('agentUploads', {
            userId,
            storageId,
            name,
            contentType,
            size: 10,
            createdAt: Date.now(),
          });
          return { storageId, uploadId };
        });
      };

      const badUpload = await makeUpload('notes.txt', 'text/plain');
      await expect(
        t.mutation(api.albatross.setAreaImage, {
          ...caller(userId),
          areaId,
          uploadId: badUpload.uploadId,
        }),
      ).rejects.toThrow(/Choose an image file/);

      const firstUpload = await makeUpload('cover.png', 'image/png');
      const setResult = await t.mutation(api.albatross.setAreaImage, {
        ...caller(userId),
        areaId,
        uploadId: firstUpload.uploadId,
      });
      expect(setResult.ok).toBe(true);
      expect(setResult.imageUrl).toBeTruthy();
      expect(await t.run((ctx) => ctx.db.get(areaId))).toMatchObject({
        imageStorageId: firstUpload.storageId,
      });

      const secondUpload = await makeUpload('cover2.png', 'image/png');
      await t.mutation(api.albatross.setAreaImage, {
        ...caller(userId),
        areaId,
        uploadId: secondUpload.uploadId,
      });
      expect(await t.run((ctx) => ctx.db.get(firstUpload.uploadId))).toBeNull();
      expect(await t.run((ctx) => ctx.storage.getUrl(firstUpload.storageId))).toBeNull();

      const cleared = await t.mutation(api.albatross.setAreaImage, { ...caller(userId), areaId });
      expect(cleared).toEqual({ ok: true, imageUrl: null });
      const area = await t.run((ctx) => ctx.db.get(areaId));
      expect(area?.imageStorageId).toBeUndefined();
      expect(area?.imageUrl).toBeUndefined();
      expect(await t.run((ctx) => ctx.db.get(secondUpload.uploadId))).toBeNull();

      await expect(
        t.mutation(api.albatross.setAreaImage, {
          ...caller('someone_else_entirely'),
          areaId,
        }),
      ).rejects.toThrow(/Area not found/);
    }));
});
