import { afterEach, describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { Avatar } from '../components/ui/avatar';
import { settingsTabFromSearch } from '../lib/albatross/teach-ui';
import { persistedClientState, useClientStore } from '../lib/client-state';
import { searchPages } from '../lib/search/global-search';
import { navigateSearchTarget } from '../lib/search/navigation';
import { decodeMailText, dedupeSnippet } from '../lib/shared/format';
import { assistantAfterPageNavigation } from '../lib/shell/assistant-navigation';

describe('workspace foundations', () => {
  const initial = useClientStore.getState();
  afterEach(() => useClientStore.setState(initial, true));

  test('Chat is a destination around the current page, preserving its context', () => {
    useClientStore.setState({
      primaryView: 'mail',
      selectedThreadId: 'thread-a',
      selectedWorkId: 'work-a',
      query: 'from:alex',
      accountFilter: ['mailbox-a'],
      aiBarOpen: false,
    });
    const paths: string[] = [];
    navigateSearchTarget({ kind: 'page', view: 'chat' }, useClientStore.getState(), (path) =>
      paths.push(path),
    );
    expect(useClientStore.getState()).toMatchObject({
      primaryView: 'mail',
      selectedThreadId: 'thread-a',
      selectedWorkId: 'work-a',
      query: 'from:alex',
      accountFilter: ['mailbox-a'],
      aiBarOpen: true,
      assistantPresentation: 'full',
    });
    expect(paths).toEqual(['/?view=chat']);
    useClientStore.getState().setAssistantPresentation('full');
    useClientStore.getState().setAssistantPresentation('corner');
    useClientStore.getState().setAiBarOpen(false);
    expect(useClientStore.getState()).toMatchObject({ primaryView: 'mail', selectedThreadId: 'thread-a' });
    expect(persistedClientState(useClientStore.getState())).not.toHaveProperty('assistantPresentation');
  });

  test('Chat, Notifications and Appearance are directly discoverable', () => {
    expect(
      searchPages('chat').some((item) => item.target.kind === 'page' && item.target.view === 'chat'),
    ).toBe(true);
    expect(
      searchPages('notifications').some(
        (item) => item.target.kind === 'page' && item.target.view === 'notifications',
      ),
    ).toBe(true);
    expect(settingsTabFromSearch('appearance')).toBe('appearance');
  });

  test('leaving the Chat destination closes it without discarding the conversation', () => {
    useClientStore.setState({ aiBarOpen: true, assistantPresentation: 'full', lastChatId: 'chat-a' });
    navigateSearchTarget({ kind: 'page', view: 'calendar' }, useClientStore.getState(), () => {});
    expect(useClientStore.getState()).toMatchObject({
      primaryView: 'calendar',
      aiBarOpen: false,
      assistantPresentation: 'corner',
      lastChatId: 'chat-a',
    });
    const full = { aiBarOpen: true, assistantPresentation: 'full' as const };
    for (const viewport of [{ mobile: true }, { availableWidth: 645 }, { availableWidth: 1440 }]) {
      expect(assistantAfterPageNavigation(full, viewport)).toEqual({
        aiBarOpen: false,
        assistantPresentation: 'corner',
      });
    }
    expect(assistantAfterPageNavigation({ ...full, aiBarOpen: false }, { mobile: true })).toEqual({});
    expect(assistantAfterPageNavigation({ ...full, assistantPresentation: 'corner' })).toEqual({});
  });

  test('an intentional split survives page navigation only when both panes fit', () => {
    const split = { aiBarOpen: true, assistantPresentation: 'split' as const };
    expect(assistantAfterPageNavigation(split, { availableWidth: 646 })).toEqual({});
    expect(assistantAfterPageNavigation(split, { availableWidth: 645 })).toEqual({ aiBarOpen: false });
    expect(assistantAfterPageNavigation(split, { mobile: true })).toEqual({ aiBarOpen: false });
    useClientStore.setState(split);
    useClientStore.getState().setPrimaryView('calendar');
    expect(useClientStore.getState()).toMatchObject({ primaryView: 'calendar', ...split });
  });

  test('the launcher invitation is transient and Sidebar Chat starts with its own invitation', () => {
    useClientStore.getState().setAssistantInvitation('Draft an email');
    expect(useClientStore.getState().assistantInvitation).toBe('Draft an email');
    expect(persistedClientState(useClientStore.getState())).not.toHaveProperty('assistantInvitation');
    useClientStore.getState().setPrimaryView('chat');
    expect(useClientStore.getState().assistantInvitation).toBeNull();
  });

  test('mail text decodes once and remains plain text, including hostile and invalid entities', () => {
    expect(decodeMailText('You&#39;re &quot;here&quot; &amp; ready&#x2014;yes&nbsp;')).toBe(
      'You\'re "here" & ready—yes ',
    );
    expect(decodeMailText('&lt;script&gt;alert(1)&lt;/script&gt;')).toBe('<script>alert(1)</script>');
    expect(decodeMailText('&amp;lt;script&amp;gt;')).toBe('&lt;script&gt;');
    expect(decodeMailText('&#x110000; &#xD800; &#0; &unknown;')).toBe('&#x110000; &#xD800; &#0; &unknown;');
    expect(dedupeSnippet('You’re invited', 'You’re invited — It&#39;s tomorrow')).toBe("It's tomorrow");
    expect(dedupeSnippet("It's here", 'It&#39;s here — Read more')).toBe('Read more');
  });

  test('photo and fallback share one ring owner with no competing shadow', () => {
    for (const src of [undefined, 'https://example.test/avatar.png']) {
      const html = renderToStaticMarkup(<Avatar name="Alex Example" src={src} size={28} ringColor="red" />);
      expect(html).toContain('width:28px;height:28px;border-color:red');
      expect(html).not.toContain('shadow-');
      expect(html).toContain('rounded-full');
    }
  });
});
