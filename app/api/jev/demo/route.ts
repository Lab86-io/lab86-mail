import { NextRequest, NextResponse } from 'next/server';
import { runWithAiRequestContext } from '@/lib/ai/context';
import { recordJevUsage, resolveJevRuntime } from '@/lib/ai/gateway';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { OfficeError, readOfficeRequest } from '@/lib/documents/office-security';
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
    try {
      await deps.enforceUserRateLimit({ userId: user.userId, key: 'jev:demo', limit: 10, windowMs: 60_000 });
      let body: unknown;
      try {
        // Reuse the bounded stream reader: character limits apply only after JSON parsing.
        body = JSON.parse((await readOfficeRequest(request, 32 * 1024)).toString('utf8'));
      } catch (error) {
        if (error instanceof OfficeError && error.status === 413)
          return NextResponse.json(
            { error: 'The example is too large. Use a shorter message.' },
            { status: 413 },
          );
        return NextResponse.json({ error: 'The example could not be read.' }, { status: 400 });
      }
      const parsed = jevDemoInputSchema.safeParse(body);
      if (!parsed.success)
        return NextResponse.json(
          { error: 'Enter a sender, subject, and message of up to 2,400 characters.' },
          { status: 400 },
        );
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
      console.warn(
        '[jev] demonstration classification failed',
        error instanceof Error ? error.name : 'unknown',
      );
      return NextResponse.json(
        { error: 'Jev could not classify this example. Check your connection and try again.' },
        { status: 503 },
      );
    }
  };
}
export const POST = createJevDemoRoute();
