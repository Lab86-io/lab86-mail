import { v } from 'convex/values';
import type { Id } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';
import { mutation, query } from './_generated/server';
import {
  type AlbatrossConfirmationRef,
  type AlbatrossSourceRef,
  type AreaArtifactLinkStatus,
  type AreaFactStatus,
  assertFactTransitionAllowed,
  assertVerifiedFactAllowed,
  normalizeConfirmationRefs,
  normalizeSourceRefs,
  normalizeText,
} from './albatrossModel';
import { now, requireInternalSecret } from './lib';

const callerArgs = {
  internalSecret: v.optional(v.string()),
  userId: v.optional(v.string()),
};

const sourceRefValidator = v.object({
  kind: v.string(),
  id: v.string(),
  label: v.optional(v.string()),
  accountId: v.optional(v.string()),
  url: v.optional(v.string()),
});

const confirmationRefValidator = v.object({
  kind: v.string(),
  id: v.string(),
  confirmedAt: v.number(),
  confirmedBy: v.optional(v.string()),
  prompt: v.optional(v.string()),
  sourceRefId: v.optional(v.string()),
});

const areaStatusValidator = v.union(v.literal('active'), v.literal('archived'));
const factStatusValidator = v.union(
  v.literal('candidate'),
  v.literal('verified'),
  v.literal('rejected'),
  v.literal('superseded'),
);
const creatableFactStatusValidator = v.union(v.literal('candidate'), v.literal('verified'));
const linkStatusValidator = v.union(v.literal('candidate'), v.literal('verified'), v.literal('rejected'));
const artifactKindValidator = v.union(
  v.literal('mailThread'),
  v.literal('calendarEvent'),
  v.literal('task'),
  v.literal('mcpItem'),
  v.literal('intent'),
  v.literal('manual'),
);
const linkRoleValidator = v.union(v.literal('primary'), v.literal('secondary'), v.literal('supporting'));

async function resolveUserId(
  ctx: QueryCtx | MutationCtx,
  args: { internalSecret?: string; userId?: string },
): Promise<string> {
  if (args.internalSecret) {
    requireInternalSecret(args.internalSecret);
    if (!args.userId) throw new Error('userId required with internal secret.');
    return args.userId;
  }
  const identity = await ctx.auth.getUserIdentity();
  if (!identity?.subject) throw new Error('Not authenticated');
  return identity.subject;
}

async function requireArea(ctx: QueryCtx | MutationCtx, areaId: Id<'areas'>, userId: string) {
  const area = await ctx.db.get(areaId);
  if (!area || area.userId !== userId) throw new Error('Area not found.');
  return area;
}

async function requireFact(ctx: QueryCtx | MutationCtx, factId: Id<'areaFacts'>, userId: string) {
  const fact = await ctx.db.get(factId);
  if (!fact || fact.userId !== userId) throw new Error('Area fact not found.');
  return fact;
}

function normalizedRefs(input: {
  sourceRefs?: AlbatrossSourceRef[];
  confirmationRefs?: AlbatrossConfirmationRef[];
}) {
  return {
    sourceRefs: normalizeSourceRefs(input.sourceRefs),
    confirmationRefs: normalizeConfirmationRefs(input.confirmationRefs),
  };
}

function verifiedFactPatch(status: AreaFactStatus, confirmationRefs: AlbatrossConfirmationRef[], ts: number) {
  assertVerifiedFactAllowed({ kind: 'area_fact', status, confirmationRefs });
  return {
    verifiedAt: status === 'verified' ? ts : undefined,
    rejectedAt: status === 'rejected' ? ts : undefined,
  };
}

async function ensureExternalAreaIdAvailable(
  ctx: QueryCtx | MutationCtx,
  userId: string,
  externalId: string | undefined,
  currentId?: Id<'areas'>,
) {
  if (!externalId) return;
  const existing = await ctx.db
    .query('areas')
    .withIndex('by_user_external', (q) => q.eq('userId', userId).eq('externalId', externalId))
    .unique();
  if (existing && existing._id !== currentId)
    throw new Error(`Area externalId already exists: ${externalId}`);
}

export const createArea = mutation({
  args: {
    ...callerArgs,
    externalId: v.optional(v.string()),
    name: v.string(),
    kind: v.optional(v.string()),
    description: v.optional(v.string()),
    priority: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    const externalId = args.externalId ? normalizeText(args.externalId) : undefined;
    await ensureExternalAreaIdAvailable(ctx, userId, externalId);
    const ts = now();
    return await ctx.db.insert('areas', {
      userId,
      externalId,
      name: normalizeText(args.name, 'Untitled area').slice(0, 120),
      kind: normalizeText(args.kind || 'general', 'general').slice(0, 80),
      status: 'active',
      description: args.description ? normalizeText(args.description).slice(0, 600) : undefined,
      priority: args.priority,
      createdAt: ts,
      updatedAt: ts,
    });
  },
});

export const updateArea = mutation({
  args: {
    ...callerArgs,
    areaId: v.id('areas'),
    name: v.optional(v.string()),
    kind: v.optional(v.string()),
    description: v.optional(v.string()),
    priority: v.optional(v.number()),
    status: v.optional(areaStatusValidator),
  },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    await requireArea(ctx, args.areaId, userId);
    const ts = now();
    await ctx.db.patch(args.areaId, {
      ...(args.name !== undefined ? { name: normalizeText(args.name, 'Untitled area').slice(0, 120) } : {}),
      ...(args.kind !== undefined ? { kind: normalizeText(args.kind, 'general').slice(0, 80) } : {}),
      ...(args.description !== undefined
        ? { description: normalizeText(args.description).slice(0, 600) || undefined }
        : {}),
      ...(args.priority !== undefined ? { priority: args.priority } : {}),
      ...(args.status !== undefined
        ? { status: args.status, archivedAt: args.status === 'archived' ? ts : undefined }
        : {}),
      updatedAt: ts,
    });
    return { ok: true };
  },
});

export const archiveArea = mutation({
  args: { ...callerArgs, areaId: v.id('areas') },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    await requireArea(ctx, args.areaId, userId);
    const ts = now();
    await ctx.db.patch(args.areaId, { status: 'archived', archivedAt: ts, updatedAt: ts });
    return { ok: true };
  },
});

export const listAreas = query({
  args: { ...callerArgs, status: v.optional(areaStatusValidator) },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    const rows = args.status
      ? await ctx.db
          .query('areas')
          .withIndex('by_user_status', (q) => q.eq('userId', userId).eq('status', args.status!))
          .collect()
      : await ctx.db
          .query('areas')
          .withIndex('by_user', (q) => q.eq('userId', userId))
          .collect();
    return rows.sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99) || a.name.localeCompare(b.name));
  },
});

export const getArea = query({
  args: { ...callerArgs, areaId: v.id('areas') },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    return await requireArea(ctx, args.areaId, userId);
  },
});

export const addAreaFact = mutation({
  args: {
    ...callerArgs,
    areaId: v.id('areas'),
    externalId: v.optional(v.string()),
    kind: v.string(),
    value: v.string(),
    status: v.optional(creatableFactStatusValidator),
    sourceRefs: v.optional(v.array(sourceRefValidator)),
    confirmationRefs: v.optional(v.array(confirmationRefValidator)),
  },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    await requireArea(ctx, args.areaId, userId);
    const status = (args.status || 'candidate') as AreaFactStatus;
    const refs = normalizedRefs(args);
    assertVerifiedFactAllowed({
      kind: args.kind,
      status,
      confirmationRefs: refs.confirmationRefs,
    });
    const ts = now();
    return await ctx.db.insert('areaFacts', {
      userId,
      areaId: args.areaId,
      externalId: args.externalId ? normalizeText(args.externalId) : undefined,
      kind: normalizeText(args.kind, 'note').slice(0, 80),
      value: normalizeText(args.value).slice(0, 1200),
      status,
      sourceRefs: refs.sourceRefs,
      confirmationRefs: refs.confirmationRefs,
      ...verifiedFactPatch(status, refs.confirmationRefs, ts),
      createdAt: ts,
      updatedAt: ts,
    });
  },
});

export const verifyAreaFact = mutation({
  args: {
    ...callerArgs,
    factId: v.id('areaFacts'),
    sourceRefs: v.optional(v.array(sourceRefValidator)),
    confirmationRefs: v.array(confirmationRefValidator),
  },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    const fact = await requireFact(ctx, args.factId, userId);
    assertFactTransitionAllowed(fact.status as AreaFactStatus, 'verified');
    const refs = normalizedRefs(args);
    const confirmationRefs = [...fact.confirmationRefs, ...refs.confirmationRefs];
    assertVerifiedFactAllowed({ kind: fact.kind, status: 'verified', confirmationRefs });
    const ts = now();
    await ctx.db.patch(args.factId, {
      status: 'verified',
      sourceRefs: [...fact.sourceRefs, ...refs.sourceRefs],
      confirmationRefs,
      verifiedAt: ts,
      updatedAt: ts,
    });
    return { ok: true };
  },
});

export const rejectAreaFact = mutation({
  args: { ...callerArgs, factId: v.id('areaFacts'), reason: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    const fact = await requireFact(ctx, args.factId, userId);
    assertFactTransitionAllowed(fact.status as AreaFactStatus, 'rejected');
    const ts = now();
    await ctx.db.patch(args.factId, {
      status: 'rejected',
      rejectedReason: args.reason ? normalizeText(args.reason).slice(0, 500) : undefined,
      rejectedAt: ts,
      updatedAt: ts,
    });
    return { ok: true };
  },
});

export const supersedeAreaFact = mutation({
  args: {
    ...callerArgs,
    factId: v.id('areaFacts'),
    replacement: v.optional(
      v.object({
        externalId: v.optional(v.string()),
        kind: v.optional(v.string()),
        value: v.string(),
        status: v.optional(v.union(v.literal('candidate'), v.literal('verified'))),
        sourceRefs: v.optional(v.array(sourceRefValidator)),
        confirmationRefs: v.optional(v.array(confirmationRefValidator)),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    const fact = await requireFact(ctx, args.factId, userId);
    assertFactTransitionAllowed(fact.status as AreaFactStatus, 'superseded');
    const ts = now();
    let replacementFactId: Id<'areaFacts'> | undefined;
    if (args.replacement) {
      const replacementStatus = (args.replacement.status || 'verified') as AreaFactStatus;
      const refs = normalizedRefs(args.replacement);
      assertVerifiedFactAllowed({
        kind: args.replacement.kind || fact.kind,
        status: replacementStatus,
        confirmationRefs: refs.confirmationRefs,
      });
      replacementFactId = await ctx.db.insert('areaFacts', {
        userId,
        areaId: fact.areaId,
        externalId: args.replacement.externalId ? normalizeText(args.replacement.externalId) : undefined,
        kind: normalizeText(args.replacement.kind || fact.kind, fact.kind).slice(0, 80),
        value: normalizeText(args.replacement.value).slice(0, 1200),
        status: replacementStatus,
        sourceRefs: refs.sourceRefs,
        confirmationRefs: refs.confirmationRefs,
        supersedesFactId: args.factId,
        ...verifiedFactPatch(replacementStatus, refs.confirmationRefs, ts),
        createdAt: ts,
        updatedAt: ts,
      });
    }
    await ctx.db.patch(args.factId, {
      status: 'superseded',
      supersededAt: ts,
      supersededByFactId: replacementFactId,
      updatedAt: ts,
    });
    return { ok: true, replacementFactId };
  },
});

export const listAreaFacts = query({
  args: { ...callerArgs, areaId: v.id('areas'), status: v.optional(factStatusValidator) },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    await requireArea(ctx, args.areaId, userId);
    return args.status
      ? await ctx.db
          .query('areaFacts')
          .withIndex('by_user_area_status', (q) =>
            q.eq('userId', userId).eq('areaId', args.areaId).eq('status', args.status!),
          )
          .collect()
      : await ctx.db
          .query('areaFacts')
          .withIndex('by_area', (q) => q.eq('areaId', args.areaId))
          .collect();
  },
});

export const listVerifiedFacts = query({
  args: { ...callerArgs, areaId: v.optional(v.id('areas')) },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    if (args.areaId) {
      await requireArea(ctx, args.areaId, userId);
      return await ctx.db
        .query('areaFacts')
        .withIndex('by_user_area_status', (q) =>
          q.eq('userId', userId).eq('areaId', args.areaId!).eq('status', 'verified'),
        )
        .collect();
    }
    return await ctx.db
      .query('areaFacts')
      .withIndex('by_user_status', (q) => q.eq('userId', userId).eq('status', 'verified'))
      .collect();
  },
});

export const linkArtifactToArea = mutation({
  args: {
    ...callerArgs,
    areaId: v.id('areas'),
    externalId: v.optional(v.string()),
    artifactKind: artifactKindValidator,
    artifactId: v.string(),
    accountId: v.optional(v.string()),
    role: v.optional(linkRoleValidator),
    status: v.optional(linkStatusValidator),
    confidence: v.optional(v.number()),
    reason: v.optional(v.string()),
    sourceRefs: v.optional(v.array(sourceRefValidator)),
    confirmationRefs: v.optional(v.array(confirmationRefValidator)),
  },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    await requireArea(ctx, args.areaId, userId);
    const refs = normalizedRefs(args);
    const ts = now();
    const artifactId = normalizeText(args.artifactId);
    const existing = (
      await ctx.db
        .query('areaArtifactLinks')
        .withIndex('by_user_artifact', (q) =>
          q.eq('userId', userId).eq('artifactKind', args.artifactKind).eq('artifactId', artifactId),
        )
        .collect()
    ).find((link) => link.areaId === args.areaId);
    const patch = {
      userId,
      areaId: args.areaId,
      externalId: args.externalId ? normalizeText(args.externalId) : undefined,
      artifactKind: args.artifactKind,
      artifactId,
      accountId: args.accountId ? normalizeText(args.accountId) : undefined,
      role: args.role || 'primary',
      status: (args.status || 'candidate') as AreaArtifactLinkStatus,
      confidence: args.confidence,
      reason: args.reason ? normalizeText(args.reason).slice(0, 700) : undefined,
      sourceRefs: refs.sourceRefs,
      confirmationRefs: refs.confirmationRefs,
      updatedAt: ts,
    };
    if (existing) {
      await ctx.db.patch(existing._id, patch);
      return existing._id;
    }
    return await ctx.db.insert('areaArtifactLinks', { ...patch, createdAt: ts });
  },
});

export const listAreaArtifactLinks = query({
  args: { ...callerArgs, areaId: v.id('areas'), status: v.optional(linkStatusValidator) },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    await requireArea(ctx, args.areaId, userId);
    return args.status
      ? await ctx.db
          .query('areaArtifactLinks')
          .withIndex('by_user_area_status', (q) =>
            q.eq('userId', userId).eq('areaId', args.areaId).eq('status', args.status!),
          )
          .collect()
      : await ctx.db
          .query('areaArtifactLinks')
          .withIndex('by_user_area', (q) => q.eq('userId', userId).eq('areaId', args.areaId))
          .collect();
  },
});

export const listArtifactLinks = query({
  args: { ...callerArgs, artifactKind: artifactKindValidator, artifactId: v.string() },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    return await ctx.db
      .query('areaArtifactLinks')
      .withIndex('by_user_artifact', (q) =>
        q.eq('userId', userId).eq('artifactKind', args.artifactKind).eq('artifactId', args.artifactId),
      )
      .collect();
  },
});

type SeedFixture = {
  tables?: {
    areas?: any[];
    areaFacts?: any[];
    areaArtifactLinks?: any[];
  };
};

function seedConfirmationRefs(refs: any[] | undefined): AlbatrossConfirmationRef[] {
  return (refs || []).map((ref) => ({
    kind: String(ref.kind || ''),
    id: String(ref.id || ''),
    confirmedAt:
      typeof ref.confirmedAt === 'number'
        ? ref.confirmedAt
        : Date.parse(String(ref.confirmedAt || '')) || now(),
    confirmedBy: typeof ref.confirmedBy === 'string' ? ref.confirmedBy : undefined,
    prompt: typeof ref.prompt === 'string' ? ref.prompt : undefined,
    sourceRefId: typeof ref.sourceRefId === 'string' ? ref.sourceRefId : undefined,
  }));
}

export const seedContextGraphFromFixture = mutation({
  args: { internalSecret: v.optional(v.string()), userId: v.string(), fixture: v.any() },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const fixture = args.fixture as SeedFixture;
    const tables = fixture.tables || {};
    const existingLinks = await ctx.db
      .query('areaArtifactLinks')
      .withIndex('by_user', (q) => q.eq('userId', args.userId))
      .collect();
    for (const link of existingLinks) await ctx.db.delete(link._id);
    const existingFacts = await ctx.db
      .query('areaFacts')
      .withIndex('by_user', (q) => q.eq('userId', args.userId))
      .collect();
    for (const fact of existingFacts) await ctx.db.delete(fact._id);
    const existingAreas = await ctx.db
      .query('areas')
      .withIndex('by_user', (q) => q.eq('userId', args.userId))
      .collect();
    for (const area of existingAreas) await ctx.db.delete(area._id);

    const ts = now();
    const areaIds = new Map<string, Id<'areas'>>();
    for (const area of tables.areas || []) {
      const id = await ctx.db.insert('areas', {
        userId: args.userId,
        externalId: String(area.id || ''),
        name: normalizeText(String(area.name || ''), 'Untitled area').slice(0, 120),
        kind: normalizeText(String(area.kind || 'general'), 'general').slice(0, 80),
        status: area.status === 'archived' ? 'archived' : 'active',
        description:
          typeof area.description === 'string' ? normalizeText(area.description).slice(0, 600) : undefined,
        priority: typeof area.priority === 'number' ? area.priority : undefined,
        createdAt: ts,
        updatedAt: ts,
      });
      if (area.id) areaIds.set(String(area.id), id);
    }

    const factIds = new Map<string, Id<'areaFacts'>>();
    for (const fact of tables.areaFacts || []) {
      const areaId = areaIds.get(String(fact.areaId || ''));
      if (!areaId) continue;
      const status = ['verified', 'rejected', 'superseded'].includes(fact.status)
        ? (fact.status as AreaFactStatus)
        : 'candidate';
      const refs = {
        sourceRefs: normalizeSourceRefs(fact.sourceRefs || []),
        confirmationRefs: normalizeConfirmationRefs(seedConfirmationRefs(fact.confirmationRefs)),
      };
      assertVerifiedFactAllowed({
        kind: String(fact.kind || ''),
        status,
        confirmationRefs: refs.confirmationRefs,
      });
      const id = await ctx.db.insert('areaFacts', {
        userId: args.userId,
        areaId,
        externalId: String(fact.id || ''),
        kind: normalizeText(String(fact.kind || 'note'), 'note').slice(0, 80),
        value: normalizeText(String(fact.value || '')).slice(0, 1200),
        status,
        sourceRefs: refs.sourceRefs,
        confirmationRefs: refs.confirmationRefs,
        ...verifiedFactPatch(status, refs.confirmationRefs, ts),
        createdAt: ts,
        updatedAt: ts,
      });
      if (fact.id) factIds.set(String(fact.id), id);
    }

    let linkCount = 0;
    for (const link of tables.areaArtifactLinks || []) {
      const areaId = areaIds.get(String(link.areaId || ''));
      if (!areaId) continue;
      await ctx.db.insert('areaArtifactLinks', {
        userId: args.userId,
        areaId,
        externalId: String(link.id || ''),
        artifactKind: ['mailThread', 'calendarEvent', 'task', 'mcpItem', 'intent', 'manual'].includes(
          link.artifactKind,
        )
          ? link.artifactKind
          : 'manual',
        artifactId: normalizeText(String(link.artifactId || '')),
        accountId: typeof link.accountId === 'string' ? normalizeText(link.accountId) : undefined,
        role: ['primary', 'secondary', 'supporting'].includes(link.role) ? link.role : 'supporting',
        status: ['verified', 'rejected'].includes(link.status) ? link.status : 'candidate',
        confidence: typeof link.confidence === 'number' ? link.confidence : undefined,
        reason: typeof link.reason === 'string' ? normalizeText(link.reason).slice(0, 700) : undefined,
        sourceRefs: normalizeSourceRefs(link.sourceRefs || []),
        confirmationRefs: normalizeConfirmationRefs(seedConfirmationRefs(link.confirmationRefs)),
        createdAt: ts,
        updatedAt: ts,
      });
      linkCount += 1;
    }

    return {
      userId: args.userId,
      counts: {
        areas: areaIds.size,
        areaFacts: factIds.size,
        areaArtifactLinks: linkCount,
      },
    };
  },
});
