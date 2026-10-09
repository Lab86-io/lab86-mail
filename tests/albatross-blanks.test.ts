import { describe, expect, test } from 'bun:test';
import { cleanBlanks } from '../convex/albatrossStepRuns';
import { blankCountLabel, blankSentence, blankSentenceText, handoffBlanks } from '../lib/albatross/blanks';

describe('blank sentence', () => {
  test('no blanks draws nothing', () => {
    expect(blankSentence([])).toEqual([]);
    expect(blankSentence(['  '])).toEqual([]);
  });

  test('one, two, and three blanks join like a sentence', () => {
    expect(blankSentenceText(['hourly rate'])).toBe('Fill in hourly rate.');
    expect(blankSentenceText(['hours', 'rate'])).toBe('Fill in hours and rate.');
    expect(blankSentenceText(['hours for each week', 'hourly rate', 'invoice number'])).toBe(
      'Fill in hours for each week, hourly rate, and invoice number.',
    );
  });

  test('the parts keep each blank as its own part', () => {
    expect(blankSentence(['hours', 'rate'])).toEqual([
      { kind: 'text', text: 'Fill in ' },
      { kind: 'blank', name: 'hours' },
      { kind: 'text', text: ' and ' },
      { kind: 'blank', name: 'rate' },
      { kind: 'text', text: '.' },
    ]);
  });

  test('handoffBlanks reads an absent, null, or padded list', () => {
    expect(handoffBlanks(null)).toEqual([]);
    expect(handoffBlanks({})).toEqual([]);
    expect(handoffBlanks({ blanks: null })).toEqual([]);
    expect(handoffBlanks({ blanks: [' rate ', ''] })).toEqual(['rate']);
  });

  test('count label', () => {
    expect(blankCountLabel(1)).toBe('1 blank');
    expect(blankCountLabel(4)).toBe('4 blanks');
  });
});

describe('cleanBlanks (stored on the run)', () => {
  test('trims, drops empty and repeated names, and keeps six', () => {
    expect(cleanBlanks(undefined)).toEqual([]);
    expect(cleanBlanks(['  hourly   rate ', 'Hourly rate', '', 'a', 'b', 'c', 'd', 'e', 'f'])).toEqual([
      'hourly rate',
      'a',
      'b',
      'c',
      'd',
      'e',
    ]);
  });

  test('cuts a long name to 40 characters', () => {
    expect(cleanBlanks(['x'.repeat(60)])[0].length).toBeLessThanOrEqual(40);
  });
});
