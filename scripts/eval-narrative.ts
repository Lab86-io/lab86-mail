/** Explicit, synthetic-only live model smoke. Never reads or writes a user's memory.
 * OPENROUTER_API_KEY=... bun scripts/eval-narrative.ts
 */
import { createOpenAI } from '@ai-sdk/openai';
import { generateText, Output, stepCountIs, tool } from 'ai';
import { z } from 'zod';
import { NARRATIVE_SKILL } from '../lib/narrative/core';
import { NARRATIVE_GENERATION_SCHEMA, parseNarrativeGeneration } from '../lib/narrative/service';

const key = process.env.OPENROUTER_API_KEY;
if (!key) throw new Error('OPENROUTER_API_KEY is required for this opt-in live evaluation');
const evidence = [
  {
    id: 'intention',
    trust: 'reported',
    text: 'On September 7 Alex said: tomorrow I want to deploy the search improvement and prepare for the design review.',
  },
  {
    id: 'progress',
    trust: 'observed',
    text: 'On September 8 GitHub PR 42 for search was merged. No deployment status is available.',
  },
  {
    id: 'meeting',
    trust: 'observed',
    text: 'Calendar: design review scheduled September 8 at 14:00. This is not attendance evidence.',
  },
  {
    id: 'correction',
    trust: 'reported',
    text: 'On September 8 Alex corrected their intention: defer deployment until QA passes. Preparing for the review is still the priority.',
  },
];
let reads = 0;
const result = await generateText({
  model: createOpenAI({ apiKey: key, baseURL: 'https://openrouter.ai/api/v1' }).chat('z-ai/glm-5.3-flash'),
  system: `${NARRATIVE_SKILL}\nWrite a brief using only the synthetic evidence. First use narrative_sources. Return JSON {"text":string,"sourceIds":string[]}. Explain what changed and what remains uncertain. Under 200 words.`,
  prompt: 'It is September 8. What matters today for Alex?',
  output: Output.object({ schema: NARRATIVE_GENERATION_SCHEMA }),
  tools: {
    narrative_sources: tool({
      description: 'Read the evidence for this synthetic user.',
      inputSchema: z.object({}),
      execute: async () => {
        reads++;
        return evidence;
      },
    }),
  },
  prepareStep: ({ stepNumber }) => ({
    toolChoice: stepNumber === 0 ? { type: 'tool', toolName: 'narrative_sources' } : 'none',
  }),
  stopWhen: stepCountIs(3),
  maxOutputTokens: 4000,
  maxRetries: 0,
  providerOptions: { openai: { reasoningEffort: 'low' } },
  abortSignal: AbortSignal.timeout(90_000),
});
if (!result.text.includes('{'))
  console.log(
    JSON.stringify(
      {
        finishReason: result.finishReason,
        usage: result.totalUsage,
        steps: result.steps.map((step) => ({
          finishReason: step.finishReason,
          calls: step.toolCalls.map((call) => call.toolName),
          text: step.text,
          reasoning: step.reasoningText?.slice(-600),
          warnings: step.warnings,
        })),
      },
      null,
      2,
    ),
  );
const parsed = parseNarrativeGeneration(result.output, new Set(evidence.map((e) => e.id)));
if (!reads || !parsed.sourceIds.includes('correction'))
  throw new Error('Evaluation failed: omitted source retrieval or current correction');
console.log(
  JSON.stringify({ model: 'z-ai/glm-5.3-flash', reads, usage: result.totalUsage, ...parsed }, null, 2),
);
