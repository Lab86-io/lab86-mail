import type { ModelMessage } from 'ai';

// A tool result goes to the model on every later step and on every later turn,
// so one large result costs many times its size. Each result has a byte cap,
// and the results of one prompt have a joint cap. The cap changes only what the
// model reads. The user's card reads the full output.

/** The cap of one result: about 16,000 tokens. */
export const MAX_TOOL_RESULT_BYTES = 64_000;
/** A read of a whole document needs more room before an edit can address it. */
const MAX_DOCUMENT_READ_BYTES = 160_000;
const DOCUMENT_READ_TOOLS: ReadonlySet<string> = new Set([
  'document_get',
  'word_document_get',
  'google_document_get',
  'presentation_plan',
]);
/** The joint cap of the results in one prompt, the same size as the transcript budget of the agent route. */
export const MAX_TOOL_RESULTS_TOTAL_BYTES = 180_000;

export function toolResultCapFor(toolName: string): number {
  return DOCUMENT_READ_TOOLS.has(toolName) ? MAX_DOCUMENT_READ_BYTES : MAX_TOOL_RESULT_BYTES;
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/** The result text cut to the cap. The note comes first, so the model reads it before the cut text. */
function cutResultText(text: string, limit: number, ok: unknown): string {
  const kept = Buffer.from(text, 'utf8').subarray(0, limit).toString('utf8').replace(/�+$/, '');
  const failed = ok === false ? ' The tool reported a failure (ok: false).' : '';
  return `[This result was cut to its first ${limit} bytes of ${byteLength(text)}, so the end is missing.${failed} Do not treat it as complete. Ask for less: use a filter, a limit, or a narrower read.]\n${kept}`;
}

/** What the model reads for one tool result. Passed to the SDK as `toModelOutput`. */
export function toolModelOutput(toolName: string, output: unknown) {
  const value = output === undefined ? null : output;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const limit = toolResultCapFor(toolName);
  if (byteLength(text) > limit)
    return { type: 'text' as const, value: cutResultText(text, limit, (value as any)?.ok) };
  return typeof value === 'string'
    ? { type: 'text' as const, value }
    : { type: 'json' as const, value: value as any };
}

function storedOutputSize(output: unknown): number {
  return byteLength(JSON.stringify(output ?? null));
}

function storedOutputOk(output: any): unknown {
  return output?.type === 'json' ? output.value?.ok : undefined;
}

/**
 * The messages with each tool result under its cap and all results under the
 * joint cap. The oldest results go first, and the newest stay whole. A prompt
 * inside the caps comes back as the same array.
 */
export function boundToolResults<T extends ModelMessage>(
  messages: T[],
  totalLimit = MAX_TOOL_RESULTS_TOTAL_BYTES,
): T[] {
  let changed = false;
  const bounded = messages.map((message) => {
    if (message.role !== 'tool' || !Array.isArray(message.content)) return message;
    let touched = false;
    const content = message.content.map((part: any) => {
      if (part?.type !== 'tool-result' || !part.output) return part;
      const limit = toolResultCapFor(String(part.toolName ?? ''));
      if (storedOutputSize(part.output) <= limit) return part;
      touched = true;
      const text =
        part.output.type === 'text' ? String(part.output.value) : JSON.stringify(part.output.value);
      return {
        ...part,
        output: { type: 'text', value: cutResultText(text, limit, storedOutputOk(part.output)) },
      };
    });
    if (!touched) return message;
    changed = true;
    return { ...message, content } as T;
  });
  let total = 0;
  for (const message of bounded) {
    if (message.role !== 'tool' || !Array.isArray(message.content)) continue;
    for (const part of message.content as any[])
      if (part?.type === 'tool-result') total += storedOutputSize(part.output);
  }
  for (let index = 0; index < bounded.length && total > totalLimit; index += 1) {
    const message = bounded[index];
    if (message.role !== 'tool' || !Array.isArray(message.content)) continue;
    let touched = false;
    const content = (message.content as any[]).map((part) => {
      if (part?.type !== 'tool-result' || total <= totalLimit) return part;
      const before = storedOutputSize(part.output);
      const failed = storedOutputOk(part.output) === false ? ' The tool reported a failure (ok: false).' : '';
      const output = {
        type: 'text',
        value: `[Older result omitted to keep this chat inside its size limit.${failed} Read the source again if you need it.]`,
      };
      total -= before - storedOutputSize(output);
      touched = true;
      return { ...part, output };
    });
    if (!touched) continue;
    changed = true;
    bounded[index] = { ...message, content } as T;
  }
  return changed ? bounded : messages;
}
