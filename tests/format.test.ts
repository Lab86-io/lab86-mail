import { describe, expect, test } from 'bun:test';
import {
  categoricalColor,
  dateToEpoch,
  dedupeSnippet,
  emailFromHeader,
  formatDate,
  fromColor,
  fromInitials,
  gmailUrlFor,
  shortFrom,
  stripEmoji,
  TABLEAU10,
} from '../lib/shared/format';

describe('shortFrom', () => {
  test('strips angle brackets and quotes', () => {
    expect(shortFrom('"Ada Lovelace" <ada@example.test>')).toBe('Ada Lovelace');
    expect(shortFrom('noreply@example.test')).toBe('noreply@example.test');
  });
  test('shows the bare address for an address-only header', () => {
    expect(shortFrom('<ada@example.test>')).toBe('ada@example.test');
  });
  test('falls back to raw value when stripping empties it', () => {
    expect(shortFrom('<>""')).toBe('<>""');
  });
});

describe('dedupeSnippet', () => {
  test('removes a leading subject echo and its separator', () => {
    expect(dedupeSnippet('Build failed for polish', 'Build failed for polish - project polish')).toBe(
      'project polish',
    );
  });
  test('tolerates case and whitespace differences', () => {
    expect(dedupeSnippet('Order shipped', 'order  shipped: arrives Friday')).toBe('arrives Friday');
  });
  test('returns an empty string when the snippet is only the subject', () => {
    expect(dedupeSnippet('Uptime alert', 'Uptime alert')).toBe('');
  });
  test('keeps a snippet that does not echo the subject', () => {
    expect(dedupeSnippet('Monthly report', 'Your vehicle is due for service')).toBe(
      'Your vehicle is due for service',
    );
  });
  test('keeps the snippet when the subject only partially matches', () => {
    expect(dedupeSnippet('Build failed for polish', 'Build failed')).toBe('Build failed');
  });
  test('handles empty inputs', () => {
    expect(dedupeSnippet('', 'anything')).toBe('anything');
    expect(dedupeSnippet('subject', '')).toBe('');
  });
});

describe('emailFromHeader', () => {
  test('extracts email from common header shapes', () => {
    expect(emailFromHeader('Tori <tori@example.test>')).toBe('tori@example.test');
    expect(emailFromHeader('tori@example.test')).toBe('tori@example.test');
    expect(emailFromHeader('')).toBeNull();
    expect(emailFromHeader('not-an-email')).toBeNull();
  });
});

describe('fromInitials', () => {
  test('derives one or two character initials', () => {
    expect(fromInitials('Ada Lovelace <ada@example.test>')).toBe('AL');
    expect(fromInitials('noreply@example.test')).toBe('NE');
    expect(fromInitials('')).toBe('?');
  });
});

describe('color helpers', () => {
  test('fromColor returns a CSS variable token', () => {
    expect(fromColor('ada@example.test')).toMatch(/^var\(--color-avatar-[1-5]\)$/);
    expect(fromColor('ada@example.test')).toBe(fromColor('ada@example.test'));
  });
  test('categoricalColor picks from TABLEAU10', () => {
    const color = categoricalColor('grant_123');
    expect(TABLEAU10).toContain(color);
    expect(categoricalColor('grant_123')).toBe(color);
  });
});

describe('dateToEpoch', () => {
  test('normalizes seconds, milliseconds, and ISO strings', () => {
    expect(dateToEpoch(1_700_000_000)).toBe(1_700_000_000_000);
    expect(dateToEpoch(1_700_000_000_000)).toBe(1_700_000_000_000);
    expect(dateToEpoch('2026-06-10T12:00:00.000Z')).toBe(Date.parse('2026-06-10T12:00:00.000Z'));
    expect(dateToEpoch(null)).toBe(0);
    expect(dateToEpoch('garbage')).toBe(0);
  });
});

describe('formatDate', () => {
  test('returns empty for missing values', () => {
    expect(formatDate(null)).toBe('');
    expect(formatDate(0)).toBe('');
  });
  test('formats a known historical date with year', () => {
    expect(formatDate('2020-01-15T12:00:00.000Z')).toContain('Jan 15');
  });
});

describe('gmailUrlFor', () => {
  test('builds a Gmail deep link', () => {
    expect(gmailUrlFor('jakob@example.test', 'thread_123')).toBe(
      'https://mail.google.com/mail/u/jakob%40example.test/#all/thread_123',
    );
  });
});

describe('stripEmoji', () => {
  test('removes pictographic characters and collapses whitespace', () => {
    expect(stripEmoji('Hello 👋  world')).toBe('Hello world');
    expect(stripEmoji('')).toBe('');
  });
});
