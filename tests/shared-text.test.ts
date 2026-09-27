import { describe, expect, test } from 'bun:test';
import { safeSlice, stripLoneSurrogates, stripLoneSurrogatesDeep, truncateText } from '../lib/shared/text';

const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const EMOJI = '\u{1F600}';
const HIGH = EMOJI[0];
const LOW = EMOJI[1];

describe('safeSlice', () => {
  test('matches String.prototype.slice for plain text', () => {
    const text = 'Please confirm the budget by Friday.';
    const cases: Array<[number | undefined, number | undefined]> = [
      [undefined, undefined],
      [0, undefined],
      [0, 6],
      [7, 14],
      [-7, undefined],
      [-7, -1],
      [3, 2],
      [0, 999],
      [999, undefined],
      [-999, 4],
      [0, 0],
      [Number.NaN, 5],
      [1.9, 4.2],
      [0, Number.POSITIVE_INFINITY],
    ];
    for (const [start, end] of cases) expect(safeSlice(text, start, end)).toBe(text.slice(start, end));
    expect(safeSlice('', 0, 10)).toBe('');
  });

  test('never ends right after a high surrogate', () => {
    const text = `ab${EMOJI}cd`;
    // A plain cut at index 3 keeps only the high half of the emoji.
    expect(LONE.test(text.slice(0, 3))).toBe(true);
    expect(safeSlice(text, 0, 3)).toBe('ab');
    expect(safeSlice(text, 0, 4)).toBe(`ab${EMOJI}`);
    expect(safeSlice(text, 0, 2)).toBe('ab');
    expect(safeSlice(EMOJI, 0, 1)).toBe('');
    expect(safeSlice(text, 0, -3)).toBe('ab');
  });

  test('never starts on a low surrogate', () => {
    const text = `ab${EMOJI}cd`;
    expect(LONE.test(text.slice(3))).toBe(true);
    expect(safeSlice(text, 3)).toBe('cd');
    expect(safeSlice(text, 2)).toBe(`${EMOJI}cd`);
    expect(safeSlice(text, -3)).toBe('cd');
    expect(safeSlice(text, 3, 5)).toBe('c');
    expect(safeSlice(EMOJI, 1)).toBe('');
  });

  test('handles emoji at both window edges and adjacent pairs', () => {
    const text = `${EMOJI}${EMOJI}x${EMOJI}`;
    for (let start = -text.length; start <= text.length; start++)
      for (let end = -text.length; end <= text.length + 1; end++) {
        const cut = safeSlice(text, start, end);
        expect(LONE.test(cut)).toBe(false);
        expect(text.slice(start, end).includes(cut)).toBe(true);
        expect(text.slice(start, end).length - cut.length).toBeLessThanOrEqual(2);
      }
  });
});

describe('truncateText', () => {
  test('keeps plain text and whole emoji within the limit', () => {
    expect(truncateText('hello world', 5)).toBe('hello');
    expect(truncateText('short', 50)).toBe('short');
    const body = `${'x'.repeat(2399)}${EMOJI}tail`;
    expect(LONE.test(body.slice(0, 2400))).toBe(true);
    expect(truncateText(body, 2400)).toBe('x'.repeat(2399));
    expect(truncateText(body, 2401)).toBe(`${'x'.repeat(2399)}${EMOJI}`);
    expect(truncateText(body, 2400).length).toBeLessThanOrEqual(2400);
  });

  test('passes a nullish value through like optional chaining', () => {
    expect(truncateText(undefined, 5)).toBeUndefined();
    expect(truncateText(null, 5)).toBeNull();
    expect(truncateText('', 5)).toBe('');
  });
});

describe('stripLoneSurrogates', () => {
  test('replaces lone halves and keeps valid pairs', () => {
    expect(stripLoneSurrogates('plain text')).toBe('plain text');
    expect(stripLoneSurrogates(`a${EMOJI}b`)).toBe(`a${EMOJI}b`);
    expect(stripLoneSurrogates(`a${HIGH}`)).toBe('a\uFFFD');
    expect(stripLoneSurrogates(`${LOW}a`)).toBe('\uFFFDa');
    expect(stripLoneSurrogates(`${HIGH}${HIGH}${LOW}`)).toBe(`\uFFFD${EMOJI}`);
    expect(stripLoneSurrogates(`${HIGH}${LOW}${LOW}`)).toBe(`${EMOJI}\uFFFD`);
    expect(stripLoneSurrogates(`${LOW}${HIGH}`)).toBe('\uFFFD\uFFFD');
    const cleaned = stripLoneSurrogates(`${HIGH}x${LOW}${EMOJI}${HIGH}`);
    expect(LONE.test(cleaned)).toBe(false);
    expect(JSON.parse(JSON.stringify(cleaned))).toBe(`\uFFFDx\uFFFD${EMOJI}\uFFFD`);
  });
});

describe('stripLoneSurrogatesDeep', () => {
  test('cleans each string and key in a plain value and keeps other values', () => {
    const input = {
      subject: `Plan ${HIGH}`,
      labels: ['INBOX', `x${LOW}`],
      headers: { [`k${HIGH}`]: `v${EMOJI}` },
      attachments: [{ filename: `a${LOW}.pdf`, size: 3 }],
      unread: true,
      count: 2,
      missing: undefined,
      empty: null,
    };
    const when = new Date(0);
    expect(stripLoneSurrogatesDeep(input)).toEqual({
      subject: 'Plan \uFFFD',
      labels: ['INBOX', 'x\uFFFD'],
      headers: { 'k\uFFFD': `v${EMOJI}` },
      attachments: [{ filename: 'a\uFFFD.pdf', size: 3 }],
      unread: true,
      count: 2,
      missing: undefined,
      empty: null,
    });
    expect(stripLoneSurrogatesDeep(when)).toBe(when);
    expect(stripLoneSurrogatesDeep(`${HIGH}`)).toBe('\uFFFD');
    expect(stripLoneSurrogatesDeep(7)).toBe(7);
  });
});
