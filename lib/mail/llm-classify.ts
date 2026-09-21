import { getAiRequestContext, runWithAiRequestContext } from '../ai/context';
import { isConvexConfigured } from '../hosted/env';
import { runJevSweep } from '../jev/service';

// Persisted Jev assessments, refreshed when message content changes. The
// historical llmPending queue name is retained for compatibility. Leases and
// bounded retries live in Convex, so concurrent servers cannot apply stale work.
const SWEEP_BATCH = 40;
const MAX_BATCHES_PER_KICK = 5;
const KICK_DEBOUNCE_MS = 5_000;

const sweeping = new Set<string>();
const pendingKicks = new Map<string, ReturnType<typeof setTimeout>>();
// Kicks that arrive mid-sweep (when the per-kick batch cap may have left rows
// behind, or new rows landed during the run) are coalesced here and replayed
// once the current sweep finishes, so the backlog always drains.
const rerunRequested = new Set<string>();

export async function drainPendingSweepPages<T>({
  loadPage,
  handleItems,
  batchSize = SWEEP_BATCH,
  maxBatches = MAX_BATCHES_PER_KICK,
}: {
  loadPage: () => Promise<{ items: T[]; moreRemaining: boolean }>;
  handleItems: (items: T[]) => Promise<number>;
  batchSize?: number;
  maxBatches?: number;
}) {
  let classified = 0;
  let moreRemaining = false;
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const page = await loadPage();
    if (!page.items.length) {
      if (page.moreRemaining) {
        if (batch === maxBatches - 1) moreRemaining = true;
        continue;
      }
      break;
    }
    if (batch === maxBatches - 1 && (page.moreRemaining || page.items.length === batchSize)) {
      moreRemaining = true;
    }
    classified += await handleItems(page.items);
    if (page.items.length < batchSize) {
      if (page.moreRemaining) continue;
      break;
    }
  }
  return { classified, moreRemaining };
}

export function kickLlmClassification(userId?: string | null, delayMs = KICK_DEBOUNCE_MS) {
  const uid = userId || getAiRequestContext().userId;
  if (!uid || !isConvexConfigured()) return;
  if (sweeping.has(uid)) {
    rerunRequested.add(uid);
    return;
  }
  if (pendingKicks.has(uid)) return;
  pendingKicks.set(
    uid,
    setTimeout(() => {
      pendingKicks.delete(uid);
      void runLlmClassificationSweep(uid).catch((err: any) => {
        console.error('[llm-classify] sweep failed:', err?.message || err);
      });
    }, delayMs),
  );
}

export async function runLlmClassificationSweep(userId: string) {
  if (sweeping.has(userId) || !isConvexConfigured()) return { classified: 0 };
  sweeping.add(userId);
  let result: { classified: number; moreRemaining?: boolean } = { classified: 0 };
  try {
    result = await runWithAiRequestContext({ userId, agent: 'ai' }, () => runJevSweep(userId));
    return result;
  } finally {
    sweeping.delete(userId);
    // Drain the rest: rows left by the per-kick cap, or a kick that arrived
    // while we were running. A short delay yields the event loop and re-debounces.
    const replay = rerunRequested.delete(userId) || result?.moreRemaining;
    if (replay) kickLlmClassification(userId, 1_000);
  }
}
