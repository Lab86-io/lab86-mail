export {};

// Probe: does /api/agent's runAgent stream live against a real provider?
// Usage: bun --env-file=.env.local run scripts/_stream-probe.ts "prompt"
// PROBE_ROUTE=openrouter drops the direct keys so the OpenRouter path runs.
if (process.env.PROBE_ROUTE === 'openrouter') {
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
}
const { runAgent } = await import('../lib/ai/loop');

const prompt =
  process.argv[2] ||
  'In one sentence, say hello. Then call corpus_count with query "invoice" and tell me what happened.';

const started = Date.now();
const run = await runAgent({
  messages: [{ role: 'user', content: prompt }],
  userId: null,
  userEmail: null,
  userName: 'Probe',
  userTimezone: 'America/New_York',
});
const response = run.toUIMessageStreamResponse();
const reader = response.body!.getReader();
const decoder = new TextDecoder();
let first = 0;
let buffer = '';
const counts = new Map<string, number>();
let textChars = 0;
while (true) {
  const { value, done } = await reader.read();
  if (done) break;
  if (!first) {
    first = Date.now();
    console.log(`first byte after ${first - started}ms`);
  }
  buffer += decoder.decode(value, { stream: true });
  const lines = buffer.split('\n');
  buffer = lines.pop() || '';
  for (const line of lines) {
    if (!line.startsWith('data:')) continue;
    const raw = line.slice(5).trim();
    if (!raw || raw === '[DONE]') continue;
    try {
      const chunk = JSON.parse(raw);
      counts.set(chunk.type, (counts.get(chunk.type) || 0) + 1);
      if (chunk.type === 'text-delta') textChars += chunk.delta.length;
      if (
        ['tool-input-start', 'tool-output-available', 'data-tool-shape', 'error', 'finish'].includes(
          chunk.type,
        )
      ) {
        console.log(
          `${Date.now() - started}ms ${chunk.type} ${chunk.toolName || chunk.id || chunk.errorText || chunk.finishReason || ''}`,
        );
      }
    } catch {}
  }
}
const steps = await run.steps;
console.log({
  totalMs: Date.now() - started,
  textChars,
  steps: steps.length,
  counts: Object.fromEntries(counts),
});
