/** Explicit real-account acceptance check. Never changes source consent or AI settings. */
import { getFunctionName } from 'convex/server';
import { generateTextForCurrentUser, resolveAiRuntime } from '../lib/ai/gateway';
import { api, convexMutation, convexQuery } from '../lib/hosted/convex';
import { __setNarrativeDepsForTest, refreshNarrative } from '../lib/narrative/service';

if (
  process.env.NEXT_PUBLIC_CONVEX_URL !== 'https://precise-skunk-847.convex.cloud' ||
  process.env.RAILWAY_ENVIRONMENT_ID !== 'be41491e-6d1b-45f7-b85a-299540ac125e'
)
  throw new Error('Real-account acceptance is staging-only');
const users = (process.env.LAB86_NARRATIVE_USER_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
if (users.length !== 1) throw new Error('Select one verified staging pilot before running acceptance');
const userId = users[0];
const before = await convexQuery<any>(api.narrative.status, { userId });
if (!before.settings.enabled) throw new Error('Existing narrative consent required');
const started = Date.now();
__setNarrativeDepsForTest({
  runtime: async (input) => {
    const runtime = await resolveAiRuntime(input);
    console.log(JSON.stringify({ phase: 'runtime', provider: runtime.provider, model: runtime.modelName }));
    return runtime;
  },
  mutation: (async (fn: any, args: any) => {
    try {
      return await convexMutation(fn, args);
    } catch (error: any) {
      console.log(
        JSON.stringify({ phase: 'mutation', function: getFunctionName(fn), errorName: error?.name }),
      );
      throw error;
    }
  }) as any,
  generate: (async (input: any) => {
    const at = Date.now();
    try {
      const result = await generateTextForCurrentUser(input);
      let output: any;
      try {
        output = result.output;
      } catch (error: any) {
        console.log(
          JSON.stringify({
            phase: input.feature,
            outputErrorName: error?.name,
            finishReason: result.finishReason,
            rawTextLength: result.text?.length,
            usage: result.totalUsage,
          }),
        );
        throw error;
      }
      console.log(
        JSON.stringify({
          phase: input.feature,
          ms: Date.now() - at,
          finishReason: result.finishReason,
          hasOutput: !!output,
          textLength: output?.text?.length,
          citations: output?.sourceIds?.length,
          usage: result.totalUsage,
        }),
      );
      return result;
    } catch (error: any) {
      console.log(
        JSON.stringify({
          phase: input.feature,
          ms: Date.now() - at,
          errorName: error?.name,
          causeName: error?.cause?.name,
          statusCode: error?.statusCode,
          finishReason: error?.finishReason,
          issues: error?.cause?.issues?.map((i: any) => ({
            code: i.code,
            path: i.path,
            maximum: i.maximum,
            minimum: i.minimum,
          })),
        }),
      );
      throw error;
    }
  }) as any,
});
try {
  const result = await refreshNarrative(userId, 'manual');
  const brief = await convexQuery<any>(api.narrative.brief, { userId });
  const after = await convexQuery<any>(api.narrative.status, { userId });
  if (JSON.stringify(before.settings.sources) !== JSON.stringify(after.settings.sources))
    throw new Error('Source choices changed during acceptance');
  console.log(
    JSON.stringify({
      result,
      ms: Date.now() - started,
      modelWritten: !!brief.entry?.model,
      textLength: brief.entry?.text?.length,
      sourceCount: brief.entry?.sourceIds?.length,
    }),
  );
  if (result.status !== 'ready' || !brief.entry?.model) process.exitCode = 1;
} finally {
  __setNarrativeDepsForTest();
}
