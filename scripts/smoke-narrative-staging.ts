/** Synthetic-only staging verification; never opts a real user into collection.
 * Run with the Railway development web environment injected.
 */
import { randomUUID } from 'node:crypto';
import { createOpenAI } from '@ai-sdk/openai';
import { generateText } from 'ai';
import { getFunctionName } from 'convex/server';
import { api, convexMutation, convexQuery } from '../lib/hosted/convex';
import { __setNarrativeDepsForTest, refreshNarrative } from '../lib/narrative/service';

if (
  process.env.NEXT_PUBLIC_CONVEX_URL !== 'https://precise-skunk-847.convex.cloud' ||
  process.env.RAILWAY_ENVIRONMENT_ID !== 'be41491e-6d1b-45f7-b85a-299540ac125e'
)
  throw new Error('This smoke only permits the verified staging environment');
if (!process.env.OPENROUTER_API_KEY) throw new Error('OpenRouter key missing');
const userId = `narrative-smoke-${randomUUID()}`;
const model = createOpenAI({
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: 'https://openrouter.ai/api/v1',
}).chat('z-ai/glm-5.3-flash');
process.env.LAB86_NARRATIVE_ENABLED = 'true';
process.env.LAB86_NARRATIVE_USER_IDS = userId;
// Exercise the deployed memory + actual research loop without provisioning
// a fake Clerk billing identity or altering any real user's AI preferences.
__setNarrativeDepsForTest({
  query: (async (fn: any, args: any) => {
    const name = getFunctionName(fn);
    try {
      const result = await convexQuery(fn, args);
      console.log('Synthetic query complete', name);
      return result;
    } catch (error) {
      console.error('Synthetic query failed', name);
      throw error;
    }
  }) as any,
  mutation: (async (fn: any, args: any) => {
    const name = getFunctionName(fn);
    try {
      const result = await convexMutation(fn, args);
      console.log('Synthetic mutation complete', name);
      return result;
    } catch (error) {
      console.error('Synthetic mutation failed', name);
      throw error;
    }
  }) as any,
  runtime: (async () => ({ modelName: 'z-ai/glm-5.3-flash', provider: 'openrouter' })) as any,
  generate: (async ({
    userId: _,
    feature: _feature,
    speed: _speed,
    narrativeModel: _narrativeModel,
    ...options
  }: any) => {
    try {
      const result = await generateText({ ...options, model });
      console.log('Synthetic model result', {
        finishReason: result.finishReason,
        text: result.text.slice(0, 1200),
        usage: result.totalUsage,
      });
      return result;
    } catch (error: any) {
      console.error('Synthetic model failure', {
        name: error?.name,
        message: error?.message,
        text: error?.text?.slice(0, 1200),
        cause: error?.cause?.message,
        usage: error?.usage,
      });
      throw error;
    }
  }) as any,
});
const f = api.narrative;
const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};
const failures: unknown[] = [];
try {
  await convexMutation(f.configure, {
    userId,
    enabled: true,
    sources: ['chat'],
    timezone: 'America/New_York',
    model: 'z-ai/glm-5.3-flash',
  });
  const observation = await convexMutation<string>(f.captureTurn, {
    userId,
    messageId: 'synthetic-plan',
    text: 'Synthetic test: I intend to finish QA before deploying. A merged PR is not a deployment. Preparing for the design review is still the priority.',
    topics: ['work:synthetic-review'],
  });
  const result = await refreshNarrative(userId, 'synthetic-smoke');
  const brief = await convexQuery<any>(f.brief, { userId });
  assert(result.status === 'ready', `Research did not finish: ${JSON.stringify(result)}`);
  assert(brief.entry?.model === 'z-ai/glm-5.3-flash', 'Brief was not model-written');
  assert(
    /design review/i.test(brief.entry.text) &&
      (/QA[^.!?]*before[^.!?]*deploy/i.test(brief.entry.text) ||
        /before[^.!?]*deploy[^.!?]*QA/i.test(brief.entry.text) ||
        /deploy[^.!?]*until[^.!?]*QA/i.test(brief.entry.text)),
    'Brief omitted the actual intention or its QA condition',
  );
  assert(brief.entry.sourceIds.includes(observation), 'Brief lost source provenance');
  const search = await convexQuery<any>(f.search, { userId, query: 'review' });
  assert(search.entries.length > 0, 'Deployed full-text search returned no evidence');
  const expanded = await convexQuery<any>(f.read, { userId, id: brief.entry._id, sources: true });
  assert(
    expanded.sources.some((s: any) => s._id === observation),
    'Source expansion failed',
  );
  await convexMutation(f.edit, {
    userId,
    id: observation,
    text: 'Synthetic correction: deployment is canceled; only prepare for the design review.',
  });
  assert((await convexQuery<any>(f.brief, { userId })).entry === null, 'Correction did not revoke old brief');
  console.log(
    JSON.stringify(
      {
        status: 'passed',
        model: brief.entry.model,
        usage: result,
        sourceCount: brief.entry.sourceIds.length,
        text: brief.entry.text,
        checks: [
          'research',
          'publication',
          'full-text search',
          'source expansion',
          'correction invalidation',
        ],
      },
      null,
      2,
    ),
  );
} catch (error) {
  failures.push(error);
} finally {
  try {
    await convexMutation(f.erase, { userId });
    const cleared = await convexQuery<any>(f.search, { userId });
    assert(!cleared.enabled && cleared.entries.length === 0, 'Synthetic memory was not revoked');
    console.log('Synthetic memory revoked; bounded cleanup scheduled. No real account was opted in.');
  } catch (cleanupError) {
    failures.push(cleanupError);
  } finally {
    __setNarrativeDepsForTest();
  }
}
if (failures.length) throw new AggregateError(failures, `Synthetic verification failed for ${userId}`);
