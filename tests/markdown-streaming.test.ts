import { describe, expect, test } from 'bun:test';
import { STREAMING_WORD_FADE } from '../components/ui/markdown';

describe('streaming chat reveal', () => {
  test('reveals streamed assistant copy word-by-word with a short fade', () => {
    expect(STREAMING_WORD_FADE).toEqual({
      animation: 'fadeIn',
      duration: 180,
      sep: 'word',
      stagger: 24,
    });
  });
});
