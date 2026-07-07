import { describe, expect, test } from 'bun:test';
import {
  HITL_TOOL_NAMES,
  isHitlToolName,
  lastMessageAnsweredHitl,
  rangeSelection,
  toggledOptionId,
} from '../lib/albatross/teach-ui';

describe('HITL tool identity', () => {
  test('covers every pause-and-wait tool', () => {
    for (const name of [
      'ask_user',
      'ask_approval',
      'ask_parameters',
      'ask_preferences',
      'ask_question_flow',
    ]) {
      expect(isHitlToolName(name)).toBe(true);
      expect(HITL_TOOL_NAMES.has(name)).toBe(true);
    }
    expect(isHitlToolName('show_chart')).toBe(false);
    expect(isHitlToolName('search_threads')).toBe(false);
  });
});

describe('lastMessageAnsweredHitl (auto-continue predicate)', () => {
  const assistant = (parts: any[]) => ({ role: 'assistant', parts });

  test('fires when any HITL tool part has its output', () => {
    expect(lastMessageAnsweredHitl([assistant([{ type: 'tool-ask_user', state: 'output-available' }])])).toBe(
      true,
    );
    expect(
      lastMessageAnsweredHitl([
        assistant([{ type: 'dynamic-tool', toolName: 'ask_approval', state: 'output-available' }]),
      ]),
    ).toBe(true);
  });

  test('stays quiet for pending questions, plain tools, and user turns', () => {
    expect(lastMessageAnsweredHitl([assistant([{ type: 'tool-ask_user', state: 'input-available' }])])).toBe(
      false,
    );
    expect(
      lastMessageAnsweredHitl([assistant([{ type: 'tool-search_threads', state: 'output-available' }])]),
    ).toBe(false);
    expect(lastMessageAnsweredHitl([{ role: 'user', parts: [] }])).toBe(false);
    expect(lastMessageAnsweredHitl([])).toBe(false);
  });
});

describe('toggledOptionId', () => {
  test('finds additions, removals, and no-ops', () => {
    expect(toggledOptionId(['a'], ['a', 'b'])).toBe('b');
    expect(toggledOptionId(['a', 'b'], ['a'])).toBe('b');
    expect(toggledOptionId(['a'], ['a'])).toBeNull();
    expect(toggledOptionId([], [])).toBeNull();
  });
});

describe('rangeSelection (shift-click)', () => {
  const ids = ['a', 'b', 'c', 'd', 'e'];

  test('selects the inclusive span between anchor and click', () => {
    expect(rangeSelection(ids, ['b'], 'd', 'b')).toEqual(['b', 'c', 'd']);
    expect(rangeSelection(ids, ['d'], 'a', 'd')).toEqual(['a', 'b', 'c', 'd']);
  });

  test('unions with the previous selection in on-screen order', () => {
    expect(rangeSelection(ids, ['a', 'e'], 'c', 'b')).toEqual(['a', 'b', 'c', 'e']);
  });

  test('falls back to a plain toggle without a valid anchor', () => {
    expect(rangeSelection(ids, ['a'], 'c', null)).toEqual(['a', 'c']);
    expect(rangeSelection(ids, ['a'], 'c', 'zz')).toEqual(['a', 'c']);
    expect(rangeSelection(ids, ['a', 'c'], 'c', 'zz')).toEqual(['a', 'c']);
  });

  test('ignores clicks outside the option list', () => {
    expect(rangeSelection(ids, ['a'], null, 'a')).toEqual(['a']);
    expect(rangeSelection(ids, ['a'], 'zz', 'a')).toEqual(['a', 'zz']);
  });
});
