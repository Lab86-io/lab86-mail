// The secure details routes (docs/albatross-secure-store.md):
//
//   GET    /api/secure-details                  the items, without values
//   POST   /api/secure-details                  add an item
//   PUT    /api/secure-details/[itemId]         change the label, sites, or values
//   DELETE /api/secure-details/[itemId]         delete the item and its history
//   GET    /api/secure-details/[itemId]/uses    the use history
//   POST   /api/secure-details/allow            answer an allow_secure handoff
//
// No response holds a value, and no response is cached. Every write takes
// JSON only, so a cross-site form post cannot reach it. A new place for a
// value (a new site, "Allow once", "Always on this site") needs a recent
// identity check; the 403 answer is Clerk's reverification body.

import { z } from 'zod';
import { resumeStepRun, StepRunStartError } from '../albatross/step-run-start';
import { AuthRequiredError, requireCurrentUser } from '../auth/current-user';
import { api, convexMutation, convexQuery } from '../hosted/convex';
import { enforceUserRateLimit, RateLimitError, rateLimitResponse } from '../rate-limit';
import { errorAnswerMessage } from '../security/error-answer';
import { ALLOW_SECURE_NEXT_KIND, SECURE_ITEM_KINDS, type SecureDetailsResponse } from './contract';
import { SecureKeyError } from './crypto';
import { identityRecentlyChecked, verifyIdentityResponse } from './identity';
import { SecurePolicyError } from './policy';
import {
  createSecureItem,
  deleteSecureItem,
  listSecureItems,
  listSecureUses,
  recordSecureUse,
  SecureStoreError,
  secureStoreEnabled,
  updateSecureItem,
} from './store';

/** "Allow once" lasts this long: the run and its continuations on the same step. */
export const ALLOW_ONCE_MS = 2 * 60 * 60_000;

const createBody = z.object({
  kind: z.enum(SECURE_ITEM_KINDS),
  label: z.string().max(80).optional(),
  sites: z.array(z.string().max(2_000)).max(20).optional(),
  values: z.record(z.string().max(32), z.unknown()),
});
const updateBody = z.object({
  label: z.string().max(80).optional(),
  sites: z.array(z.string().max(2_000)).max(20).optional(),
  values: z.record(z.string().max(32), z.union([z.string().max(4_000), z.null()])).optional(),
});
const allowBody = z.object({
  runId: z.string().min(1).max(64),
  itemId: z.string().min(1).max(64),
  site: z.string().min(1).max(253),
  scope: z.enum(['once', 'always', 'deny']),
});

const NO_STORE = { 'cache-control': 'no-store' };

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: NO_STORE });
}

class BadRequest extends Error {}

async function readJson(req: Request): Promise<unknown> {
  if (!(req.headers.get('content-type') || '').toLowerCase().includes('application/json'))
    throw new BadRequest('Send JSON.');
  return req.json().catch(() => {
    throw new BadRequest('Send JSON.');
  });
}

function failure(error: unknown, fallback: string) {
  if (error instanceof RateLimitError) return rateLimitResponse(error);
  if (error instanceof SecureStoreError) {
    if (error.code === 'verify_identity') return verifyIdentityResponse();
    const status = error.code === 'limit' ? 409 : 404;
    return json({ ok: false, code: error.code, error: error.message }, status);
  }
  if (error instanceof SecurePolicyError)
    return json(
      {
        ok: false,
        code: error.code,
        ...(error.field ? { field: error.field } : {}),
        ...(error.reason ? { reason: error.reason } : {}),
        error: error.message,
      },
      error.code === 'limit' ? 409 : 400,
    );
  if (error instanceof SecureKeyError)
    return json({ ok: false, code: 'off', error: 'Passwords and IDs is not set up yet.' }, 503);
  if (error instanceof StepRunStartError) return json({ ok: false, error: error.message }, error.status);
  if (error instanceof BadRequest || error instanceof z.ZodError)
    return json({ ok: false, code: 'invalid', error: 'Check the request.' }, 400);
  const status = error instanceof AuthRequiredError ? 401 : 500;
  return json(
    { ok: false, error: errorAnswerMessage(status, error, fallback, '[secure-details] failed') },
    status,
  );
}

export const secureRouteDefaults = {
  requireCurrentUser,
  enforceUserRateLimit,
  enabled: secureStoreEnabled,
  identityChecked: identityRecentlyChecked,
  listSecureItems,
  createSecureItem,
  updateSecureItem,
  deleteSecureItem,
  listSecureUses,
  recordSecureUse,
  getRun: (userId: string, runId: string) =>
    convexQuery<any>(api.albatrossStepRuns.get, { userId, id: runId }),
  answerAllow: (userId: string, runId: string, scope: 'once' | 'always' | 'deny') =>
    convexMutation<boolean>(api.albatrossStepRuns.answerAllow, { userId, id: runId as any, scope }),
  grantOnce: (input: { userId: string; itemId: string; site: string; workId: string; stepKey: string }) =>
    convexMutation<{ granted: boolean }>(api.secureDetails.grantOnce, { ...input, ttlMs: ALLOW_ONCE_MS }),
  addSite: (input: { userId: string; itemId: string; site: string }) =>
    convexMutation<{ added: boolean }>(api.secureDetails.addSite, input),
  resumeStepRun,
};

/** The note a resumed run reads after the user's answer. */
export function allowNote(scope: 'once' | 'always' | 'deny', itemLabel: string, site: string) {
  if (scope === 'deny')
    return `The user did not allow ${itemLabel} on ${site}. Do not use it there. Fill what you can, then hand that field to the user with next.kind finish_on_page.`;
  return scope === 'always'
    ? `The user allowed ${itemLabel} on ${site} from now on. Type the same reference again.`
    : `The user allowed ${itemLabel} on ${site} for this step. Type the same reference again.`;
}

export function createSecureDetailsRoutes(deps = secureRouteDefaults) {
  async function caller(key: string, limit: number) {
    const user = await deps.requireCurrentUser();
    await deps.enforceUserRateLimit({ userId: user.userId, key, limit, windowMs: 60_000 });
    return user;
  }

  return {
    async list() {
      try {
        const user = await caller('secure-details-read', 120);
        if (!deps.enabled(user.userId)) {
          const off: SecureDetailsResponse = { ok: true, enabled: false, items: [] };
          return json(off);
        }
        const body: SecureDetailsResponse = {
          ok: true,
          enabled: true,
          items: await deps.listSecureItems(user.userId),
        };
        return json(body);
      } catch (error) {
        return failure(error, 'Passwords and IDs did not load.');
      }
    },

    async create(req: Request) {
      try {
        const user = await caller('secure-details-write', 30);
        const body = createBody.parse(await readJson(req));
        const item = await deps.createSecureItem(user.userId, body);
        return json({ ok: true, item }, 201);
      } catch (error) {
        return failure(error, 'The item was not saved.');
      }
    },

    async update(req: Request, itemId: string) {
      try {
        const user = await caller('secure-details-write', 30);
        const body = updateBody.parse(await readJson(req));
        // The check costs a token read; ask for it only when sites change.
        const identityChecked = body.sites ? await deps.identityChecked() : false;
        const item = await deps.updateSecureItem(user.userId, itemId, body, { identityChecked });
        return json({ ok: true, item });
      } catch (error) {
        return failure(error, 'The item was not saved.');
      }
    },

    async remove(itemId: string) {
      try {
        const user = await caller('secure-details-write', 30);
        const deleted = await deps.deleteSecureItem(user.userId, itemId);
        return json({ ok: true, deleted });
      } catch (error) {
        return failure(error, 'The item was not deleted.');
      }
    },

    async uses(itemId: string) {
      try {
        const user = await caller('secure-details-read', 120);
        const uses = await deps.listSecureUses(user.userId, itemId);
        return json({ ok: true, uses });
      } catch (error) {
        return failure(error, 'The history did not load.');
      }
    },

    async allow(req: Request) {
      try {
        const user = await caller('secure-details-allow', 30);
        const body = allowBody.parse(await readJson(req));
        if (!deps.enabled(user.userId))
          throw new SecureStoreError('off', 'Passwords and IDs is not available for this account.');
        const run = await deps.getRun(user.userId, body.runId).catch(() => null);
        const asked = run?.next?.allow;
        if (
          !run ||
          run.state !== 'handed_off' ||
          run.next?.kind !== ALLOW_SECURE_NEXT_KIND ||
          asked?.itemId !== body.itemId ||
          asked?.site !== body.site ||
          run.next?.allowAnswer
        )
          return json({ ok: false, code: 'closed', error: 'This question is not open any more.' }, 409);
        if (body.scope !== 'deny' && !(await deps.identityChecked())) return verifyIdentityResponse();
        // The first answer wins: a second tap or a second device changes nothing.
        if (!(await deps.answerAllow(user.userId, body.runId, body.scope)))
          return json({ ok: false, code: 'closed', error: 'This question is not open any more.' }, 409);
        const where = { userId: user.userId, itemId: body.itemId, site: body.site };
        if (body.scope === 'once') {
          const granted = await deps.grantOnce({ ...where, workId: run.workId, stepKey: run.stepKey });
          if (!granted?.granted) throw new SecureStoreError('not_found', 'This item is not saved any more.');
        } else if (body.scope === 'always') {
          await deps.addSite(where);
        }
        await deps.recordSecureUse({
          ...where,
          host: asked.host,
          workId: run.workId,
          runId: body.runId,
          outcome:
            body.scope === 'once' ? 'allowed_once' : body.scope === 'always' ? 'allowed_always' : 'denied',
        });
        const resumed = await deps.resumeStepRun({
          userId: user.userId,
          workId: run.workId,
          runId: body.runId,
          note: allowNote(body.scope, asked.itemLabel, body.site),
        });
        return json({ ok: true, runId: resumed.runId });
      } catch (error) {
        return failure(error, 'The answer was not saved.');
      }
    },
  };
}
