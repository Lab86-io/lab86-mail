import { describe, expect, test } from 'bun:test';
import {
  buildCorpusSearchText,
  CORPUS_SEARCH_TEXT_MAX_CHARS,
  normalizeCorpusText,
  yearMonthFromTimestamp,
} from '../lib/mail/corpus';

describe('normalizeCorpusText', () => {
  test('collapses whitespace and caps length', () => {
    expect(normalizeCorpusText('  hello   world  ', 10)).toBe('hello worl');
    expect(normalizeCorpusText(null)).toBe('');
  });

  test('never cuts an emoji in half at the cap', () => {
    const emoji = '\u{1F600}';
    expect(normalizeCorpusText(`hello${emoji}`, 6)).toBe('hello');
    const body = `${'x'.repeat(CORPUS_SEARCH_TEXT_MAX_CHARS - 1)}${emoji}`;
    const text = buildCorpusSearchText({ textBody: body });
    expect(text).toBe('x'.repeat(CORPUS_SEARCH_TEXT_MAX_CHARS - 1));
    expect(JSON.stringify(text)).not.toMatch(/\\ud[89a-f][0-9a-f]{2}/i);
  });
});

describe('buildCorpusSearchText', () => {
  test('joins searchable fields and respects max length', () => {
    const text = buildCorpusSearchText({
      subject: 'Invoice',
      from: 'Billing <billing@example.test>',
      labels: ['INBOX'],
      textBody: 'x'.repeat(CORPUS_SEARCH_TEXT_MAX_CHARS + 100),
    });
    expect(text).toContain('Invoice');
    expect(text).toContain('billing@example.test');
    expect(text.length).toBe(CORPUS_SEARCH_TEXT_MAX_CHARS);
  });
});

describe('yearMonthFromTimestamp', () => {
  test('formats UTC year-month buckets', () => {
    expect(yearMonthFromTimestamp(Date.parse('2026-06-10T13:00:00.000Z'))).toBe('2026-06');
    expect(yearMonthFromTimestamp(Number.NaN, Date.parse('2026-02-01T00:00:00Z'))).toBe('2026-02');
  });
});
