import { beforeEach, expect, test } from 'bun:test';
import { persistedClientState, useClientStore } from '../lib/client-state';

beforeEach(() => useClientStore.setState({ assistantPrompt: null, aiBarOpen: false }));

test('a palette request opens the assistant and is claimed exactly once', () => {
  const state = useClientStore.getState();
  expect(state.askAssistant('  Triage my newest 25 inbox threads ')).toBe(true);
  expect(useClientStore.getState().aiBarOpen).toBe(true);
  expect(useClientStore.getState().claimAssistantPrompt()).toBe('Triage my newest 25 inbox threads');
  expect(useClientStore.getState().claimAssistantPrompt()).toBeNull();
});

test('an empty request does nothing and a request never survives a reload', () => {
  expect(useClientStore.getState().askAssistant('   ')).toBe(false);
  expect(useClientStore.getState().aiBarOpen).toBe(false);
  useClientStore.getState().askAssistant('Summarize today');
  expect(persistedClientState(useClientStore.getState())).not.toHaveProperty('assistantPrompt');
});
