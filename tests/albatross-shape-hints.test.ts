import { describe, expect, test } from 'bun:test';
import { parseCount, parseListHint, parseMetricHint, parseSeasonHorizon } from '../lib/albatross/shape-hints';
import { parseWorkSplit, shapeForSplitItem } from '../lib/albatross/work-v2';

const NOW = Date.parse('2026-09-03T12:00:00Z');

describe('parseCount', () => {
  test('reads digits, words, and compounds', () => {
    expect(parseCount('15')).toBe(15);
    expect(parseCount('1,500')).toBe(1500);
    expect(parseCount('2.5')).toBe(2.5);
    expect(parseCount('fifteen')).toBe(15);
    expect(parseCount('twenty five')).toBe(25);
    expect(parseCount('twenty-five')).toBe(25);
    expect(parseCount('two hundred')).toBe(200);
    expect(parseCount('a')).toBe(1);
  });

  test('returns null for words that are not numbers', () => {
    expect(parseCount('some')).toBeNull();
    expect(parseCount('')).toBeNull();
    expect(parseCount('the passport')).toBeNull();
  });
});

describe('parseListHint', () => {
  test('reads the doc example', () => {
    expect(parseListHint('Movie list: Heat, Alien, Dune part two')).toEqual({
      title: 'Movie list',
      items: ['Heat', 'Alien', 'Dune part two'],
    });
  });

  test('reads other list heads and separators', () => {
    expect(parseListHint('Books to read - Dune; Neuromancer and Snow Crash.')).toEqual({
      title: 'Books to read',
      items: ['Dune', 'Neuromancer', 'Snow Crash'],
    });
    expect(parseListHint('gift ideas: a scarf, good coffee')).toEqual({
      title: 'Gift ideas',
      items: ['a scarf', 'good coffee'],
    });
    expect(parseListHint('List of places to visit: Kyoto, Lisbon')?.items).toEqual(['Kyoto', 'Lisbon']);
  });

  test('reads a head line followed by one item per line', () => {
    expect(parseListHint('Movie list\n- Heat\n- Alien\n- Dune part two')).toEqual({
      title: 'Movie list',
      items: ['Heat', 'Alien', 'Dune part two'],
    });
  });

  test('one item is not a list, and plain Work is not a list', () => {
    expect(parseListHint('Movie list: Heat')).toBeNull();
    expect(parseListHint('Renew the passport before November')).toBeNull();
    expect(parseListHint('Book the dentist, then call mom')).toBeNull();
    expect(parseListHint('')).toBeNull();
  });
});

describe('parseSeasonHorizon', () => {
  test('by spring is the next spring start', () => {
    const horizon = parseSeasonHorizon('lose weight by spring', NOW);
    expect(horizon?.kind).toBe('now');
    expect(horizon?.label).toBe('by spring');
    const by = new Date(horizon!.by!);
    expect(by.getMonth()).toBe(2);
    expect(by.getDate()).toBe(20);
    expect(by.getTime()).toBeGreaterThan(NOW);
  });

  test('a season already started rolls to next year', () => {
    const horizon = parseSeasonHorizon('by summer', NOW);
    expect(new Date(horizon!.by!).getFullYear()).toBe(2027);
  });

  test('no season word means null', () => {
    expect(parseSeasonHorizon('by Friday', NOW)).toBeNull();
  });
});

describe('parseMetricHint', () => {
  test('reads the doc example', () => {
    const hint = parseMetricHint('Lose fifteen pounds by spring', NOW);
    expect(hint?.metric).toEqual({ name: 'weight', unit: 'lb', direction: 'down' });
    expect(hint?.delta).toBe(15);
    expect(hint?.horizon?.kind).toBe('now');
    expect(hint?.horizon?.label).toBe('by spring');
    expect(hint?.horizon?.by).toBeGreaterThan(NOW);
  });

  test('an absolute weight is a target', () => {
    expect(parseMetricHint('Get down to 170 lb', NOW)?.metric).toEqual({
      name: 'weight',
      unit: 'lb',
      target: 170,
      direction: 'down',
    });
    expect(parseMetricHint('get back up to 80 kg', NOW)?.metric).toEqual({
      name: 'weight',
      unit: 'kg',
      target: 80,
      direction: 'up',
    });
    expect(parseMetricHint('gain 5 kilos', NOW)?.metric.direction).toBe('up');
  });

  test('reads distance, steps, books, and savings', () => {
    expect(parseMetricHint('Run a 10k by October', NOW)?.metric).toEqual({
      name: 'distance',
      unit: 'km',
      target: 10,
      direction: 'up',
    });
    expect(parseMetricHint('run 5 miles', NOW)?.metric.unit).toBe('mi');
    expect(parseMetricHint('Walk 10,000 steps a day', NOW)?.metric).toEqual({
      name: 'steps',
      unit: 'steps',
      target: 10000,
      direction: 'up',
    });
    expect(parseMetricHint('Read twelve books this year', NOW)?.metric.target).toBe(12);
    expect(parseMetricHint('Save $5,000 for the trip', NOW)?.metric).toEqual({
      name: 'savings',
      unit: 'usd',
      target: 5000,
      direction: 'up',
    });
    expect(parseMetricHint('save 5k', NOW)?.metric.target).toBe(5000);
  });

  test('plain Work is not a metric goal', () => {
    expect(parseMetricHint('Renew the passport', NOW)).toBeNull();
    expect(parseMetricHint('Movie list: Heat, Alien', NOW)).toBeNull();
    expect(parseMetricHint('', NOW)).toBeNull();
  });
});

describe('shapeForSplitItem', () => {
  test('the model read wins when it is usable', () => {
    expect(
      shapeForSplitItem({ shape: 'list', listItems: ['Heat', ' Alien '] }, 'Movie list: Heat, Alien', NOW),
    ).toEqual({ shape: 'list', listItems: ['Heat', 'Alien'] });
    expect(
      shapeForSplitItem(
        { shape: 'practice', metric: { name: 'weight', unit: 'lb', target: 170, direction: 'down' } },
        'get to 170',
        NOW,
      ),
    ).toEqual({ shape: 'practice', metric: { name: 'weight', unit: 'lb', target: 170, direction: 'down' } });
  });

  test('the parsers fill a model read with no items or metric', () => {
    expect(shapeForSplitItem({ shape: 'list' }, 'Movie list: Heat, Alien', NOW).listItems).toEqual([
      'Heat',
      'Alien',
    ]);
    const practice = shapeForSplitItem({ shape: 'practice' }, 'Lose fifteen pounds by spring', NOW);
    expect(practice.metric).toEqual({ name: 'weight', unit: 'lb', direction: 'down' });
    expect(practice.horizon?.label).toBe('by spring');
  });

  test('a missing shape is read from the text', () => {
    expect(shapeForSplitItem({}, 'Movie list: Heat, Alien, Dune part two', NOW)).toEqual({
      shape: 'list',
      listItems: ['Heat', 'Alien', 'Dune part two'],
    });
    expect(shapeForSplitItem({}, 'Lose fifteen pounds by spring', NOW).shape).toBe('practice');
    expect(shapeForSplitItem({}, 'Renew the passport', NOW)).toEqual({ shape: undefined });
  });

  test('a model shape other than list or practice is kept as is', () => {
    expect(shapeForSplitItem({ shape: 'quick' }, 'Movie list: Heat, Alien', NOW)).toEqual({ shape: 'quick' });
  });
});

describe('parseWorkSplit with shape data', () => {
  test('accepts listItems and metric from the model', () => {
    const split = parseWorkSplit(
      JSON.stringify({
        work: [
          {
            title: 'Movie list',
            rawText: 'Movie list: Heat, Alien',
            shape: 'list',
            listItems: ['Heat', 'Alien'],
          },
          {
            title: 'Weight',
            rawText: 'Lose fifteen pounds',
            shape: 'practice',
            metric: { name: 'weight', unit: 'lb', target: null, direction: 'down' },
          },
        ],
      }),
      'dump',
    );
    expect(split.work[0].listItems).toEqual(['Heat', 'Alien']);
    expect(split.work[1].metric).toEqual({
      name: 'weight',
      unit: 'lb',
      target: undefined,
      direction: 'down',
    });
  });

  test('a malformed metric drops to undefined without failing the split', () => {
    const split = parseWorkSplit(
      JSON.stringify({ work: [{ title: 'W', rawText: 'text', shape: 'practice', metric: { unit: 'lb' } }] }),
      'dump',
    );
    expect(split.work).toHaveLength(1);
    expect(split.work[0].metric).toBeUndefined();
  });
});
