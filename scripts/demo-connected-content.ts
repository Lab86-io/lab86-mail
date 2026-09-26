import { mkdir, writeFile } from 'node:fs/promises';
import { createOpenAI } from '@ai-sdk/openai';
import { generateObject } from 'ai';
import { getFunctionName } from 'convex/server';
import { evaluateClassifier } from '../lib/classifier/client';
import type { ContentItem } from '../lib/content/contract';
import { classifyContent, embedContent } from '../lib/content/intelligence';
import { prepareBriefWork } from '../lib/content/prepare';

// Live providers, entirely synthetic source material. No user account reads or writes.
const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) throw new Error('OPENROUTER_API_KEY is required.');
const model = process.env.CONTENT_DEMO_MODEL || 'openai/gpt-5.5';
const provider = createOpenAI({ apiKey, baseURL: 'https://openrouter.ai/api/v1' });
const output = process.env.CONTENT_DEMO_OUTPUT || '/tmp/albatross-connected-content/live';
await mkdir(output, { recursive: true });
const inference: any = {
  resolveClassifierRuntime: async () => ({ apiKey }),
  evaluateClassifier,
  recordClassifierUsage: async () => {},
};
const now = Date.now();
function item(id: string, title: string, text: string): ContentItem {
  return {
    _id: id,
    key: id,
    externalId: id,
    connectionId: 'synthetic',
    source: 'document',
    title,
    text,
    version: '1',
    modifiedAt: now,
    indexedAt: now,
    partial: false,
    ownerIdentities: ['Jakob', 'jakob@example.test'],
  };
}
const sources = [
  item(
    'launch-request',
    'Orion launch requirements',
    'To Jakob: Please prepare the Orion launch checklist by Friday. You own the checklist. We still need signed security approval before launch. Use the current requirements document. Nobody has completed this task yet.',
  ),
  item(
    'athletics',
    'Syracuse Athletics: tickets available',
    'General athletics newsletter. Tickets are on sale for the next game. Come support the team! Optional promotional event; no personal request or obligation.',
  ),
  item(
    'resolved',
    'Orion archive cleanup completed',
    'The archive cleanup was completed and approved. This request is closed. There is nothing left for Jakob to do.',
  ),
  item(
    'requirements',
    'Orion release requirements',
    'The release requires signed security approval. Run smoke tests in staging. Record a rollback owner before launch. No production deployment until security approval is recorded. The launch date has not been agreed.',
  ),
];
const classifications = [];
for (const source of sources.slice(0, 3)) {
  const runs: Array<{
    ms: number;
    labels: Omit<Awaited<ReturnType<typeof classifyContent>>, 'evaluatedAt'>;
  }> = [];
  for (let i = 0; i < 3; i++) {
    const start = performance.now();
    const result = await classifyContent('synthetic-demo', source, [], inference);
    const { evaluatedAt: _, ...labels } = result;
    runs.push({ ms: Math.round(performance.now() - start), labels });
  }
  classifications.push({
    source: source._id,
    repeatedLabelsEqual: runs.every((run) => JSON.stringify(run.labels) === JSON.stringify(runs[0].labels)),
    runs,
  });
}
const embedStart = performance.now();
const vectors = await embedContent(
  'synthetic-demo',
  sources.map((s) => s.text),
  undefined,
  fetch,
  inference,
);
const embeddingMs = Math.round(performance.now() - embedStart);
let draft: any;
const generations: Array<{ feature: string; ms: number }> = [];
const started = performance.now();
const preparation = await prepareBriefWork('synthetic-demo', {
  convexMutation: async (ref: any, args: any) => {
    if (getFunctionName(ref).endsWith(':claim'))
      return {
        _id: 'demo-proposal',
        lease: 'demo',
        revision: 1,
        seed: sources[0],
        userNotes: 'Prepare a checklist for review. Do not deploy anything.',
      };
    if (getFunctionName(ref).endsWith(':complete')) {
      draft = args.draft;
      return true;
    }
    return null;
  },
  convexQuery: async () => [sources[0], sources[3]],
  searchContent: async () => ({ items: [sources[3]], semanticUnavailable: false }),
  reportFailure: (error: any) => console.error('Preparation failure:', error.name, error.message),
  generateObjectForCurrentUser: async (args: any) => {
    const start = performance.now();
    const result = await generateObject({
      model: provider.chat(model),
      schema: args.schema,
      system: args.system,
      prompt: args.prompt,
      maxOutputTokens: args.maxOutputTokens,
      abortSignal: args.abortSignal,
      providerOptions: { openai: { reasoningEffort: 'low' } },
    });
    generations.push({ feature: args.feature, ms: Math.round(performance.now() - start) });
    return result;
  },
} as any);
const evidence = {
  at: new Date().toISOString(),
  syntheticSources: true,
  retrieval: 'fixed synthetic corpus; provider calls are live',
  model,
  classifications,
  embeddings: { ms: embeddingMs, count: vectors.length, dimensions: vectors[0]?.length },
  preparation: { ...preparation, ms: Math.round(performance.now() - started), generations },
  draft,
};
await writeFile(`${output}/evidence.json`, JSON.stringify(evidence, null, 2));
for (const file of draft?.files || []) await writeFile(`${output}/${file.name}`, file.content);
console.log(
  JSON.stringify({
    output,
    classified: classifications.length,
    embeddingMs,
    prepared: preparation.prepared,
    generations,
  }),
);
if (!preparation.prepared) process.exitCode = 1;
