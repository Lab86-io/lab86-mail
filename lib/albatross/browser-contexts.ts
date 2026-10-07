// Saved sign-ins for the shared browser (owner decision, 2026-10-07).
//
// Each user has one Browserbase context. Sessions use it, so a site the user
// signed in to once stays signed in for the next step. Only one live session
// saves cookies back at a time (Browserbase keeps the last writer), so a
// second live session reads the saved sign-ins without saving. The context
// holds browser data only. Albatross never asks for, stores, or reads a
// password. A failure here never blocks a session: the session then starts
// without saved sign-ins.

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
  reportError: typeof console.error;
}

const defaults: BrowserContextDependencies = {
  convexQuery,
  convexMutation,
  createBrowserContext,
  deleteBrowserContext,
  configured: browserSessionsConfigured,
  reportError: console.error,
};

/** The session options for a new shared browser of this user. */
export async function sessionOptionsForUser(
  userId: string,
  overrides: Partial<BrowserContextDependencies> = {},
): Promise<BrowserSessionOptions> {
  const deps = { ...defaults, ...overrides };
  if (!deps.configured()) return {};
  try {
    const saved = await deps.convexQuery<{ contextId: string } | null>(api.albatrossStepRuns.browserContext, {
      userId,
    });
    let contextId = saved?.contextId;
    if (!contextId) {
      contextId = await deps.createBrowserContext();
      await deps.convexMutation(api.albatrossStepRuns.saveBrowserContext, { userId, contextId });
    } else {
      await deps.convexMutation(api.albatrossStepRuns.saveBrowserContext, { userId, contextId });
    }
    const live = await deps
      .convexQuery<number>(api.albatrossBrowserSessions.liveSessionCount, { userId })
      .catch(() => 1);
    return { contextId, persist: Number(live) === 0 };
  } catch (error) {
    deps.reportError(
      '[browser-contexts] saved sign-ins unavailable',
      error instanceof Error ? error.name : 'error',
    );
    return {};
  }
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
 * Forget the saved sign-ins: the rows go first, so no new session picks the
 * context up, then each context is deleted at Browserbase.
 */
export async function forgetSavedSignIns(
  userId: string,
  overrides: Partial<BrowserContextDependencies> = {},
): Promise<{ forgotten: number }> {
  const deps = { ...defaults, ...overrides };
  const { contextIds } = await deps.convexMutation<{ contextIds: string[] }>(
    api.albatrossStepRuns.forgetBrowserContext,
    { userId },
  );
  for (const contextId of contextIds || []) {
    if (!deps.configured()) break;
    await deps.deleteBrowserContext(contextId);
  }
  return { forgotten: (contextIds || []).length };
}
