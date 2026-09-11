import { describe, expect, test } from 'bun:test';
import { groupRows, matchesQuery, pickerRows } from '../components/settings/ModelPicker';
import { buildModelCatalog } from '../lib/ai/model-catalog';

describe('model picker choices', () => {
  const catalog = buildModelCatalog();
  test('groups by provider and searches names without case sensitivity', () => {
    const matches = catalog.filter((model) => matchesQuery(model, 'anthropic HAIKU'));
    expect(matches.map((model) => model.id)).toEqual(['anthropic/claude-haiku-4.5']);
    expect(
      groupRows(catalog)
        .slice(0, 3)
        .map((group) => group.label),
    ).toEqual(['OpenAI', 'Anthropic', 'Google']);
  });
  test('fast defaults hide larger models while preserving a selected large model', () => {
    const options = { slot: 'fast' as const, value: '', showOlder: false, showAllTiers: false };
    expect(
      pickerRows(catalog, options).every((model) => model.tier === 'fast' || model.tier === 'nano'),
    ).toBe(true);
    expect(
      pickerRows(catalog, { ...options, value: 'openai/gpt-5.5' }).some(
        (model) => model.id === 'openai/gpt-5.5',
      ),
    ).toBe(true);
    expect(pickerRows(catalog, { ...options, showAllTiers: true }).length).toBeGreaterThan(
      pickerRows(catalog, options).length,
    );
  });
  test('older models are optional and retired or unavailable models cannot be selected', () => {
    const options = { slot: 'normal' as const, value: '', showOlder: false, showAllTiers: true };
    expect(pickerRows(catalog, options).some((model) => model.status === 'legacy')).toBe(false);
    expect(
      pickerRows(catalog, { ...options, showOlder: true }).some((model) => model.status === 'legacy'),
    ).toBe(true);
    expect(
      pickerRows(catalog, { ...options, value: 'openai/gpt-5.1-chat' }).some(
        (model) => model.status === 'deprecated',
      ),
    ).toBe(false);
    const direct = buildModelCatalog({ provider: 'anthropic' });
    expect(
      pickerRows(direct, { ...options, value: 'openai/gpt-5.5' }).every(
        (model) => model.provider === 'anthropic',
      ),
    ).toBe(true);
  });
});
