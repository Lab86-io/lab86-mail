import { v } from 'convex/values';
import {
  areaBrandingFromFacts,
  extractAreaPlaces,
  faviconUrlForDomain,
  intentDisplayTitle,
  normalizeAreaDomain,
  PERSONAL_AREA_EXTERNAL_ID,
} from '../lib/albatross/area-home';
import { validateAreaImageUpload } from '../lib/albatross/area-image';
import { areaMailMoveConfirmation, areaMailMoveReason } from '../lib/albatross/area-mail';
import { matchAreaContext } from '../lib/albatross/area-matching';
import { type EvidenceSourceKind, evidenceWeight } from '../lib/albatross/evidence-index';
import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';
import { internalAction, internalMutation, mutation, query } from './_generated/server';
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

function cleanOptionalUrl(value: string | undefined) {
  const raw = normalizeText(value || '').slice(0, 800);
  return /^https?:\/\//i.test(raw) ? raw : undefined;
}

function areaBrandingPatch(args: { primaryDomain?: string; faviconUrl?: string; imageUrl?: string }) {
  const primaryDomain =
    args.primaryDomain !== undefined ? normalizeAreaDomain(args.primaryDomain) || undefined : undefined;
  const shouldPatchFavicon = args.faviconUrl !== undefined || args.primaryDomain !== undefined;
  const faviconUrl = shouldPatchFavicon
    ? cleanOptionalUrl(args.faviconUrl) ||
      (primaryDomain ? faviconUrlForDomain(primaryDomain) || undefined : undefined)
    : undefined;
  const imageUrl = args.imageUrl !== undefined ? cleanOptionalUrl(args.imageUrl) : undefined;
  return {
    ...(args.primaryDomain !== undefined ? { primaryDomain } : {}),
    ...(shouldPatchFavicon ? { faviconUrl } : {}),
    ...(args.imageUrl !== undefined ? { imageUrl } : {}),
  };
}

async function upsertAreaEvidence(
  ctx: MutationCtx,
  input: {
    userId: string;
    areaId: Id<'areas'>;
    sourceKind: EvidenceSourceKind;
    sourceId: string;
    title: string;
    summary?: string;
    occurredAt: number;
    trust: 'observed' | 'inferred' | 'confirmed' | 'rejected';
    confidence?: number;
    dedupeKey: string;
    metadata?: unknown;
  },
) {
  const existing = await ctx.db
    .query('albatrossEvidence')
    .withIndex('by_user_dedupe', (q) => q.eq('userId', input.userId).eq('dedupeKey', input.dedupeKey))
    .unique();
  const confidence = Math.min(1, Math.max(0, input.confidence ?? 1));
  const row = {
    userId: input.userId,
    targetKind: 'area' as const,
    targetId: String(input.areaId),
    sourceKind: input.sourceKind,
    sourceId: input.sourceId,
    title: input.title.slice(0, 500),
    summary: input.summary?.slice(0, 2_000),
    occurredAt: input.occurredAt,
    weight: evidenceWeight(input.sourceKind, input.trust, confidence),
    confidence,
    trust: input.trust,
    dedupeKey: input.dedupeKey,
    searchText: `${input.title} ${input.summary || ''}`.trim().slice(0, 4_000),
    metadata: input.metadata,
    updatedAt: now(),
  };
  if (existing) await ctx.db.patch(existing._id, row);
  else await ctx.db.insert('albatrossEvidence', { ...row, createdAt: now() });
}

function artifactEvidenceKind(kind: string): EvidenceSourceKind {
  if (kind === 'mailThread') return 'mail_thread';
  if (kind === 'calendarEvent') return 'calendar_event';
  if (kind === 'task') return 'task';
  if (kind === 'mcpItem') return 'mcp_item';
  if (kind === 'intent') return 'chat';
  return 'manual';
}

async function ensurePersonalArea(ctx: MutationCtx, userId: string): Promise<Id<'areas'>> {
  const ts = now();
  const byExternal = await ctx.db
    .query('areas')
    .withIndex('by_user_external', (q) => q.eq('userId', userId).eq('externalId', PERSONAL_AREA_EXTERNAL_ID))
    .unique();
  if (byExternal) {
    const patch: Record<string, unknown> = {};
    if (byExternal.status !== 'active') {
      patch.status = 'active';
      patch.archivedAt = undefined;
    }
    if (byExternal.kind !== 'personal') patch.kind = 'personal';
    if (Object.keys(patch).length) {
      patch.updatedAt = ts;
      await ctx.db.patch(byExternal._id, patch);
    }
    await ensureAreaBoard(ctx, userId, byExternal);
    return byExternal._id;
  }

  const mine = await ctx.db
    .query('areas')
    .withIndex('by_user', (q) => q.eq('userId', userId))
    .collect();
  const existingPersonal = mine.find((area) => area.name.toLowerCase() === 'personal');
  if (existingPersonal) {
    await ctx.db.patch(existingPersonal._id, {
      externalId: PERSONAL_AREA_EXTERNAL_ID,
      kind: 'personal',
      status: 'active',
      archivedAt: undefined,
      updatedAt: ts,
    });
    await ensureAreaBoard(ctx, userId, existingPersonal);
    return existingPersonal._id;
  }

  const areaId = await ctx.db.insert('areas', {
    userId,
    externalId: PERSONAL_AREA_EXTERNAL_ID,
    name: 'Personal',
    kind: 'personal',
    status: 'active',
    description: 'Personal mail, obligations, and catch-all context.',
    createdAt: ts,
    updatedAt: ts,
  });
  await ensureAreaBoard(ctx, userId, { _id: areaId, name: 'Personal' });
  return areaId;
}

async function scheduleAreaReindex(
  ctx: MutationCtx,
  userId: string,
  delayMs = 5_000,
  input: { reason?: string; areaId?: Id<'areas'> } = {},
) {
  const ts = now();
  const runId = await ctx.db.insert('areaReindexRuns', {
    userId,
    areaId: input.areaId ? String(input.areaId) : undefined,
    status: 'queued',
    reason: input.reason ? normalizeText(input.reason).slice(0, 160) : undefined,
    scanned: 0,
    inserted: 0,
    matched: 0,
    personal: 0,
    skipped: 0,
    createdAt: ts,
    updatedAt: ts,
  });
  await ctx.scheduler.runAfter(delayMs, internal.albatross.reindexUserAreaArtifacts, { userId, runId });
  return runId;
}

export const createArea = mutation({
  args: {
    ...callerArgs,
    externalId: v.optional(v.string()),
    name: v.string(),
    kind: v.optional(v.string()),
    description: v.optional(v.string()),
    priority: v.optional(v.number()),
    primaryDomain: v.optional(v.string()),
    faviconUrl: v.optional(v.string()),
    imageUrl: v.optional(v.string()),
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
        ...areaBrandingPatch(args),
        updatedAt: ts,
      });
      await ensureAreaBoard(ctx, userId, existing);
      await scheduleAreaReindex(ctx, userId);
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
      ...areaBrandingPatch(args),
      createdAt: ts,
      updatedAt: ts,
    });
    await ensureAreaBoard(ctx, userId, { _id: areaId, name });
    await ensurePersonalArea(ctx, userId);
    await scheduleAreaReindex(ctx, userId);
    return areaId;
  },
});

export const ensurePersonal = mutation({
  args: callerArgs,
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    const areaId = await ensurePersonalArea(ctx, userId);
    return { areaId };
  },
});

export const reindexMyAreas = mutation({
  args: { ...callerArgs, areaId: v.optional(v.id('areas')) },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    if (args.areaId) await requireArea(ctx, args.areaId, userId);
    const personalAreaId = await ensurePersonalArea(ctx, userId);
    const runId = await scheduleAreaReindex(ctx, userId, 0, {
      reason: args.areaId ? 'Manual area brief refresh' : 'Manual area reindex',
      areaId: args.areaId,
    });
    return { ok: true, personalAreaId, runId };
  },
});

export const areaIndexStatus = query({
  args: { ...callerArgs },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    const latestRun = await ctx.db
      .query('areaReindexRuns')
      .withIndex('by_user_updatedAt', (q) => q.eq('userId', userId))
      .order('desc')
      .first();
    const syncStates = await ctx.db
      .query('mailSyncStates')
      .withIndex('by_user', (q) => q.eq('userId', userId))
      .collect();
    const mailboxes = syncStates.map((state) => ({
      accountId: state.accountId,
      provider: state.provider,
      status: state.status,
      corpusReady: state.corpusReady,
      messagesSynced: state.messagesSynced ?? 0,
      updatedAt: state.updatedAt,
      error: state.error,
    }));
    return {
      latestRun: latestRun
        ? {
            runId: String(latestRun._id),
            areaId: latestRun.areaId ?? null,
            status: latestRun.status as 'queued' | 'running' | 'done' | 'error',
            reason: latestRun.reason ?? null,
            scanned: latestRun.scanned,
            inserted: latestRun.inserted,
            matched: latestRun.matched,
            personal: latestRun.personal,
            skipped: latestRun.skipped,
            error: latestRun.error ?? null,
            startedAt: latestRun.startedAt ?? null,
            finishedAt: latestRun.finishedAt ?? null,
            createdAt: latestRun.createdAt,
            updatedAt: latestRun.updatedAt,
          }
        : null,
      mail: {
        total: mailboxes.length,
        ready: mailboxes.filter((state) => state.corpusReady).length,
        indexing: mailboxes.filter(
          (state) => !state.corpusReady && (state.status === 'backfilling' || state.status === 'syncing'),
        ).length,
        errored: mailboxes.filter((state) => state.status === 'error').length,
        messagesSynced: mailboxes.reduce((sum, state) => sum + (state.messagesSynced ?? 0), 0),
        mailboxes,
      },
    };
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
    primaryDomain: v.optional(v.string()),
    faviconUrl: v.optional(v.string()),
    imageUrl: v.optional(v.string()),
    status: v.optional(areaStatusValidator),
  },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    const area = await requireArea(ctx, args.areaId, userId);
    if (area.externalId === PERSONAL_AREA_EXTERNAL_ID && args.status === 'archived') {
      throw new Error('Personal is a system area and cannot be archived. Rename it instead.');
    }
    const ts = now();
    await ctx.db.patch(args.areaId, {
      ...(args.name !== undefined ? { name: normalizeText(args.name, 'Untitled area').slice(0, 120) } : {}),
      ...(args.kind !== undefined ? { kind: normalizeText(args.kind, 'general').slice(0, 80) } : {}),
      ...(args.description !== undefined
        ? { description: normalizeText(args.description).slice(0, 600) || undefined }
        : {}),
      ...(args.priority !== undefined ? { priority: args.priority } : {}),
      ...areaBrandingPatch(args),
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
    await scheduleAreaReindex(ctx, userId);
    return { ok: true };
  },
});

export const setAreaImage = mutation({
  args: {
    ...callerArgs,
    areaId: v.id('areas'),
    uploadId: v.optional(v.id('agentUploads')),
  },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    const area = await requireArea(ctx, args.areaId, userId);
    const previousStorageId = area.imageStorageId;
    if (!args.uploadId) {
      await ctx.db.patch(args.areaId, {
        imageStorageId: undefined,
        imageUrl: undefined,
        updatedAt: now(),
      });
      if (previousStorageId) {
        const previousUpload = await ctx.db
          .query('agentUploads')
          .withIndex('by_storage', (q) => q.eq('storageId', previousStorageId))
          .unique();
        if (previousUpload?.userId === userId) await ctx.db.delete(previousUpload._id);
        await ctx.storage.delete(previousStorageId);
      }
      return { ok: true, imageUrl: null };
    }
    const upload = await ctx.db.get(args.uploadId);
    if (!upload || upload.userId !== userId) throw new Error('Image upload not found.');
    validateAreaImageUpload(upload);
    const imageUrl = await ctx.storage.getUrl(upload.storageId);
    if (!imageUrl) throw new Error('The uploaded image is unavailable.');
    await ctx.db.patch(args.areaId, {
      imageStorageId: upload.storageId,
      imageUrl,
      updatedAt: now(),
    });
    if (previousStorageId && previousStorageId !== upload.storageId) {
      const previousUpload = await ctx.db
        .query('agentUploads')
        .withIndex('by_storage', (q) => q.eq('storageId', previousStorageId))
        .unique();
      if (previousUpload?.userId === userId) await ctx.db.delete(previousUpload._id);
      await ctx.storage.delete(previousStorageId);
    }
    return { ok: true, imageUrl };
  },
});

export const archiveArea = mutation({
  args: { ...callerArgs, areaId: v.id('areas') },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    const area = await requireArea(ctx, args.areaId, userId);
    if (area.externalId === PERSONAL_AREA_EXTERNAL_ID) {
      throw new Error('Personal is a system area and cannot be archived. Rename it instead.');
    }
    const ts = now();
    await ctx.db.patch(args.areaId, { status: 'archived', archivedAt: ts, updatedAt: ts });
    await scheduleAreaReindex(ctx, userId);
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

// Route-safe owned-Area point lookup. It accepts the URL's raw string so an
// invalid/stale id resolves to null instead of becoming a validator error, and
// never reveals another user's Area.
export const areaBriefTarget = query({
  args: { ...callerArgs, areaId: v.string() },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    const areaId = ctx.db.normalizeId('areas', args.areaId);
    if (!areaId) return null;
    const area = await ctx.db.get(areaId);
    return area?.userId === userId ? { _id: area._id } : null;
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
    const factId = await ctx.db.insert('areaFacts', {
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
    const factKind = normalizeText(args.kind, 'note').slice(0, 80);
    const factValue = normalizeText(args.value).slice(0, 1200);
    await upsertAreaEvidence(ctx, {
      userId,
      areaId: args.areaId,
      sourceKind: 'area_fact',
      sourceId: String(factId),
      title: `${factKind}: ${factValue}`,
      occurredAt: ts,
      trust: status === 'verified' ? 'confirmed' : 'inferred',
      confidence: status === 'verified' ? 1 : 0.7,
      dedupeKey: `area-fact:${String(factId)}`,
      metadata: { factKind, status },
    });
    await scheduleAreaReindex(ctx, userId);
    return factId;
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
    await upsertAreaEvidence(ctx, {
      userId,
      areaId: fact.areaId,
      sourceKind: 'area_fact',
      sourceId: String(fact._id),
      title: `${fact.kind}: ${fact.value}`,
      occurredAt: ts,
      trust: 'confirmed',
      confidence: 1,
      dedupeKey: `area-fact:${String(fact._id)}`,
      metadata: { factKind: fact.kind, status: 'verified' },
    });
    await scheduleAreaReindex(ctx, userId);
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
    await upsertAreaEvidence(ctx, {
      userId,
      areaId: fact.areaId,
      sourceKind: 'area_fact',
      sourceId: String(fact._id),
      title: `${fact.kind}: ${fact.value}`,
      occurredAt: ts,
      trust: 'rejected',
      confidence: 1,
      dedupeKey: `area-fact:${String(fact._id)}`,
      metadata: { factKind: fact.kind, status: 'rejected' },
    });
    await scheduleAreaReindex(ctx, userId);
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
    await scheduleAreaReindex(ctx, userId);
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
      await upsertAreaEvidence(ctx, {
        userId,
        areaId: args.areaId,
        sourceKind: artifactEvidenceKind(args.artifactKind),
        sourceId: artifactId,
        title: `${args.artifactKind} filed to this Area`,
        summary: patch.reason,
        occurredAt: ts,
        trust: status === 'verified' ? 'confirmed' : status === 'rejected' ? 'rejected' : 'inferred',
        confidence: args.confidence ?? (status === 'verified' ? 1 : status === 'rejected' ? 0 : 0.65),
        dedupeKey: `area-link:${String(args.areaId)}:${args.artifactKind}:${accountId || ''}:${artifactId}`,
        metadata: {
          artifactKind: args.artifactKind,
          role: patch.role,
          status,
          linkId: String(existing._id),
        },
      });
      return existing._id;
    }
    const linkId = await ctx.db.insert('areaArtifactLinks', { ...patch, createdAt: ts });
    await upsertAreaEvidence(ctx, {
      userId,
      areaId: args.areaId,
      sourceKind: artifactEvidenceKind(args.artifactKind),
      sourceId: artifactId,
      title: `${args.artifactKind} filed to this Area`,
      summary: patch.reason,
      occurredAt: ts,
      trust: status === 'verified' ? 'confirmed' : status === 'rejected' ? 'rejected' : 'inferred',
      confidence: args.confidence ?? (status === 'verified' ? 1 : status === 'rejected' ? 0 : 0.65),
      dedupeKey: `area-link:${String(args.areaId)}:${args.artifactKind}:${accountId || ''}:${artifactId}`,
      metadata: { artifactKind: args.artifactKind, role: patch.role, status, linkId: String(linkId) },
    });
    return linkId;
  },
});

// A user's Area move is an explicit filing correction, not a destructive
// relabel. The source link remains as rejected evidence so Albatross can learn
// what was wrong; the destination link becomes verified with a server-minted
// user confirmation. A batch keeps multi-select moves one atomic transaction.
export const moveMailThreadsToArea = mutation({
  args: {
    ...callerArgs,
    sourceAreaId: v.id('areas'),
    destinationAreaId: v.id('areas'),
    threads: v.array(v.object({ accountId: v.string(), threadId: v.string() })),
  },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    if (args.threads.length > 50) throw new Error('Move at most 50 mail threads at a time.');
    if (args.sourceAreaId === args.destinationAreaId) throw new Error('Choose a different Area.');
    const [sourceArea, destinationArea] = await Promise.all([
      requireArea(ctx, args.sourceAreaId, userId),
      requireArea(ctx, args.destinationAreaId, userId),
    ]);
    if (destinationArea.status !== 'active') throw new Error('The destination Area is archived.');

    const ts = now();
    let moved = 0;
    let skipped = 0;
    for (const requested of args.threads) {
      const { artifactId: threadId, accountId } = normalizedArtifactIdentity({
        artifactId: requested.threadId,
        accountId: requested.accountId,
      });
      if (!threadId || !accountId) {
        skipped += 1;
        continue;
      }
      const links = await ctx.db
        .query('areaArtifactLinks')
        .withIndex('by_user_account_artifact', (q) =>
          q
            .eq('userId', userId)
            .eq('accountId', accountId)
            .eq('artifactKind', 'mailThread')
            .eq('artifactId', threadId),
        )
        .collect();
      const sourceLinks = links.filter(
        (link) => link.areaId === args.sourceAreaId && link.status !== 'rejected',
      );
      if (!sourceLinks.length) {
        skipped += 1;
        continue;
      }

      const reason = areaMailMoveReason(sourceArea.name, destinationArea.name);
      const confirmation = areaMailMoveConfirmation({
        sourceAreaId: String(args.sourceAreaId),
        destinationAreaId: String(args.destinationAreaId),
        accountId,
        threadId,
        sourceAreaName: sourceArea.name,
        destinationAreaName: destinationArea.name,
        confirmedAt: ts,
        confirmedBy: userId,
      });
      const sourceRef = {
        kind: 'mailThread',
        id: threadId,
        accountId,
        label: `Mail moved from ${sourceArea.name} to ${destinationArea.name}`,
      };

      for (const sourceLink of sourceLinks) {
        await ctx.db.patch(sourceLink._id, {
          status: 'rejected',
          confidence: 0,
          reason,
          sourceRefs: normalizeSourceRefs([sourceRef, ...(sourceLink.sourceRefs || [])]),
          confirmationRefs: normalizeConfirmationRefs([confirmation, ...(sourceLink.confirmationRefs || [])]),
          updatedAt: ts,
        });
      }

      const destinationLink = links.find((link) => link.areaId === args.destinationAreaId);
      const confirmationRefs = normalizeConfirmationRefs([
        confirmation,
        ...(destinationLink?.confirmationRefs || []),
      ]);
      assertVerifiedArtifactLinkAllowed('verified', confirmationRefs);
      const destinationPatch = {
        userId,
        areaId: args.destinationAreaId,
        artifactKind: 'mailThread' as const,
        artifactId: threadId,
        accountId,
        role: 'primary' as const,
        status: 'verified' as const,
        confidence: 1,
        reason,
        sourceRefs: normalizeSourceRefs([sourceRef, ...(destinationLink?.sourceRefs || [])]),
        confirmationRefs,
        updatedAt: ts,
      };
      let destinationLinkId: Id<'areaArtifactLinks'>;
      if (destinationLink) {
        await ctx.db.patch(destinationLink._id, destinationPatch);
        destinationLinkId = destinationLink._id;
      } else {
        destinationLinkId = await ctx.db.insert('areaArtifactLinks', {
          ...destinationPatch,
          createdAt: ts,
        });
      }

      await Promise.all([
        upsertAreaEvidence(ctx, {
          userId,
          areaId: args.sourceAreaId,
          sourceKind: 'mail_thread',
          sourceId: threadId,
          title: 'Mail removed from this Area',
          summary: reason,
          occurredAt: ts,
          trust: 'rejected',
          confidence: 0,
          dedupeKey: `area-link:${String(args.sourceAreaId)}:mailThread:${accountId}:${threadId}`,
          metadata: {
            artifactKind: 'mailThread',
            status: 'rejected',
            movedToAreaId: String(args.destinationAreaId),
          },
        }),
        upsertAreaEvidence(ctx, {
          userId,
          areaId: args.destinationAreaId,
          sourceKind: 'mail_thread',
          sourceId: threadId,
          title: 'Mail filed to this Area',
          summary: reason,
          occurredAt: ts,
          trust: 'confirmed',
          confidence: 1,
          dedupeKey: `area-link:${String(args.destinationAreaId)}:mailThread:${accountId}:${threadId}`,
          metadata: {
            artifactKind: 'mailThread',
            role: 'primary',
            status: 'verified',
            linkId: String(destinationLinkId),
            movedFromAreaId: String(args.sourceAreaId),
          },
        }),
      ]);
      moved += 1;
    }
    return { moved, skipped };
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

type AreaReindexFact = {
  _id: string;
  areaId: Id<'areas'>;
  kind: string;
  value: string;
  status: 'candidate' | 'verified';
  confirmationRefs: AlbatrossConfirmationRef[];
  verifiedAt?: number;
  updatedAt?: number;
};

type AreaReindexMatch = {
  areaId: Id<'areas'>;
  status: 'candidate' | 'verified';
  confidence: number;
  reason: string;
  fact: AreaReindexFact;
};

function factIdentityKind(value: string): 'email' | 'domain' | null {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/^mailto:/, '')
    .replace(/^@/, '');
  if (!normalized || /\s/.test(normalized)) return null;
  if (normalized.includes('@')) return 'email';
  if (normalizeAreaDomain(normalized)) return 'domain';
  return null;
}

function factIdentityValue(value: string, kind: 'email' | 'domain') {
  if (kind === 'domain') return normalizeAreaDomain(value) || '';
  return value
    .trim()
    .toLowerCase()
    .replace(/^mailto:/, '')
    .replace(/^@/, '');
}

function confirmationForVerifiedFact(fact: AreaReindexFact): AlbatrossConfirmationRef[] {
  const refs = normalizeConfirmationRefs(fact.confirmationRefs);
  if (refs.some((ref) => ref.kind === 'userConfirmation' && Number.isFinite(ref.confirmedAt))) return refs;
  return [];
}

function matchMailRowToAreaFact(
  row: { fromAddress?: string },
  facts: AreaReindexFact[],
): AreaReindexMatch | null {
  const email = emailFromAddress(row.fromAddress || '');
  if (!email.includes('@')) return null;
  const domain = email.split('@')[1] || '';
  let best: AreaReindexMatch | null = null;
  const rank = (match: AreaReindexMatch) =>
    (match.status === 'verified' ? 4 : 0) + (match.reason.includes('email') ? 2 : 0);
  for (const fact of facts) {
    const kind = factIdentityKind(fact.value);
    if (!kind) continue;
    const value = factIdentityValue(fact.value, kind);
    const matches = kind === 'email' ? email === value : domain === value;
    if (!matches) continue;
    const confirmationRefs = fact.status === 'verified' ? confirmationForVerifiedFact(fact) : [];
    const status = fact.status === 'verified' && confirmationRefs.length ? 'verified' : 'candidate';
    const match: AreaReindexMatch = {
      areaId: fact.areaId,
      status,
      confidence: status === 'verified' ? 0.95 : 0.7,
      reason: `${status} ${kind} ${value}`,
      fact,
    };
    if (!best || rank(match) > rank(best)) best = match;
  }
  return best;
}

const AREA_OVERVIEW_LINK_SCAN = 2000;
const AREA_OVERVIEW_INTENT_SCAN = 500;
const AREA_OVERVIEW_PROJECT_SCAN = 500;
const AREA_OVERVIEW_CARD_SCAN = 500;
const AREA_REINDEX_PAGE_SIZE = 100;

function emptyAreaWorkCounts() {
  return {
    facts: { verified: 0, candidate: 0 },
    mail: 0,
    events: 0,
    tasks: 0,
    plans: 0,
    projects: 0,
    needsYou: 0,
    overdueTasks: 0,
    unreadMail: 0,
    suggestedLinks: 0,
  };
}

// Areas plus compact per-area work counts in one call — the Teach agent's first
// read, and the Areas chooser's command surface. Counts are intentionally
// bounded and approximate where needed; opening the area resolves the full rows.
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
    const areaIds = new Set(areas.map((area) => String(area._id)));
    const boardToArea = new Map(
      areas.filter((area) => area.boardId).map((area) => [String(area.boardId), String(area._id)] as const),
    );
    const [facts, links, intents, projects, cards] = await Promise.all([
      ctx.db
        .query('areaFacts')
        .withIndex('by_user', (q) => q.eq('userId', userId))
        .collect(),
      ctx.db
        .query('areaArtifactLinks')
        .withIndex('by_user', (q) => q.eq('userId', userId))
        .order('desc')
        .take(AREA_OVERVIEW_LINK_SCAN),
      ctx.db
        .query('albatrossIntents')
        .withIndex('by_user_updatedAt', (q) => q.eq('userId', userId))
        .order('desc')
        .take(AREA_OVERVIEW_INTENT_SCAN),
      ctx.db
        .query('albatrossProjects')
        .withIndex('by_user_updatedAt', (q) => q.eq('userId', userId))
        .order('desc')
        .take(AREA_OVERVIEW_PROJECT_SCAN),
      ctx.db
        .query('cards')
        .withIndex('by_user', (q) => q.eq('userId', userId))
        .take(AREA_OVERVIEW_CARD_SCAN),
    ]);
    const counts = new Map<string, ReturnType<typeof emptyAreaWorkCounts>>();
    const lastSignalAt = new Map<string, number>();
    const factsByArea = new Map<string, typeof facts>();
    const ensure = (areaId: string) => {
      const existing = counts.get(areaId);
      if (existing) return existing;
      const next = emptyAreaWorkCounts();
      counts.set(areaId, next);
      return next;
    };
    const touch = (areaId: string, ts?: number) => {
      if (!Number.isFinite(ts)) return;
      lastSignalAt.set(areaId, Math.max(lastSignalAt.get(areaId) ?? 0, ts!));
    };
    for (const fact of facts) {
      if (fact.status !== 'verified' && fact.status !== 'candidate') continue;
      const areaId = String(fact.areaId);
      if (!areaIds.has(areaId)) continue;
      factsByArea.set(areaId, [...(factsByArea.get(areaId) || []), fact]);
      ensure(areaId).facts[fact.status as 'verified' | 'candidate'] += 1;
      touch(areaId, fact.updatedAt);
    }
    const linkedTaskIdsByArea = new Map<string, Set<string>>();
    for (const link of links) {
      if (link.status === 'rejected') continue;
      const areaId = String(link.areaId);
      if (!areaIds.has(areaId)) continue;
      const entry = ensure(areaId);
      if (link.status === 'candidate') entry.suggestedLinks += 1;
      if (link.artifactKind === 'mailThread') entry.mail += 1;
      if (link.artifactKind === 'calendarEvent') entry.events += 1;
      if (link.artifactKind === 'task') {
        const ids = linkedTaskIdsByArea.get(areaId) ?? new Set<string>();
        ids.add(link.artifactId);
        linkedTaskIdsByArea.set(areaId, ids);
      }
      touch(areaId, link.updatedAt);
    }
    for (const card of cards) {
      const areaId = boardToArea.get(String(card.boardId));
      if (!areaId) continue;
      const ids = linkedTaskIdsByArea.get(areaId) ?? new Set<string>();
      ids.add(String(card._id));
      linkedTaskIdsByArea.set(areaId, ids);
      if (!card.completedAt && card.dueAt && card.dueAt < now()) ensure(areaId).overdueTasks += 1;
      touch(areaId, card.updatedAt);
    }
    for (const [areaId, ids] of linkedTaskIdsByArea) {
      ensure(areaId).tasks = ids.size;
    }
    for (const intent of intents) {
      const areaId = String(intent.areaId ?? '');
      if (!areaIds.has(areaId) || intent.status === 'done' || intent.status === 'archived') continue;
      const entry = ensure(areaId);
      entry.plans += 1;
      if (intent.status === 'needs_answers') entry.needsYou += 1;
      touch(areaId, intent.updatedAt);
    }
    for (const project of projects) {
      const areaId = String(project.areaId ?? '');
      if (!areaIds.has(areaId) || (project.status !== 'active' && project.status !== 'paused')) continue;
      ensure(areaId).projects += 1;
      touch(areaId, project.updatedAt);
    }
    return areas
      .sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99) || a.name.localeCompare(b.name))
      .map((area) => ({
        ...area,
        ...areaBrandingFromFacts(area, factsByArea.get(String(area._id))),
        factCounts: counts.get(String(area._id))?.facts || { verified: 0, candidate: 0 },
        workCounts: counts.get(String(area._id)) || emptyAreaWorkCounts(),
        lastSignalAt: lastSignalAt.get(String(area._id)) ?? null,
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
const AREA_HOME_LINK_SCAN_CAPS = {
  mailThread: AREA_HOME_MAIL_CAP * 3,
  calendarEvent: AREA_HOME_EVENT_CAP * 3,
  task: AREA_HOME_TASK_CAP * 3,
  mcpItem: 30,
  intent: 30,
  manual: 30,
} as const;

type AreaHomeArtifactKind = keyof typeof AREA_HOME_LINK_SCAN_CAPS;

async function recentActiveAreaLinks(
  ctx: QueryCtx | MutationCtx,
  userId: string,
  areaId: Id<'areas'>,
  artifactKind: AreaHomeArtifactKind,
) {
  const cap = AREA_HOME_LINK_SCAN_CAPS[artifactKind];
  const statuses = ['verified', 'candidate'] as const;
  const rows = (
    await Promise.all(
      statuses.map((status) =>
        ctx.db
          .query('areaArtifactLinks')
          .withIndex('by_user_area_kind_status_updatedAt', (q) =>
            q.eq('userId', userId).eq('areaId', areaId).eq('artifactKind', artifactKind).eq('status', status),
          )
          .order('desc')
          // Read one sentinel row past the scan cap so callers can distinguish
          // an exact bounded count from "there are more" without an unbounded
          // collect. The combined result is trimmed to that same cap + sentinel.
          .take(cap + 1),
      ),
    )
  ).flat();
  return rows.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, cap + 1);
}

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
    labels: thread.labels,
    unread: thread.unread,
    starred: thread.starred ?? false,
    messageCount: thread.messageCount ?? 1,
    smartCategory: thread.smartCategory ?? null,
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

async function resolveMcpLink(ctx: QueryCtx | MutationCtx, userId: string, link: any) {
  const externalId = link.externalId || link.artifactId;
  const item = await ctx.db
    .query('mcpItems')
    .withIndex('by_user_external', (q) => q.eq('userId', userId).eq('externalId', externalId))
    .first();
  if (!item) return null;
  return {
    externalId: item.externalId,
    server: item.server,
    kind: item.kind,
    title: item.title,
    summary: item.summary ?? null,
    url: item.url ?? null,
    state: item.state ?? null,
    author: item.author ?? null,
    repository: item.repository ?? null,
    organization: item.organization ?? null,
    occurredAt: item.updatedAtSource ?? item.updatedAt,
    linkStatus: link.status,
    confidence: link.confidence ?? null,
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
    const [verified, candidate, linkGroups] = await Promise.all([
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
      Promise.all(
        (Object.keys(AREA_HOME_LINK_SCAN_CAPS) as AreaHomeArtifactKind[]).map((artifactKind) =>
          recentActiveAreaLinks(ctx, userId, args.areaId, artifactKind),
        ),
      ),
    ]);
    const activeLinks = linkGroups.flat();
    const byKind = new Map<string, any[]>();
    for (const link of activeLinks) {
      const list = byKind.get(link.artifactKind) || [];
      list.push(link);
      byKind.set(link.artifactKind, list);
    }

    const resolvedMail = (
      await Promise.all((byKind.get('mailThread') || []).map((link) => resolveMailLink(ctx, userId, link)))
    )
      .filter((row): row is NonNullable<typeof row> => row !== null)
      .sort((a, b) => b.lastDate - a.lastDate);
    const mail = resolvedMail.slice(0, AREA_HOME_MAIL_CAP);

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
    const boardCardScan = area.boardId
      ? await ctx.db
          .query('cards')
          .withIndex('by_board_updatedAt', (q) => q.eq('boardId', area.boardId!))
          .order('desc')
          .take(201)
      : [];
    const boardCards = boardCardScan.slice(0, 200);
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
    const resolvedTasks = [...linkedTasks, ...boardTasks].sort(
      (a, b) => Number(a.completedAt !== null) - Number(b.completedAt !== null) || b.updatedAt - a.updatedAt,
    );
    const tasks = resolvedTasks.slice(0, AREA_HOME_TASK_CAP);
    const mcpItems = (
      await Promise.all((byKind.get('mcpItem') || []).map((link) => resolveMcpLink(ctx, userId, link)))
    )
      .filter((row): row is NonNullable<typeof row> => row !== null)
      .sort((a, b) => b.occurredAt - a.occurredAt)
      .slice(0, AREA_HOME_LINK_SCAN_CAPS.mcpItem);

    // Plans become components of the area: its active Work (+ latest plan)
    // surface here rather than on a separate Plans page. Read both the typed
    // primaryAreaId and the legacy string during the additive migration.
    const areaIdStr = String(args.areaId);
    const recentIntents = await ctx.db
      .query('albatrossIntents')
      .withIndex('by_user_updatedAt', (q) => q.eq('userId', userId))
      .order('desc')
      .take(AREA_HOME_INTENT_SCAN);
    const activeIntents = recentIntents
      .filter(
        (intent) =>
          String(intent.primaryAreaId ?? intent.areaId ?? '') === areaIdStr &&
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

    const projectRows = (
      await ctx.db
        .query('albatrossProjects')
        .withIndex('by_user_area', (q) => q.eq('userId', userId).eq('areaId', areaIdStr))
        .collect()
    )
      .filter((project) => project.status === 'active' || project.status === 'paused')
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, AREA_HOME_PROJECT_CAP);
    const projects = await Promise.all(
      projectRows.map(async (project) => {
        const links = await ctx.db
          .query('albatrossProjectLinks')
          .withIndex('by_user_project', (q) => q.eq('userId', userId).eq('projectId', project._id))
          .collect();
        const taskLinks = links.filter((link) => link.artifactKind === 'task');
        const cards = await Promise.all(
          taskLinks.slice(0, 100).map((link) => {
            const cardId = ctx.db.normalizeId('cards', link.artifactId);
            return cardId ? ctx.db.get(cardId) : null;
          }),
        );
        const activeSprint = project.activeSprintId ? await ctx.db.get(project.activeSprintId) : null;
        return {
          projectId: String(project._id),
          title: project.title,
          outcome: project.outcome ?? null,
          status: project.status,
          sourceIntentId: project.sourceIntentId ?? null,
          taskCount: taskLinks.length,
          completedTaskCount: cards.filter((card) => card?.userId === userId && card.completedAt).length,
          activeSprint:
            activeSprint?.userId === userId
              ? { title: activeSprint.title, status: activeSprint.status, endAt: activeSprint.endAt ?? null }
              : null,
          updatedAt: project.updatedAt,
        };
      }),
    );

    const branding = areaBrandingFromFacts(area, [...verified, ...candidate]);
    const livingBrief = await ctx.db
      .query('albatrossAreaBriefs')
      .withIndex('by_user_area', (q) => q.eq('userId', userId).eq('areaId', args.areaId))
      .unique();
    const evidence = {
      mail: {
        shown: mail.length,
        hasMore:
          resolvedMail.length > mail.length ||
          (byKind.get('mailThread') || []).length > AREA_HOME_LINK_SCAN_CAPS.mailThread,
      },
      events: {
        shown: events.length,
        hasMore:
          resolvedEvents.length > events.length ||
          (byKind.get('calendarEvent') || []).length > AREA_HOME_LINK_SCAN_CAPS.calendarEvent,
      },
      tasks: {
        shown: tasks.length,
        hasMore:
          resolvedTasks.length > tasks.length ||
          boardCardScan.length > 200 ||
          (byKind.get('task') || []).length > AREA_HOME_LINK_SCAN_CAPS.task,
      },
    };

    return {
      area: { ...area, ...branding },
      livingBrief,
      facts: { verified, candidate },
      mail,
      events,
      tasks,
      mcpItems,
      plans,
      projects,
      places,
      counts: {
        facts: { verified: verified.length, candidate: candidate.length },
        links: {
          mailThread: {
            shown: Math.min((byKind.get('mailThread') || []).length, AREA_HOME_LINK_SCAN_CAPS.mailThread),
            bounded: true,
          },
          calendarEvent: {
            shown: Math.min(
              (byKind.get('calendarEvent') || []).length,
              AREA_HOME_LINK_SCAN_CAPS.calendarEvent,
            ),
            bounded: true,
          },
          task: {
            shown: Math.min((byKind.get('task') || []).length, AREA_HOME_LINK_SCAN_CAPS.task),
            bounded: true,
          },
          other: {
            shown: (['mcpItem', 'intent', 'manual'] as const).reduce(
              (total, kind) =>
                total + Math.min((byKind.get(kind) || []).length, AREA_HOME_LINK_SCAN_CAPS[kind]),
              0,
            ),
            bounded: true,
          },
        },
        evidence,
        // The actionable queue is assembled from these bounded task/intent
        // previews plus the separate Work query. Let the UI qualify its count
        // whenever either source may have more rows beyond the scan.
        needsYouBounded: evidence.tasks.hasMore || recentIntents.length >= AREA_HOME_INTENT_SCAN,
        plans: plans.length,
        projects: projects.length,
        places: places.length,
      },
    };
  },
});

// Compact pending-evidence read for the Teach and Area-scoped conversations.
// These are hypotheses, never silent truth: the agent uses them to ask one
// evidence-backed confirmation question at a time.
export const areaDiscoveryBrief = query({
  args: { ...callerArgs, areaId: v.optional(v.id('areas')), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    if (args.areaId) await requireArea(ctx, args.areaId, userId);
    const limit = Math.min(Math.max(args.limit ?? 20, 1), 30);
    const [areas, links, facts] = await Promise.all([
      ctx.db
        .query('areas')
        .withIndex('by_user_status', (q) => q.eq('userId', userId).eq('status', 'active'))
        .collect(),
      ctx.db
        .query('areaArtifactLinks')
        .withIndex('by_user_status', (q) => q.eq('userId', userId).eq('status', 'candidate'))
        .take(200),
      ctx.db
        .query('areaFacts')
        .withIndex('by_user_status', (q) => q.eq('userId', userId).eq('status', 'candidate'))
        .take(100),
    ]);
    const areaById = new Map(areas.map((area) => [String(area._id), area]));
    const scoped = links
      .filter((link) => !args.areaId || link.areaId === args.areaId)
      .filter((link) => areaById.has(String(link.areaId)))
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, limit);
    const candidates = await Promise.all(
      scoped.map(async (link) => {
        const area = areaById.get(String(link.areaId))!;
        let source = link.artifactKind;
        let title = link.artifactId;
        let occurredAt = link.updatedAt;
        if (link.artifactKind === 'mailThread') {
          const row = await resolveMailLink(ctx, userId, link);
          if (row) {
            source = 'mail';
            title = row.subject;
            occurredAt = row.lastDate;
          }
        } else if (link.artifactKind === 'calendarEvent') {
          const row = await resolveEventLink(ctx, userId, link);
          if (row) {
            source = 'calendar';
            title = row.title;
            occurredAt = row.startAt;
          }
        } else if (link.artifactKind === 'task') {
          const row = await resolveTaskLink(ctx, userId, link);
          if (row) {
            source = 'tasks';
            title = row.title;
            occurredAt = row.updatedAt;
          }
        } else if (link.artifactKind === 'mcpItem') {
          const row = await resolveMcpLink(ctx, userId, link);
          if (row) {
            source = row.server;
            title = row.title;
            occurredAt = row.occurredAt;
          }
        }
        return {
          areaId: String(area._id),
          areaName: area.name,
          artifactKind: link.artifactKind,
          artifactId: link.artifactId,
          source,
          title,
          occurredAt,
          confidence: link.confidence ?? null,
          reason: link.reason ?? null,
        };
      }),
    );
    return {
      candidates,
      candidateFacts: facts
        .filter((fact) => !args.areaId || fact.areaId === args.areaId)
        .filter((fact) => areaById.has(String(fact.areaId)))
        .map((fact) => ({
          factId: String(fact._id),
          areaId: String(fact.areaId),
          areaName: areaById.get(String(fact.areaId))!.name,
          kind: fact.kind,
          value: fact.value,
          sourceRefs: fact.sourceRefs,
        })),
    };
  },
});

const UNCLASSIFIED_SCAN = 200;
const UNCLASSIFIED_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const AREA_DISCOVERY_SCAN_PER_SOURCE = 120;
const AREA_DISCOVERY_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

async function hasAreaArtifactLink(
  ctx: QueryCtx,
  userId: string,
  artifactKind: 'mailThread' | 'calendarEvent' | 'task' | 'mcpItem',
  artifactId: string,
  accountId?: string,
) {
  if (accountId) {
    return Boolean(
      await ctx.db
        .query('areaArtifactLinks')
        .withIndex('by_user_account_artifact', (q) =>
          q
            .eq('userId', userId)
            .eq('accountId', accountId)
            .eq('artifactKind', artifactKind)
            .eq('artifactId', artifactId),
        )
        .first(),
    );
  }
  return Boolean(
    await ctx.db
      .query('areaArtifactLinks')
      .withIndex('by_user_artifact', (q) =>
        q.eq('userId', userId).eq('artifactKind', artifactKind).eq('artifactId', artifactId),
      )
      .first(),
  );
}

// One bounded discovery pass across every locally indexed source. Connector
// sync owns the remote crawl; Area discovery consumes the private local
// corpora so teaching never sends connector credentials or full histories to
// the model. Only unclaimed artifacts leave this query.
export const unclassifiedAreaArtifacts = query({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const limit = Math.min(Math.max(args.limit ?? 80, 1), 100);
    const cutoff = now() - AREA_DISCOVERY_WINDOW_MS;
    const [mail, events, cards, mcp, connections] = await Promise.all([
      ctx.db
        .query('mailCorpusThreads')
        .withIndex('by_user_lastDate', (q) => q.eq('userId', args.userId).gte('lastDate', cutoff))
        .order('desc')
        .take(AREA_DISCOVERY_SCAN_PER_SOURCE),
      ctx.db
        .query('calendarEvents')
        .withIndex('by_user_start', (q) => q.eq('userId', args.userId).gte('startAt', cutoff))
        .order('desc')
        .take(AREA_DISCOVERY_SCAN_PER_SOURCE),
      ctx.db
        .query('cards')
        .withIndex('by_user', (q) => q.eq('userId', args.userId))
        .take(200),
      ctx.db
        .query('mcpItems')
        .withIndex('by_user_updated', (q) => q.eq('userId', args.userId))
        .order('desc')
        .take(AREA_DISCOVERY_SCAN_PER_SOURCE),
      ctx.db
        .query('mcpConnections')
        .withIndex('by_user', (q) => q.eq('userId', args.userId))
        .collect(),
    ]);
    const searchableConnectionIds = new Set(
      connections
        .filter((connection) => connection.status === 'connected' && connection.includeInSearch)
        .map((connection) => connection.connectionId),
    );
    const candidates = [
      ...mail.map((row) => ({
        artifactKind: 'mailThread' as const,
        artifactId: row.providerThreadId,
        accountId: row.accountId,
        source: 'mail',
        title: row.subject || '(no subject)',
        text: [row.subject, row.snippet, row.fromAddress].filter(Boolean).join('\n'),
        occurredAt: row.lastDate,
      })),
      ...events.map((row) => ({
        artifactKind: 'calendarEvent' as const,
        artifactId: String(row._id),
        accountId: row.accountId,
        source: 'calendar',
        title: row.title || '(untitled event)',
        text: [
          row.title,
          row.description,
          row.location,
          JSON.stringify(row.participants || []),
          JSON.stringify(row.organizer || {}),
        ]
          .filter(Boolean)
          .join('\n')
          .slice(0, 8_000),
        occurredAt: row.startAt,
      })),
      ...cards
        .sort((left, right) => right.updatedAt - left.updatedAt)
        .slice(0, AREA_DISCOVERY_SCAN_PER_SOURCE)
        .map((row) => ({
          artifactKind: 'task' as const,
          artifactId: String(row._id),
          source: 'tasks',
          title: row.title,
          text: [row.title, row.description, ...(row.labels || []), JSON.stringify(row.source || {})]
            .filter(Boolean)
            .join('\n')
            .slice(0, 8_000),
          occurredAt: row.updatedAt,
        })),
      ...mcp
        .filter((row) => searchableConnectionIds.has(row.connectionId))
        .map((row) => ({
          artifactKind: 'mcpItem' as const,
          artifactId: row.externalId,
          source: row.server,
          title: row.title,
          text: row.searchText.slice(0, 8_000),
          occurredAt: row.updatedAtSource ?? row.updatedAt,
        })),
    ].sort((left, right) => right.occurredAt - left.occurredAt);

    // Preserve recency within each source, but rotate across source groups so
    // a busy inbox cannot crowd GitHub, Granola, calendar, or task evidence
    // out of a Teach-time discovery pass.
    const groups = new Map<string, typeof candidates>();
    for (const candidate of candidates) {
      groups.set(candidate.source, [...(groups.get(candidate.source) || []), candidate]);
    }
    const items: Array<(typeof candidates)[number]> = [];
    const positions = new Map<string, number>();
    while (items.length < limit) {
      let advanced = false;
      for (const [source, group] of groups) {
        let position = positions.get(source) || 0;
        while (position < group.length) {
          const candidate = group[position++];
          positions.set(source, position);
          if (
            await hasAreaArtifactLink(
              ctx,
              args.userId,
              candidate.artifactKind,
              candidate.artifactId,
              'accountId' in candidate ? candidate.accountId : undefined,
            )
          ) {
            continue;
          }
          items.push(candidate);
          advanced = true;
          break;
        }
        if (items.length >= limit) break;
      }
      if (!advanced) break;
    }
    return {
      items,
      sources: [
        'mail',
        'calendar',
        'tasks',
        ...new Set(
          connections
            .filter((connection) => connection.status === 'connected' && connection.includeInSearch)
            .map((connection) => connection.server),
        ),
      ],
    };
  },
});

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
        artifactKind: v.optional(artifactKindValidator),
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
      const artifactKind = link.artifactKind ?? 'mailThread';
      const { artifactId, accountId } = normalizedArtifactIdentity(link);
      const refs = normalizedRefs(link);
      assertVerifiedArtifactLinkAllowed(link.status, refs.confirmationRefs);
      const existing = await ctx.db
        .query('areaArtifactLinks')
        .withIndex('by_user_artifact', (q) =>
          q.eq('userId', userId).eq('artifactKind', artifactKind).eq('artifactId', artifactId),
        )
        .collect();
      if (existing.some((row) => row.areaId === link.areaId)) {
        skipped += 1;
        continue;
      }
      await ctx.db.insert('areaArtifactLinks', {
        userId,
        areaId: link.areaId,
        artifactKind,
        externalId: artifactKind === 'mcpItem' ? artifactId : undefined,
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

export const queueUserAreaReindex = internalMutation({
  args: {
    userId: v.string(),
    reason: v.optional(v.string()),
    delayMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const runId = await scheduleAreaReindex(ctx, args.userId, Math.max(0, args.delayMs ?? 0), {
      reason: args.reason,
    });
    return { runId };
  },
});

export const reindexUserAreaArtifacts = internalMutation({
  args: { userId: v.string(), cursor: v.optional(v.string()), runId: v.optional(v.id('areaReindexRuns')) },
  handler: async (ctx, args) => {
    const userId = args.userId;
    const run = args.runId ? await ctx.db.get(args.runId) : null;
    const trackedRun = run && run.userId === userId ? run : null;
    const ts = now();
    let scanned = 0;
    let inserted = 0;
    let matched = 0;
    let personal = 0;
    let skipped = 0;
    try {
      if (trackedRun) {
        await ctx.db.patch(trackedRun._id, {
          status: 'running',
          cursor: args.cursor,
          startedAt: trackedRun.startedAt ?? ts,
          updatedAt: ts,
        });
      }
      const personalAreaId = await ensurePersonalArea(ctx, userId);
      const areas = await ctx.db
        .query('areas')
        .withIndex('by_user_status', (q) => q.eq('userId', userId).eq('status', 'active'))
        .collect();
      const activeAreaIds = new Set(areas.map((area) => String(area._id)));
      const factRows = (
        await ctx.db
          .query('areaFacts')
          .withIndex('by_user', (q) => q.eq('userId', userId))
          .collect()
      ).filter(
        (fact) =>
          (fact.status === 'candidate' || fact.status === 'verified') &&
          activeAreaIds.has(String(fact.areaId)),
      );
      const facts: AreaReindexFact[] = factRows.map((fact) => ({
        _id: String(fact._id),
        areaId: fact.areaId,
        kind: fact.kind,
        value: fact.value,
        status: fact.status as 'candidate' | 'verified',
        confirmationRefs: fact.confirmationRefs,
        verifiedAt: fact.verifiedAt,
        updatedAt: fact.updatedAt,
      }));
      for (const area of areas) {
        const primaryDomain = normalizeAreaDomain(area.primaryDomain);
        if (!primaryDomain) continue;
        facts.push({
          _id: `area-domain:${area._id}`,
          areaId: area._id,
          kind: 'domain',
          value: primaryDomain,
          status: 'candidate',
          confirmationRefs: [],
          updatedAt: area.updatedAt,
        });
      }

      const page = await ctx.db
        .query('mailCorpusThreads')
        .withIndex('by_user', (q) => q.eq('userId', userId))
        .paginate({ cursor: args.cursor ?? null, numItems: AREA_REINDEX_PAGE_SIZE });

      for (const row of page.page) {
        scanned += 1;
        const existing = await ctx.db
          .query('areaArtifactLinks')
          .withIndex('by_user_account_artifact', (q) =>
            q
              .eq('userId', userId)
              .eq('accountId', row.accountId)
              .eq('artifactKind', 'mailThread')
              .eq('artifactId', row.providerThreadId),
          )
          .collect();
        const match = matchMailRowToAreaFact(row, facts);
        const contextMatch = match
          ? null
          : matchAreaContext({
              text: [row.subject, row.snippet, row.fromAddress].filter(Boolean).join(' '),
              areas: areas.map((area) => ({
                _id: String(area._id),
                name: area.name,
                kind: area.kind,
                description: area.description,
                primaryDomain: area.primaryDomain,
              })),
              facts: facts.map((fact) => ({
                _id: fact._id,
                areaId: String(fact.areaId),
                kind: fact.kind,
                value: fact.value,
                status: fact.status,
              })),
            });
        const categorized = existing.some(
          (link) => link.status !== 'rejected' && activeAreaIds.has(String(link.areaId)),
        );
        const target = match
          ? {
              areaId: match.areaId,
              status: match.status,
              confidence: match.confidence,
              reason: match.reason,
              sourceRefs: [
                {
                  kind: match.fact._id.startsWith('area-domain:') ? 'area' : 'areaFact',
                  id: match.fact._id,
                  label: `${match.fact.kind}: ${match.fact.value}`.slice(0, 200),
                },
              ],
              confirmationRefs: match.status === 'verified' ? confirmationForVerifiedFact(match.fact) : [],
            }
          : contextMatch
            ? {
                areaId: ctx.db.normalizeId('areas', contextMatch.areaId)!,
                status: 'candidate' as const,
                confidence: contextMatch.confidence,
                reason: contextMatch.reason,
                sourceRefs: contextMatch.signals.map((label, index) => ({
                  kind: 'areaContext',
                  id: `${contextMatch.areaId}:${index}`,
                  label,
                })),
                confirmationRefs: [],
              }
            : categorized
              ? null
              : {
                  areaId: personalAreaId,
                  status: 'candidate' as const,
                  confidence: 0.25,
                  reason: 'legacy mail fallback to Personal',
                  sourceRefs: [{ kind: 'system', id: 'area-reindex', label: 'Historical area backfill' }],
                  confirmationRefs: [],
                };
        if (!target) {
          skipped += 1;
          continue;
        }
        if (existing.some((link) => String(link.areaId) === String(target.areaId))) {
          skipped += 1;
          continue;
        }
        assertVerifiedArtifactLinkAllowed(target.status, target.confirmationRefs);
        await ctx.db.insert('areaArtifactLinks', {
          userId,
          areaId: target.areaId,
          artifactKind: 'mailThread',
          artifactId: row.providerThreadId,
          accountId: row.accountId,
          role: match || contextMatch ? 'supporting' : 'secondary',
          status: target.status,
          confidence: target.confidence,
          reason: target.reason,
          sourceRefs: normalizeSourceRefs(target.sourceRefs),
          confirmationRefs: normalizeConfirmationRefs(target.confirmationRefs),
          createdAt: ts,
          updatedAt: ts,
        });
        inserted += 1;
        if (match || contextMatch) matched += 1;
        else personal += 1;
      }

      if (trackedRun) {
        await ctx.db.patch(trackedRun._id, {
          status: page.isDone ? 'done' : 'running',
          cursor: page.isDone ? undefined : page.continueCursor,
          scanned: trackedRun.scanned + scanned,
          inserted: trackedRun.inserted + inserted,
          matched: trackedRun.matched + matched,
          personal: trackedRun.personal + personal,
          skipped: trackedRun.skipped + skipped,
          finishedAt: page.isDone ? now() : undefined,
          updatedAt: now(),
        });
      }

      if (!page.isDone) {
        await ctx.scheduler.runAfter(0, internal.albatross.reindexUserAreaArtifacts, {
          userId,
          cursor: page.continueCursor,
          ...(trackedRun ? { runId: trackedRun._id } : {}),
        });
      }

      return { inserted, matched, personal, skipped, scanned, done: page.isDone };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!trackedRun) throw error;
      await ctx.db.patch(trackedRun._id, {
        status: 'error',
        cursor: args.cursor,
        scanned: trackedRun.scanned + scanned,
        inserted: trackedRun.inserted + inserted,
        matched: trackedRun.matched + matched,
        personal: trackedRun.personal + personal,
        skipped: trackedRun.skipped + skipped,
        error: message.slice(0, 1000),
        finishedAt: now(),
        updatedAt: now(),
      });
      return { inserted, matched, personal, skipped, scanned, done: false, error: message };
    }
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
