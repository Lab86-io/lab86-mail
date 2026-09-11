import { describe, expect, test } from 'bun:test';
import { settingsModelFor } from '../lib/ai/gateway';
import {
  buildModelCatalog,
  findCatalogModel,
  resolveSavedModel,
  resolveSavedModelId,
  validateModelChoice,
} from '../lib/ai/model-catalog';

const live = [
  {
    id: 'openai/gpt-5.5',
    context_length: 1050000,
    pricing: { prompt: '0.000005', completion: '0.00003' },
    supported_parameters: ['tools', 'reasoning'],
    architecture: { input_modalities: ['text', 'image', 'file'] },
  },
  { id: 'openai/gpt-5.4' },
  { id: 'openai/gpt-5-nano' },
  { id: 'anthropic/claude-sonnet-4.6' },
  { id: 'anthropic/claude-haiku-4.5' },
  { id: 'vendor/new-mini', name: 'Vendor: New Mini', context_length: 8000 },
  { id: 'vendor/new-mini:batch' },
  { id: 'vendor/image', architecture: { output_modalities: ['image'] } },
];

describe('model catalog and runtime choices', () => {
  test('merges live models, pricing, and capabilities; excludes batch and image-only routes', () => {
    const catalog = buildModelCatalog({ live });
    expect(findCatalogModel(catalog, 'gpt-5.5')).toMatchObject({
      id: 'openai/gpt-5.5',
      pricing: { inputPerM: 5, outputPerM: 30 },
      contextTokens: 1050000,
      capabilities: { tools: true, reasoning: true, vision: true, pdf: true, longContext: true },
    });
    expect(findCatalogModel(catalog, 'vendor/new-mini')).toMatchObject({ name: 'New Mini', tier: 'fast' });
    expect(findCatalogModel(catalog, 'vendor/new-mini:batch')).toBeUndefined();
    expect(findCatalogModel(catalog, 'vendor/image')).toBeUndefined();
    expect(catalog.findIndex((m) => m.provider === 'openai')).toBeLessThan(
      catalog.findIndex((m) => m.provider === 'anthropic'),
    );
    expect(findCatalogModel(catalog, 'openai/gpt-5.4')?.status).toBe('legacy');
  });

  test('replaces retired ids only with available models of the same vendor', () => {
    const catalog = buildModelCatalog({ live });
    expect(resolveSavedModel('openai/gpt-5.1-chat', catalog)).toMatchObject({
      id: 'openai/gpt-5.5',
      deprecated: true,
    });
    expect(resolveSavedModel('anthropic/claude-opus-4.8', catalog)).toMatchObject({
      id: 'anthropic/claude-sonnet-4.6',
      deprecated: true,
    });
    expect(resolveSavedModelId('openai/gpt-5.4-mini', 'openrouter', catalog)).toBe('openai/gpt-5-nano');
    expect(() => resolveSavedModelId('google/gemini-3.5-flash', 'openrouter', catalog)).toThrow('retired');
  });

  test('direct providers keep vendor ids and cannot select another vendor', () => {
    const catalog = buildModelCatalog({ live, provider: 'anthropic' });
    expect(resolveSavedModel('anthropic/claude-sonnet-4.6', catalog, { provider: 'anthropic' }).id).toBe(
      'claude-sonnet-4-6',
    );
    expect(findCatalogModel(catalog, 'claude-haiku-4-5-20251001')?.id).toBe('anthropic/claude-haiku-4.5');
    expect(validateModelChoice({ provider: 'anthropic', slot: 'normal', value: 'gpt-5.5', catalog }).ok).toBe(
      false,
    );
    expect(
      validateModelChoice({ provider: 'openrouter', slot: 'normal', value: 'vendor/custom', catalog }),
    ).toMatchObject({ ok: true, unknown: true });
    expect(
      validateModelChoice({ provider: 'openrouter', slot: 'normal', value: 'invalid', catalog }).ok,
    ).toBe(false);
  });

  test('saved Normal/Fast slots reach hosted, OpenRouter, and direct runtime choices', () => {
    const catalog = buildModelCatalog({ live });
    const settings = {
      mode: 'byok' as const,
      enabled: true,
      provider: 'anthropic' as const,
      model: 'anthropic/claude-sonnet-4.6',
      fastModel: 'anthropic/claude-haiku-4.5',
    };
    expect(settingsModelFor('primary', settings, catalog, 'openrouter')).toBe('anthropic/claude-sonnet-4.6');
    expect(settingsModelFor('primary', settings, catalog, 'anthropic')).toBe('claude-sonnet-4-6');
    expect(settingsModelFor('fast', settings, catalog, 'anthropic')).toBe('claude-haiku-4-5');
    expect(settingsModelFor('primary', { ...settings, mode: 'lab86' }, catalog, 'openrouter')).toBe(
      'anthropic/claude-sonnet-4.6',
    );
    expect(settingsModelFor('nano', settings, catalog)).toBeUndefined();
    expect(settingsModelFor('classify', settings, catalog)).toBeUndefined();
    expect(
      settingsModelFor('primary', { ...settings, provider: 'openai', model: 'openai/gpt-5.5' }, catalog),
    ).toBe('gpt-5.5');
  });
});
