import { auth, clerkClient } from '@clerk/nextjs/server';
import { type NextRequest, NextResponse } from 'next/server';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { isStagingRuntime } from '@/lib/hosted/controls';
import { createNativeBrowserAccess } from '@/lib/native/browser-access';
import { enforceUserRateLimit, RateLimitError, rateLimitJson } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Dependencies {
  requireCurrentUser: typeof requireCurrentUser;
  auth: typeof auth;
  clerkClient: typeof clerkClient;
  enforceUserRateLimit: typeof enforceUserRateLimit;
  createAccess: typeof createNativeBrowserAccess;
}
const defaults: Dependencies = {
  requireCurrentUser,
  auth,
  clerkClient,
  enforceUserRateLimit,
  createAccess: createNativeBrowserAccess,
};

function noStore(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store, private', Pragma: 'no-cache' },
  });
}

function failure(error: unknown) {
  if (error instanceof AuthRequiredError)
    return noStore({ ok: false, error: 'Sign in to Albatross again.' }, 401);
  if (error instanceof RateLimitError) {
    const response = rateLimitJson(error);
    response.headers.set('Cache-Control', 'no-store');
    return response;
  }
  // Never log a sign-in ticket or a provider response containing one.
  return noStore({ ok: false, error: 'The editor session could not be opened. Try again.' }, 503);
}

function requireBearer(req: NextRequest) {
  if (!/^Bearer \S+$/iu.test(req.headers.get('authorization') || ''))
    throw new AuthRequiredError('Native sign-in required.');
}

export function createNativeWebSessionPost(deps: Dependencies = defaults) {
  return async (req: NextRequest) => {
    try {
      requireBearer(req);
      const user = await deps.requireCurrentUser();
      await deps.enforceUserRateLimit({
        userId: user.userId,
        key: 'native-web-session',
        limit: 20,
        windowMs: 60_000,
      });
      const access = isStagingRuntime(req.nextUrl.hostname)
        ? await deps.createAccess(req.nextUrl.origin, process.env.LAB86_CONVEX_INTERNAL_SECRET || '')
        : null;
      const client = await deps.clerkClient();
      const ticket = await client.signInTokens.createSignInToken({
        userId: user.userId,
        expiresInSeconds: 60,
      });
      return noStore({ ok: true, ticket: ticket.token, userId: user.userId, access });
    } catch (error) {
      return failure(error);
    }
  };
}

// Renew the staging gate without creating another Clerk sign-in ticket.
export function createNativeWebSessionPatch(deps: Dependencies = defaults) {
  return async (req: NextRequest) => {
    try {
      requireBearer(req);
      const user = await deps.requireCurrentUser();
      await deps.enforceUserRateLimit({
        userId: user.userId,
        key: 'native-web-access',
        limit: 20,
        windowMs: 60_000,
      });
      const access = isStagingRuntime(req.nextUrl.hostname)
        ? await deps.createAccess(req.nextUrl.origin, process.env.LAB86_CONVEX_INTERNAL_SECRET || '')
        : null;
      return noStore({ ok: true, userId: user.userId, access });
    } catch (error) {
      return failure(error);
    }
  };
}

export function createNativeWebSessionDelete(deps: Dependencies = defaults) {
  return async (req: NextRequest) => {
    try {
      requireBearer(req);
      const user = await deps.requireCurrentUser();
      const native = await deps.auth();
      const body = await req.json().catch(() => null);
      if (
        typeof body?.sessionId !== 'string' ||
        !/^sess_[a-zA-Z0-9]+$/u.test(body.sessionId) ||
        body.sessionId === native.sessionId
      ) {
        return noStore({ ok: false, error: 'Invalid editor session.' }, 400);
      }
      const client = await deps.clerkClient();
      const session = await client.sessions.getSession(body.sessionId);
      if (session.userId !== user.userId)
        return noStore({ ok: false, error: 'Editor session not found.' }, 404);
      if (session.status === 'active') await client.sessions.revokeSession(session.id);
      return noStore({ ok: true });
    } catch (error) {
      return failure(error);
    }
  };
}

export const POST = createNativeWebSessionPost();
export const DELETE = createNativeWebSessionDelete();

export const PATCH = createNativeWebSessionPatch();
