import { describe, expect, test } from 'bun:test';
import { railHoverState } from '../lib/rail-hover';

describe('railHoverState', () => {
  test('an explicitly expanded rail is pinned — hover and focus change nothing', () => {
    expect(railHoverState(true, false, false)).toBe('pinned');
    expect(railHoverState(true, true, false)).toBe('pinned');
    expect(railHoverState(true, false, true)).toBe('pinned');
    expect(railHoverState(true, true, true)).toBe('pinned');
  });

  test('a collapsed rail peeks on hover', () => {
    expect(railHoverState(false, true, false)).toBe('peek');
  });

  test('a collapsed rail peeks on focus-within (keyboard users)', () => {
    expect(railHoverState(false, false, true)).toBe('peek');
    expect(railHoverState(false, true, true)).toBe('peek');
  });

  test('collapsed with no pointer and no focus stays collapsed', () => {
    expect(railHoverState(false, false, false)).toBe('collapsed');
  });
});
