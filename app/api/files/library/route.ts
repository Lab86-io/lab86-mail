import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { api, convexQuery } from '@/lib/hosted/convex';
import { enforceUserRateLimit, RateLimitError, rateLimitJson } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';
const inputSchema = z.object({
  kind: z.enum(['documents', 'uploads']),
  cursor: z.string().max(16000).optional(),
  search: z.string().max(200).optional(),
});
const defaults = {
  user: requireCurrentUser,
  rate: enforceUserRateLimit,
  page: (args: z.infer<typeof inputSchema> & { userId: string }) => convexQuery(api.fileLibrary.page, args),
};
export function createFileLibraryGet(deps = defaults) {
  return async (req: NextRequest) => {
    try {
      const user = await deps.user();
      await deps.rate({ userId: user.userId, key: 'file-library', limit: 120, windowMs: 60000 });
      const input = inputSchema.parse(Object.fromEntries(req.nextUrl.searchParams));
      const page = await deps.page({ ...input, userId: user.userId });
      return NextResponse.json(
        { ok: true, ...(page as object) },
        { headers: { 'cache-control': 'private, no-store' } },
      );
    } catch (error) {
      if (error instanceof AuthRequiredError)
        return NextResponse.json({ ok: false, error: 'Sign in required.' }, { status: 401 });
      if (error instanceof RateLimitError) return rateLimitJson(error);
      if (error instanceof z.ZodError)
        return NextResponse.json({ ok: false, error: 'Invalid file query.' }, { status: 400 });
      return NextResponse.json(
        { ok: false, error: 'Could not load your file library. Please retry.' },
        { status: 503 },
      );
    }
  };
}
export const GET = createFileLibraryGet();
