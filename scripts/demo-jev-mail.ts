/** Live provider calls on synthetic messages, using the same questions and policy as the Settings demo. */
import { mkdir, writeFile } from 'node:fs/promises';
import { evaluateClassifier } from '../lib/classifier/client';
import { DEFAULT_JEV_PREFERENCES } from '../lib/jev/contract';
import { demoMailInput, demoResult, JEV_DEMO_EXAMPLES } from '../lib/jev/demo';
import { buildMailQuestions } from '../lib/jev/mail';

const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) throw new Error('OPENROUTER_API_KEY is required.');
const results = [];
for (const example of JEV_DEMO_EXAMPLES) {
  const input = demoMailInput(example.input, Date.now());
  const start = performance.now();
  const response = await evaluateClassifier({
    apiKey,
    state: {
      mailboxOwnerAddresses: input.selfAddresses,
      messagesOldestToNewest: input.messages,
      contextComplete: true,
    },
    questions: buildMailQuestions(input),
  });
  const result = demoResult(
    input,
    response,
    DEFAULT_JEV_PREFERENCES,
    Math.round(performance.now() - start),
    Date.now(),
  );
  results.push({ example: example.label, input: example.input, result, usage: response.usage });
  console.log(JSON.stringify({ example: example.label, ...result }));
}
await mkdir('docs/research/jev-live-demo', { recursive: true });
await writeFile(
  'docs/research/jev-live-demo/results.json',
  `${JSON.stringify({ at: new Date().toISOString(), synthetic: true, results }, null, 2)}\n`,
);
