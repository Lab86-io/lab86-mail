import type { NextRequest } from 'next/server';
import { commitWorkSplit, proposeWorkSplit, type SplitWorkChild } from '@/lib/albatross/split-work';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { enforceUserRateLimit, RateLimitError, rateLimitResponse } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

interface WorkSplitDependencies {
  requireCurrentUser: typeof requireCurrentUser;
  enforceUserRateLimit: typeof enforceUserRateLimit;
  proposeWorkSplit: typeof proposeWorkSplit;
  commitWorkSplit: typeof commitWorkSplit;
}

const defaults: WorkSplitDependencies = {
  requireCurrentUser,
  enforceUserRateLimit,
  proposeWorkSplit,
  commitWorkSplit,
};

function parsedItems(raw: unknown): SplitWorkChild[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 6).flatMap((item) => {
    const title = typeof item?.title === 'string' ? item.title.trim().slice(0, 180) : '';
    const rawText = typeof item?.rawText === 'string' ? item.rawText.trim().slice(0, 20_000) : '';
    return title && rawText ? [{ title, rawText }] : [];
  });
}

export function createWorkSplitPost(overrides: Partial<WorkSplitDependencies> = {}) {
  const deps: WorkSplitDependencies = { ...defaults, ...overrides };
  return async function POST(req: NextRequest, context: { params: Promise<{ workId: string }> }) {
    try {
      const user = await deps.requireCurrentUser();
      await deps.enforceUserRateLimit({
        userId: user.userId,
        key: 'albatross-work-split',
        limit: 10,
        windowMs: 60_000,
      });
      const { workId } = await context.params;
      const body = await req.json().catch(() => ({}));
      const mode = body?.mode === 'commit' ? 'commit' : 'propose';
      if (mode === 'propose') {
        const proposal = await deps.proposeWorkSplit({
          userId: user.userId,
          userEmail: user.email,
          userName: user.name,
          workId,
          focus: typeof body?.focus === 'string' ? body.focus.slice(0, 300) : undefined,
        });
        return Response.json({ ok: true, ...proposal });
      }
      const items = parsedItems(body?.items);
      if (items.length < 2) {
        return Response.json({ ok: false, error: 'A split needs at least 2 Works.' }, { status: 400 });
      }
      const committed = await deps.commitWorkSplit({
        userId: user.userId,
        userEmail: user.email,
        userName: user.name,
        workId,
        items,
        timezone: typeof body?.timezone === 'string' ? body.timezone : undefined,
      });
      return Response.json({ ok: true, ...committed });
    } catch (error) {
      if (error instanceof RateLimitError) return rateLimitResponse(error);
      const status = error instanceof AuthRequiredError ? 401 : 500;
      return Response.json(
        { ok: false, error: error instanceof Error ? error.message : 'The split failed.' },
        { status },
      );
    }
  };
}

export const POST = createWorkSplitPost();
