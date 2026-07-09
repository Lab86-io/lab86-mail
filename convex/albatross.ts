import { v } from 'convex/values';
import { extractAreaPlaces, intentDisplayTitle } from '../lib/albatross/area-home';
import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';
import { internalAction, mutation, query } from './_generated/server';
import {
  type AlbatrossConfirmationRef,
  type AlbatrossSourceRef,
  type AreaArtifactLinkStatus,
  type AreaFactStatus,
  assertFactTransitionAllowed,
  assertVerifiedArtifactLinkAllowed,
  assertVerifiedFactAllowed,
  normalizeConfirmationRefs,
  normalizeSourceRefs,
  normalizeText,
} from './albatrossModel';
import { insertBoardWithColumns } from './boards';
import { fanOutInternalPost, now, requireInternalSecret } from './lib';

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
const ARTIFACT_ID_MAX = 200;
const ACCOUNT_ID_MAX = 120;

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

function normalizedArtifactIdentity(input: { artifactId: string; accountId?: string }) {
  const accountId = input.accountId ? normalizeText(input.accountId).slice(0, ACCOUNT_ID_MAX) : undefined;
  return {
    artifactId: normalizeText(input.artifactId).slice(0, ARTIFACT_ID_MAX),
    accountId: accountId || undefined,
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

// Every area owns a task board. Idempotent: reuses the area's linked board when
// it still exists, creates one (named after the area) only when missing.
// Archiving an area never deletes its board; unarchiving reuses it.
async function ensureAreaBoard(
  ctx: MutationCtx,
  userId: string,
  area: { _id: Id<'areas'>; name: string; boardId?: Id<'boards'> },
): Promise<Id<'boards'>> {
  if (area.boardId) {
    const board = await ctx.db.get(area.boardId);
    if (board) return area.boardId;
  }
  const boardId = await insertBoardWithColumns(ctx, userId, area.name);
  await ctx.db.patch(area._id, { boardId, updatedAt: now() });
  return boardId;
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
    const name = normalizeText(args.name, 'Untitled area').slice(0, 120);
    const ts = now();
    // Re-creating an area the user already named (active OR archived) revives
    // the existing row instead of spawning a duplicate — and therefore reuses
    // its existing board instead of creating a second one.
    const mine = await ctx.db
      .query('areas')
      .withIndex('by_user', (q) => q.eq('userId', userId))
      .collect();
    const existing = mine.find((area) => area.name.toLowerCase() === name.toLowerCase());
    if (existing) {
      await ensureExternalAreaIdAvailable(ctx, userId, externalId, existing._id);
      await ctx.db.patch(existing._id, {
        status: 'active',
        archivedAt: undefined,
        ...(externalId ? { externalId } : {}),
        ...(args.kind ? { kind: normalizeText(args.kind, 'general').slice(0, 80) } : {}),
        ...(args.description ? { description: normalizeText(args.description).slice(0, 600) } : {}),
        ...(args.priority !== undefined ? { priority: args.priority } : {}),
        updatedAt: ts,
      });
      await ensureAreaBoard(ctx, userId, existing);
      return existing._id;
    }
    await ensureExternalAreaIdAvailable(ctx, userId, externalId);
    const areaId = await ctx.db.insert('areas', {
      userId,
      externalId,
      name,
      kind: normalizeText(args.kind || 'general', 'general').slice(0, 80),
      status: 'active',
      description: args.description ? normalizeText(args.description).slice(0, 600) : undefined,
      priority: args.priority,
      createdAt: ts,
      updatedAt: ts,
    });
    await ensureAreaBoard(ctx, userId, { _id: areaId, name });
    return areaId;
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
    const area = await requireArea(ctx, args.areaId, userId);
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
    // Unarchiving an area must not spawn a duplicate board: ensureAreaBoard
    // reuses the linked board and only creates one when it never existed.
    if (args.status === 'active') {
      await ensureAreaBoard(ctx, userId, area);
    }
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
    const sourceRefs = normalizeSourceRefs([...fact.sourceRefs, ...refs.sourceRefs]);
    const confirmationRefs = normalizeConfirmationRefs([...fact.confirmationRefs, ...refs.confirmationRefs]);
    assertVerifiedFactAllowed({ kind: fact.kind, status: 'verified', confirmationRefs });
    const ts = now();
    await ctx.db.patch(args.factId, {
      status: 'verified',
      sourceRefs,
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
    const { artifactId, accountId } = normalizedArtifactIdentity(args);
    const status = (args.status || 'candidate') as AreaArtifactLinkStatus;
    assertVerifiedArtifactLinkAllowed(status, refs.confirmationRefs);
    const artifactLinks = accountId
      ? await ctx.db
          .query('areaArtifactLinks')
          .withIndex('by_user_account_artifact', (q) =>
            q
              .eq('userId', userId)
              .eq('accountId', accountId)
              .eq('artifactKind', args.artifactKind)
              .eq('artifactId', artifactId),
          )
          .collect()
      : await ctx.db
          .query('areaArtifactLinks')
          .withIndex('by_user_artifact', (q) =>
            q.eq('userId', userId).eq('artifactKind', args.artifactKind).eq('artifactId', artifactId),
          )
          .collect();
    const existing = artifactLinks.find(
      (link) => link.areaId === args.areaId && (link.accountId || undefined) === accountId,
    );
    const patch = {
      userId,
      areaId: args.areaId,
      externalId: args.externalId ? normalizeText(args.externalId) : undefined,
      artifactKind: args.artifactKind,
      artifactId,
      accountId,
      role: args.role || 'primary',
      status,
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
  args: {
    ...callerArgs,
    artifactKind: artifactKindValidator,
    artifactId: v.string(),
    accountId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    const { artifactId, accountId } = normalizedArtifactIdentity(args);
    if (accountId) {
      return await ctx.db
        .query('areaArtifactLinks')
        .withIndex('by_user_account_artifact', (q) =>
          q
            .eq('userId', userId)
            .eq('accountId', accountId)
            .eq('artifactKind', args.artifactKind)
            .eq('artifactId', artifactId),
        )
        .collect();
    }
    return (
      await ctx.db
        .query('areaArtifactLinks')
        .withIndex('by_user_artifact', (q) =>
          q.eq('userId', userId).eq('artifactKind', args.artifactKind).eq('artifactId', artifactId),
        )
        .collect()
    ).filter((link) => !link.accountId);
  },
});

// ---------------------------------------------------------------------------
// Areas-become-the-app: read models and classifier plumbing.
// ---------------------------------------------------------------------------

function emailFromAddress(raw: string): string {
  const angled = raw.match(/<([^>]+)>/);
  const candidate = (angled ? angled[1] : raw).trim().toLowerCase();
  const token = candidate.split(/\s+/).find((part) => part.includes('@'));
  return (token || candidate).replace(/^mailto:/, '').replace(/[<>,;"']/g, '');
}

// Areas plus per-area fact counts in one call — the Teach agent's first read.
export const listAreasOverview = query({
  args: { ...callerArgs, status: v.optional(areaStatusValidator) },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    const areas = args.status
      ? await ctx.db
          .query('areas')
          .withIndex('by_user_status', (q) => q.eq('userId', userId).eq('status', args.status!))
          .collect()
      : await ctx.db
          .query('areas')
          .withIndex('by_user', (q) => q.eq('userId', userId))
          .collect();
    const facts = await ctx.db
      .query('areaFacts')
      .withIndex('by_user', (q) => q.eq('userId', userId))
      .collect();
    const counts = new Map<string, { verified: number; candidate: number }>();
    for (const fact of facts) {
      if (fact.status !== 'verified' && fact.status !== 'candidate') continue;
      const entry = counts.get(fact.areaId) || { verified: 0, candidate: 0 };
      entry[fact.status as 'verified' | 'candidate'] += 1;
      counts.set(fact.areaId, entry);
    }
    return areas
      .sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99) || a.name.localeCompare(b.name))
      .map((area) => ({
        ...area,
        factCounts: counts.get(area._id) || { verified: 0, candidate: 0 },
      }));
  },
});

// All of one user's area facts, optionally by status — the classifier loads
// verified and candidate facts across every area in two indexed reads.
export const listUserAreaFacts = query({
  args: { ...callerArgs, status: v.optional(factStatusValidator) },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    return args.status
      ? await ctx.db
          .query('areaFacts')
          .withIndex('by_user_status', (q) => q.eq('userId', userId).eq('status', args.status!))
          .collect()
      : await ctx.db
          .query('areaFacts')
          .withIndex('by_user', (q) => q.eq('userId', userId))
          .collect();
  },
});

const DOMAIN_ACTIVITY_SCAN = 500;

// Investigation read for the Teach conversation: who has been emailing from a
// domain (or one address), how much, and about what. Index-friendly: one
// bounded recency scan on by_user_lastDate, filtered in memory.
export const domainActivity = query({
  args: {
    ...callerArgs,
    domain: v.optional(v.string()),
    senderEmail: v.optional(v.string()),
    max: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    const domain = args.domain ? normalizeText(args.domain).toLowerCase().replace(/^@/, '') : undefined;
    const senderEmail = args.senderEmail ? normalizeText(args.senderEmail).toLowerCase() : undefined;
    if (!domain && !senderEmail) throw new Error('Provide domain or senderEmail.');
    const max = Math.min(Math.max(args.max ?? 10, 1), 25);
    const rows = await ctx.db
      .query('mailCorpusThreads')
      .withIndex('by_user_lastDate', (q) => q.eq('userId', userId))
      .order('desc')
      .take(DOMAIN_ACTIVITY_SCAN);
    const bySender = new Map<
      string,
      { email: string; name?: string; threads: number; lastDate: number; recentSubjects: string[] }
    >();
    let matched = 0;
    for (const row of rows) {
      const email = emailFromAddress(row.fromAddress || '');
      if (!email.includes('@')) continue;
      const matches = senderEmail ? email === senderEmail : email.endsWith(`@${domain}`);
      if (!matches) continue;
      matched += 1;
      const entry = bySender.get(email) || {
        email,
        name: row.fromAddress?.replace(/<.*?>/g, '').trim() || undefined,
        threads: 0,
        lastDate: 0,
        recentSubjects: [],
      };
      entry.threads += 1;
      entry.lastDate = Math.max(entry.lastDate, row.lastDate);
      const subject = normalizeText(row.subject || '');
      if (subject && entry.recentSubjects.length < 3 && !entry.recentSubjects.includes(subject)) {
        entry.recentSubjects.push(subject);
      }
      bySender.set(email, entry);
    }
    return {
      domain: domain ?? null,
      senderEmail: senderEmail ?? null,
      threadsScanned: rows.length,
      threadsMatched: matched,
      senders: [...bySender.values()].sort((a, b) => b.threads - a.threads).slice(0, max),
    };
  },
});

const AREA_HOME_MAIL_CAP = 30;
const AREA_HOME_EVENT_CAP = 20;
const AREA_HOME_TASK_CAP = 30;
// The brief leads with a handful of active plans/projects, not a backlog — a
// bounded recency scan keeps the read cheap even for a busy area.
const AREA_HOME_INTENT_SCAN = 150;
const AREA_HOME_PLAN_CAP = 8;
const AREA_HOME_PROJECT_CAP = 8;

async function resolveMailLink(ctx: QueryCtx | MutationCtx, userId: string, link: any) {
  if (!link.accountId) return null;
  const thread = await ctx.db
    .query('mailCorpusThreads')
    .withIndex('by_user_account_thread', (q) =>
      q.eq('userId', userId).eq('accountId', link.accountId).eq('providerThreadId', link.artifactId),
    )
    .first();
  if (!thread) return null;
  return {
    providerThreadId: thread.providerThreadId,
    accountId: thread.accountId,
    subject: thread.subject,
    fromAddress: thread.fromAddress,
    lastDate: thread.lastDate,
    snippet: thread.snippet,
    unread: thread.unread,
    linkStatus: link.status,
    confidence: link.confidence ?? null,
    reason: link.reason ?? null,
  };
}

async function resolveEventLink(ctx: QueryCtx | MutationCtx, userId: string, link: any) {
  const docId = ctx.db.normalizeId('calendarEvents', link.artifactId);
  let event = docId ? await ctx.db.get(docId) : null;
  if (!event && link.accountId) {
    event = await ctx.db
      .query('calendarEvents')
      .withIndex('by_account_event', (q) =>
        q.eq('accountId', link.accountId).eq('providerEventId', link.artifactId),
      )
      .first();
  }
  if (!event || event.userId !== userId) return null;
  return {
    providerEventId: event.providerEventId,
    accountId: event.accountId,
    title: event.title,
    startAt: event.startAt,
    endAt: event.endAt,
    allDay: event.allDay ?? false,
    location: event.location ?? null,
    linkStatus: link.status,
    reason: link.reason ?? null,
  };
}

async function resolveTaskLink(ctx: QueryCtx | MutationCtx, userId: string, link: any) {
  const cardId = ctx.db.normalizeId('cards', link.artifactId);
  if (!cardId) return null;
  const card = await ctx.db.get(cardId);
  if (!card || card.userId !== userId) return null;
  return {
    cardId: card._id,
    boardId: card.boardId,
    title: card.title,
    completedAt: card.completedAt ?? null,
    dueAt: card.dueAt ?? null,
    updatedAt: card.updatedAt,
    linkStatus: link.status,
    reason: link.reason ?? null,
  };
}

// The Area home read model: the area, its facts by trust level, and its
// linked artifacts resolved to real rows the UI can render directly.
export const areaHome = query({
  args: { ...callerArgs, areaId: v.id('areas') },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    const area = await requireArea(ctx, args.areaId, userId);
    const [verified, candidate, links] = await Promise.all([
      ctx.db
        .query('areaFacts')
        .withIndex('by_user_area_status', (q) =>
          q.eq('userId', userId).eq('areaId', args.areaId).eq('status', 'verified'),
        )
        .collect(),
      ctx.db
        .query('areaFacts')
        .withIndex('by_user_area_status', (q) =>
          q.eq('userId', userId).eq('areaId', args.areaId).eq('status', 'candidate'),
        )
        .collect(),
      ctx.db
        .query('areaArtifactLinks')
        .withIndex('by_user_area', (q) => q.eq('userId', userId).eq('areaId', args.areaId))
        .collect(),
    ]);
    const activeLinks = links.filter((link) => link.status !== 'rejected');
    const byKind = new Map<string, any[]>();
    for (const link of activeLinks) {
      const list = byKind.get(link.artifactKind) || [];
      list.push(link);
      byKind.set(link.artifactKind, list);
    }

    const mail = (
      await Promise.all((byKind.get('mailThread') || []).map((link) => resolveMailLink(ctx, userId, link)))
    )
      .filter((row): row is NonNullable<typeof row> => row !== null)
      .sort((a, b) => b.lastDate - a.lastDate)
      .slice(0, AREA_HOME_MAIL_CAP);

    const ts = now();
    const resolvedEvents = (
      await Promise.all(
        (byKind.get('calendarEvent') || []).map((link) => resolveEventLink(ctx, userId, link)),
      )
    ).filter((row): row is NonNullable<typeof row> => row !== null);
    const upcoming = resolvedEvents
      .filter((event) => event.endAt >= ts)
      .sort((a, b) => a.startAt - b.startAt);
    const past = resolvedEvents.filter((event) => event.endAt < ts).sort((a, b) => b.startAt - a.startAt);
    const events = [...upcoming, ...past].slice(0, AREA_HOME_EVENT_CAP);

    // Tasks come from two places: classifier/apply links, plus every card on
    // the area's own board (areas own a board from creation). Deduped by card.
    const linkedTasks = (
      await Promise.all((byKind.get('task') || []).map((link) => resolveTaskLink(ctx, userId, link)))
    ).filter((row): row is NonNullable<typeof row> => row !== null);
    const boardCards = area.boardId
      ? await ctx.db
          .query('cards')
          .withIndex('by_board', (q) => q.eq('boardId', area.boardId!))
          .take(200)
      : [];
    const seenCardIds = new Set(linkedTasks.map((task) => String(task.cardId)));
    const boardTasks = boardCards
      .filter((card) => !seenCardIds.has(String(card._id)))
      .map((card) => ({
        cardId: card._id,
        boardId: card.boardId,
        title: card.title,
        completedAt: card.completedAt ?? null,
        dueAt: card.dueAt ?? null,
        updatedAt: card.updatedAt,
        linkStatus: 'verified',
        reason: null,
      }));
    const tasks = [...linkedTasks, ...boardTasks]
      .sort(
        (a, b) =>
          Number(a.completedAt !== null) - Number(b.completedAt !== null) || b.updatedAt - a.updatedAt,
      )
      .slice(0, AREA_HOME_TASK_CAP);

    // Plans become components of the area: its active intents (+ their latest
    // plan) surface here rather than on a separate Plans page. Intents carry
    // areaId as a plain string, so this is a bounded recency scan filtered in
    // memory rather than an indexed area read.
    const areaIdStr = String(args.areaId);
    const recentIntents = await ctx.db
      .query('albatrossIntents')
      .withIndex('by_user_updatedAt', (q) => q.eq('userId', userId))
      .order('desc')
      .take(AREA_HOME_INTENT_SCAN);
    const activeIntents = recentIntents
      .filter(
        (intent) =>
          String(intent.areaId ?? '') === areaIdStr &&
          intent.status !== 'done' &&
          intent.status !== 'archived',
      )
      .slice(0, AREA_HOME_PLAN_CAP);
    const intentPlans = await Promise.all(
      activeIntents.map(async (intent) => {
        const plan = intent.latestPlanId ? await ctx.db.get(intent.latestPlanId) : null;
        const ownPlan = plan && plan.userId === userId ? plan : null;
        return {
          intentId: String(intent._id),
          title: intentDisplayTitle(intent),
          status: intent.status,
          planId: ownPlan ? String(ownPlan._id) : null,
          planStatus: ownPlan?.status ?? null,
          outcome: ownPlan?.outcome ?? null,
          summary: ownPlan?.summary ?? null,
          proposedProjectTitle: ownPlan?.proposedProjectTitle ?? null,
          updatedAt: intent.updatedAt,
          _places: ownPlan?.places ?? null,
          _mapQuery: ownPlan?.mapQuery ?? null,
          _options: (intent.questions ?? []).flatMap((question) => question.options ?? []),
        };
      }),
    );
    const places = extractAreaPlaces(
      intentPlans.map((row) => ({ places: row._places, mapQuery: row._mapQuery })),
      intentPlans.map((row) => row._options),
    );
    const plans = intentPlans.map(({ _places, _mapQuery, _options, ...row }) => row);

    const projects = (
      await ctx.db
        .query('albatrossProjects')
        .withIndex('by_user_area', (q) => q.eq('userId', userId).eq('areaId', areaIdStr))
        .collect()
    )
      .filter((project) => project.status === 'active' || project.status === 'paused')
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, AREA_HOME_PROJECT_CAP)
      .map((project) => ({
        projectId: String(project._id),
        title: project.title,
        outcome: project.outcome ?? null,
        status: project.status,
        sourceIntentId: project.sourceIntentId ?? null,
        updatedAt: project.updatedAt,
      }));

    return {
      area,
      facts: { verified, candidate },
      mail,
      events,
      tasks,
      plans,
      projects,
      places,
      counts: {
        facts: { verified: verified.length, candidate: candidate.length },
        links: {
          mailThread: (byKind.get('mailThread') || []).length,
          calendarEvent: (byKind.get('calendarEvent') || []).length,
          task: (byKind.get('task') || []).length,
          other: activeLinks.filter(
            (link) => !['mailThread', 'calendarEvent', 'task'].includes(link.artifactKind),
          ).length,
        },
        mail: mail.length,
        events: events.length,
        tasks: tasks.length,
        plans: plans.length,
        projects: projects.length,
        places: places.length,
      },
    };
  },
});

const UNCLASSIFIED_SCAN = 200;
const UNCLASSIFIED_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

// Recent corpus threads that no area has claimed yet — the classifier's work
// queue. Internal-secret-gated: only the cron/classifier path reads this.
export const unclassifiedThreads = query({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const limit = Math.min(Math.max(args.limit ?? 50, 1), 50);
    const cutoff = now() - UNCLASSIFIED_WINDOW_MS;
    const rows = await ctx.db
      .query('mailCorpusThreads')
      .withIndex('by_user_lastDate', (q) => q.eq('userId', args.userId).gte('lastDate', cutoff))
      .order('desc')
      .take(UNCLASSIFIED_SCAN);
    const out: Array<{
      providerThreadId: string;
      accountId: string;
      subject: string;
      fromAddress: string;
      lastDate: number;
      snippet: string;
    }> = [];
    for (const row of rows) {
      if (out.length >= limit) break;
      const existing = await ctx.db
        .query('areaArtifactLinks')
        .withIndex('by_user_artifact', (q) =>
          q.eq('userId', args.userId).eq('artifactKind', 'mailThread').eq('artifactId', row.providerThreadId),
        )
        .first();
      if (existing) continue;
      out.push({
        providerThreadId: row.providerThreadId,
        accountId: row.accountId,
        subject: row.subject,
        fromAddress: row.fromAddress,
        lastDate: row.lastDate,
        snippet: row.snippet,
      });
    }
    return out;
  },
});

// Batch write for classifier verdicts. Dedupe on by_user_artifact + areaId:
// an existing link for the same (thread, area) is left untouched — the
// classifier never downgrades or churns prior decisions.
export const recordAreaLinks = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    links: v.array(
      v.object({
        areaId: v.id('areas'),
        artifactKind: v.optional(v.literal('mailThread')),
        artifactId: v.string(),
        accountId: v.optional(v.string()),
        status: v.union(v.literal('candidate'), v.literal('verified')),
        confidence: v.optional(v.number()),
        reason: v.optional(v.string()),
        sourceRefs: v.optional(v.array(sourceRefValidator)),
        confirmationRefs: v.optional(v.array(confirmationRefValidator)),
      }),
    ),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const userId = args.userId;
    const ts = now();
    const areaCache = new Map<string, boolean>();
    let inserted = 0;
    let skipped = 0;
    for (const link of args.links.slice(0, 100)) {
      if (!areaCache.has(link.areaId)) {
        const area = await ctx.db.get(link.areaId);
        areaCache.set(link.areaId, Boolean(area && area.userId === userId && area.status === 'active'));
      }
      if (!areaCache.get(link.areaId)) {
        skipped += 1;
        continue;
      }
      const { artifactId, accountId } = normalizedArtifactIdentity(link);
      const refs = normalizedRefs(link);
      assertVerifiedArtifactLinkAllowed(link.status, refs.confirmationRefs);
      const existing = await ctx.db
        .query('areaArtifactLinks')
        .withIndex('by_user_artifact', (q) =>
          q.eq('userId', userId).eq('artifactKind', 'mailThread').eq('artifactId', artifactId),
        )
        .collect();
      if (existing.some((row) => row.areaId === link.areaId)) {
        skipped += 1;
        continue;
      }
      await ctx.db.insert('areaArtifactLinks', {
        userId,
        areaId: link.areaId,
        artifactKind: 'mailThread',
        artifactId,
        accountId,
        role: 'supporting',
        status: link.status,
        confidence: link.confidence,
        reason: link.reason ? normalizeText(link.reason).slice(0, 700) : undefined,
        sourceRefs: refs.sourceRefs,
        confirmationRefs: refs.confirmationRefs,
        createdAt: ts,
        updatedAt: ts,
      });
      inserted += 1;
    }
    return { inserted, skipped };
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
      const status = ['verified', 'rejected'].includes(link.status)
        ? (link.status as AreaArtifactLinkStatus)
        : 'candidate';
      const confirmationRefs = normalizeConfirmationRefs(seedConfirmationRefs(link.confirmationRefs));
      assertVerifiedArtifactLinkAllowed(status, confirmationRefs);
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
        status,
        confidence: typeof link.confidence === 'number' ? link.confidence : undefined,
        reason: typeof link.reason === 'string' ? normalizeText(link.reason).slice(0, 700) : undefined,
        sourceRefs: normalizeSourceRefs(link.sourceRefs || []),
        confirmationRefs,
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

// Periodic area classification. Mirrors convex/calendarSync.ts: AI + the
// classifier live in the Next.js app, so the schedule fans out to the
// internal-secret-gated route for every user with a connected account.
export const classifyTick = internalAction({
  args: {},
  handler: async (ctx) => {
    const appUrl = (process.env.LAB86_MAIL_PUBLIC_URL || '').replace(/\/$/, '');
    const secret = process.env.LAB86_CONVEX_INTERNAL_SECRET || '';
    if (!appUrl || !secret) {
      console.error('[area-classify cron] missing LAB86_MAIL_PUBLIC_URL or LAB86_CONVEX_INTERNAL_SECRET');
      return;
    }
    const targets = await ctx.runQuery(internal.dailyReports.reportTargets, {});
    const ok = await fanOutInternalPost(
      `${appUrl}/api/cron/area-classify`,
      secret,
      targets.map((target) => ({ userId: target.userId })),
      { label: 'area-classify cron', timeoutMs: 60_000, concurrency: 4 },
    );
    console.log(`[area-classify cron] classified ${ok}/${targets.length} users`);
  },
});
