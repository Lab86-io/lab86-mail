import { after, type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { api, convexMutation, convexQuery } from '@/lib/hosted/convex';
import { narrativeEnabled, readNarrative, refreshNarrative, searchNarrative } from '@/lib/narrative/service';
import { enforceUserRateLimit, RateLimitError, rateLimitJson } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;
const functions = (api as any).narrative;
const level = z.enum(['observation', 'day', 'week', 'month', 'thread']);
const command = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('configure'),
    enabled: z.boolean(),
    sources: z.array(z.string().max(240)).max(40),
    timezone: z.string().max(100),
    model: z.enum(['current', 'z-ai/glm-5.3-flash']),
  }),
  z.object({ action: z.literal('refresh') }),
  z
    .object({
      action: z.literal('edit'),
      id: z.string(),
      text: z.string().trim().min(1).max(4000).optional(),
      pinned: z.boolean().optional(),
    })
    .refine((input) => input.text !== undefined || input.pinned !== undefined),
  z.object({ action: z.literal('forget'), id: z.string() }),
  z.object({ action: z.literal('erase'), confirmation: z.literal('forget narrative') }),
]);
function errorResponse(error: unknown) {
  if (error instanceof RateLimitError) return rateLimitJson(error);
  if (error instanceof AuthRequiredError)
    return NextResponse.json({ error: 'Sign in required.' }, { status: 401 });
  if (error instanceof z.ZodError || error instanceof SyntaxError)
    return NextResponse.json({ error: 'Invalid narrative request.' }, { status: 400 });
  console.error('[narrative]', error);
  return NextResponse.json(
    { error: 'Narrative is temporarily unavailable. Your existing memory has not been replaced.' },
    { status: 500 },
  );
}
export function createNarrativeRoutes(
  overrides: Partial<{
    requireCurrentUser: typeof requireCurrentUser;
    enabled: typeof narrativeEnabled;
    query: typeof convexQuery;
    mutation: typeof convexMutation;
    read: typeof readNarrative;
    search: typeof searchNarrative;
    refresh: typeof refreshNarrative;
    after: typeof after;
    rateLimit: typeof enforceUserRateLimit;
  }> = {},
) {
  const deps = {
    requireCurrentUser,
    enabled: narrativeEnabled,
    query: convexQuery,
    mutation: convexMutation,
    read: readNarrative,
    search: searchNarrative,
    refresh: refreshNarrative,
    after,
    rateLimit: enforceUserRateLimit,
    ...overrides,
  };
  async function GET(req: NextRequest) {
    try {
      const user = await deps.requireCurrentUser();
      if (!deps.enabled(user.userId))
        return NextResponse.json({ available: false, entries: [], enabled: false });
      const params = req.nextUrl.searchParams;
      if (params.get('op') === 'brief')
        return NextResponse.json({
          available: true,
          ...(await deps.query<any>(functions.brief, {
            userId: user.userId,
            at: params.get('at') ? z.coerce.number().finite().parse(params.get('at')) : undefined,
          })),
        });
      if (params.get('id'))
        return NextResponse.json({
          available: true,
          ...(await deps.read(user.userId, params.get('id')!, params.get('sources') === 'true')),
        });
      if (params.get('op') === 'status')
        return NextResponse.json({
          available: true,
          ...(await deps.query<any>(functions.status, { userId: user.userId })),
        });
      const parsedLevel = params.get('level') ? level.parse(params.get('level')) : undefined;
      return NextResponse.json({
        available: true,
        ...(await deps.search(user.userId, {
          query: (params.get('q') || '').slice(0, 300),
          topic: params.get('topic') || undefined,
          level: parsedLevel,
          limit: 30,
        })),
      });
    } catch (error) {
      return errorResponse(error);
    }
  }
  async function POST(req: NextRequest) {
    try {
      const user = await deps.requireCurrentUser();
      if (!deps.enabled(user.userId))
        return NextResponse.json({ error: 'Narrative is not enabled for this account.' }, { status: 403 });
      await deps.rateLimit({ userId: user.userId, key: 'narrative-write', limit: 30, windowMs: 60_000 });
      const input = command.parse(await req.json());
      if (input.action === 'configure') {
        const { action: _, ...preferences } = input;
        const state = await deps.query<any>(functions.status, { userId: user.userId });
        const sources = new Set(state.sources.map((source: any) => source.id));
        if (input.sources.some((source) => !sources.has(source)))
          return NextResponse.json({ error: 'Choose only your available sources.' }, { status: 400 });
        try {
          new Intl.DateTimeFormat('en', { timeZone: input.timezone });
        } catch {
          return NextResponse.json({ error: 'Choose a valid timezone.' }, { status: 400 });
        }
        await deps.mutation(functions.configure, { userId: user.userId, ...preferences });
        if (input.enabled) deps.after(() => deps.refresh(user.userId).then(() => undefined));
        return NextResponse.json({ ok: true });
      }
      if (input.action === 'refresh') {
        deps.after(() => deps.refresh(user.userId, 'manual').then(() => undefined));
        return NextResponse.json({ ok: true, status: 'queued' }, { status: 202 });
      }
      if (input.action === 'erase')
        return NextResponse.json(await deps.mutation(functions.erase, { userId: user.userId }));
      return NextResponse.json(
        await deps.mutation(functions.edit, {
          userId: user.userId,
          id: input.id,
          ...(input.action === 'forget' ? { forget: true } : { text: input.text, pinned: input.pinned }),
        }),
      );
    } catch (error) {
      return errorResponse(error);
    }
  }
  return { GET, POST };
}
export const { GET, POST } = createNarrativeRoutes();
