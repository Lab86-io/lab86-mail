import { describe, expect, test } from 'bun:test';
import { liftToolsForAgent, normalizeClientCapabilities } from '../lib/ai/loop';
import { buildSystemPrompt } from '../lib/ai/system-prompt';

// ask_form pauses the chat until the client answers. A client that cannot
// show it (an older iPhone or Mac app) would wait forever, so the tool and its
// prompt line exist only when the client declares the capability.

describe('client capabilities', () => {
  test('only known names survive', () => {
    expect([...normalizeClientCapabilities(['ask_form', 'teleport', 7, null])]).toEqual(['ask_form']);
    expect(normalizeClientCapabilities(undefined).size).toBe(0);
    expect(normalizeClientCapabilities('ask_form').size).toBe(0);
  });

  test('ask_form is a tool only for a client that renders it', () => {
    expect(liftToolsForAgent('b', 'UTC', undefined, {}).ask_form).toBeUndefined();
    expect(liftToolsForAgent('b', 'UTC', undefined, { askForm: true }).ask_form).toBeDefined();
    // The other asks stay for every client.
    expect(liftToolsForAgent('b', 'UTC', undefined, {}).ask_user).toBeDefined();
  });

  test('the prompt names ask_form only when the client renders it', () => {
    expect(buildSystemPrompt({}, {})).not.toContain('- ask_form:');
    expect(buildSystemPrompt({}, { askForm: true })).toContain('- ask_form: ONE form with typed fields');
  });
});
