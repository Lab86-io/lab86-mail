import { runWithAiRequestContext } from '../ai/context';
import { mapConcurrent } from '../classifier/client';
import { api, convexMutation, convexQuery } from '../hosted/convex';
import type { JevAssessment } from '../jev/contract';
import { loadJevPolicy } from '../jev/service';
import { contentVersion, syncCloudContent } from './cloud-sync';
import { type ContentItem } from './contract';
import { classifyContent, contentChunks, embedContent } from './intelligence';
import { syncMailAttachments } from './mail-attachments';
import { syncMcpContent } from './mcp-sync';
import { prepareBriefWork } from './prepare';

const ref = api.content;

/**
 * The part of a Jev verdict that changes what an indexed mail item means.
 * The time of the pass, the model, and the raw probabilities stay out: a new
 * Jev pass on unchanged mail must keep the same content version, or the item
 * gets new labels and new vectors for the same text.
 */
export function mailAssessmentDigest(assessment: unknown) {
  if (!assessment || typeof assessment !== 'object') return undefined;
  const verdict = assessment as Partial<JevAssessment>;
  return {
    status: verdict.status,
    purpose: verdict.purpose,
    subjectKind: verdict.subjectKind,
    obligations: (verdict.obligations || []).map((obligation) => obligation.kind).sort(),
    meaningfulChange: Boolean(verdict.meaningfulChange),
  };
}

/** Version of a local item (mail, connector item, document) for the content index. */
export function localContentVersion(
  item: { title: string; text: string; deleted?: boolean },
  mailAssessment?: unknown,
) {
  return contentVersion([item.title, item.text, item.deleted, mailAssessmentDigest(mailAssessment)]);
}

/** Mail older than this is not added to the content index by the change feed. */
export const CONTENT_MAIL_WINDOW_MS = 60 * 86_400_000;
/**
 * Where the mail change feed starts for a user whose old walk cursor exists:
 * the old walk indexed the corpus already, so only recent changes need a pass.
 */
export const CONTENT_MAIL_RESUME_MS = 10 * 60_000;
/** The longest time between two preparation claims of an idle user. */
export const PREPARE_IDLE_MS = 30 * 60_000;
const lastPrepared = new Map<string, number>();

export function __resetPreparationClockForTest() {
  lastPrepared.clear();
}

interface LocalPage {
  items: any[];
  attachments: any[];
  cursor: unknown;
  more: boolean;
}

type Watermark = { updatedAt: number; creationTime: number };

/** The saved mail watermark, or the start point for a user with no watermark yet. */
export function mailWatermark(cursor: any, now = Date.now()): Watermark {
  const saved = cursor?.mail;
  if (saved && Number.isFinite(saved.updatedAt) && Number.isFinite(saved.creationTime))
    return { updatedAt: Number(saved.updatedAt), creationTime: Number(saved.creationTime) };
  // A user with an old walk cursor has an index already: start near now.
  // A new user starts at the mail window.
  return { updatedAt: now - (cursor ? CONTENT_MAIL_RESUME_MS : CONTENT_MAIL_WINDOW_MS), creationTime: 0 };
}

// IO-1 (K2): mail reads only the threads that changed after the watermark.
async function mailChangePage(userId: string, cursor: any, deps: typeof defaults): Promise<LocalPage> {
  const now = Date.now();
  const page = await deps.convexQuery<any>(ref.mailChanges, {
    userId,
    after: mailWatermark(cursor, now),
    sinceLastDate: now - CONTENT_MAIL_WINDOW_MS,
  });
  return {
    items: page.items,
    attachments: page.attachments || [],
    cursor: { mail: page.watermark },
    more: page.more,
  };
}

// Connector items and documents: one page of the walk plus the newest items.
async function localSourcePage(
  userId: string,
  source: 'mcp' | 'document',
  cursor: any,
  deps: typeof defaults,
): Promise<LocalPage> {
  const [page, recent] = await Promise.all([
    deps.convexQuery<any>(ref.localPage, { userId, source, cursor: cursor?.page || undefined }),
    deps.convexQuery<any>(ref.localPage, { userId, source, recent: true }),
  ]);
  const items = [
    ...new Map(
      [...page.items, ...recent.items].map((row: any) => [`${row.connectionId}:${row.externalId}`, row]),
    ).values(),
  ];
  return { items, attachments: [], cursor: { page: page.cursor }, more: Boolean(page.cursor) };
}

const defaults = {
  convexMutation,
  convexQuery,
  syncCloudContent,
  classifyContent,
  embedContent,
  prepareBriefWork,
  loadJevPolicy,
  syncMailAttachments,
  syncMcpContent,
};
export async function runContentCycle(userId: string, deps = defaults) {
  const lease = await deps.convexMutation<any>(ref.claimSync, { userId, connectionId: '__cycle' });
  if (!lease) return { started: false };
  try {
    await deps.syncMcpContent(userId);
    let indexedChanges = 0;
    for (const source of ['mail', 'mcp', 'document'] as const) {
      const claim = await deps.convexMutation<any>(ref.claimSync, { userId, connectionId: `__${source}` });
      if (!claim) continue;
      try {
        const next =
          source === 'mail'
            ? await mailChangePage(userId, claim.cursor, deps)
            : await localSourcePage(userId, source, claim.cursor, deps);
        const items = next.items.map((row: any) => {
          const { mailAssessment, ...item } = row;
          return {
            ...item,
            text: `${item.title}\n${item.text}`,
            version: localContentVersion(item, mailAssessment),
          };
        });
        let changed = 0;
        for (let start = 0; start < items.length; start += 5)
          changed += (
            await deps.convexMutation<any>(ref.upsert, { userId, items: items.slice(start, start + 5) })
          ).changed;
        indexedChanges += changed;
        if (source === 'mail') await deps.syncMailAttachments(userId, next.attachments);
        await deps.convexMutation(ref.finishSync, {
          userId,
          connectionId: `__${source}`,
          lease: claim.lease,
          cursor: next.cursor,
          indexed: changed,
          skipped: 0,
          status: next.more ? 'indexing' : 'ready',
        });
      } catch {
        await deps.convexMutation(ref.finishSync, {
          userId,
          connectionId: `__${source}`,
          lease: claim.lease,
          indexed: 0,
          skipped: 0,
          status: 'error',
          error: 'Local content indexing will retry.',
        });
      }
    }
    await deps.syncCloudContent(userId);
    const policy = await deps.loadJevPolicy(userId);
    const works = await deps.convexQuery<any[]>(ref.workCandidates, { userId });
    const items = await deps.convexMutation<
      Array<ContentItem & { lease: string; embeddingVersion?: string }>
    >(ref.claimItems, { userId });
    await mapConcurrent(items, 4, async (item) => {
      const [classification, embeddings] = await Promise.allSettled([
        item.labels
          ? Promise.resolve(item.labels)
          : policy.preferences.enabled
            ? deps.classifyContent(userId, item, works)
            : Promise.resolve(undefined),
        item.embeddingVersion === item.version
          ? Promise.resolve(undefined)
          : deps.embedContent(userId, contentChunks(item.text)),
      ]);
      await deps.convexMutation(ref.completeItem, {
        userId,
        id: item._id,
        version: item.version,
        lease: item.lease,
        labels: classification.status === 'fulfilled' ? classification.value : undefined,
        vectors: embeddings.status === 'fulfilled' ? embeddings.value : undefined,
      });
    });
    // IO-1: the preparation claim reads the 100 newest content items. Run it
    // when this cycle indexed or labelled something, else at most every
    // PREPARE_IDLE_MS, so time-based eligibility still gets its turn.
    const nowMs = Date.now();
    if (
      indexedChanges > 0 ||
      items.length > 0 ||
      nowMs - (lastPrepared.get(userId) ?? 0) >= PREPARE_IDLE_MS
    ) {
      lastPrepared.set(userId, nowMs);
      await deps.prepareBriefWork(userId);
    }
    return { started: true, processed: items.length };
  } finally {
    await deps.convexMutation(ref.finishSync, {
      userId,
      connectionId: '__cycle',
      lease: lease.lease,
      indexed: 0,
      skipped: 0,
      status: 'ready',
    });
  }
}
const running = new Map<string, Promise<unknown>>();
export function kickContentCycle(userId: string) {
  if (running.has(userId)) return running.get(userId)!;
  const work = runWithAiRequestContext({ userId, agent: 'ai' }, () => runContentCycle(userId))
    .catch(() => console.warn('[content] background cycle will retry'))
    .finally(() => running.delete(userId));
  running.set(userId, work);
  return work;
}
