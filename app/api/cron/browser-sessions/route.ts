import { type NextRequest, NextResponse } from 'next/server';
import { browserSessionsConfigured, releaseBrowserSession } from '@/lib/albatross/browser-session';
import { isInternalCronRequest } from '@/lib/cron-auth';
import { api, convexMutation } from '@/lib/hosted/convex';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const SWEEP_MAX = 25;

interface BrowserSessionSweepDependencies {
  isInternalCronRequest: typeof isInternalCronRequest;
  browserSessionsConfigured: typeof browserSessionsConfigured;
  releaseBrowserSession: typeof releaseBrowserSession;
  convexMutation: typeof convexMutation;
  reportError: typeof console.error;
}

const defaults: BrowserSessionSweepDependencies = {
  isInternalCronRequest,
  browserSessionsConfigured,
  releaseBrowserSession,
  convexMutation,
  reportError: console.error,
};

/**
 * Called by the Convex stale-session cron (WRK-8). Each session is ended at
 * Browserbase with the shared helper, then its ledger row is marked ended.
 * A release error does not keep the row live: a session past its timeout is
 * already gone at Browserbase, and a live row would show a dead view.
 */
export function createBrowserSessionSweepPost(overrides: Partial<BrowserSessionSweepDependencies> = {}) {
  const deps: BrowserSessionSweepDependencies = { ...defaults, ...overrides };
  return async function POST(req: NextRequest) {
    if (!deps.isInternalCronRequest(req)) {
      return NextResponse.json({ ok: false, error: 'Unauthorized.' }, { status: 401 });
    }
    const body = await req.json().catch(() => ({}));
    const sessions = (Array.isArray(body?.sessions) ? body.sessions : [])
      .map((row: any) => ({ userId: String(row?.userId || ''), sessionId: String(row?.sessionId || '') }))
      .filter((row: { userId: string; sessionId: string }) => row.userId && row.sessionId)
      .slice(0, SWEEP_MAX);
    const configured = deps.browserSessionsConfigured();
    let released = 0;
    let ended = 0;
    for (const session of sessions) {
      if (configured) {
        try {
          await deps.releaseBrowserSession(session.sessionId);
          released += 1;
        } catch (error) {
          deps.reportError('[cron/browser-sessions] release failed', session.sessionId, error);
        }
      }
      try {
        await deps.convexMutation(api.albatrossBrowserSessions.setSessionStatus, {
          userId: session.userId,
          sessionId: session.sessionId,
          status: 'ended',
          statusDetail: 'The session timed out.',
        });
        ended += 1;
      } catch (error) {
        deps.reportError('[cron/browser-sessions] ledger update failed', session.sessionId, error);
      }
    }
    return NextResponse.json({ ok: true, released, ended });
  };
}

export const POST = createBrowserSessionSweepPost();
