import { describe, expect, test } from 'bun:test';
import './tools/harness';
import {
  describeProvider,
  fastModel,
  hasAi,
  OPENAI_FAST_MODEL,
  OPENAI_PRIMARY_MODEL,
  primaryModel,
} from '../lib/ai/client';

// The tools harness clears all provider keys, so the no-provider branches are
// the deterministic ones to assert here.
describe('ai/client provider resolution without keys', () => {
  test('hasAi is false and describeProvider reports none', () => {
    expect(hasAi()).toBe(false);
    expect(describeProvider()).toEqual({ provider: 'none', primary: '', fast: '' });
  });

  test('the default model ids resolve to strings', () => {
    expect(typeof OPENAI_PRIMARY_MODEL).toBe('string');
    expect(typeof OPENAI_FAST_MODEL).toBe('string');
  });

  test('primaryModel / fastModel throw a clear error when nothing is configured', () => {
    expect(() => primaryModel()).toThrow(/No AI provider configured/);
    expect(() => fastModel()).toThrow(/No AI provider configured/);
  });
});
