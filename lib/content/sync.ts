import { runWithAiRequestContext } from '../ai/context';
import { api, convexMutation, convexQuery } from '../hosted/convex';
import { mapConcurrent } from '../jev/client';
import { loadJevPolicy } from '../jev/service';
import { contentVersion, syncCloudContent } from './cloud-sync';
import { type ContentItem } from './contract';
import { classifyContent, contentChunks, embedContent } from './intelligence';
import { syncMailAttachments } from './mail-attachments';
import { syncMcpContent } from './mcp-sync';
import { prepareBriefWork } from './prepare';

const ref = (api as any).content;
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
    for (const source of ['mail', 'mcp', 'document'] as const) {
      const claim = await deps.convexMutation<any>(ref.claimSync, { userId, connectionId: `__${source}` });
      if (!claim) continue;
      try {
        const [page, recent] = await Promise.all([
          deps.convexQuery<any>(ref.localPage, { userId, source, cursor: claim.cursor?.page || undefined }),
          deps.convexQuery<any>(ref.localPage, { userId, source, recent: true }),
        ]);
        const items = [
          ...new Map(
            [...page.items, ...recent.items].map((row: any) => [
              `${row.connectionId}:${row.externalId}`,
              row,
            ]),
          ).values(),
        ].map((row: any) => {
          const { mailAssessment, ...item } = row;
          return {
            ...item,
            text: `${item.title}\n${item.text}`,
            version: contentVersion([item.title, item.text, item.deleted, mailAssessment]),
          };
        });
        let changed = 0;
        for (let start = 0; start < items.length; start += 5)
          changed += (
            await deps.convexMutation<any>(ref.upsert, { userId, items: items.slice(start, start + 5) })
          ).changed;
        if (source === 'mail')
          await deps.syncMailAttachments(userId, [
            ...(recent.attachments || []),
            ...(page.attachments || []),
          ]);
        await deps.convexMutation(ref.finishSync, {
          userId,
          connectionId: `__${source}`,
          lease: claim.lease,
          cursor: { page: page.cursor },
          indexed: changed,
          skipped: 0,
          status: page.cursor ? 'indexing' : 'ready',
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
    await deps.prepareBriefWork(userId);
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
  if (running.has(userId)) return;
  const work = runWithAiRequestContext({ userId, agent: 'ai' }, () => runContentCycle(userId))
    .catch(() => console.warn('[content] background cycle will retry'))
    .finally(() => running.delete(userId));
  running.set(userId, work);
}
