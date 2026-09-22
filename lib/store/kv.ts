import { getAiRequestContext } from '../ai/context';
import { api, convexMutation, convexQuery } from '../hosted/convex';
import { isConvexConfigured } from '../hosted/env';

// Per-user document store. Every read and write is scoped to the userId on
// the ambient request context (set by invokeTool / the API routes) — this is
// the tenancy boundary. The old NeDB file store had none, which let one
// user's daily brief, memories, and labels leak to every other user.

const userDataApi = (api as any).userData;

export interface KvRecord<T = any> {
  key: string;
  ref?: string;
  doc: T;
  updatedAt: number;
}

export function requireStoreUserId(): string {
  const { userId } = getAiRequestContext();
  if (!userId) {
    throw new Error('No user on request context — per-user store access requires a signed-in request.');
  }
  return userId;
}

export async function kvGet<T = any>(kind: string, key: string): Promise<T | null> {
  const userId = requireStoreUserId();
  if (!isConvexConfigured()) return memoryGet(userId, kind, key);
  const row = await convexQuery<KvRecord<T> | null>(userDataApi.getDoc, { userId, kind, key });
  return row ? (row.doc as T) : null;
}

export async function kvList<T = any>(
  kind: string,
  options: { ref?: string; limit?: number } = {},
): Promise<T[]> {
  const userId = requireStoreUserId();
  if (!isConvexConfigured()) return memoryList(userId, kind, options.ref, options.limit);
  const rows = await convexQuery<KvRecord<T>[]>(userDataApi.listDocs, {
    userId,
    kind,
    ref: options.ref,
    limit: options.limit,
  });
  return rows.map((row) => row.doc as T);
}

export async function kvUpsert<T = any>(kind: string, key: string, doc: T, ref?: string): Promise<T> {
  const userId = requireStoreUserId();
  if (!isConvexConfigured()) {
    memoryUpsert(userId, kind, key, doc, ref);
    return doc;
  }
  await convexMutation(userDataApi.upsertDoc, {
    userId,
    kind,
    key,
    ref,
    doc,
    ...(kind === 'dailyReport' ? { briefJob: getAiRequestContext().briefJob } : {}),
  });
  return doc;
}

export async function kvCreateIfAbsent<T = any>(
  kind: string,
  key: string,
  doc: T,
  ref?: string,
): Promise<{ created: boolean; doc: T }> {
  const userId = requireStoreUserId();
  if (!isConvexConfigured()) {
    const existing = memoryGet(userId, kind, key);
    if (existing) return { created: false, doc: existing as T };
    memoryUpsert(userId, kind, key, doc, ref);
    return { created: true, doc };
  }
  const result = await convexMutation<{ created: boolean; doc: T }>(userDataApi.createDocIfAbsent, {
    userId,
    kind,
    key,
    ref,
    doc,
  });
  return { created: result.created, doc: result.doc as T };
}

export async function kvDelete(kind: string, key: string): Promise<void> {
  const userId = requireStoreUserId();
  if (!isConvexConfigured()) {
    memoryDelete(userId, kind, key);
    return;
  }
  await convexMutation(userDataApi.deleteDoc, { userId, kind, key });
}

/** Atomic optimistic write for edition inputs; concurrent tabs cannot overwrite unseen answers. */
export async function kvCompareAndSwap<T extends { revision: string }>(
  kind: string,
  key: string,
  expectedRevision: string | null,
  doc: T,
  ref?: string,
): Promise<boolean> {
  const userId = requireStoreUserId();
  if (!isConvexConfigured()) {
    const current = memoryGet(userId, kind, key);
    if ((current?.revision ?? null) !== expectedRevision) return false;
    memoryUpsert(userId, kind, key, doc, ref);
    return true;
  }
  return convexMutation<boolean>(userDataApi.compareAndSwapDoc, {
    userId,
    kind,
    key,
    expectedRevision,
    doc,
    ref,
  });
}

export async function kvDeleteMany(kind: string, ref?: string): Promise<void> {
  const userId = requireStoreUserId();
  if (!isConvexConfigured()) {
    memoryDeleteMany(userId, kind, ref);
    return;
  }
  for (let batch = 0; batch < 100; batch += 1) {
    const result = await convexMutation<{ hasMore?: boolean }>(userDataApi.deleteDocs, {
      userId,
      kind,
      ref,
      limit: 500,
    });
    if (!result.hasMore) return;
  }
  throw new Error(`Too many ${kind} records to delete in one request.`);
}

// ---------------------------------------------------------------------------
// In-memory fallback: used only when Convex is not configured (unit tests and
// bare local dev). Still per-user keyed so tests exercise the same scoping.
// ---------------------------------------------------------------------------

interface MemoryRecord {
  doc: any;
  ref?: string;
  updatedAt: number;
}

const memory = new Map<string, Map<string, MemoryRecord>>();

function bucket(userId: string, kind: string) {
  const id = `${userId}\0${kind}`;
  let map = memory.get(id);
  if (!map) {
    map = new Map();
    memory.set(id, map);
  }
  return map;
}

function memoryGet(userId: string, kind: string, key: string) {
  return bucket(userId, kind).get(key)?.doc ?? null;
}

function memoryList(userId: string, kind: string, ref?: string, limit?: number) {
  const rows = [...bucket(userId, kind).values()]
    .filter((row) => ref === undefined || row.ref === ref)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const limited = limit === undefined ? rows : rows.slice(0, limit);
  return limited.map((row) => row.doc);
}

function memoryUpsert(userId: string, kind: string, key: string, doc: any, ref?: string) {
  bucket(userId, kind).set(key, { doc, ref, updatedAt: Date.now() });
}

function memoryDelete(userId: string, kind: string, key: string) {
  bucket(userId, kind).delete(key);
}

function memoryDeleteMany(userId: string, kind: string, ref?: string) {
  const map = bucket(userId, kind);
  for (const [key, row] of map) {
    if (ref === undefined || row.ref === ref) map.delete(key);
  }
}
