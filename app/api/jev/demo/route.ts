import { NextRequest, NextResponse } from 'next/server';
import { runWithAiRequestContext } from '@/lib/ai/context';
import { recordJevUsage, resolveJevRuntime } from '@/lib/ai/gateway';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { evaluateJev, type JevResponse } from '@/lib/jev/client';
import { demoMailInput, demoResult, jevDemoInputSchema } from '@/lib/jev/demo';
import { buildMailQuestions } from '@/lib/jev/mail';
import { loadJevPolicy } from '@/lib/jev/service';
import { enforceUserRateLimit, RateLimitError, rateLimitJson } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const defaults = {
  requireCurrentUser,
  runWithAiRequestContext,
  resolveJevRuntime,
  recordJevUsage,
  evaluateJev,
  loadJevPolicy,
  enforceUserRateLimit,
};
export function createJevDemoRoute(deps = defaults) {
  return async function POST(request: NextRequest) {
    const user = await deps.requireCurrentUser().catch((error) => {
      if (error instanceof AuthRequiredError) return null;
      throw error;
    });
    if (!user) return NextResponse.json({ error: 'Sign in required.' }, { status: 401 });
    const parsed = jevDemoInputSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success)
      return NextResponse.json(
        { error: 'Enter a sender, subject, and message of up to 2,400 characters.' },
        { status: 400 },
      );
    try {
      await deps.enforceUserRateLimit({ userId: user.userId, key: 'jev:demo', limit: 10, windowMs: 60_000 });
      return await deps.runWithAiRequestContext({ userId: user.userId, agent: 'ai' }, async () => {
        const policy = await deps.loadJevPolicy(user.userId);
        const resolved = await deps.resolveJevRuntime(user.userId);
        const input = demoMailInput(parsed.data, Date.now());
        const start = performance.now();
        let response: JevResponse;
        try {
          response = await deps.evaluateJev({
            apiKey: resolved.apiKey,
            state: {
              mailboxOwnerAddresses: input.selfAddresses,
              messagesOldestToNewest: input.messages,
              contextComplete: true,
            },
            questions: buildMailQuestions(input),
            signal: request.signal,
          });
        } catch (error) {
          await deps.recordJevUsage(resolved, 'jev_demo');
          throw error;
        }
        const inferenceMs = Math.round(performance.now() - start);
        await deps.recordJevUsage(resolved, 'jev_demo', response);
        return NextResponse.json(
          { ok: true, ...demoResult(input, response, policy.preferences, inferenceMs, Date.now()) },
          { headers: { 'Cache-Control': 'no-store' } },
        );
      });
    } catch (error) {
      if (error instanceof RateLimitError) return rateLimitJson(error);
      return NextResponse.json(
        { error: 'Jev could not classify this example. Check your connection and try again.' },
        { status: 503 },
      );
    }
  };
}
export const POST = createJevDemoRoute();
