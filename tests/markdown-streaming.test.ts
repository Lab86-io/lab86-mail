import { describe, expect, test } from 'bun:test';
import { STREAMING_WORD_RISE } from '../components/ui/markdown';

describe('streaming chat reveal', () => {
  test('reveals streamed assistant copy word-by-word with the route-chip rise', () => {
    expect(STREAMING_WORD_RISE).toEqual({
      animation: 'rise',
      duration: 150,
      easing: 'cubic-bezier(0.165, 0.84, 0.44, 1)',
      sep: 'word',
      stagger: 0,
    });
  });
});
