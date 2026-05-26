import fs from 'node:fs';
import path from 'node:path';
import Datastore from '@seald-io/nedb';

const DATA_DIR =
  process.env.LAB86_MAIL_DATA_DIR || process.env.MAIL_OS_DATA_DIR || path.join(process.cwd(), 'data');

let instances: {
  threads: Datastore;
  messages: Datastore;
  chat: Datastore;
  memories: Datastore;
  audit: Datastore;
  prefs: Datastore;
  snooze: Datastore;
  drafts: Datastore;
  photos: Datastore;
  smartLabels: Datastore;
  smartRules: Datastore;
  smartCorrections: Datastore;
  trackedThreads: Datastore;
  threadInsights: Datastore;
  dailyReports: Datastore;
  smartCategoryStats: Datastore;
} | null = null;

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

export function db() {
  if (instances) return instances;
  ensureDir(DATA_DIR);

  const open = (name: string, indexes: Array<{ fieldName: string; unique?: boolean }> = []) => {
    const ds = new Datastore({
      filename: path.join(DATA_DIR, `${name}.db`),
      autoload: true,
    });
    for (const idx of indexes) {
      try {
        const res = ds.ensureIndex(idx) as unknown;
        if (res && typeof (res as any).catch === 'function') {
          (res as Promise<unknown>).catch(() => undefined);
        }
      } catch {
        // best-effort
      }
    }
    return ds;
  };

  instances = {
    threads: open('threads', [{ fieldName: 'account' }, { fieldName: 'lastDate' }]),
    messages: open('messages', [{ fieldName: 'account' }, { fieldName: 'threadId' }]),
    chat: open('chat', [{ fieldName: 'threadId' }, { fieldName: 'ts' }]),
    memories: open('memories', [{ fieldName: 'email', unique: true }]),
    audit: open('audit', [{ fieldName: 'ts' }, { fieldName: 'tool' }]),
    prefs: open('prefs', []),
    snooze: open('snooze', [{ fieldName: 'untilTs' }]),
    drafts: open('drafts', [{ fieldName: 'account' }, { fieldName: 'updatedAt' }]),
    photos: open('photos', [{ fieldName: 'email', unique: true }]),
    smartLabels: open('smart-labels', [{ fieldName: 'slug', unique: true }, { fieldName: 'enabled' }]),
    smartRules: open('smart-rules', [
      { fieldName: 'enabled' },
      { fieldName: 'scope' },
      { fieldName: 'match' },
    ]),
    smartCorrections: open('smart-corrections', [
      { fieldName: 'createdAt' },
      { fieldName: 'threadId' },
      { fieldName: 'account' },
    ]),
    trackedThreads: open('tracked-threads', [
      { fieldName: 'account' },
      { fieldName: 'threadId' },
      { fieldName: 'status' },
      { fieldName: 'dueAt' },
      { fieldName: 'updatedAt' },
    ]),
    threadInsights: open('thread-insights', [
      { fieldName: 'account' },
      { fieldName: 'threadId' },
      { fieldName: 'generatedAt' },
    ]),
    dailyReports: open('daily-reports', [{ fieldName: 'generatedAt' }, { fieldName: 'kind' }]),
    smartCategoryStats: open('smart-category-stats', [
      { fieldName: 'account' },
      { fieldName: 'category' },
      { fieldName: 'computedAt' },
    ]),
  };
  return instances;
}

// Generic helpers — typed wrappers around NeDB's callback API via promises.
export async function upsert<T>(store: Datastore, query: Record<string, unknown>, doc: T): Promise<void> {
  await store.updateAsync(query, { $set: doc as Record<string, unknown> }, { upsert: true });
}

export async function findOne<T>(store: Datastore, query: Record<string, unknown>): Promise<T | null> {
  return (await store.findOneAsync(query)) as T | null;
}

export async function findMany<T>(
  store: Datastore,
  query: Record<string, unknown>,
  options: { sort?: Record<string, 1 | -1>; limit?: number; skip?: number } = {},
): Promise<T[]> {
  let cursor = store.findAsync(query);
  if (options.sort) cursor = cursor.sort(options.sort);
  if (options.skip) cursor = cursor.skip(options.skip);
  if (options.limit) cursor = cursor.limit(options.limit);
  return (await cursor) as T[];
}

export async function removeMany(store: Datastore, query: Record<string, unknown>): Promise<number> {
  return await store.removeAsync(query, { multi: true });
}

export async function insertOne<T>(store: Datastore, doc: T): Promise<T> {
  return (await store.insertAsync(doc as unknown as Record<string, any>)) as unknown as T;
}
