import { describe, expect, test } from 'bun:test';
import {
  backfillPrompt,
  planShapeBackfill,
  planShapeWrite,
  type UnshapedWorkRow,
} from '../lib/albatross/shape-backfill';

const NOW = Date.UTC(2026, 8, 3, 12, 0, 0);

const row = (rawText: string, title: string | null = null): UnshapedWorkRow => ({
  workId: 'w1',
  title,
  rawText,
});

describe('planShapeWrite', () => {
  test('keeps a plain errand as quick', () => {
    const write = planShapeWrite(row('Book the dentist'), null, NOW);
    expect(write.shape).toBe('quick');
    expect(write.listItems).toBeUndefined();
    expect(write.metric).toBeUndefined();
  });

  test('reads a list from the text when the model says nothing', () => {
    const write = planShapeWrite(row('Movie list: Heat, Alien, Dune part two'), null, NOW);
    expect(write.shape).toBe('list');
    expect(write.listItems).toEqual(['Heat', 'Alien', 'Dune part two']);
  });

  test('reads a metric goal as a practice', () => {
    const write = planShapeWrite(row('Lose fifteen pounds by spring'), null, NOW);
    expect(write.shape).toBe('practice');
    expect(write.metric?.unit).toBe('lb');
    expect(write.metric?.direction).toBe('down');
  });

  test('a model verdict wins over the parsers', () => {
    const write = planShapeWrite(row('Ship the Mac app'), { shape: 'project' }, NOW);
    expect(write.shape).toBe('project');
  });

  test('a list without items falls back to quick', () => {
    const write = planShapeWrite(row('Some vague note'), { shape: 'list' }, NOW);
    expect(write.shape).toBe('quick');
    expect(write.listItems).toBeUndefined();
  });

  test('a practice without a metric falls back to quick', () => {
    const write = planShapeWrite(row('Get fitter'), { shape: 'practice' }, NOW);
    expect(write.shape).toBe('quick');
  });

  test('takes the horizon the text states', () => {
    const write = planShapeWrite(row('Renew the passport, not before November'), null, NOW);
    expect(write.horizon?.notBefore).toBeGreaterThan(NOW);
  });

  test('invents no horizon when the text gives none', () => {
    const write = planShapeWrite(row('Book the dentist'), null, NOW);
    expect(write.horizon).toBeUndefined();
  });

  test('caps a very long list', () => {
    const items = Array.from({ length: 80 }, (_, index) => `Item ${index}`);
    const write = planShapeWrite(row('List of things'), { shape: 'list', listItems: items }, NOW);
    expect(write.listItems).toHaveLength(50);
  });
});

describe('backfillPrompt', () => {
  test('names every row and clips long text', () => {
    const prompt = backfillPrompt([
      { workId: 'w1', title: 'Passport', rawText: 'x'.repeat(900) },
      { workId: 'w2', title: null, rawText: 'Book the dentist' },
    ]);
    expect(prompt).toContain('workId: w1');
    expect(prompt).toContain('title: Passport');
    expect(prompt).toContain('workId: w2');
    expect(prompt).not.toContain('x'.repeat(700));
  });
});

describe('planShapeBackfill', () => {
  const rows = [row('Movie list: Heat, Alien'), { ...row('Book the dentist'), workId: 'w2' }];

  test('uses the model verdicts when they arrive', async () => {
    const writes = await planShapeBackfill(rows, {
      generateObject: (async () => ({
        object: { verdicts: [{ workId: 'w2', shape: 'project' }] },
      })) as any,
      now: () => NOW,
    });
    expect(writes).toHaveLength(2);
    // w1 had no verdict, so the parser read the list.
    expect(writes[0]?.shape).toBe('list');
    expect(writes[1]?.shape).toBe('project');
  });

  test('still shapes every row when the model fails', async () => {
    const writes = await planShapeBackfill(rows, {
      generateObject: (async () => {
        throw new Error('model down');
      }) as any,
      now: () => NOW,
    });
    expect(writes.map((write) => write.shape)).toEqual(['list', 'quick']);
  });

  test('answers nothing for an empty batch', async () => {
    const writes = await planShapeBackfill([], {
      generateObject: (async () => {
        throw new Error('should not run');
      }) as any,
      now: () => NOW,
    });
    expect(writes).toEqual([]);
  });
});
