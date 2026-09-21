import { JEV_MODEL } from './contract';

export type JevQuestion =
  | { type: 'noul'; instructions: string }
  | { type: 'choice'; instructions: string; criteria: Record<string, string> };
export type JevAnswer =
  | { type: 'noul'; noul: number }
  | { type: 'choice'; choice: string; confidence: number; probabilities: Record<string, number> };
export interface JevResponse {
  model: string;
  answers: Record<string, JevAnswer>;
  usage: { input_tokens: number; output_tokens: number; cost?: number };
}
export class JevUnavailableError extends Error {
  constructor(public readonly reason: 'timeout' | 'provider' | 'invalid_response' | 'not_configured') {
    super(`Jev evaluation unavailable (${reason}).`);
  }
}
const probability = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;

export function validateJevResponse(raw: unknown, questions: Record<string, JevQuestion>): JevResponse {
  const result = raw as JevResponse;
  if (
    !result ||
    typeof result.model !== 'string' ||
    !/^typesafe\/jev-1\.13(?:-\d{8})?$/.test(result.model) ||
    !result.answers
  )
    throw new JevUnavailableError('invalid_response');
  for (const [key, question] of Object.entries(questions)) {
    const answer = result.answers[key];
    if (!answer || answer.type !== question.type) throw new JevUnavailableError('invalid_response');
    if (answer.type === 'noul') {
      if (!probability(answer.noul)) throw new JevUnavailableError('invalid_response');
    } else {
      if (
        question.type !== 'choice' ||
        !Object.hasOwn(question.criteria, answer.choice) ||
        !probability(answer.confidence) ||
        !answer.probabilities
      )
        throw new JevUnavailableError('invalid_response');
      const keys = Object.keys(question.criteria);
      if (
        Object.keys(answer.probabilities).length !== keys.length ||
        !keys.every((key) => probability(answer.probabilities[key])) ||
        Math.abs(Object.values(answer.probabilities).reduce((a, b) => a + b, 0) - 1) > 0.03
      )
        throw new JevUnavailableError('invalid_response');
    }
  }
  if (
    !result.usage ||
    !Number.isFinite(result.usage.input_tokens) ||
    result.usage.input_tokens < 0 ||
    !Number.isFinite(result.usage.output_tokens) ||
    result.usage.output_tokens < 0
  )
    throw new JevUnavailableError('invalid_response');
  return result;
}

export async function evaluateJev(
  input: {
    apiKey: string;
    state: unknown;
    questions: Record<string, JevQuestion>;
    timeoutMs?: number;
    signal?: AbortSignal;
  },
  fetcher: typeof fetch = fetch,
): Promise<JevResponse> {
  if (!input.apiKey) throw new JevUnavailableError('not_configured');
  const timeout = AbortSignal.timeout(input.timeoutMs ?? 5_000);
  const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await fetcher('https://openrouter.ai/api/alpha/decisions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${input.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: JEV_MODEL, state: input.state, questions: input.questions }),
      signal,
    });
  } catch {
    if (input.signal?.aborted) input.signal.throwIfAborted();
    throw new JevUnavailableError(timeout.aborted ? 'timeout' : 'provider');
  }
  if (!response.ok) throw new JevUnavailableError('provider');
  const raw = await response.json().catch(() => {
    throw new JevUnavailableError('invalid_response');
  });
  return validateJevResponse(raw, input.questions);
}

export async function mapConcurrent<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(items.length, Math.max(1, concurrency)) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await fn(items[index]);
      }
    }),
  );
  return results;
}
