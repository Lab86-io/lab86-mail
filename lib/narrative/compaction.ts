import { type NarrativeEntry, narrativePeriods } from './core';

export const COMPACTION_POLICY_VERSION = 1;
const DAY = 86_400_000;

function sampleKey(id: string) {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i++) hash = Math.imul(hash ^ id.charCodeAt(i), 16777619);
  return hash >>> 0;
}

/** Detail ages out of the default account, never out of the evidence store. */
export function narrativeAgeTier(at: number, now = Date.now()): 'day' | 'week' | 'month' {
  const age = Math.max(0, now - at) / DAY;
  return age < 14 ? 'day' : age < 90 ? 'week' : 'month';
}

export function compactionBucket(entry: NarrativeEntry, timezone: string, now = Date.now()) {
  const level = narrativeAgeTier(entry.occurredAt, now);
  const periods = narrativePeriods(entry.occurredAt, timezone);
  return { level, period: periods[level], key: `${level}:${periods[level]}` };
}

/** Keep corrections/open commitments and chronological/source diversity. This
 * bounded representative overview does not claim to replace all raw evidence. */
export function selectCompactionEvidence(entries: NarrativeEntry[], limit = 60) {
  const rows = [...new Map(entries.map((row) => [row._id, row])).values()].sort(
    (a, b) => a.occurredAt - b.occurredAt || a._id.localeCompare(b._id),
  );
  if (rows.length <= limit) return rows;
  const selected = new Map<string, NarrativeEntry>();
  const add = (row: NarrativeEntry) => {
    if (selected.size < limit) selected.set(row._id, row);
  };
  rows
    .filter((row) => row.corrected || (row.current && row.pinned))
    .slice(-Math.floor(limit / 3))
    .forEach(add);
  add(rows[0]);
  add(rows.at(-1)!);
  // Sample each source independently so high-volume email cannot erase Work or meetings.
  const sources = [...new Set(rows.map((row) => row.source))];
  for (const source of sources) {
    const records = rows.filter((row) => row.source === source);
    add(records[0]);
    add(records.at(-1)!);
  }
  // Stable priority sampling, not positions in the current scan window. A
  // resumed/repeated sweep must converge rather than churn the same chapter.
  [...rows].sort((a, b) => sampleKey(a._id) - sampleKey(b._id) || a._id.localeCompare(b._id)).forEach(add);
  return [...selected.values()].sort((a, b) => a.occurredAt - b.occurredAt);
}

export function narrativeWritingLimit(level: string, key: string) {
  return key.startsWith('brief:') ? 2200 : level === 'month' ? 1400 : level === 'week' ? 1800 : 2200;
}

/** Size each record before enforcing the packet budget: one long record must
 * not suppress every later source (the previous serializer stopped at it). */
export function writerEvidenceRows(entries: NarrativeEntry[], maxChars = 10_000, brief = false) {
  const chosen = selectCompactionEvidence(entries, 24);
  if (brief)
    chosen.sort(
      (a, b) =>
        Number(b.source === 'checkins') - Number(a.source === 'checkins') ||
        Number(Boolean(b.corrected)) - Number(Boolean(a.corrected)) ||
        Number(b.current && b.pinned) - Number(a.current && a.pinned) ||
        b.occurredAt - a.occurredAt,
    );
  const rows = chosen.map((row) => ({
    ...row,
    title: row.title.slice(0, 160),
    text: row.text.slice(0, 700),
    topics: row.topics.slice(0, 8),
  }));
  const selected: NarrativeEntry[] = [];
  let size = 0;
  for (const row of rows) {
    const bytes = JSON.stringify(row).length;
    if (size + bytes > maxChars) continue;
    selected.push(row);
    size += bytes;
  }
  return selected;
}
