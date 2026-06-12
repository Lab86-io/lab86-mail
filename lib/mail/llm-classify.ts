import { getAiRequestContext, runWithAiRequestContext } from '../ai/context';
import { hasAiForCurrentUser } from '../ai/gateway';
import { api, convexMutation, convexQuery } from '../hosted/convex';
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

export function kickLlmClassification(userId?: string | null, delayMs = KICK_DEBOUNCE_MS) {
  const uid = userId || getAiRequestContext().userId;
  if (!uid || !isConvexConfigured() || pendingKicks.has(uid)) return;
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
  try {
    return await runWithAiRequestContext({ userId, agent: 'ai' }, async () => {
      if (!(await hasAiForCurrentUser('classify_threads'))) return { classified: 0 };
      const [rules, labels] = await Promise.all([listSmartRules(), listSmartLabels()]);
      let classified = 0;
      for (let batch = 0; batch < MAX_BATCHES_PER_KICK; batch++) {
        const pending = await convexQuery<any[]>((api as any).mailCorpus.listLlmPending, {
          userId,
          limit: SWEEP_BATCH,
        });
        if (!pending.length) break;
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
          if (!fromModel) return { accountId: row.accountId, providerThreadId: row.providerThreadId };
          const { id: _id, ...category } = verdict as any;
          return {
            accountId: row.accountId,
            providerThreadId: row.providerThreadId,
            verdict: { ...category, classifiedAt: Date.now() },
          };
        });
        const result = await convexMutation<{ stored: number }>((api as any).mailCorpus.storeLlmVerdicts, {
          userId,
          items,
        });
        classified += result.stored;
        if (pending.length < SWEEP_BATCH) break;
      }
      if (classified) console.log(`[llm-classify] stored ${classified} verdicts for ${userId}`);
      return { classified };
    });
  } finally {
    sweeping.delete(userId);
  }
}
