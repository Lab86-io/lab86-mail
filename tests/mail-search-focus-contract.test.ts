import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  focusMailResult,
  focusMailSearchInput,
  isEditableSearchTarget,
  isGlobalMailSearchShortcut,
  MAIL_SEARCH_TARGET_SELECTOR,
  mailSearchShortcutLabel,
  registerMailSearchFocus,
  requestMailSearchFocus,
} from '../lib/mail/search/focus-contract';

const read = (relativePath: string) => readFileSync(join(import.meta.dir, '..', relativePath), 'utf8');

const shortcut = (
  key: string,
  overrides: Partial<{ altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }> = {},
) => ({
  key,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  ...overrides,
});

describe('the global mail-search keyboard contract', () => {
  test('accepts slash and the platform Find shortcuts', () => {
    expect(isGlobalMailSearchShortcut(shortcut('/'), null)).toBe(true);
    expect(isGlobalMailSearchShortcut(shortcut('f', { metaKey: true }), null)).toBe(true);
    expect(isGlobalMailSearchShortcut(shortcut('F', { ctrlKey: true }), null)).toBe(true);
    expect(isGlobalMailSearchShortcut(shortcut('f'), null)).toBe(false);
    expect(isGlobalMailSearchShortcut(shortcut('/', { metaKey: true }), null)).toBe(false);
  });

  test('never steals search shortcuts from editable controls', () => {
    for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT']) {
      const target = { tagName } as unknown as EventTarget;
      expect(isEditableSearchTarget(target)).toBe(true);
      expect(isGlobalMailSearchShortcut(shortcut('/'), target)).toBe(false);
      expect(isGlobalMailSearchShortcut(shortcut('f', { metaKey: true }), target)).toBe(false);
    }
    expect(
      isEditableSearchTarget({ tagName: 'DIV', isContentEditable: true } as unknown as EventTarget),
    ).toBe(true);
  });

  test('publishes stable target and discoverable platform labels', () => {
    expect(MAIL_SEARCH_TARGET_SELECTOR).toBe('[data-mail-search-input="true"]');
    expect(mailSearchShortcutLabel('MacIntel')).toBe('⌘F');
    expect(mailSearchShortcutLabel('Win32')).toBe('Ctrl F');
  });

  test('routes both the rail action and keyboard shortcuts to the authoritative Inbox target', () => {
    const rail = read('components/shell/Rail.tsx');
    const shortcuts = read('components/shell/ShortcutsBinding.tsx');
    const inbox = read('components/inbox/Inbox.tsx');
    expect(rail).toContain("setPrimaryView('mail')");
    expect(rail).toContain('requestMailSearchFocus()');
    expect(rail).toContain('{searchShortcut}');
    expect(shortcuts).toContain('isGlobalMailSearchShortcut(e, e.target)');
    expect(shortcuts).not.toContain("querySelector('input[placeholder");
    expect(inbox).toContain('data-mail-search-input="true"');
    expect(inbox).toContain('registerMailSearchFocus()');
  });

  test('typed empty searches never offer natural-language-only recovery actions', () => {
    const inbox = read('components/inbox/Inbox.tsx');
    expect(inbox).toContain('nlSearchIntent ? (\n                <SearchEmptyState');
    expect(inbox).not.toContain('translatedQuery || nlSearchIntent ? (');
    expect(inbox).toContain('No mail matched your search');
    expect(inbox).toContain("setTranslatedSearch(null, nlSearchIntent, 'typed')");
    expect(inbox).not.toContain('aria-label="Clear generated filter"');
  });
});

function searchWindow() {
  const document = {
    activeElement: null as unknown,
    input: null as unknown,
    querySelector() {
      return this.input;
    },
  };
  const target = Object.assign(new EventTarget(), { document }) as unknown as Window;
  let focused = 0;
  let selected = 0;
  const input = {
    ownerDocument: document,
    focus() {
      focused++;
      document.activeElement = input;
    },
    select() {
      selected++;
    },
  };
  return { target, document, input, counts: () => ({ focused, selected }) };
}

describe('search focus survives navigation', () => {
  test('a request before the field mounts is consumed when Inbox registers', () => {
    const fixture = searchWindow();
    requestMailSearchFocus(fixture.target);
    expect(fixture.counts().focused).toBe(0);
    fixture.document.input = fixture.input;
    const cleanup = registerMailSearchFocus(fixture.target);
    expect(fixture.document.activeElement).toBe(fixture.input);
    expect(fixture.counts()).toEqual({ focused: 1, selected: 1 });
    cleanup();
    // An ordinary later visit must not replay the consumed request.
    const laterCleanup = registerMailSearchFocus(fixture.target);
    expect(fixture.counts().focused).toBe(1);
    laterCleanup();
  });

  test('opening search on an existing field selects the query for replacement', () => {
    const fixture = searchWindow();
    fixture.document.input = fixture.input;
    const cleanup = registerMailSearchFocus(fixture.target);
    requestMailSearchFocus(fixture.target);
    expect(fixture.document.activeElement).toBe(fixture.input);
    expect(fixture.counts().selected).toBeGreaterThan(0);
    cleanup();
  });

  test('missing or unfocusable fields do not report success', () => {
    const fixture = searchWindow();
    expect(focusMailSearchInput(fixture.document as unknown as ParentNode)).toBe(false);
    fixture.document.input = { ...fixture.input, focus() {} };
    expect(focusMailSearchInput(fixture.document as unknown as ParentNode)).toBe(false);
  });

  test('arrow navigation enters, traverses, and stops at the result boundaries', () => {
    let active = -1;
    let scrolled = -1;
    const rows = [0, 1, 2].map((index) => ({
      focus() {
        active = index;
      },
      scrollIntoView() {
        scrolled = index;
      },
    })) as unknown as HTMLElement[];
    const root = { querySelectorAll: () => rows } as unknown as ParentNode;
    expect(focusMailResult(root, 1)).toBe(true);
    expect(active).toBe(0);
    expect(focusMailResult(root, 1, rows[0])).toBe(true);
    expect(active).toBe(1);
    expect(scrolled).toBe(1);
    expect(focusMailResult(root, -1, rows[1])).toBe(true);
    expect(active).toBe(0);
    expect(focusMailResult(root, -1, rows[0])).toBe(false);
    expect(focusMailResult(root, -1)).toBe(true);
    expect(active).toBe(2);
    expect(focusMailResult(root, 1, rows[2])).toBe(false);
    expect(focusMailResult({ querySelectorAll: () => [] } as unknown as ParentNode, 1)).toBe(false);
  });
});
