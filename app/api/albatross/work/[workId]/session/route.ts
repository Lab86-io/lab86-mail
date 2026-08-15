import { after, type NextRequest } from 'next/server';
import {
  browserSessionsConfigured,
  createBrowserSession,
  navigateSession,
  readSessionPage,
  releaseBrowserSession,
} from '@/lib/albatross/browser-session';
import { evidenceSatisfies } from '@/lib/albatross/evidence-gate';
import { completeWorkStep } from '@/lib/albatross/step-execution';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { api, convexMutation, convexQuery } from '@/lib/hosted/convex';
import { enforceUserRateLimit, RateLimitError, rateLimitResponse } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

interface WorkSessionDependencies {
  requireCurrentUser: typeof requireCurrentUser;
  enforceUserRateLimit: typeof enforceUserRateLimit;
  convexMutation: typeof convexMutation;
  convexQuery: typeof convexQuery;
  browserSessionsConfigured: typeof browserSessionsConfigured;
  createBrowserSession: typeof createBrowserSession;
  releaseBrowserSession: typeof releaseBrowserSession;
  navigateSession: typeof navigateSession;
  readSessionPage: typeof readSessionPage;
  evidenceSatisfies: typeof evidenceSatisfies;
  completeWorkStep: typeof completeWorkStep;
  schedule: (task: () => Promise<void>) => void;
  reportError: typeof console.error;
}

const defaults: WorkSessionDependencies = {
  requireCurrentUser,
  enforceUserRateLimit,
  convexMutation,
  convexQuery,
  browserSessionsConfigured,
  createBrowserSession,
  releaseBrowserSession,
  navigateSession,
  readSessionPage,
  evidenceSatisfies,
  completeWorkStep,
  schedule: (task) => after(task),
  reportError: console.error,
};

interface SessionStepRow {
  key: string;
  identity?: string;
  title: string;
  url: string | null;
  doneWhen?: string | null;
  done: boolean;
}

function findStep(detail: any, stepKey: string): SessionStepRow | null {
  const steps: SessionStepRow[] = detail?.execution?.guideSteps || [];
  return steps.find((step) => step.key === stepKey) || null;
}

/**
 * The relay: start opens one shared browser at the step's page and hands the
 * user the controls. Verify reads the page and asks the evidence gate whether
 * doneWhen is now true; only a satisfied verdict checks the step, with the
 * session replay bound as observed step evidence. Credentials never pass
 * through here — the user types into the site, inside the live view.
 */
export function createWorkSessionPost(overrides: Partial<WorkSessionDependencies> = {}) {
  const deps: WorkSessionDependencies = { ...defaults, ...overrides };
  return async function POST(req: NextRequest, context: { params: Promise<{ workId: string }> }) {
    try {
      const user = await deps.requireCurrentUser();
      await deps.enforceUserRateLimit({
        userId: user.userId,
        key: 'albatross-work-session',
        limit: 20,
        windowMs: 60_000,
      });
      const { workId } = await context.params;
      const body = await req.json().catch(() => ({}));
      const action = typeof body?.action === 'string' ? body.action : '';
      const userId = user.userId;

      if (action === 'start') {
        if (!deps.browserSessionsConfigured()) {
          return Response.json(
            { ok: false, error: 'Shared browser sessions are not configured.' },
            { status: 503 },
          );
        }
        const stepKey = typeof body?.stepKey === 'string' ? body.stepKey : '';
        const detail = await deps.convexQuery<any>((api as any).albatrossWorkV2.workDetail, {
          userId,
          workId,
        });
        if (!detail?.work) return Response.json({ ok: false, error: 'Work not found.' }, { status: 404 });
        const step = stepKey ? findStep(detail, stepKey) : null;
        // The Convex ledger supersedes the old row; the remote browser must be
        // released too, or it idles until its timeout on the account.
        const previous = await deps
          .convexQuery<any>((api as any).albatrossBrowserSessions.activeSessionForWork, {
            userId,
            workId,
          })
          .catch(() => null);
        if (previous?.sessionId) {
          await deps.releaseBrowserSession(previous.sessionId).catch(() => undefined);
        }
        const session = await deps.createBrowserSession();
        await deps.convexMutation((api as any).albatrossBrowserSessions.openSession, {
          userId,
          workId,
          stepKey: step?.key,
          stepIdentity: step?.identity,
          sessionId: session.sessionId,
          liveViewUrl: session.liveViewUrl,
          replayUrl: session.replayUrl,
        });
        const targetUrl = step?.url || null;
        deps.schedule(async () => {
          try {
            if (targetUrl) await deps.navigateSession(session.connectUrl, targetUrl);
            await deps.convexMutation((api as any).albatrossBrowserSessions.setSessionStatus, {
              userId,
              sessionId: session.sessionId,
              status: 'user',
              statusDetail: targetUrl
                ? 'The page is ready. Take it from here.'
                : 'The shared browser is ready.',
            });
          } catch (error) {
            deps.reportError('[work-session] prepare failed', session.sessionId, error);
            await deps
              .convexMutation((api as any).albatrossBrowserSessions.setSessionStatus, {
                userId,
                sessionId: session.sessionId,
                status: 'user',
                statusDetail: 'The shared browser is ready. Open the page yourself inside it.',
              })
              .catch(() => undefined);
          }
        });
        return Response.json({
          ok: true,
          sessionId: session.sessionId,
          liveViewUrl: session.liveViewUrl,
          replayUrl: session.replayUrl,
        });
      }

      if (action === 'verify') {
        const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : '';
        const stepKey = typeof body?.stepKey === 'string' ? body.stepKey : '';
        if (!sessionId || !stepKey) {
          return Response.json({ ok: false, error: 'sessionId and stepKey are required.' }, { status: 400 });
        }
        const [detail, session] = await Promise.all([
          deps.convexQuery<any>((api as any).albatrossWorkV2.workDetail, { userId, workId }),
          deps.convexQuery<any>((api as any).albatrossBrowserSessions.activeSessionForWork, {
            userId,
            workId,
          }),
        ]);
        const step = findStep(detail, stepKey);
        if (!step) return Response.json({ ok: false, error: 'Step not found.' }, { status: 404 });
        if (step.done) {
          return Response.json({ ok: false, error: 'This step is already complete.' }, { status: 409 });
        }
        if (!session || session.sessionId !== sessionId) {
          return Response.json(
            { ok: false, error: 'The shared browser is no longer open.' },
            { status: 409 },
          );
        }
        await deps.convexMutation((api as any).albatrossBrowserSessions.setSessionStatus, {
          userId,
          sessionId,
          status: 'verifying',
          stepKey: step.key,
          stepIdentity: step.identity,
        });
        // The session row stores no connectUrl (it is a credentialed endpoint);
        // reads go through a fresh create-time handle only. Re-derive it.
        const connectUrl = `wss://connect.browserbase.com?apiKey=${encodeURIComponent(
          process.env.BROWSERBASE_API_KEY ||
            process.env.LAB86_BROWSERBASE_API_KEY ||
            process.env.BB_API_KEY ||
            '',
        )}&sessionId=${encodeURIComponent(sessionId)}`;
        let satisfied = false;
        let reason = '';
        let checkRan = false;
        try {
          const page = await deps.readSessionPage(connectUrl).catch((error) => {
            // The connect URL embeds the API key; neither it nor the raw error
            // may reach the client or the status line.
            deps.reportError('[work-session] page read failed', sessionId, error?.name || 'error');
            return null;
          });
          if (!page) {
            return Response.json({
              ok: true,
              satisfied: false,
              reason: 'The page could not be read. Nothing is claimed either way.',
              checkRan: false,
            });
          }
          checkRan = true;
          const verdict = await deps.evidenceSatisfies({
            userId,
            workTitle: String(detail?.plan?.outcome || detail?.work?.title || ''),
            outcome: detail?.plan?.outcome ?? null,
            requirement: step.doneWhen || `"${step.title}" is complete.`,
            evidenceText: `Page: ${page.url}\nTitle: ${page.title}\n${page.text}`,
          });
          satisfied = verdict.satisfies === true && !verdict.unavailable;
          checkRan = !verdict.unavailable;
          reason = verdict.reason;
          if (satisfied) {
            await deps.convexMutation((api as any).albatrossWorkV2.attachProof, {
              userId,
              workId,
              claim: `${step.title}: ${reason || 'the page shows the completion state'}`.slice(0, 400),
              title: page.title || 'Verified on the page',
              summary: `Seen at ${page.url}`.slice(0, 600),
              url: session.replayUrl,
              sourceKind: 'browser_session',
              sourceId: sessionId,
              stepIdentity: step.identity,
              trust: 'observed',
              settleContract: true,
            });
            await deps.completeWorkStep({ userId, workId, stepKey: step.key, source: 'evidence' });
          }
        } finally {
          await deps
            .convexMutation((api as any).albatrossBrowserSessions.setSessionStatus, {
              userId,
              sessionId,
              status: 'user',
              // "Not complete" is a verdict; "did not run" is not. The status
              // line never converts an unrun check into a judgment.
              statusDetail: satisfied
                ? 'Verified. The step is checked off.'
                : !checkRan
                  ? 'The check did not run. Try again.'
                  : reason
                    ? `Not yet: ${reason}`.slice(0, 300)
                    : 'The page does not show the completion state yet.',
            })
            .catch(() => undefined);
        }
        return Response.json({ ok: true, satisfied, reason, checkRan });
      }

      if (action === 'end') {
        const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : '';
        if (!sessionId) {
          return Response.json({ ok: false, error: 'sessionId is required.' }, { status: 400 });
        }
        await deps.releaseBrowserSession(sessionId).catch(() => undefined);
        await deps.convexMutation((api as any).albatrossBrowserSessions.setSessionStatus, {
          userId,
          sessionId,
          status: 'ended',
        });
        return Response.json({ ok: true });
      }

      return Response.json({ ok: false, error: 'Unknown action.' }, { status: 400 });
    } catch (error) {
      if (error instanceof RateLimitError) return rateLimitResponse(error);
      const status = error instanceof AuthRequiredError ? 401 : 500;
      return Response.json(
        { ok: false, error: error instanceof Error ? error.message : 'The session failed.' },
        { status },
      );
    }
  };
}

export const POST = createWorkSessionPost();
