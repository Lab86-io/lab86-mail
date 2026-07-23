import type { NextRequest } from 'next/server';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { api, convexQuery } from '@/lib/hosted/convex';
import {
  type BriefHydratedEntity,
  BriefQueryRequestSchema,
  BriefQueryResponseSchema,
} from '@/lib/shared/brief-hydration';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface BriefQueryDependencies {
  currentUser: typeof requireCurrentUser;
  query(args: {
    userId: string;
    name: string;
    areaId?: string;
    startAt: number;
    endAt: number;
    limit: number;
  }): Promise<BriefHydratedEntity[]>;
  now: () => Date;
}

const dependencies: BriefQueryDependencies = {
  currentUser: requireCurrentUser,
  query: (args) => convexQuery((api as any).mobile.queryBriefCatalog, args),
  now: () => new Date(),
};

export function briefQueryWindow(
  name: string,
  now: Date,
  timeZone: string,
): { startAt: number; endAt: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((entry) => entry.type === type)?.value);
  const localNoonUtc = Date.UTC(part('year'), part('month') - 1, part('day'), 12);
  const offsetText = new Intl.DateTimeFormat('en-US', {
    timeZone,
    timeZoneName: 'longOffset',
    hour: '2-digit',
  })
    .formatToParts(new Date(localNoonUtc))
    .find((entry) => entry.type === 'timeZoneName')?.value;
  const match = offsetText?.match(/GMT([+-])(\d{2}):(\d{2})/);
  const offset = match
    ? (match[1] === '-' ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3])) * 60_000
    : 0;
  const startAt = Date.UTC(part('year'), part('month') - 1, part('day')) - offset;
  const days = name === 'events_next_7d' ? 7 : 1;
  return { startAt, endAt: startAt + days * 86_400_000 };
}

export function createBriefQueryPost(deps: BriefQueryDependencies = dependencies) {
  return async function briefQueryPost(request: NextRequest) {
    try {
      const user = await deps.currentUser();
      const parsed = BriefQueryRequestSchema.safeParse(await request.json());
      if (!parsed.success) {
        return Response.json({ ok: false, error: 'Invalid brief query.' }, { status: 400 });
      }
      const timeZone = request.headers.get('x-user-timezone') || 'UTC';
      let window: { startAt: number; endAt: number };
      try {
        window = briefQueryWindow(parsed.data.query.name, deps.now(), timeZone);
      } catch {
        window = briefQueryWindow(parsed.data.query.name, deps.now(), 'UTC');
      }
      const items = await deps.query({
        userId: user.userId,
        name: parsed.data.query.name,
        ...(parsed.data.query.areaId ? { areaId: parsed.data.query.areaId } : {}),
        ...window,
        limit: parsed.data.limit,
      });
      return Response.json(
        BriefQueryResponseSchema.parse({
          ok: true,
          query: parsed.data.query,
          items,
          count: items.length,
        }),
      );
    } catch (error) {
      if (error instanceof AuthRequiredError) {
        return Response.json({ ok: false, error: error.message }, { status: 401 });
      }
      return Response.json({ ok: false, error: 'Brief query could not be loaded.' }, { status: 500 });
    }
  };
}

export const POST = createBriefQueryPost();
