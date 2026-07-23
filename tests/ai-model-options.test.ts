import { describe, expect, test } from 'bun:test';
import {
  isOpenRouterFastModel,
  isOpenRouterPrimaryModel,
  loadOpenRouterModelOptions,
  normalizeOpenRouterFastModel,
  normalizeOpenRouterPrimaryModel,
  OPENROUTER_DEFAULT_FAST_MODEL,
  OPENROUTER_DEFAULT_PRIMARY_MODEL,
  OPENROUTER_FAST_MODEL_OPTIONS,
  OPENROUTER_PRIMARY_MODEL_OPTIONS,
  type Provider,
  setProviderForByok,
} from '../lib/ai/model-options';

describe('OpenRouter model validation', () => {
  test('curated options always include the shipped defaults', () => {
    expect(OPENROUTER_PRIMARY_MODEL_OPTIONS.map((option) => option.id)).toContain(
      OPENROUTER_DEFAULT_PRIMARY_MODEL,
    );
    expect(OPENROUTER_FAST_MODEL_OPTIONS.map((option) => option.id)).toContain(OPENROUTER_DEFAULT_FAST_MODEL);
  });

  test('accepts curated ids and any well-formed vendor/model id', () => {
    expect(isOpenRouterPrimaryModel(OPENROUTER_DEFAULT_PRIMARY_MODEL)).toBe(true);
    expect(isOpenRouterPrimaryModel('some-vendor/experimental-model')).toBe(true);
    expect(isOpenRouterPrimaryModel('meta-llama/llama-3.1-70b:free')).toBe(true);
    expect(isOpenRouterFastModel(OPENROUTER_DEFAULT_FAST_MODEL)).toBe(true);
    expect(isOpenRouterFastModel('some-vendor/quick-model')).toBe(true);
  });

  test('rejects ids that cannot be OpenRouter models', () => {
    expect(isOpenRouterPrimaryModel(undefined)).toBe(false);
    expect(isOpenRouterPrimaryModel(null)).toBe(false);
    expect(isOpenRouterPrimaryModel('')).toBe(false);
    expect(isOpenRouterPrimaryModel('gpt-5.5')).toBe(false);
    expect(isOpenRouterPrimaryModel('bad vendor/model')).toBe(false);
    expect(isOpenRouterFastModel('no-slash-here')).toBe(false);
  });

  test('normalization keeps valid ids and falls back to the defaults otherwise', () => {
    expect(normalizeOpenRouterPrimaryModel('anthropic/claude-sonnet-4.6')).toBe(
      'anthropic/claude-sonnet-4.6',
    );
    expect(normalizeOpenRouterPrimaryModel('nonsense')).toBe(OPENROUTER_DEFAULT_PRIMARY_MODEL);
    expect(normalizeOpenRouterPrimaryModel()).toBe(OPENROUTER_DEFAULT_PRIMARY_MODEL);
    expect(normalizeOpenRouterFastModel('openai/gpt-5.4-mini')).toBe('openai/gpt-5.4-mini');
    expect(normalizeOpenRouterFastModel(null)).toBe(OPENROUTER_DEFAULT_FAST_MODEL);
  });
});

describe('setProviderForByok', () => {
  function record() {
    const events: string[] = [];
    return {
      events,
      apply(value: Provider) {
        setProviderForByok(
          value,
          (provider) => events.push(`provider:${provider}`),
          (model) => events.push(`model:${model}`),
          (fast) => events.push(`fast:${fast}`),
        );
      },
    };
  }

  test('switching to OpenRouter seeds both model slots with the defaults', () => {
    const recorder = record();
    recorder.apply('openrouter');
    expect(recorder.events).toEqual([
      'provider:openrouter',
      `model:${OPENROUTER_DEFAULT_PRIMARY_MODEL}`,
      `fast:${OPENROUTER_DEFAULT_FAST_MODEL}`,
    ]);
  });

  test('switching to a first-party provider clears both model slots', () => {
    const recorder = record();
    recorder.apply('anthropic');
    expect(recorder.events).toEqual(['provider:anthropic', 'model:', 'fast:']);
  });
});

describe('loadOpenRouterModelOptions', () => {
  const catalog = [
    {
      id: 'openai/gpt-5.5',
      name: 'OpenAI: GPT-5.5',
      context_length: 2_000_000,
      pricing: { prompt: '0.00000125', completion: '0.00001' },
    },
    { id: 'acme/large-context', name: 'Acme: Large', context_length: 8000, pricing: {} },
    { id: 'acme/turbo-mini', name: '', description: 'd'.repeat(200) },
    { id: 'tiny/model', context_length: 512, pricing: { prompt: '0.0000001', completion: '0.0000002' } },
    { id: 'img/only', architecture: { output_modalities: ['image'] } },
    { id: 'notamodel' },
  ];

  function withFetch<T>(implementation: typeof fetch, run: () => Promise<T>): Promise<T> {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = implementation;
    return run().finally(() => {
      globalThis.fetch = originalFetch;
    });
  }

  test('maps the live catalog into labeled options with pinned defaults', async () => {
    let requestedUrl = '';
    const result = await withFetch(
      (async (url: unknown) => {
        requestedUrl = String(url);
        return new Response(JSON.stringify({ data: catalog }), { status: 200 });
      }) as typeof fetch,
      () => loadOpenRouterModelOptions(),
    );

    expect(requestedUrl).toBe('https://openrouter.ai/api/v1/models');
    expect(result.live).toBe(true);
    expect(result.primary[0]).toEqual({
      id: 'openai/gpt-5.5',
      label: 'GPT-5.5',
      detail: '2M context · $1.25/M in, $10.00/M out',
    });
    // The fast default is not in the primary pool, so the catalog order continues after the pin.
    expect(result.primary[1].id).toBe('acme/large-context');

    const byId = new Map(result.primary.map((option) => [option.id, option]));
    // Only known vendor prefixes are stripped from labels.
    expect(byId.get('acme/large-context')).toMatchObject({ label: 'Acme: Large', detail: '8k context' });
    expect(byId.get('tiny/model')).toEqual({
      id: 'tiny/model',
      label: 'tiny/model',
      detail: '512 context · $0.100/M in, $0.200/M out',
    });
    expect(byId.get('acme/turbo-mini')?.detail).toBe('d'.repeat(160));
    expect(byId.has('img/only')).toBe(false);
    expect(byId.has('notamodel')).toBe(false);
    // Curated fallbacks that the live catalog missed are still offered.
    expect(byId.has('anthropic/claude-sonnet-4.6')).toBe(true);
  });

  test('the fast list keeps only fast-shaped ids plus the pinned default', async () => {
    const result = await withFetch(
      (async () => new Response(JSON.stringify({ data: catalog }), { status: 200 })) as typeof fetch,
      () => loadOpenRouterModelOptions(),
    );

    expect(result.fast[0].id).toBe(OPENROUTER_DEFAULT_FAST_MODEL);
    const fastIds = result.fast.map((option) => option.id);
    expect(fastIds).toContain('acme/turbo-mini');
    expect(fastIds).not.toContain('acme/large-context');
    expect(fastIds).not.toContain('tiny/model');
  });

  test('an empty catalog degrades to the full curated lists while staying live', async () => {
    const result = await withFetch(
      (async () => new Response(JSON.stringify({}), { status: 200 })) as typeof fetch,
      () => loadOpenRouterModelOptions(),
    );

    expect(result.live).toBe(true);
    expect(result.primary[0].id).toBe(OPENROUTER_DEFAULT_PRIMARY_MODEL);
    expect(result.primary).toHaveLength(OPENROUTER_PRIMARY_MODEL_OPTIONS.length);
    expect(result.fast[0].id).toBe(OPENROUTER_DEFAULT_FAST_MODEL);
    expect(result.fast).toHaveLength(OPENROUTER_FAST_MODEL_OPTIONS.length);
  });

  test('a non-OK catalog response falls back to the curated options', async () => {
    const result = await withFetch(
      (async () => new Response('upstream error', { status: 500 })) as typeof fetch,
      () => loadOpenRouterModelOptions(),
    );

    expect(result).toEqual({
      primary: OPENROUTER_PRIMARY_MODEL_OPTIONS,
      fast: OPENROUTER_FAST_MODEL_OPTIONS,
      live: false,
    });
  });

  test('a network failure falls back to the curated options', async () => {
    const result = await withFetch(
      (async () => {
        throw new Error('network unreachable');
      }) as typeof fetch,
      () => loadOpenRouterModelOptions(),
    );

    expect(result.live).toBe(false);
    expect(result.primary).toEqual(OPENROUTER_PRIMARY_MODEL_OPTIONS);
  });

  test('a hung catalog request is aborted by the timeout and falls back', async () => {
    const result = await withFetch(
      ((_url: unknown, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        })) as unknown as typeof fetch,
      () => loadOpenRouterModelOptions(),
    );

    expect(result.live).toBe(false);
    expect(result.fast).toEqual(OPENROUTER_FAST_MODEL_OPTIONS);
  }, 10_000);
});
