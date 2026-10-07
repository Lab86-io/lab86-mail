import { describe, expect, test } from 'bun:test';
import {
  assistantLauncherPlacement,
  assistantShortcutTarget,
  capturePillHidden,
  isAssistantShortcut,
  isWorkThreadOpen,
} from '../lib/client-state';

// The floating "Ask Assistant" door on the web shell, and its ⌘K twin.
describe('the assistant launcher', () => {
  const free = { aiBarOpen: false, threadFullscreen: false, capturePillVisible: false, readerOpen: false };

  test('sits in the bottom-right corner when nothing else holds it', () => {
    expect(assistantLauncherPlacement(free)).toBe('corner');
  });

  test('leaves while its own panel is open or the reader is fullscreen', () => {
    expect(assistantLauncherPlacement({ ...free, aiBarOpen: true })).toBe('hidden');
    expect(assistantLauncherPlacement({ ...free, threadFullscreen: true })).toBe('hidden');
    expect(assistantLauncherPlacement({ ...free, aiBarOpen: true, capturePillVisible: true })).toBe('hidden');
  });

  test('hides on the Work thread, where the page is the chat', () => {
    expect(assistantLauncherPlacement({ ...free, workThreadOpen: true })).toBe('hidden');
    expect(assistantLauncherPlacement({ ...free, workThreadOpen: false })).toBe('corner');
  });

  test('stacks above the New Intent pill and an open reader instead of overlapping', () => {
    expect(assistantLauncherPlacement({ ...free, capturePillVisible: true })).toBe('stacked');
    expect(assistantLauncherPlacement({ ...free, readerOpen: true })).toBe('stacked');
  });

  test('follows the same corner rules the capture pill uses', () => {
    // Expanded desktop rail: the capture pill hides, so the corner is free.
    const railExpanded = !capturePillHidden(false, true, false, false);
    expect(assistantLauncherPlacement({ ...free, capturePillVisible: railExpanded })).toBe('corner');
    // Collapsed rail or mobile: the capture pill is back, so stack.
    const railCollapsed = !capturePillHidden(false, false, false, false);
    expect(assistantLauncherPlacement({ ...free, capturePillVisible: railCollapsed })).toBe('stacked');
  });
});

describe('the Work thread', () => {
  test('is open when one Albatross is selected on the Albatrosses or Areas page', () => {
    expect(isWorkThreadOpen({ primaryView: 'albatrosses', selectedWorkId: 'w1' })).toBe(true);
    expect(isWorkThreadOpen({ primaryView: 'areas', selectedWorkId: 'w1' })).toBe(true);
    expect(isWorkThreadOpen({ primaryView: 'albatrosses', selectedWorkId: null })).toBe(false);
    expect(isWorkThreadOpen({ primaryView: 'mail', selectedWorkId: 'w1' })).toBe(false);
  });

  test('takes the shortcut: ⌘K focuses the thread composer there, and toggles the panel elsewhere', () => {
    expect(assistantShortcutTarget({ primaryView: 'albatrosses', selectedWorkId: 'w1' })).toBe('thread');
    expect(assistantShortcutTarget({ primaryView: 'today', selectedWorkId: 'w1' })).toBe('assistant');
    expect(assistantShortcutTarget({ primaryView: 'albatrosses', selectedWorkId: null })).toBe('assistant');
  });
});

describe('the assistant shortcut', () => {
  test('is ⌘K on the Mac and Ctrl+K elsewhere', () => {
    expect(isAssistantShortcut({ key: 'k', metaKey: true, ctrlKey: false })).toBe(true);
    expect(isAssistantShortcut({ key: 'K', metaKey: false, ctrlKey: true })).toBe(true);
  });

  test('ignores plain k, other modifier combinations, and other keys', () => {
    expect(isAssistantShortcut({ key: 'k', metaKey: false, ctrlKey: false })).toBe(false);
    expect(isAssistantShortcut({ key: 'k', metaKey: true, ctrlKey: false, shiftKey: true })).toBe(false);
    expect(isAssistantShortcut({ key: 'k', metaKey: true, ctrlKey: false, altKey: true })).toBe(false);
    expect(isAssistantShortcut({ key: 'p', metaKey: true, ctrlKey: false })).toBe(false);
  });
});
