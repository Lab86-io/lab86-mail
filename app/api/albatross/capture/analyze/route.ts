import type { NextRequest } from 'next/server';
import { generateTextForCurrentUser } from '@/lib/ai/gateway';
import { parseWorkSplit } from '@/lib/albatross/work-v2';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { enforceUserRateLimit, RateLimitError, rateLimitResponse } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface CaptureAnalyzeDependencies {
  requireCurrentUser: typeof requireCurrentUser;
  enforceUserRateLimit: typeof enforceUserRateLimit;
  generateTextForCurrentUser: typeof generateTextForCurrentUser;
  reportUnexpectedError: (error: unknown) => void;
}

const defaultDependencies: CaptureAnalyzeDependencies = {
  requireCurrentUser,
  enforceUserRateLimit,
  generateTextForCurrentUser,
  reportUnexpectedError: (error) => console.error('Capture analysis failed.', error),
};

export function createCaptureAnalyzePost(deps: CaptureAnalyzeDependencies = defaultDependencies) {
  return async function captureAnalyzePost(req: NextRequest) {
    try {
      const user = await deps.requireCurrentUser();
      await deps.enforceUserRateLimit({
        userId: user.userId,
        key: 'albatross-capture-analyze',
        limit: 30,
        windowMs: 60_000,
      });
      const body = await req.json().catch(() => ({}));
      const rawText = String(body?.rawText || '').trim();
      if (!rawText) return Response.json({ ok: false, error: 'rawText required' }, { status: 400 });
      const { text } = await deps.generateTextForCurrentUser({
        feature: 'albatross_capture_review',
        speed: 'fast',
        userId: user.userId,
        userEmail: user.email,
        userName: user.name,
        system: `Analyze one brain dump for independent desired outcomes.
Split only when parts can be completed, paused, or abandoned independently.
Preserve the user's exact meaning and important detail. Never invent goals.
Return JSON only: {"work":[{"title":string,"rawText":string}]}.`,
        prompt: rawText,
      });
      const split = parseWorkSplit(text, rawText);
      return Response.json({
        ok: true,
        work: split.work.map((item) => ({ title: item.title, rawText: item.rawText })),
      });
    } catch (error) {
      if (error instanceof RateLimitError) return rateLimitResponse(error);
      if (error instanceof AuthRequiredError) {
        return Response.json({ ok: false, error: error.message }, { status: 401 });
      }
      deps.reportUnexpectedError(error);
      return Response.json({ ok: false, error: 'Capture analysis failed.' }, { status: 500 });
    }
  };
}

export const POST = createCaptureAnalyzePost();
