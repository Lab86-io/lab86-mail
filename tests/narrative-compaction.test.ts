import { describe, expect, test } from 'bun:test';
import {
  compactionBucket,
  narrativeAgeTier,
  narrativeWritingLimit,
  selectCompactionEvidence,
  writerEvidenceRows,
} from '../lib/narrative/compaction';
import { type NarrativeEntry, narrativeContext } from '../lib/narrative/core';

const day = 86_400_000;
function row(i: number, overrides: Partial<NarrativeEntry> = {}): NarrativeEntry {
  return {
    _id: `e${i}`,
    key: `e${i}`,
    level: 'observation',
    title: 'Evidence',
    text: 'Reported work',
    source: 'chat',
    sourceIds: [],
    topics: [],
    trust: 'reported',
    occurredAt: i,
    observedAt: i,
    updatedAt: i,
    current: true,
    pinned: false,
    ...overrides,
  };
}
describe('age-aware evidence compaction', () => {
  test('ages days into weeks and months with precise boundaries and local period keys', () => {
    const now = Date.parse('2026-09-09T01:00:00Z');
    expect([0, 13.99, 14, 89.99, 90, 900].map((age) => narrativeAgeTier(now - age * day, now))).toEqual([
      'day',
      'day',
      'week',
      'week',
      'month',
      'month',
    ]);
    expect(narrativeAgeTier(now + day, now)).toBe('day');
    expect(compactionBucket(row(1, { occurredAt: now }), 'America/New_York', now).key).toBe('day:2026-09-08');
    expect(
      compactionBucket(row(1, { occurredAt: Date.parse('2025-12-01T01:00:00Z') }), 'America/New_York', now)
        .key,
    ).toBe('month:2025-11');
    expect(narrativeWritingLimit('day', 'brief:today')).toBe(2200);
    expect(narrativeWritingLimit('week', 'week:x')).toBe(1800);
    expect(narrativeWritingLimit('month', 'month:x')).toBe(1400);
    expect(narrativeWritingLimit('thread', 'thread:x')).toBe(2200);
  });
  test('bounded selection preserves corrections, open commitments, chronology, source diversity, and raw input', () => {
    const rows = Array.from({ length: 500 }, (_, i) => row(i));
    rows[28] = row(28, { corrected: true });
    rows[315] = row(315, { pinned: true });
    rows[217] = row(217, { source: 'mcp:granola' });
    const before = JSON.stringify(rows);
    const selected = selectCompactionEvidence([...rows, rows[0]]);
    expect(selected).toHaveLength(60);
    expect(new Set(selected.map((r) => r._id)).size).toBe(60);
    for (const i of [0, 499, 28, 315, 217]) expect(selected.some((r) => r._id === `e${i}`)).toBe(true);
    expect(JSON.stringify(rows)).toBe(before);
    expect(selectCompactionEvidence([...rows].reverse())).toEqual(selected);
    expect(selectCompactionEvidence([])).toEqual([]);
    expect(selectCompactionEvidence([rows[2], rows[1], rows[2]])).toEqual([rows[1], rows[2]]);
  });
  test('stable priority sampling converges across repeated resumable scan windows', () => {
    const rows = Array.from({ length: 500 }, (_, i) => row(i));
    let stored: NarrativeEntry[] = [];
    const sweep = () => {
      for (let i = 0; i < rows.length; i += 80)
        stored = selectCompactionEvidence([...stored, ...selectCompactionEvidence(rows.slice(i, i + 80))]);
    };
    sweep();
    const first = stored;
    sweep();
    expect(stored).toEqual(first);
    expect(stored[0]._id).toBe('e0');
    expect(stored.at(-1)?._id).toBe('e499');
  });
  test('writer trims giant evidence without dropping later sources and prioritizes the brief intention', () => {
    const rows = [
      row(0, { text: 'x'.repeat(90000), title: 't'.repeat(900), topics: Array(90).fill('work:one') }),
      row(1, { source: 'checkins', text: 'Tomorrow I want to finish QA' }),
      row(2),
    ];
    const chosen = writerEvidenceRows(rows, 1100, true);
    expect(chosen[0]._id).toBe('e1');
    expect(chosen.map((r) => r._id)).toContain('e2');
    expect(narrativeContext(chosen).length).toBeLessThan(1800);
    expect(writerEvidenceRows(rows)[0].text.length).toBe(700);
    expect(writerEvidenceRows(rows)[0].title.length).toBe(160);
    expect(writerEvidenceRows(rows)[0].topics.length).toBe(8);
    expect(writerEvidenceRows(rows, 1)).toEqual([]);
  });
});
