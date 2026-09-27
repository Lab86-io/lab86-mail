import { z } from 'zod';
import { AuthRequiredError, requireCurrentUser } from '../auth/current-user';
import { OfficeError, readOfficeRequest } from '../documents/office-security';
import { api, convexMutation, convexQuery } from '../hosted/convex';
import { enforceUserRateLimit, RateLimitError, rateLimitResponse } from '../rate-limit';
import { contentExcerpt } from './contract';
import { searchContent } from './intelligence';
import { kickContentCycle } from './sync';

const operations = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('preferences'), enabled: z.boolean(), prepare: z.boolean() }).strict(),
  z.object({ operation: z.literal('sync') }).strict(),
  z
    .object({
      operation: z.enum(['edit', 'dismiss', 'refresh', 'adopt']),
      id: z.string().min(1).max(100),
      revision: z.number().int().nonnegative(),
      notes: z.string().max(10_000).optional(),
      files: z
        .array(z.object({ name: z.string().min(1).max(120), content: z.string().max(30_000) }))
        .max(3)
        .optional(),
    })
    .strict(),
]);
const defaults = {
  requireCurrentUser,
  convexQuery,
  convexMutation,
  searchContent,
  kickContentCycle,
  enforceUserRateLimit,
};
function failure(error: unknown) {
  if (error instanceof AuthRequiredError)
    return Response.json({ error: 'Sign in required.' }, { status: 401 });
  if (error instanceof RateLimitError) return rateLimitResponse(error);
  if (error instanceof OfficeError)
    return Response.json({ error: 'Request is too large.' }, { status: error.status });
  if (error instanceof SyntaxError || error instanceof z.ZodError)
    return Response.json({ error: 'Invalid request.' }, { status: 400 });
  if (
    error instanceof Error &&
    /PREPARATION_CONFLICT|Refresh this preparation|Related work is no longer/.test(error.message)
  )
    return Response.json(
      { error: 'This preparation changed. Refresh it before continuing.' },
      { status: 409 },
    );
  return Response.json({ error: 'Connected content is unavailable. Please retry.' }, { status: 503 });
}
export function contentRoutes(deps = defaults) {
  return {
    GET: async (request: Request) => {
      try {
        const user = await deps.requireCurrentUser();
        const params = new URL(request.url).searchParams;
        const view = params.get('view') || 'settings';
        if (!['settings', 'brief', 'search'].includes(view))
          return Response.json({ error: 'Unknown view.' }, { status: 400 });
        await deps.enforceUserRateLimit({
          userId: user.userId,
          key: `content-${view}`,
          limit: 90,
          windowMs: 60_000,
        });
        let data: any;
        if (view === 'search') {
          const query = params.get('q')?.trim() || '';
          if (query.length < 2 || query.length > 200)
            return Response.json({ error: 'Search requires 2–200 characters.' }, { status: 400 });
          data = await deps.searchContent(user.userId, query, {
            semantic: params.get('semantic') === 'true',
            signal: request.signal,
          });
          data.items = data.items.map((item: any) => ({
            ...item,
            text: contentExcerpt(item.matchedText || item.text, query),
          }));
        } else
          data =
            view === 'brief'
              ? {
                  items: await deps.convexQuery(api.briefPreparations.list, { userId: user.userId }),
                }
              : await deps.convexQuery(api.content.settings, { userId: user.userId });
        return Response.json(data, { headers: { 'Cache-Control': 'private, no-store' } });
      } catch (error) {
        return failure(error);
      }
    },
    POST: async (request: Request) => {
      try {
        const user = await deps.requireCurrentUser();
        await deps.enforceUserRateLimit({
          userId: user.userId,
          key: 'content-write',
          limit: 20,
          windowMs: 60_000,
        });
        const input = operations.parse(
          JSON.parse((await readOfficeRequest(request, 320_000)).toString('utf8')),
        );
        let result: unknown = { queued: true };
        if (input.operation === 'preferences')
          result = await deps.convexMutation(api.content.savePreferences, {
            userId: user.userId,
            enabled: input.enabled,
            prepare: input.prepare,
          });
        else if (input.operation !== 'sync')
          result = await deps.convexMutation(api.briefPreparations.update, {
            ...input,
            userId: user.userId,
          });
        if (input.operation !== 'dismiss' && input.operation !== 'adopt') deps.kickContentCycle(user.userId);
        return Response.json({ ok: true, result }, { headers: { 'Cache-Control': 'private, no-store' } });
      } catch (error) {
        return failure(error);
      }
    },
  };
}
