/** Synthetic-only history/retrieval acceptance. No external provider writes. */
import { randomUUID } from 'node:crypto';
import { createOpenAI } from '@ai-sdk/openai';
import { generateText } from 'ai';
import { api, convexMutation, convexQuery } from '../lib/hosted/convex';
import {
  __setNarrativeDepsForTest,
  getNarrativeTaskContext,
  refreshNarrative,
} from '../lib/narrative/service';

if (
  process.env.NEXT_PUBLIC_CONVEX_URL !== 'https://precise-skunk-847.convex.cloud' ||
  process.env.RAILWAY_ENVIRONMENT_ID !== 'be41491e-6d1b-45f7-b85a-299540ac125e'
)
  throw new Error('Staging-only check');
if (!process.env.OPENROUTER_API_KEY) throw new Error('OpenRouter key missing');
const userId = `narrative-spine-smoke-${randomUUID()}`;
process.env.LAB86_NARRATIVE_ENABLED = 'true';
process.env.LAB86_NARRATIVE_USER_IDS = userId;
const client = createOpenAI({
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: 'https://openrouter.ai/api/v1',
});
let semanticCalls = 0;
__setNarrativeDepsForTest({
  runtime: (async () => ({ modelName: 'z-ai/glm-5.3-flash', provider: 'openrouter' })) as any,
  generate: (async ({ userId: _, feature, speed: __, narrativeModel: ___, ...options }: any) => {
    const start = Date.now();
    const result = await generateText({
      ...options,
      model: client.chat(feature === 'narrative_retrieval' ? 'openai/gpt-5.6-luna' : 'z-ai/glm-5.3-flash'),
    });
    if (feature === 'narrative_retrieval') semanticCalls++;
    console.log(
      JSON.stringify({
        phase: feature,
        ms: Date.now() - start,
        finishReason: result.finishReason,
        usage: result.totalUsage,
      }),
    );
    return result;
  }) as any,
});
const f = api.narrative;
const assert = (value: unknown, message: string) => {
  if (!value) throw new Error(message);
};
const sources = ['granola', 'github'] as const;
const failures: unknown[] = [];
try {
  for (const server of sources)
    await convexMutation(api.mcp.upsertConnection, {
      userId,
      connectionId: `synthetic-${server}`,
      server,
      serverUrl: 'https://synthetic.invalid',
      authKind: 'token',
      displayName: 'Synthetic acceptance fixture',
    });
  await convexMutation(f.configure, {
    userId,
    enabled: true,
    sources: sources.map((server) => `mcp:synthetic-${server}`),
    timezone: 'UTC',
    model: 'z-ai/glm-5.3-flash',
  });
  const old = Date.now() - 180 * 86400000;
  const items = Array.from({ length: 125 }, (_, i) => ({
    externalId: `history-${i}`,
    kind: 'note',
    title: `Historical sample ${i}`,
    summary: 'Synthetic archived bookkeeping note.',
    updatedAtSource: old + i * 1000,
    searchText: `history ${i}`,
  }));
  for (let i = 0; i < items.length; i += 30)
    await convexMutation(api.mcp.upsertItems, {
      userId,
      connectionId: 'synthetic-granola',
      server: 'granola',
      items: items.slice(i, i + 30),
    });
  await convexMutation(api.mcp.upsertItems, {
    userId,
    connectionId: 'synthetic-granola',
    server: 'granola',
    items: [
      {
        externalId: 'decision',
        kind: 'meeting',
        title: 'Release postponed',
        summary: 'Launch delayed pending security approval.',
        repository: 'synthetic/atlas',
        updatedAtSource: Date.now() - 30 * 86400000,
        searchText: 'Release postponed launch delayed',
      },
    ],
  });
  await convexMutation(api.mcp.upsertItems, {
    userId,
    connectionId: 'synthetic-github',
    server: 'github',
    items: [
      {
        externalId: 'commit',
        kind: 'commit',
        title: 'Security changeset merged',
        summary: 'Changeset abcd reached the default branch. Deployment is not established.',
        repository: 'synthetic/atlas',
        updatedAtSource: Date.now() - 1000,
        searchText: 'Security changeset merged',
      },
    ],
  });
  let done = false,
    scanned = 0;
  for (let page = 0; page < 10 && !done; page++)
    done = (await convexMutation<any>(f.ingest, { userId, group: 'mcp' })).done;
  assert(done, 'Fixture ingestion did not finish');
  done = false;
  for (let page = 0; page < 10 && !done; page++) {
    const result = await convexMutation<any>(f.compact, { userId });
    done = result.done;
    scanned += result.scanned;
  }
  assert(done && scanned === 127, 'History sweep missed source records');
  // Queries naturally retry while bounded scheduled chapter writes settle.
  let chapters: any[] = [];
  for (let attempt = 0; attempt < 20; attempt++) {
    chapters = (await convexQuery<any>(f.search, { userId, level: 'month' })).entries;
    if (chapters[0]?.sourceIds?.length === 60) break;
  }
  const month = chapters[0];
  assert(month?.sourceIds.length === 60, 'Monthly overview did not compact evidence');
  const detail = await convexQuery<any>(f.read, { userId, id: month._id });
  assert(detail.navigation.from === old && detail.sources.length === 60, 'Month lost provenance/navigation');
  const packet = await getNarrativeTaskContext(userId, {
    purpose: 'chat',
    query: 'Why did the shipping date slip?',
  });
  assert(semanticCalls > 0, 'Semantic lookup failed or timed out');
  assert(
    packet.evidence.some((row) => row.title === 'Release postponed'),
    'Paraphrase did not find the decision',
  );
  assert(
    packet.evidence.some((row) => row.title === 'Security changeset merged'),
    'Cross-service link was not followed',
  );
  assert(
    !packet.evidence.some((row) => row.title.startsWith('Historical sample')),
    'Unrelated history entered the task packet',
  );
  for (let run = 0; run < 2; run++) {
    const result = await refreshNarrative(userId, 'synthetic-spine-acceptance');
    assert(result.status === 'ready', `Writer failed: ${JSON.stringify(result)}`);
  }
  const polished = await convexQuery<any>(f.read, { userId, id: month._id });
  assert(
    polished.entry.model === 'z-ai/glm-5.3-flash' && polished.entry.text.length <= 1400,
    'Monthly model compaction did not publish at its tighter bound',
  );
  await convexMutation(f.edit, {
    userId,
    id: polished.sources[0]._id,
    text: 'Synthetic correction: that old account was incomplete.',
  });
  assert(
    (await convexQuery(f.read, { userId, id: month._id })) === null,
    'Correction failed to revoke compacted history',
  );
  console.log(
    JSON.stringify({
      status: 'passed',
      scanned,
      semanticCalls,
      evidenceCount: packet.evidence.length,
      monthCharacters: polished.entry.text.length,
      checks: [
        'resumable history',
        'monthly provenance',
        'semantic paraphrase',
        'cross-service connection',
        'model-written brief and compacted month',
        'correction revocation',
      ],
    }),
  );
} catch (error) {
  failures.push(error);
} finally {
  try {
    await convexMutation(f.erase, { userId });
    for (const server of sources)
      await convexMutation(api.mcp.disconnectConnection, { userId, connectionId: `synthetic-${server}` });
    assert(!(await convexQuery<any>(f.search, { userId })).enabled, 'Synthetic narrative was not revoked');
    console.log(
      'Synthetic memory revoked and synthetic connections disconnected; recoverable provider records outside this fixture were not touched.',
    );
  } catch (error) {
    failures.push(error);
  }
  __setNarrativeDepsForTest();
}
if (failures.length) throw new AggregateError(failures, 'Staging spine acceptance failed');
