import { describe, expect, test } from 'bun:test';
import { pipStateFor } from '../components/albatross/IntentPip';

const intent = (id: string, status: string, updatedAt: number) => ({ _id: id, status, updatedAt }) as any;

describe('pipStateFor', () => {
  test('questions outrank planning, planning outranks ready', () => {
    const intents = [intent('a', 'planning', 3), intent('b', 'needs_answers', 2), intent('c', 'ready', 1)];
    expect(pipStateFor(intents, new Set(), new Set(['c']))).toEqual({ intentId: 'b', mode: 'question' });
    expect(pipStateFor([intents[0], intents[2]], new Set(), new Set(['c']))).toEqual({
      intentId: 'a',
      mode: 'planning',
    });
    expect(pipStateFor([intents[2]], new Set(), new Set(['c']))).toEqual({ intentId: 'c', mode: 'ready' });
  });

  test('ready only announces intents observed transitioning this session', () => {
    expect(pipStateFor([intent('old', 'ready', 5)], new Set(), new Set())).toBeNull();
  });

  test('dismissed intents never resurface; most recent wins within a mode', () => {
    const intents = [intent('a', 'planning', 1), intent('b', 'planning', 9)];
    expect(pipStateFor(intents, new Set(['b']), new Set())).toEqual({ intentId: 'a', mode: 'planning' });
    expect(pipStateFor(intents, new Set(), new Set())).toEqual({ intentId: 'b', mode: 'planning' });
    expect(pipStateFor(intents, new Set(['a', 'b']), new Set())).toBeNull();
    expect(pipStateFor(undefined, new Set(), new Set())).toBeNull();
  });
});
