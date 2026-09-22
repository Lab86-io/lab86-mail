/** Synthetic live-model evaluation. Explicit opt-in; no customer data or application writes. */
import { readFile, writeFile } from 'node:fs/promises';
import { createOpenAI } from '@ai-sdk/openai';
import { generateText } from 'ai';
import { writeDailyEditorial } from '../lib/mail/brief-editorial';
import { editorialFixture } from '../tests/fixtures/editorial';

if (!process.env.EDITORIAL_EVAL_ENV_FILE)
  throw new Error('Set EDITORIAL_EVAL_ENV_FILE to opt into one synthetic model run.');
const env = Object.fromEntries(
  (await readFile(process.env.EDITORIAL_EVAL_ENV_FILE, 'utf8')).split('\n').flatMap((line) => {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    return match ? [[match[1], match[2].trim().replace(/^['"]|['"]$/g, '')]] : [];
  }),
);
if (!env.OPENROUTER_API_KEY) throw new Error('An OpenRouter key is required for this evaluation.');
const provider = createOpenAI({ apiKey: env.OPENROUTER_API_KEY, baseURL: 'https://openrouter.ai/api/v1' });
const model = env.LAB86_MAIL_OPENAI_MODEL || 'openai/gpt-5.5';
const { edition, letter } = editorialFixture();
const started = Date.now();
const steps: unknown[] = [];
const result = await writeDailyEditorial(edition, letter, {
  evidence: {
    'thread:account-a:thread-a': {
      sender: 'Maya',
      subject: 'Confirm the launch budget',
      messages: [
        {
          from: 'maya@example.com',
          body: 'Before the launch review, compare the two support quotes. North quoted $120 for eight weekday support hours. South quoted $180 for twelve weekday support hours and same-day escalation. Both cover the same launch date. We still need to choose who owns support internally. Please review the costs and draft a reply asking for escalation details; do not send anything yet. The release checklist is complete. The decision can wait until the Thursday team review, but the staffing owner should be agreed first.',
        },
      ],
    },
  },
  generate: (async (options: any) => {
    const { feature: _feature, speed: _speed, userId: _userId, ...settings } = options;
    return generateText({
      ...settings,
      model: provider.chat(model),
      onStepFinish(step: any) {
        const details = {
          tools: step.toolCalls.map((call: any) => call.toolName),
          results: step.toolResults.map((r: any) => ({
            tool: r.toolName,
            ok: r.output?.ok,
            error: r.output?.error,
          })),
          usage: step.usage,
        };
        steps.push(details);
        console.log(JSON.stringify(details));
      },
    });
  }) as any,
});
const components: string[] = [];
let words = 0;
const walk = (node: any) => {
  if (node.kind === 'tool_ui') {
    components.push(node.component);
    if (node.component === 'editorial-text') words += String(node.props.text).split(/\s+/).length;
  }
  if (node.children) node.children.forEach(walk);
};
result.document.regions.forEach((region) => {
  walk(region.tree);
});
const summary = {
  model,
  elapsedMs: Date.now() - started,
  mode: result.editorial.mode,
  words,
  components,
  steps: steps.length,
};
console.log(JSON.stringify(summary));
await writeFile('/tmp/brief-live-eval.json', JSON.stringify({ ...result, summary, steps }, null, 2));
if (result.failed || !components.includes('editorial-text') || components.length < 2) process.exitCode = 1;
