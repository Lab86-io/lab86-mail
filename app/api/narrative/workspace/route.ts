import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import {
  loadNarrativeWorkspace,
  saveWorkspaceFeedback,
  WorkspaceError,
} from '@/lib/narrative/workspace-service';
import { enforceUserRateLimit, RateLimitError, rateLimitJson } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
const atSchema = z.coerce.number().int().min(0).max(8_640_000_000_000_000);
const feedback = z
  .object({
    action: z.enum(['defer', 'correct']),
    at: atSchema,
    stamp: z.string().length(64),
    sourceIds: z.array(z.string().min(1).max(200)).min(1).max(4),
    note: z.string().trim().min(1).max(1000).optional(),
  })
  .strict()
  .refine((v) => v.action !== 'correct' || !!v.note);
const command = z.union([z.object({ action: z.literal('generate'), at: atSchema }).strict(), feedback]);
const defaults = {
  user: requireCurrentUser,
  load: loadNarrativeWorkspace,
  feedback: saveWorkspaceFeedback,
  rate: enforceUserRateLimit,
};
export function createWorkspaceRoutes(deps = defaults) {
  const handle = (write: boolean) => async (request: NextRequest) => {
    try {
      const user = await deps.user();
      await deps.rate({
        userId: user.userId,
        key: `narrative-workspace-${write ? 'write' : 'read'}`,
        limit: write ? 12 : 60,
        windowMs: 60_000,
      });
      const input = write
        ? command.parse(await request.json())
        : {
            action: 'read' as const,
            at: atSchema.parse(request.nextUrl.searchParams.get('at') || undefined),
          };
      const result =
        input.action === 'defer' || input.action === 'correct'
          ? await deps.feedback(user.userId, input)
          : await deps.load(user.userId, input.at, input.action === 'generate', request.signal);
      return NextResponse.json(result, { headers: { 'cache-control': 'private, no-store' } });
    } catch (error) {
      if (error instanceof AuthRequiredError)
        return NextResponse.json({ error: 'Sign in required.' }, { status: 401 });
      if (error instanceof RateLimitError) return rateLimitJson(error);
      if (error instanceof z.ZodError || error instanceof SyntaxError)
        return NextResponse.json({ error: 'Invalid workspace request.' }, { status: 400 });
      if (error instanceof WorkspaceError)
        return NextResponse.json({ error: error.message }, { status: error.status });
      return NextResponse.json(
        { error: 'Today’s workspace is unavailable. Your brief and work are unchanged.' },
        { status: 503 },
      );
    }
  };
  return { GET: handle(false), POST: handle(true) };
}
export const { GET, POST } = createWorkspaceRoutes();
