import { z } from 'zod';
import type { PersonalDetailsResponse } from '@/lib/albatross/thread-contract';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import {
  deletePersonalDetail,
  listPersonalDetails,
  missingDetailKeys,
  PersonalDetailError,
  savePersonalDetail,
  undoPersonalDetailSave,
} from '@/lib/personal-details/store';
import { enforceUserRateLimit, RateLimitError, rateLimitResponse } from '@/lib/rate-limit';
import { errorAnswerMessage } from '@/lib/security/error-answer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Personal details for the signed-in user (docs/albatross-thread.md). The
// values are decrypted here only for their owner. No response is cached, and
// no log line holds a value.

const putBody = z.object({
  key: z.string().min(1).max(60),
  value: z.unknown(),
  label: z.string().max(60).optional(),
});
const postBody = z.object({ action: z.literal('undo'), key: z.string().min(1).max(60) });

const defaults = {
  requireCurrentUser,
  enforceUserRateLimit,
  listPersonalDetails,
  savePersonalDetail,
  deletePersonalDetail,
  undoPersonalDetailSave,
};

const NO_STORE = { 'cache-control': 'no-store' };

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: NO_STORE });
}

function failure(error: unknown, fallback: string) {
  if (error instanceof RateLimitError) return rateLimitResponse(error);
  if (error instanceof PersonalDetailError)
    return json(
      { ok: false, code: error.code, key: error.key, error: error.message },
      error.code === 'limit' ? 409 : 400,
    );
  if (error instanceof z.ZodError)
    return json({ ok: false, code: 'invalid', error: 'Check the request.' }, 400);
  const status = error instanceof AuthRequiredError ? 401 : 500;
  return json(
    { ok: false, error: errorAnswerMessage(status, error, fallback, '[personal-details] failed') },
    status,
  );
}

/** A JSON body only: a cross-site form post cannot reach a write. */
async function readJson(req: Request): Promise<unknown> {
  if (!(req.headers.get('content-type') || '').toLowerCase().includes('application/json'))
    throw new PersonalDetailError('invalid', '', 'Send JSON.');
  return req.json().catch(() => {
    throw new PersonalDetailError('invalid', '', 'Send JSON.');
  });
}

export function createPersonalDetailsRoutes(deps = defaults) {
  async function writer(key: string) {
    const user = await deps.requireCurrentUser();
    await deps.enforceUserRateLimit({ userId: user.userId, key, limit: 60, windowMs: 60_000 });
    return user;
  }
  return {
    async GET() {
      try {
        const user = await deps.requireCurrentUser();
        await deps.enforceUserRateLimit({
          userId: user.userId,
          key: 'personal-details-read',
          limit: 120,
          windowMs: 60_000,
        });
        const details = await deps.listPersonalDetails(user);
        const body: PersonalDetailsResponse = { ok: true, details, missing: missingDetailKeys(details) };
        return json(body);
      } catch (error) {
        return failure(error, 'Personal details did not load.');
      }
    },
    async PUT(req: Request) {
      try {
        const user = await writer('personal-details-write');
        const body = putBody.parse(await readJson(req));
        const detail = await deps.savePersonalDetail(user, body, 'settings');
        return json({ ok: true, detail });
      } catch (error) {
        return failure(error, 'The detail was not saved.');
      }
    },
    async POST(req: Request) {
      try {
        const user = await writer('personal-details-write');
        const body = postBody.parse(await readJson(req));
        const undone = await deps.undoPersonalDetailSave(user, body.key);
        return json({ ok: true, undone });
      } catch (error) {
        return failure(error, 'The save was not undone.');
      }
    },
    async DELETE(req: Request) {
      try {
        const user = await writer('personal-details-write');
        const key = new URL(req.url).searchParams.get('key') || '';
        const removed = await deps.deletePersonalDetail(user, key);
        return json({ ok: true, removed });
      } catch (error) {
        return failure(error, 'The detail was not deleted.');
      }
    },
  };
}

const routes = createPersonalDetailsRoutes();
export const GET = routes.GET;
export const PUT = routes.PUT;
export const POST = routes.POST;
export const DELETE = routes.DELETE;
