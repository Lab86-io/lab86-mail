import { describe, expect, test } from 'bun:test';
import {
  advanceReveal,
  countWords,
  nextWordEnd,
  type RevealProgress,
  WORD_CADENCE_MS,
} from '../lib/chat/reveal';

describe('chat word reveal', () => {
  test('releases one word at the base cadence', () => {
    const next = advanceReveal('one two three', { cursor: 0, deadline: null, finished: false }, 0, false);
    expect('one two three'.slice(0, next.cursor)).toBe('one ');
    expect(nextWordEnd('  hello\nworld', 0)).toBe(7);
    expect(countWords('hello\nworld')).toBe(2);
  });

  for (const size of [1, 40, 100, 1000, 10000]) {
    test(`drains ${size} words within 400ms after completion`, () => {
      const text = Array.from({ length: size }, (_, i) => `word${i}`).join(' ');
      let state: RevealProgress = { cursor: 0, deadline: null, finished: false };
      for (let now = 0; now < 400; now += WORD_CADENCE_MS) state = advanceReveal(text, state, now, true);
      expect(state.cursor).toBe(text.length);
    });
  }

  test('catches a large chunk within 600ms without a new budget on each tick', () => {
    const text = 'large backlog '.repeat(1000);
    let state: RevealProgress = { cursor: 0, deadline: null, finished: false };
    for (let now = 0; now < 600; now += WORD_CADENCE_MS) state = advanceReveal(text, state, now, false);
    expect(state.cursor).toBe(text.length);
  });
});
