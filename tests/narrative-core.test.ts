import { describe, expect, test } from 'bun:test';
import {
  cleanNarrativeProse,
  fallbackChapter,
  type NarrativeEntry,
  narrativeContext,
  narrativePeriods,
  nextNarrativeDay,
  rankNarrative,
  safeNarrativeUrl,
  selectBriefEvidence,
} from '../lib/narrative/core';
import { observationsForRow } from '../lib/narrative/observations';

function entry(overrides: Partial<NarrativeEntry> = {}): NarrativeEntry {
  return {
    _id: 'one',
    key: 'one',
    level: 'observation',
    title: 'Launch',
    text: 'Launch review is waiting on approval',
    source: 'work',
    sourceIds: [],
    topics: ['work:launch'],
    trust: 'reported',
    occurredAt: Date.UTC(2026, 8, 1),
    observedAt: Date.UTC(2026, 8, 2),
    updatedAt: Date.UTC(2026, 8, 2),
    current: true,
    pinned: false,
    ...overrides,
  };
}
describe('narrative memory contracts', () => {
  test('a busy inbox cannot crowd out intentions, open work, and connected changes', () => {
    const now = Date.now();
    const mail = Array.from({ length: 100 }, (_, i) =>
      entry({ _id: `mail${i}`, source: 'mail:one', occurredAt: now - i }),
    );
    const work = Array.from({ length: 50 }, (_, i) => entry({ _id: `work${i}`, pinned: true }));
    const checkin = entry({ _id: 'intention', source: 'checkins', occurredAt: now - 86400000 });
    const meeting = entry({ _id: 'meeting', source: 'mcp:granola', occurredAt: now - 10000 });
    const selected = selectBriefEvidence([...mail, ...work, checkin, meeting], now);
    expect(selected).toHaveLength(40);
    expect(selected.map((e) => e._id)).toContain('intention');
    expect(selected.map((e) => e._id)).toContain('meeting');
    expect(selected.some((e) => e.pinned)).toBe(true);
    expect(cleanNarrativeProse('One.\n\nTwo.')).toBe('One.\n\nTwo.');
  });
  test('calendar arithmetic preserves tomorrow through month, leap-year and DST boundaries', () => {
    expect(nextNarrativeDay('2026-03-08')).toBe('2026-03-09');
    expect(nextNarrativeDay('2028-02-28')).toBe('2028-02-29');
    expect(nextNarrativeDay('2026-12-31')).toBe('2027-01-01');
    expect(narrativePeriods(Date.UTC(2026, 8, 8, 2), 'America/New_York')).toEqual({
      day: '2026-09-07',
      week: '2026-09-07',
      month: '2026-09',
    });
  });
  test('retrieval preserves old unfinished work and does not upgrade trust', () => {
    const old = entry({ _id: 'old', pinned: true, occurredAt: 1 });
    const recent = entry({
      _id: 'recent',
      title: 'Other work',
      text: 'Other work',
      topics: [],
      trust: 'inferred',
    });
    expect(rankNarrative([recent, old], 'launch')[0]).toEqual(old);
    expect(rankNarrative([old], 'unknown')).toEqual([]);
  });
  test('bounded context keeps exact ids, dates and trust without slicing a record', () => {
    expect(narrativeContext([entry()], 5)).toBe('');
    expect(JSON.parse(narrativeContext([entry()])).trust).toBe('reported');
    expect(JSON.parse(narrativeContext([entry()])).observedAt).toContain('2026-09-02');
    expect(fallbackChapter([entry()], 'UTC')).toContain('You reported:');
    expect(safeNarrativeUrl('javascript:alert(1)')).toBeUndefined();
  });
  test('checkins bind intentions to the target local day, not ingestion day', () => {
    const rows = observationsForRow('albatrossDailyCheckins', {
      _id: 'check',
      localDate: '2026-12-31',
      responseText: 'Finished review',
      tomorrowIntentText: 'Ship',
      updatedAt: 10,
    });
    expect(rows).toHaveLength(2);
    expect(rows[1].text).toContain('on 2027-01-01');
    expect(rows[0].trust).toBe('reported');
    expect(rows[0].key).not.toBe(rows[1].key);
  });
  test('calendar and repository activity never implies attendance or completed goals', () => {
    const [event] = observationsForRow('calendarEvents', {
      _id: 'evt',
      accountId: 'a',
      title: 'Review',
      startAt: 1,
      endAt: 2,
      updatedAt: 3,
    });
    expect(event.text).toContain('not proof of attendance');
    const [pr] = observationsForRow('mcpItems', {
      _id: 'pr',
      server: 'github',
      connectionId: 'g',
      title: 'Fix',
      state: 'merged',
      kind: 'pull_request',
      updatedAtSource: 1,
      updatedAt: 500,
    });
    expect(pr.occurredAt).toBe(1);
    expect(pr.text).not.toContain('goal complete');
  });
  test('chat ingestion excludes assistant prose and tool outputs', () => {
    const rows = observationsForRow('userDocs', {
      _id: 'doc',
      key: 'chat',
      kind: 'chatSession',
      createdAt: 1,
      updatedAt: 2,
      doc: {
        messages: [
          { role: 'assistant', content: 'You finished everything' },
          {
            id: 'm',
            role: 'user',
            parts: [
              { type: 'text', text: 'I finished the first step' },
              { type: 'tool-secret', text: 'ignore me' },
            ],
          },
        ],
      },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].text).toBe('You said: I finished the first step');
    expect(rows[0].trust).toBe('reported');
  });
  test('idempotent source version ignores sync noise but changes with content', () => {
    const row = {
      _id: 'mail',
      accountId: 'a',
      subject: 'Review',
      snippet: 'Waiting',
      lastDate: 1,
      updatedAt: 2,
    };
    const [first] = observationsForRow('mailCorpusThreads', row);
    expect(observationsForRow('mailCorpusThreads', { ...row, updatedAt: 20 })[0].sourceVersion).toBe(
      first.sourceVersion,
    );
    expect(
      observationsForRow('mailCorpusThreads', { ...row, snippet: 'Approved' })[0].sourceVersion,
    ).not.toBe(first.sourceVersion);
  });
});
