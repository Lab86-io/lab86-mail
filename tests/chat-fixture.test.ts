import { describe, expect, test } from 'bun:test';
import {
  createFixtureTransport,
  fixtureShapes,
  fixtureTurn,
  stepsToStream,
} from '../lib/chat/preview-fixture';
import { nextRevealCursor, wordsPerTick } from '../lib/chat/reveal';

describe('chat stream fixture', () => {
  test('replays real UI chunks, shape siblings, failures, and a fresh id on each turn', async () => {
    const shapes = fixtureShapes(new Date(2026, 8, 11, 12).getTime());
    expect(Object.keys(shapes)).toHaveLength(5);
    const steps = fixtureTurn(0);
    const chunks = [];
    for await (const chunk of stepsToStream(steps, { speed: Infinity })) chunks.push(chunk);
    expect(chunks.some((chunk) => chunk.type === 'data-tool-shape')).toBe(true);
    expect(chunks.some((chunk) => chunk.type === 'tool-output-error')).toBe(true);
    expect(chunks.at(-1)?.type).toBe('finish');
    const transport = createFixtureTransport({ speed: Infinity });
    const options = { trigger: 'submit-message', chatId: 'fixture', messages: [] } as const;
    const first = await transport.sendMessages(options as any);
    const second = await transport.sendMessages(options as any);
    expect(await first.getReader().read()).not.toEqual(await second.getReader().read());
    expect(await transport.reconnectToStream({ chatId: 'fixture' })).toBeNull();
  });
  test('an aborted fixture yields no content', async () => {
    const signal = AbortSignal.abort();
    const reader = stepsToStream(fixtureTurn(0), { signal }).getReader();
    expect((await reader.read()).done).toBe(true);
  });
  test('word cursor helpers bound empty input and catch up a large backlog', () => {
    expect(wordsPerTick(0, false)).toBe(1);
    expect(wordsPerTick(1, false)).toBe(1);
    expect(wordsPerTick(100, false)).toBeGreaterThan(1);
    expect(wordsPerTick(100, true)).toBeGreaterThan(1);
    expect(nextRevealCursor('', 0, 0, false)).toBe(0);
    expect(nextRevealCursor('one two', 0, 2, false)).toBe(4);
    expect(nextRevealCursor('   ', 0, 0, true)).toBe(3);
  });
});
