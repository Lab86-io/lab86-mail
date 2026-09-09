import { describe, expect, test } from 'bun:test';
import { SEARCH_SCOPES, type SearchScope } from '../lib/search/global-search';
import { searchScopeForArrow } from '../lib/search/navigation';

const key = (value: string, overrides: Record<string, boolean> = {}) => ({
  key: value,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  isComposing: false,
  defaultPrevented: false,
  ...overrides,
});
const caret = (value: string, start: number | null, end = start) => ({
  value,
  selectionStart: start,
  selectionEnd: end,
});

describe('search category keyboard navigation', () => {
  test('cycles through the displayed categories in both directions and wraps', () => {
    let scope: SearchScope = 'all';
    for (const expected of ['mail', 'files', 'calendar', 'all'] as const) {
      scope = searchScopeForArrow(key('ArrowRight'), scope, caret('', 0))!;
      expect(scope).toBe(expected);
    }
    for (const expected of ['calendar', 'files', 'mail', 'all'] as const) {
      scope = searchScopeForArrow(key('ArrowLeft'), scope, caret('', 0))!;
      expect(scope).toBe(expected);
    }
    expect(SEARCH_SCOPES.map((scope) => scope.label)).toEqual(['Everything', 'Mail', 'Files', 'Calendar']);
  });

  test('switches only at the outward query edge and preserves the query and caret', () => {
    const input = caret('project notes', 13);
    expect(searchScopeForArrow(key('ArrowRight'), 'all', input)).toBe('mail');
    expect(searchScopeForArrow(key('ArrowLeft'), 'all', input)).toBeNull();
    expect(input).toEqual(caret('project notes', 13));
    expect(searchScopeForArrow(key('ArrowLeft'), 'mail', caret('project notes', 0))).toBe('all');
    expect(searchScopeForArrow(key('ArrowRight'), 'mail', caret('project notes', 0))).toBeNull();
    for (const arrow of ['ArrowLeft', 'ArrowRight']) {
      expect(searchScopeForArrow(key(arrow), 'files', caret('project notes', 4))).toBeNull();
      expect(searchScopeForArrow(key(arrow), 'files', caret('project notes', 0, 13))).toBeNull();
      expect(searchScopeForArrow(key(arrow), 'files', caret('project notes', null))).toBeNull();
    }
  });

  test('preserves modifiers, composition, prevented events, and vertical result navigation', () => {
    for (const modifier of ['altKey', 'ctrlKey', 'metaKey', 'shiftKey', 'isComposing', 'defaultPrevented']) {
      for (const arrow of ['ArrowLeft', 'ArrowRight']) {
        expect(searchScopeForArrow(key(arrow, { [modifier]: true }), 'all', caret('', 0))).toBeNull();
      }
    }
    for (const value of ['ArrowUp', 'ArrowDown', 'Enter', 'Escape', 'Tab', 'a']) {
      expect(searchScopeForArrow(key(value), 'all', caret('', 0))).toBeNull();
    }
  });

  test('focused category buttons can switch without a caret restriction', () => {
    expect(searchScopeForArrow(key('ArrowRight'), 'mail')).toBe('files');
    expect(searchScopeForArrow(key('ArrowLeft'), 'all')).toBe('calendar');
  });
});
