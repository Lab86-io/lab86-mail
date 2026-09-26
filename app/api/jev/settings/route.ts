import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { runWithAiRequestContext } from '@/lib/ai/context';
import { resolveClassifierRuntime } from '@/lib/ai/gateway';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { CLASSIFIER_MODELS, classifierById, resolveClassifier } from '@/lib/classifier/catalog';
import { loadClassifierSelection, saveClassifierSelection } from '@/lib/classifier/selection';
import { readOfficeRequest } from '@/lib/documents/office-security';
import { getAiBillingEntitlement } from '@/lib/hosted/billing';
import { api, convexMutation, convexQuery } from '@/lib/hosted/convex';
import { JEV_QUESTION_VERSION, jevCorrectionSchema, jevPreferencesSchema } from '@/lib/jev/contract';
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
  z
    .object({
      action: z.literal('selectClassifier'),
      classifierId: z.string().min(1).max(100),
      revision: z.number().int().nonnegative(),
    })
    .strict(),
]);
/** Whether the deployment holds the platform key a classifier needs. Never exposes the key. */
function platformKeyConfigured(credential: 'openrouter' | 'together', env = process.env) {
  return Boolean(credential === 'together' ? env.TOGETHER_API_KEY : env.OPENROUTER_API_KEY);
}
const defaults = {
  requireCurrentUser,
  convexQuery,
  convexMutation,
  resolveClassifierRuntime,
  runWithAiRequestContext,
  enforceUserRateLimit,
  kickLlmClassification,
  getAiBillingEntitlement,
  loadClassifierSelection,
  saveClassifierSelection,
  platformKeyConfigured,
};
export function createJevSettingsRoutes(dependencies = defaults) {
  const {
    requireCurrentUser,
    convexQuery,
    convexMutation,
    resolveClassifierRuntime,
    runWithAiRequestContext,
    enforceUserRateLimit,
    kickLlmClassification,
    getAiBillingEntitlement,
    loadClassifierSelection,
    saveClassifierSelection,
    platformKeyConfigured,
  } = dependencies;
  // The classifier is a deployment-wide choice; only Clerk admin-plan operators may change it.
  const isOperator = () =>
    getAiBillingEntitlement()
      .then((entitlement) => entitlement.plan === 'admin')
      .catch(() => false);
  async function currentUser() {
    return requireCurrentUser().catch((error) => {
      if (error instanceof AuthRequiredError) return null;
      throw error;
    });
  }
  async function GET() {
    const user = await currentUser();
    if (!user) return NextResponse.json({ error: 'Sign in required.' }, { status: 401 });
    const [state, selection, canChange] = await Promise.all([
      convexQuery<any>(api.jev.settings, { userId: user.userId }),
      loadClassifierSelection(),
      isOperator(),
    ]);
    const selected = resolveClassifier(selection.classifierId);
    const availability = await runWithAiRequestContext({ userId: user.userId, agent: 'ai' }, async () => {
      try {
        await resolveClassifierRuntime(user.userId);
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
      model: selected.label,
      questionVersion: JEV_QUESTION_VERSION,
      classifier: {
        selectedId: selected.id,
        revision: selection.revision,
        canChange,
        options: CLASSIFIER_MODELS.map((model) => ({
          id: model.id,
          label: model.label,
          vendor: model.vendor,
          description: model.description,
          status: model.status,
          configured: platformKeyConfigured(model.credential),
        })),
      },
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
      if (parsed.data.action === 'selectClassifier') {
        if (!(await isOperator()))
          return NextResponse.json(
            { error: 'Only a deployment operator can change the classifier.' },
            { status: 403 },
          );
        const model = classifierById(parsed.data.classifierId);
        if (!model) return NextResponse.json({ error: 'Unknown classifier.' }, { status: 400 });
        if (!platformKeyConfigured(model.credential))
          return NextResponse.json(
            { error: `${model.label} is not configured for this deployment.` },
            { status: 400 },
          );
        const result = await saveClassifierSelection({
          classifierId: model.id,
          revision: parsed.data.revision,
          updatedBy: user.userId,
        });
        if (result.requeued) kickLlmClassification(user.userId, 2_000);
        return NextResponse.json({ ok: true, classifier: result });
      }
      if (parsed.data.action === 'reprocess') {
        await convexMutation(api.jev.reprocess, { userId: user.userId });
        kickLlmClassification(user.userId, 2_000);
        return NextResponse.json({ ok: true, queued: true });
      }
      const state = await convexMutation(api.jev.saveSettings, {
        userId: user.userId,
        preferences: parsed.data.preferences,
        corrections: parsed.data.corrections,
        revision: parsed.data.revision,
      });
      return NextResponse.json({ ok: true, ...(state as object) });
    } catch (error) {
      if (error instanceof RateLimitError) return rateLimitJson(error);
      if (error instanceof Error && error.message.includes('CLASSIFIER_SETTINGS_CONFLICT'))
        return NextResponse.json(
          { error: 'The classifier changed in another window. Reload and try again.' },
          { status: 409 },
        );
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
