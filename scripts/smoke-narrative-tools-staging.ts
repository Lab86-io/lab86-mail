/** Synthetic-only integration check against staging memory and a live model.
 * The calendar record is a fixture, not a provider mutation. No email is sent.
 */
import { randomUUID } from 'node:crypto';
import { createOpenAI } from '@ai-sdk/openai';
import { generateText } from 'ai';
import { api, convexMutation, convexQuery } from '../lib/hosted/convex';
import { prepareNarrativeMeeting } from '../lib/narrative/meeting-prep';
import { getNarrativeTaskContext } from '../lib/narrative/service';

if (
  process.env.NEXT_PUBLIC_CONVEX_URL !== 'https://precise-skunk-847.convex.cloud' ||
  process.env.RAILWAY_ENVIRONMENT_ID !== 'be41491e-6d1b-45f7-b85a-299540ac125e'
)
  throw new Error('This smoke is staging-only');
if (!process.env.OPENROUTER_API_KEY) throw new Error('OpenRouter key missing');
const userId = `narrative-tools-smoke-${randomUUID()}`;
process.env.LAB86_NARRATIVE_ENABLED = 'true';
process.env.LAB86_NARRATIVE_USER_IDS = userId;
const assert = (value: unknown, message: string) => {
  if (!value) throw new Error(message);
};
const model = createOpenAI({
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: 'https://openrouter.ai/api/v1',
}).chat('z-ai/glm-5.3-flash');
const f = api.narrative;
const event = { title: 'Planning', startAt: Date.now() + 86400000, endAt: Date.now() + 88200000 };
const failures: unknown[] = [];
try {
  await convexMutation(f.configure, {
    userId,
    enabled: true,
    sources: ['chat'],
    timezone: 'UTC',
    model: 'current',
  });
  const selected = await convexMutation<string>(f.captureTurn, {
    userId,
    messageId: 'atlas-decision',
    text: 'Synthetic fixture: In the Granola Atlas planning notes, Alex and Sam agreed to wait for QA before launching. Keyboard testing is reported complete; screen-reader verification is still open.',
    topics: ['event:synthetic:atlas'],
  });
  const excluded = await convexMutation<string>(f.captureTurn, {
    userId,
    messageId: 'unrelated',
    text: 'Synthetic fixture: private unrelated medical appointment. Never include this in an Atlas email.',
    topics: ['private:unrelated'],
  });
  const context = await getNarrativeTaskContext(userId, {
    purpose: 'meeting',
    query: 'planning',
    topic: 'event:synthetic:atlas',
  });
  assert(
    context.evidence.some((entry) => entry.id === selected),
    'Relevant evidence missing',
  );
  const draft = await getNarrativeTaskContext(userId, { purpose: 'compose', evidenceIds: [selected] });
  assert(
    draft.evidence.length === 1 && draft.evidence[0].id === selected,
    'Draft selection expanded unexpectedly',
  );
  assert(!draft.evidence.some((entry) => entry.id === excluded), 'Unselected context leaked');
  const result = await prepareNarrativeMeeting(
    userId,
    { accountId: 'synthetic', calendarId: 'synthetic', eventId: 'atlas' },
    undefined,
    {
      event: async () => event,
      context: getNarrativeTaskContext,
      generate: (async ({ userId: _user, feature: _feature, speed: _speed, ...options }: any) =>
        generateText({ ...options, model })) as any,
    },
  );
  assert(result.points.length > 0, 'Meeting preparation is empty');
  assert(
    result.points.every((point) =>
      point.sourceIds.every((id) => result.context.evidence.some((entry) => entry.id === id)),
    ),
    'Unresolved meeting citation',
  );
  await convexMutation(f.edit, {
    userId,
    id: selected,
    text: 'Synthetic correction: no launch approval; QA is still open.',
  });
  const corrected = await getNarrativeTaskContext(userId, { purpose: 'compose', evidenceIds: [selected] });
  assert(
    corrected.evidence[0]?.text.includes('no launch approval'),
    'Correction not applied to task context',
  );
  console.log(
    JSON.stringify({
      status: 'passed',
      meetingMode: result.mode,
      evidenceCount: result.context.evidence.length,
      checks: ['owned retrieval', 'explicit draft selection', 'cited meeting prep', 'correction visibility'],
      fixture: 'synthetic calendar and narrative; deployed Convex; live GLM generation',
    }),
  );
} catch (error) {
  failures.push(error);
} finally {
  try {
    await convexMutation(f.erase, { userId });
    const cleared = await convexQuery<any>(f.search, { userId });
    assert(!cleared.enabled && cleared.entries.length === 0, 'Synthetic memory was not revoked');
    console.log('Synthetic memory revoked; bounded cleanup scheduled. Real accounts unchanged.');
  } catch (cleanupError) {
    failures.push(cleanupError);
  }
}
if (failures.length) throw new AggregateError(failures, `Synthetic verification failed for ${userId}`);
