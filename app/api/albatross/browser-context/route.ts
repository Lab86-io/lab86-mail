import { forgetSavedSignIns, savedSignInState } from '@/lib/albatross/browser-contexts';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { errorAnswerMessage } from '@/lib/security/error-answer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const defaults = { requireCurrentUser, savedSignInState, forgetSavedSignIns };

function failure(error: unknown, fallback: string, label: string) {
  const status = error instanceof AuthRequiredError ? 401 : 500;
  return Response.json({ ok: false, error: errorAnswerMessage(status, error, fallback, label) }, { status });
}

/** Saved sign-ins of the shared browser: read whether they exist, or forget them. */
export function createBrowserContextRoutes(deps = defaults) {
  return {
    async GET() {
      try {
        const user = await deps.requireCurrentUser();
        return Response.json({ ok: true, ...(await deps.savedSignInState(user.userId)) });
      } catch (error) {
        return failure(error, 'Saved sign-ins failed.', '[albatross/browser-context] read failed');
      }
    },
    async DELETE() {
      try {
        const user = await deps.requireCurrentUser();
        const result = await deps.forgetSavedSignIns(user.userId);
        return Response.json({ ok: true, saved: false, ...result });
      } catch (error) {
        return failure(
          error,
          'Saved sign-ins could not be forgotten.',
          '[albatross/browser-context] forget failed',
        );
      }
    },
  };
}

const routes = createBrowserContextRoutes();
export const GET = routes.GET;
export const DELETE = routes.DELETE;
