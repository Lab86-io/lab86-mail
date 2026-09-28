import { createOpenAI } from '@ai-sdk/openai';

// OpenRouter data policy (Google Limited Use, CASA). Every request that goes
// to OpenRouter sets the provider preference `data_collection: 'deny'`. Then
// OpenRouter sends the request only to a model endpoint whose provider does
// not train on the data. The filter does not remove endpoints that keep
// requests for a short time for abuse checks (OpenAI and Anthropic keep them
// for up to 30 days).
//
// Live check on 2026-09-28, one minimal request for each model id in use with
// the production key and this preference: openai/gpt-5.5, openai/gpt-5.6-luna,
// openai/gpt-5.6-terra, openai/gpt-5-nano, openai/gpt-5.4-mini,
// anthropic/claude-opus-5.5, anthropic/claude-sonnet-4.6,
// anthropic/claude-haiku-4.5, z-ai/glm-5.3-flash, google/gemini-2.5-flash,
// moonshotai/kimi-k3, openai/text-embedding-3-small (embeddings), and
// typesafe/jev-1.13 (the decisions endpoint). All of them answered, so no
// model needs an exception. A model that has no such endpoint fails with an
// OpenRouter error; it never goes out without the preference.

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

/** The provider preference that every OpenRouter request carries. */
export const OPENROUTER_DATA_POLICY = { data_collection: 'deny' } as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The request body with the data policy. Other provider preferences (for
 * example `order`) stay; the data policy replaces a different value.
 */
export function withOpenRouterDataPolicy<T extends Record<string, unknown>>(body: T) {
  const provider = isRecord(body.provider) ? body.provider : {};
  return { ...body, provider: { ...provider, ...OPENROUTER_DATA_POLICY } };
}

/**
 * A fetch for OpenRouter clients. It adds the data policy to the JSON body of
 * each request that has a body. A body that is not a JSON object cannot hold
 * the policy, so that request stops with an error and does not go out. With
 * no `base`, it reads globalThis.fetch at request time, as the AI SDK does.
 */
export function openRouterFetch(base?: typeof fetch): typeof fetch {
  const send = (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
    (base ?? globalThis.fetch)(input, init);
  const wrapped = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (init?.body === undefined || init.body === null) return send(input, init);
    let parsed: unknown;
    if (typeof init.body === 'string') {
      try {
        parsed = JSON.parse(init.body);
      } catch {
        parsed = undefined;
      }
    }
    if (!isRecord(parsed))
      throw new Error('An OpenRouter request needs a JSON object body to carry the data policy.');
    return send(input, { ...init, body: JSON.stringify(withOpenRouterDataPolicy(parsed)) });
  };
  return wrapped as typeof fetch;
}

/**
 * The AI SDK provider for OpenRouter, for the platform key and for a user's
 * own key. Chat, streaming, structured output, and embeddings all go through
 * openRouterFetch.
 */
export function createOpenRouterProvider(apiKey: string, options: { fetch?: typeof fetch } = {}) {
  return createOpenAI({
    apiKey,
    baseURL: OPENROUTER_BASE_URL,
    // Recommended (and used to attribute usage in OpenRouter dashboards):
    headers: {
      'HTTP-Referer': process.env.LAB86_MAIL_PUBLIC_URL || 'https://mail.lab86.io',
      'X-Title': 'lab86-mail',
    },
    fetch: openRouterFetch(options.fetch),
  });
}
