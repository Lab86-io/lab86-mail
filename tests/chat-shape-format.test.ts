import { describe, expect, test } from 'bun:test';
import {
  fileKindLabel,
  formatCount,
  formatDue,
  formatEventSpan,
  formatProgress,
  formatShortDate,
  hostOf,
  joinWithMore,
  receiptTargetEntries,
} from '../lib/chat/shape-format';

const now = new Date(2026, 8, 11, 12);
const iso = (day: number, hour = 14) => new Date(2026, 8, day, hour).toISOString();

describe('chat result display values', () => {
  test('formats event spans and missing dates', () => {
    expect(formatEventSpan()).toBe('');
    expect(formatEventSpan('bad')).toBe('');
    expect(formatEventSpan(iso(11), iso(11, 15), false, now)).toContain('Today');
    expect(formatEventSpan(iso(12), undefined, false, now)).toContain('Tomorrow');
    expect(formatEventSpan(iso(10), 'bad', false, now)).toContain('Yesterday');
    expect(formatEventSpan(iso(11), iso(13), true, now)).toContain('all day');
    expect(formatEventSpan(iso(11), iso(12), true, now)).toBe('Today, all day');
    expect(formatEventSpan(iso(11), iso(12), false, now)).toContain('Tomorrow');
    expect(formatEventSpan('2025-01-01T12:00:00Z', undefined, false, now)).toContain('2025');
  });
  test('formats due dates and compact mail dates', () => {
    expect(formatDue()).toBe('');
    expect(formatDue('bad')).toBe('');
    expect(formatDue(iso(10), now)).toBe('Overdue 1d');
    expect(formatDue(iso(11), now)).toBe('Due today');
    expect(formatDue(iso(12), now)).toBe('Due tomorrow');
    expect(formatDue(iso(15), now)).toContain('15');
    expect(formatShortDate()).toBe('');
    expect(formatShortDate('bad')).toBe('');
    expect(formatShortDate(iso(11), now)).not.toContain('Sep');
    expect(formatShortDate(iso(15), now)).toContain('15');
    expect(formatShortDate('2025-01-01T12:00:00Z', now)).toContain('2025');
  });
  test('formats file kinds, people, progress, counts, sources, and receipts', () => {
    expect(joinWithMore([' Ann ', 'Bo', '', 'Cy', 'Dee'], 2)).toBe('Ann, Bo +2');
    expect(joinWithMore([' Ann '])).toBe('Ann');
    expect(fileKindLabel('Document')).toBe('Document');
    for (const [mime, label] of [
      ['application/vnd.google-apps.document', 'Google Doc'],
      ['application/vnd.google-apps.spreadsheet', 'Google Sheet'],
      ['application/vnd.google-apps.presentation', 'Google Slides'],
      ['application/pdf', 'PDF'],
      ['text/plain', 'plain'],
    ])
      expect(fileKindLabel(undefined, mime)).toBe(label);
    expect(fileKindLabel()).toBe('');
    expect(formatProgress()).toBe('');
    expect(formatProgress({ done: 2, total: 3 })).toBe('2 of 3 steps');
    expect(formatCount(123)).toBe('123');
    expect(formatCount(NaN)).toBe('0');
    expect(hostOf('https://www.example.test/path')).toBe('example.test');
    expect(hostOf('bad')).toBe('');
    expect(hostOf()).toBe('');
    expect(receiptTargetEntries()).toEqual([]);
    expect(
      receiptTargetEntries(
        { skip: null, empty: '', object: {}, long: 'a'.repeat(81), eventTitle: 'Call', count: 2 },
        1,
      ),
    ).toEqual([['event title', 'Call']]);
  });
});
