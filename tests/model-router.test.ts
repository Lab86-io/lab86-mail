import { describe, expect, test } from 'bun:test';
import { classifyModel, toDirectModelId, toOpenRouterModelId } from '../lib/ai/model-router';

describe('model router — classifyModel', () => {
  test('vendor-prefixed ids', () => {
    expect(classifyModel('openai/gpt-5.5')).toBe('openai');
    expect(classifyModel('anthropic/claude-sonnet-4.6')).toBe('anthropic');
    expect(classifyModel('google/gemini-2.5-pro')).toBe('other');
    expect(classifyModel('x-ai/grok-4')).toBe('other');
  });
  test('bare ids inferred from family', () => {
    expect(classifyModel('gpt-5.5')).toBe('openai');
    expect(classifyModel('gpt-5-nano')).toBe('openai');
    expect(classifyModel('o3')).toBe('openai');
    expect(classifyModel('claude-sonnet-4.6')).toBe('anthropic');
    expect(classifyModel('claude-haiku-4.5')).toBe('anthropic');
    expect(classifyModel('gemini-2.5-pro')).toBe('other');
  });
  test('empty/garbage', () => {
    expect(classifyModel('')).toBe('other');
    expect(classifyModel('   ')).toBe('other');
  });
});

describe('model router — id translation', () => {
  test('toDirectModelId strips only openai/anthropic prefixes', () => {
    expect(toDirectModelId('openai/gpt-5.5')).toBe('gpt-5.5');
    expect(toDirectModelId('anthropic/claude-sonnet-4.6')).toBe('claude-sonnet-4.6');
    expect(toDirectModelId('gpt-5.5')).toBe('gpt-5.5');
    // non-OpenAI/Anthropic prefixes are left intact (they only run via OpenRouter)
    expect(toDirectModelId('google/gemini-2.5-pro')).toBe('google/gemini-2.5-pro');
  });
  test('toOpenRouterModelId adds the vendor prefix for bare ids', () => {
    expect(toOpenRouterModelId('gpt-5.5')).toBe('openai/gpt-5.5');
    expect(toOpenRouterModelId('claude-sonnet-4.6')).toBe('anthropic/claude-sonnet-4.6');
    expect(toOpenRouterModelId('openai/gpt-5.5')).toBe('openai/gpt-5.5');
    expect(toOpenRouterModelId('google/gemini-2.5-pro')).toBe('google/gemini-2.5-pro');
  });
  test('round-trips a configured default through both forms', () => {
    const configured = 'openai/gpt-5.5';
    expect(toDirectModelId(configured)).toBe('gpt-5.5'); // direct OpenAI key
    expect(toOpenRouterModelId(toDirectModelId(configured))).toBe('openai/gpt-5.5'); // back to OR
  });
});
