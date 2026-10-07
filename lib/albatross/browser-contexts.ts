// Saved sign-ins for the shared browser (owner decision, 2026-10-07).
//
// Each user has one Browserbase context. Sessions use it, so a site the user
// signed in to once stays signed in for the next step. Browserbase keeps the
// last writer, so only one live session may save cookies back: a session
// claims the writer place atomically in Convex, binds it once it exists, and
// the place frees when that session ends. A second live session reads the
// saved sign-ins without saving. The context holds browser data only.
// Albatross never asks for, stores, or reads a password. A failure here never
// blocks a session: the session then starts without saved sign-ins.

import { randomUUID } from 'node:crypto';
import { api, convexMutation, convexQuery } from '../hosted/convex';
import {
  type BrowserSessionOptions,
  browserSessionsConfigured,
  createBrowserContext,
  deleteBrowserContext,
} from './browser-session';

export interface BrowserContextDependencies {
  convexQuery: typeof convexQuery;
  convexMutation: typeof convexMutation;
  createBrowserContext: typeof createBrowserContext;
  deleteBrowserContext: typeof deleteBrowserContext;
  configured: () => boolean;
  newToken: () => string;
  reportError: typeof console.error;
}

const defaults: BrowserContextDependencies = {
  convexQuery,
  convexMutation,
  createBrowserContext,
  deleteBrowserContext,
  configured: browserSessionsConfigured,
  newToken: randomUUID,
  reportError: console.error,
};

export interface SessionStartOptions extends BrowserSessionOptions {
  /** Set when this session holds the writer place; bind or release it. */
  writerToken?: string;
}

/** The session options for a new shared browser of this user. */
export async function sessionOptionsForUser(
  userId: string,
  overrides: Partial<BrowserContextDependencies> = {},
): Promise<SessionStartOptions> {
  const deps = { ...defaults, ...overrides };
  if (!deps.configured()) return {};
  try {
    const saved = await deps.convexQuery<{ contextId: string } | null>(api.albatrossStepRuns.browserContext, {
      userId,
    });
    if (!saved?.contextId) {
      const contextId = await deps.createBrowserContext();
      await deps.convexMutation(api.albatrossStepRuns.saveBrowserContext, { userId, contextId });
    }
    const token = deps.newToken();
    const claimed = await deps.convexMutation<{ contextId: string; persist: boolean } | null>(
      api.albatrossStepRuns.claimContextWriter,
      { userId, token },
    );
    if (!claimed?.contextId) return {};
    return claimed.persist
      ? { contextId: claimed.contextId, persist: true, writerToken: token }
      : { contextId: claimed.contextId, persist: false };
  } catch (error) {
    deps.reportError(
      '[browser-contexts] saved sign-ins unavailable',
      error instanceof Error ? error.name : 'error',
    );
    return {};
  }
}

/** The session exists: tie the writer place to it, so its end frees the place. */
export async function bindSessionWriter(
  userId: string,
  options: SessionStartOptions,
  sessionId: string,
  overrides: Partial<BrowserContextDependencies> = {},
) {
  if (!options.writerToken) return;
  const deps = { ...defaults, ...overrides };
  await deps
    .convexMutation(api.albatrossStepRuns.bindContextWriter, {
      userId,
      token: options.writerToken,
      sessionId,
    })
    .catch(() => undefined);
}

/** The session did not start: give the writer place back at once. */
export async function releaseSessionWriter(
  userId: string,
  options: SessionStartOptions,
  overrides: Partial<BrowserContextDependencies> = {},
) {
  if (!options.writerToken) return;
  const deps = { ...defaults, ...overrides };
  await deps
    .convexMutation(api.albatrossStepRuns.releaseContextWriter, { userId, token: options.writerToken })
    .catch(() => undefined);
}

export interface SavedSignInState {
  saved: boolean;
  createdAt?: number;
  lastUsedAt?: number;
}

export async function savedSignInState(
  userId: string,
  overrides: Partial<BrowserContextDependencies> = {},
): Promise<SavedSignInState> {
  const deps = { ...defaults, ...overrides };
  const saved = await deps.convexQuery<{ createdAt: number; lastUsedAt: number } | null>(
    api.albatrossStepRuns.browserContext,
    { userId },
  );
  return saved ? { saved: true, createdAt: saved.createdAt, lastUsedAt: saved.lastUsedAt } : { saved: false };
}

/**
 * Delete contexts at Browserbase. Each confirmed delete clears its deletion
 * record; a failed one stays recorded for the hourly retry.
 */
export async function deleteContextsAtBrowserbase(
  contextIds: readonly string[],
  overrides: Partial<BrowserContextDependencies> = {},
): Promise<{ deleted: number; pending: number }> {
  const deps = { ...defaults, ...overrides };
  let deleted = 0;
  for (const contextId of contextIds) {
    if (!deps.configured()) break;
    try {
      await deps.deleteBrowserContext(contextId);
      await deps.convexMutation(api.albatrossStepRuns.completeContextDeletion, { contextId });
      deleted += 1;
    } catch (error) {
      await deps
        .convexMutation(api.albatrossStepRuns.failContextDeletion, {
          contextId,
          error: error instanceof Error ? error.message : 'delete failed',
        })
        .catch(() => undefined);
    }
  }
  return { deleted, pending: contextIds.length - deleted };
}

/**
 * Forget the saved sign-ins. The rows go first, so no new session picks the
 * context up; each id stays in a deletion record until Browserbase confirms
 * the delete, so a failed delete is retried, also after account deletion.
 */
export async function forgetSavedSignIns(
  userId: string,
  overrides: Partial<BrowserContextDependencies> = {},
): Promise<{ forgotten: number; pending: number }> {
  const deps = { ...defaults, ...overrides };
  const { contextIds } = await deps.convexMutation<{ contextIds: string[] }>(
    api.albatrossStepRuns.forgetBrowserContext,
    { userId },
  );
  const ids = contextIds || [];
  const { pending } = await deleteContextsAtBrowserbase(ids, deps);
  return { forgotten: ids.length, pending };
}
