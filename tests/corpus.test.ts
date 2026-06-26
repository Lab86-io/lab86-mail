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
