import { describe, expect, test } from 'bun:test';
import { persistedClientState, useClientStore } from '../lib/client-state';
import { PRIMARY_VIEWS } from '../lib/shared/types';
import {
  type AssistantDocumentContext,
  assistantPageContext,
  assistantPhrases,
} from '../lib/shell/assistant-context';

const document: AssistantDocumentContext = {
  id: 'doc-1',
  title: 'Proposal',
  kind: 'doc',
  provider: 'albatross',
  revision: 3,
  dirty: false,
};
describe('page-aware assistant', () => {
  test('every destination supplies several stable invitations', () => {
    for (const view of PRIMARY_VIEWS) {
      expect(assistantPhrases(view, null).length).toBeGreaterThanOrEqual(2);
      expect(assistantPhrases(view, null)).toBe(assistantPhrases(view, null));
    }
    expect(assistantPhrases('files', document)[0]).toBe('Edit this document');
    expect(assistantPhrases('mail', document)[0]).toBe('Draft an email');
  });
  test('open document metadata is scoped to Files and retains unsaved-state semantics', () => {
    expect(assistantPageContext('files', document)).toContain('document_get');
    expect(assistantPageContext('files', { ...document, dirty: true })).toContain('Do not modify');
    expect(assistantPageContext('calendar', document)).not.toContain('doc-1');
    expect(
      assistantPageContext('files', { ...document, provider: 'google', connectionId: 'drive-1' }),
    ).toContain('google_document_get');
  });
  test('document context never persists and does not reset conversation identity', () => {
    const previous = useClientStore.getState();
    useClientStore.setState({
      lastChatId: 'chat-1',
      chatScopeKind: 'global',
      assistantPresentation: 'split',
    });
    useClientStore.getState().setAssistantDocument(document);
    expect(useClientStore.getState().lastChatId).toBe('chat-1');
    expect(persistedClientState(useClientStore.getState())).not.toHaveProperty('assistantDocument');
    useClientStore.setState(previous);
  });
});
