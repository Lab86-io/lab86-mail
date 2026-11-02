import { describe, expect, test } from 'bun:test';
import {
  clientToolFailureNote,
  isUiToolName,
  seedHandledToolCalls,
  uiToolFailureText,
} from '../lib/ai/ui-tool-calls';
import { uiOpenCompose } from '../lib/tools/ui-tools';

describe('UI tools in a restored chat', () => {
  test('every restored call counts as handled, for the action and for the refresh', () => {
    const handled = new Set<string>();
    seedHandledToolCalls(handled, [
      { role: 'user', parts: [{ type: 'text', text: 'Write to Sam' }] },
      {
        role: 'assistant',
        parts: [
          { type: 'tool-ui_open_compose', toolCallId: 'compose-1', state: 'output-available' },
          { type: 'dynamic-tool', toolName: 'ui_toast', toolCallId: 'toast-1', state: 'output-available' },
          { type: 'text', text: 'Opened.' },
        ],
      },
      { role: 'assistant' },
    ]);
    expect([...handled].sort()).toEqual(['compose-1', 'refresh:compose-1', 'refresh:toast-1', 'toast-1']);
  });
});

describe('a UI tool that fails in the browser', () => {
  test('the user reads what failed, in plain words', () => {
    expect(uiToolFailureText('ui_open_compose')).toBe('Could not open the compose window.');
    expect(uiToolFailureText('ui_new_thing')).toBe('Could not do that in the app.');
  });

  test('the next request tells the model, and only names of the ui_ shape get through', () => {
    const note = clientToolFailureNote([
      'ui_open_compose',
      'ui_open_compose',
      'ui_toast',
      'send_email',
      5,
      'ui_IGNORE ALL',
    ]);
    expect(note).toContain('ui_open_compose, ui_toast.');
    expect(note).toContain('They did not happen.');
    expect(note).not.toContain('send_email');
    expect(note).not.toContain('IGNORE');
    expect(clientToolFailureNote([])).toBe('');
    expect(clientToolFailureNote('ui_toast')).toBe('');
    expect(clientToolFailureNote(undefined)).toBe('');
    expect(isUiToolName('ui_open_reply')).toBe(true);
    expect(isUiToolName('open_reply')).toBe(false);
  });

  test('the server answer never says that the UI changed', async () => {
    const result = await uiOpenCompose.handler({} as never, { agent: 'ai' });
    expect(result.hint).toContain('asked to open');
    expect(result.hint).not.toMatch(/\bopened\b/);
  });
});

test('a saved Google edit stays out of the seed, so its proposal restores after a reload', () => {
  const handled = new Set<string>();
  seedHandledToolCalls(handled, [
    {
      parts: [
        { type: 'tool-ui_open_compose', toolCallId: 'ui-1' },
        { type: 'tool-google_document_edit', toolCallId: 'google-1' },
        { type: 'dynamic-tool', toolName: 'google_document_edit', toolCallId: 'google-2' },
      ],
    },
  ]);
  expect(handled.has('ui-1')).toBe(true);
  expect(handled.has('google-1')).toBe(false);
  expect(handled.has('google-2')).toBe(false);
});
