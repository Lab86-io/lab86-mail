import { describe, expect, test } from 'bun:test';
import { liftToolsForAgent, normalizeClientCapabilities } from '../lib/ai/loop';
import { buildSystemPrompt } from '../lib/ai/system-prompt';

// ask_form pauses the chat until the client answers. A client that cannot
// show it (an older iPhone or Mac app) would wait forever, so the tool and its
// prompt line exist only when the client declares the capability.

describe('client capabilities', () => {
  test('only known names survive', () => {
    expect([...normalizeClientCapabilities(['ask_form', 'teleport', 7, null])]).toEqual(['ask_form']);
    expect([...normalizeClientCapabilities(['ask_secure_detail', 'ask_form'])]).toEqual([
      'ask_secure_detail',
      'ask_form',
    ]);
    expect(normalizeClientCapabilities(undefined).size).toBe(0);
    expect(normalizeClientCapabilities('ask_form').size).toBe(0);
  });

  test('ask_form is a tool only for a client that renders it', () => {
    expect(liftToolsForAgent('b', 'UTC', undefined, {}).ask_form).toBeUndefined();
    expect(liftToolsForAgent('b', 'UTC', undefined, { askForm: true }).ask_form).toBeDefined();
    // The other asks stay for every client.
    expect(liftToolsForAgent('b', 'UTC', undefined, {}).ask_user).toBeDefined();
  });

  test('ask_secure_detail is a tool only for a client that renders it (and the store is on)', () => {
    expect(liftToolsForAgent('b', 'UTC', undefined, { askForm: true }).ask_secure_detail).toBeUndefined();
    const tool = liftToolsForAgent('b', 'UTC', undefined, { askSecureDetail: true }).ask_secure_detail;
    expect(tool).toBeDefined();
    expect(tool.execute).toBeUndefined();
  });

  test('the prompt sends secrets to Passwords and IDs only when the store is on', () => {
    expect(buildSystemPrompt({}, {})).toContain('say that Albatross cannot keep them yet');
    const on = buildSystemPrompt({}, { secureStore: true, askSecureDetail: true });
    expect(on).toContain('Settings, Passwords and IDs');
    expect(on).toContain('[removed: looks like a Social Security number]');
    expect(on).not.toContain('cannot keep them yet');
  });

  test('the prompt names ask_form only when the client renders it', () => {
    expect(buildSystemPrompt({}, {})).not.toContain('- ask_form:');
    expect(buildSystemPrompt({}, { askForm: true })).toContain('- ask_form: ONE form with typed fields');
  });
});
