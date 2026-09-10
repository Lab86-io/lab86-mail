/**
 * Outgoing-edit retention for editors whose identity can change underneath
 * them (URL deep links, back/forward, palette navigation).
 *
 * A `key` alone on the editor isolates identity but discards the unmounted
 * instance's unsaved work. This store keeps that work, flushes it against the
 * revision it was based on, and hands it back to the next instance for the
 * same document. Stale drafts (the server moved on) are never auto-applied;
 * they are surfaced for download or discard.
 */

export interface RetainedDraft<TModel> {
  title: string;
  model: TModel;
  /** Revision (or provider version) the draft was edited against. */
  base: string;
  retainedAt: number;
  /** Set when a flush attempt failed; the next instance shows the reason. */
  lastError?: string;
}

export type DraftFlushResult = { ok: true } | { ok: false; error: string; conflict: boolean };

const drafts = new Map<string, RetainedDraft<unknown>>();
const flushes = new Map<string, Promise<DraftFlushResult>>();

export function retainDraft<TModel>(key: string, draft: Omit<RetainedDraft<TModel>, 'retainedAt'>) {
  drafts.set(key, { ...draft, retainedAt: Date.now() });
}

export function peekDraft<TModel>(key: string) {
  return (drafts.get(key) as RetainedDraft<TModel> | undefined) ?? null;
}

export function discardDraft(key: string) {
  drafts.delete(key);
}

export function pendingFlush(key: string) {
  return flushes.get(key) ?? null;
}

/**
 * Save a retained draft once. On success the draft is dropped; on failure it is
 * kept with the error so the next instance for the same key can recover it.
 */
export function flushDraft<TModel>(
  key: string,
  save: (draft: RetainedDraft<TModel>) => Promise<DraftFlushResult>,
) {
  const draft = drafts.get(key) as RetainedDraft<TModel> | undefined;
  if (!draft) return Promise.resolve<DraftFlushResult>({ ok: true });
  const existing = flushes.get(key);
  if (existing) return existing;
  const run = (async () => {
    try {
      const result = await save(draft);
      const current = drafts.get(key);
      if (result.ok) {
        if (current === draft) drafts.delete(key);
      } else if (current === draft) {
        drafts.set(key, { ...draft, lastError: result.error });
      }
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Save failed.';
      const current = drafts.get(key);
      if (current === draft) drafts.set(key, { ...draft, lastError: message });
      return { ok: false as const, error: message, conflict: false };
    } finally {
      flushes.delete(key);
    }
  })();
  flushes.set(key, run);
  return run;
}

export function __resetDraftStoreForTest() {
  drafts.clear();
  flushes.clear();
}
