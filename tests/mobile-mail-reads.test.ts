import { describe, expect, test } from 'bun:test';
import { MobileInputError } from '../lib/mobile/v1/http';
import { mailListCursor, mailListLimit, mailThreadSummariesFromCorpus } from '../lib/mobile/v1/mail-reads';

describe('mailThreadSummariesFromCorpus', () => {
  const good = {
    _id: 'thread-1',
    account: 'account-1',
    subject: 'Quarterly invoice',
    fromAddress: 'billing@vendor.com',
    lastDate: 1_755_000_000_000,
    snippet: 'Attached.',
    labels: ['INBOX'],
    unread: true,
    starred: false,
    messageCount: 1,
  };

  test('skips a row the schema rejects and keeps the rest of the page', () => {
    const skipped: number[] = [];
    const summaries = mailThreadSummariesFromCorpus(
      [good, { account: 'account-1', subject: 'No id at all' }, { ...good, _id: 'thread-3' }],
      (_error, index) => skipped.push(index),
    );
    expect(summaries.map((row) => row.id)).toEqual(['thread-1', 'thread-3']);
    expect(skipped).toEqual([1]);
  });

  test('maps a clean page without reporting anything', () => {
    const skipped: number[] = [];
    const summaries = mailThreadSummariesFromCorpus([good], (_error, index) => skipped.push(index));
    expect(summaries).toHaveLength(1);
    expect(skipped).toEqual([]);
  });

  test('works without a skip reporter', () => {
    expect(mailThreadSummariesFromCorpus([{ account: 'account-1' }])).toEqual([]);
  });
});

describe('mailListCursor', () => {
  test('absent cursors mean the first page', () => {
    expect(mailListCursor(null)).toBeUndefined();
    expect(mailListCursor('')).toBeUndefined();
  });

  test('parses a decimal epoch-ms watermark', () => {
    expect(mailListCursor('1754000000000')).toBe(1_754_000_000_000);
    expect(mailListCursor('0')).toBe(0);
  });

  test('rejects anything that is not a digit string as client input', () => {
    for (const raw of ['-1', '1.5', 'abc', '1e3', ' 12', '12 ']) {
      expect(() => mailListCursor(raw)).toThrow(MobileInputError);
    }
  });

  test('rejects watermarks beyond the safe integer range', () => {
    expect(() => mailListCursor('99999999999999999999')).toThrow(MobileInputError);
  });
});

describe('mailListLimit', () => {
  test('defaults to 50 and clamps into 1..100', () => {
    expect(mailListLimit(null)).toBe(50);
    expect(mailListLimit('')).toBe(50);
    expect(mailListLimit('25')).toBe(25);
    expect(mailListLimit('25.9')).toBe(25);
    expect(mailListLimit('0')).toBe(1);
    expect(mailListLimit('-7')).toBe(1);
    expect(mailListLimit('1000')).toBe(100);
  });

  test('falls back to the default for non-numeric input', () => {
    expect(mailListLimit('many')).toBe(50);
    expect(mailListLimit('Infinity')).toBe(50);
  });
});
