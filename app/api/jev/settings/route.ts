import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { runWithAiRequestContext } from '@/lib/ai/context';
import { resolveJevRuntime } from '@/lib/ai/gateway';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { readOfficeRequest } from '@/lib/documents/office-security';
import { api, convexMutation, convexQuery } from '@/lib/hosted/convex';
import {
  JEV_MODEL,
  JEV_QUESTION_VERSION,
  jevCorrectionSchema,
  jevPreferencesSchema,
} from '@/lib/jev/contract';
import { kickLlmClassification } from '@/lib/mail/llm-classify';
import { enforceUserRateLimit, RateLimitError, rateLimitJson } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const inputSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('save'),
      preferences: jevPreferencesSchema,
      corrections: z.array(jevCorrectionSchema).max(100),
      revision: z.number().int().nonnegative(),
    })
    .strict(),
  z.object({ action: z.literal('reprocess') }).strict(),
]);
const defaults = {
  requireCurrentUser,
  convexQuery,
  convexMutation,
  resolveJevRuntime,
  runWithAiRequestContext,
  enforceUserRateLimit,
  kickLlmClassification,
};
export function createJevSettingsRoutes(dependencies = defaults) {
  const {
    requireCurrentUser,
    convexQuery,
    convexMutation,
    resolveJevRuntime,
    runWithAiRequestContext,
    enforceUserRateLimit,
    kickLlmClassification,
  } = dependencies;
  async function currentUser() {
    return requireCurrentUser().catch((error) => {
      if (error instanceof AuthRequiredError) return null;
      throw error;
    });
  }
  async function GET() {
    const user = await currentUser();
    if (!user) return NextResponse.json({ error: 'Sign in required.' }, { status: 401 });
    const state = await convexQuery<any>((api as any).jev.settings, { userId: user.userId });
    const availability = await runWithAiRequestContext({ userId: user.userId, agent: 'ai' }, async () => {
      try {
        await resolveJevRuntime(user.userId);
        return { configured: true, configurationMessage: null };
      } catch (error) {
        return {
          configured: false,
          configurationMessage: error instanceof Error ? error.message : 'Jev is unavailable.',
        };
      }
    });
    return NextResponse.json({
      ok: true,
      ...state,
      ...availability,
      model: JEV_MODEL,
      questionVersion: JEV_QUESTION_VERSION,
    });
  }
  async function POST(request: NextRequest) {
    const user = await currentUser();
    if (!user) return NextResponse.json({ error: 'Sign in required.' }, { status: 401 });
    try {
      await enforceUserRateLimit({
        userId: user.userId,
        key: 'jev:settings:input',
        limit: 30,
        windowMs: 60_000,
      });
      const body = await readOfficeRequest(request, 64 * 1024)
        .then((bytes) => JSON.parse(bytes.toString('utf8')))
        .catch(() => null);
      const parsed = inputSchema.safeParse(body);
      if (!parsed.success) return NextResponse.json({ error: 'Invalid Jev settings.' }, { status: 400 });
      await enforceUserRateLimit({
        userId: user.userId,
        key: `jev:${parsed.data.action}`,
        limit: parsed.data.action === 'reprocess' ? 1 : 30,
        windowMs: 60_000,
      });
      if (parsed.data.action === 'reprocess') {
        await convexMutation((api as any).jev.reprocess, { userId: user.userId });
        kickLlmClassification(user.userId, 2_000);
        return NextResponse.json({ ok: true, queued: true });
      }
      const state = await convexMutation((api as any).jev.saveSettings, {
        userId: user.userId,
        preferences: parsed.data.preferences,
        corrections: parsed.data.corrections,
        revision: parsed.data.revision,
      });
      return NextResponse.json({ ok: true, ...(state as object) });
    } catch (error) {
      if (error instanceof RateLimitError) return rateLimitJson(error);
      if (error instanceof Error && error.message.includes('JEV_SETTINGS_CONFLICT'))
        return NextResponse.json(
          { error: 'These settings changed in another window. Reload and try again.' },
          { status: 409 },
        );
      return NextResponse.json({ error: 'Jev settings could not be saved. Try again.' }, { status: 503 });
    }
  }

  return { GET, POST };
}
export const { GET, POST } = createJevSettingsRoutes();
