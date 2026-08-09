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
  inboxDateGroupLabel,
  shortFrom,
  stripEmoji,
  TABLEAU10,
  unreadBadgeLabel,
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
  test('requires a word boundary after the subject match', () => {
    expect(dedupeSnippet('Order', 'Orderly dispatched')).toBe('Orderly dispatched');
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

describe('inboxDateGroupLabel', () => {
  // One frozen local reference time; every case derives from it with setDate,
  // so no assertion races the wall clock across midnight.
  const ref = new Date(2026, 6, 15, 12, 0, 0); // Wed Jul 15 2026, local noon
  const daysFromRef = (offset: number) => {
    const d = new Date(ref);
    d.setDate(d.getDate() + offset);
    return d;
  };
  test('labels today and yesterday in words', () => {
    expect(inboxDateGroupLabel(ref.getTime(), ref)).toBe('Today');
    expect(inboxDateGroupLabel(daysFromRef(-1).getTime(), ref)).toBe('Yesterday');
  });
  test('weekday labels carry the absolute date', () => {
    const date = daysFromRef(-3);
    const weekday = date.toLocaleDateString(undefined, { weekday: 'long' });
    const day = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    expect(inboxDateGroupLabel(date.getTime(), ref)).toBe(`${weekday} · ${day}`);
  });
  test('returns Undated for a missing timestamp', () => {
    expect(inboxDateGroupLabel(0, ref)).toBe('Undated');
  });
  test('a future date is never Today', () => {
    expect(inboxDateGroupLabel(daysFromRef(1).getTime(), ref)).not.toBe('Today');
  });
  test('older dates fall to month labels, with the year once it differs', () => {
    const may = new Date(2026, 4, 15, 12);
    expect(inboxDateGroupLabel(may.getTime(), ref)).toBe(
      may.toLocaleDateString(undefined, { month: 'long' }),
    );
    const lastYear = new Date(2025, 5, 15, 12);
    expect(inboxDateGroupLabel(lastYear.getTime(), ref)).toBe(
      lastYear.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }),
    );
  });
});

describe('unreadBadgeLabel', () => {
  test('renders real numbers only', () => {
    expect(unreadBadgeLabel(1)).toBe('1');
    expect(unreadBadgeLabel(99)).toBe('99');
  });
  test('drops zero, missing, and saturated counts', () => {
    expect(unreadBadgeLabel(0)).toBeNull();
    expect(unreadBadgeLabel(undefined)).toBeNull();
    expect(unreadBadgeLabel(100)).toBeNull();
    expect(unreadBadgeLabel(2500)).toBeNull();
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
