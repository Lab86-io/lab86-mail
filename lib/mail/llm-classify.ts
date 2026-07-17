import { getAiRequestContext, runWithAiRequestContext } from '../ai/context';
import { hasAiForCurrentUser } from '../ai/gateway';
import { api, convexMutation } from '../hosted/convex';
import { isConvexConfigured } from '../hosted/env';
import { listSmartLabels } from '../store/smart-labels';
import { listSmartRules } from '../store/smart-rules';
import { classifyThreadsBatched } from '../tools/ai';

// LLM-once classification sweep. Write-time classification flags threads the
// deterministic pass isn't confident about (llmPending); this drains that
// queue on the nano tier — one verdict per thread, persisted forever on the
// corpus row. Triggered after sync activity and on category reads, debounced
// per user; safe to over-kick.
const SWEEP_BATCH = 40;
const MAX_BATCHES_PER_KICK = 5;
const KICK_DEBOUNCE_MS = 5_000;

const sweeping = new Set<string>();
const pendingKicks = new Map<string, ReturnType<typeof setTimeout>>();
// Kicks that arrive mid-sweep (when the per-kick batch cap may have left rows
// behind, or new rows landed during the run) are coalesced here and replayed
// once the current sweep finishes, so the backlog always drains.
const rerunRequested = new Set<string>();

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
    result = await runWithAiRequestContext({ userId, agent: 'ai' }, async () => {
      if (!(await hasAiForCurrentUser('classify_threads'))) return { classified: 0 };
      const [rules, labels] = await Promise.all([listSmartRules(), listSmartLabels()]);
      let classified = 0;
      let moreRemaining = false;
      for (let batch = 0; batch < MAX_BATCHES_PER_KICK; batch++) {
        const page = await convexMutation<{ items: any[]; moreRemaining: boolean }>(
          (api as any).mailCorpus.listLlmPending,
          { userId, limit: SWEEP_BATCH },
        );
        const pending = page.items;
        if (!pending.length) {
          if (page.moreRemaining) {
            if (batch === MAX_BATCHES_PER_KICK - 1) moreRemaining = true;
            continue;
          }
          break;
        }
        // A full final batch under the per-kick cap means rows likely remain.
        if (batch === MAX_BATCHES_PER_KICK - 1 && (page.moreRemaining || pending.length === SWEEP_BATCH))
          moreRemaining = true;
        const verdicts = await classifyThreadsBatched(
          pending.map((row) => ({
            id: `${row.accountId}:${row.providerThreadId}`,
            account: row.accountId,
            fromAddress: row.fromAddress,
            subject: row.subject,
            snippet: row.snippet,
            labels: row.labels,
            unread: row.unread,
            date: row.lastDate,
            bodyText: row.bodyText,
          })),
          { rules, customLabels: labels, force: true, speed: 'nano' },
        );
        const verdictById = new Map(verdicts.map((v) => [v.id, v]));
        // Every listed row gets closed out — rows whose verdict didn't come
        // back keep their deterministic classification (one attempt, no loop).
        const items = pending.map((row) => {
          const verdict = verdictById.get(`${row.accountId}:${row.providerThreadId}`);
          const fromModel = verdict && verdict.model !== 'deterministic' && verdict.model !== 'user_rule';
          if (!fromModel) {
            return {
              accountId: row.accountId,
              providerThreadId: row.providerThreadId,
              messageId: row.messageId,
            };
          }
          const { id: _id, ...category } = verdict as any;
          return {
            accountId: row.accountId,
            providerThreadId: row.providerThreadId,
            messageId: row.messageId,
            verdict: { ...category, classifiedAt: Date.now() },
          };
        });
        const batchResult = await convexMutation<{ stored: number }>(
          (api as any).mailCorpus.storeLlmVerdicts,
          { userId, items },
        );
        classified += batchResult.stored;
        if (pending.length < SWEEP_BATCH) {
          if (page.moreRemaining) continue;
          break;
        }
      }
      if (classified) console.log(`[llm-classify] stored ${classified} verdicts for ${userId}`);
      return { classified, moreRemaining };
    });
    return result;
  } finally {
    sweeping.delete(userId);
    // Drain the rest: rows left by the per-kick cap, or a kick that arrived
    // while we were running. A short delay yields the event loop and re-debounces.
    const replay = rerunRequested.delete(userId) || result?.moreRemaining;
    if (replay) kickLlmClassification(userId, 1_000);
  }
}
