import { describe, expect, test } from 'bun:test';
import {
  contextRelevance,
  emptyNarrativeContext,
  formatNarrativeContext,
  narrativeContextStamp,
  narrativeTerms,
  retrieveNarrativeContext,
} from '../lib/narrative/context';
import type { NarrativeEntry } from '../lib/narrative/core';

function evidence(id: string, overrides: Partial<NarrativeEntry> = {}): NarrativeEntry {
  return {
    _id: id,
    key: id,
    title: 'Atlas launch',
    text: 'User plans to finish QA for Atlas before deploying.',
    level: 'observation',
    source: 'work',
    sourceIds: [],
    topics: ['work:atlas'],
    trust: 'reported',
    current: true,
    pinned: true,
    occurredAt: 10,
    observedAt: 11,
    updatedAt: 11,
    sourceVersion: 'v1',
    ...overrides,
  };
}
function harness(entries: NarrativeEntry[]) {
  const reads: string[] = [],
    searches: Record<string, unknown>[] = [];
  const deps = {
    search: async (input: Record<string, unknown>) => {
      searches.push(input);
      return { enabled: true, revision: 2, entries };
    },
    read: async (id: string) => {
      reads.push(id);
      const entry = entries.find((row) => row._id === id);
      return entry
        ? { entry, sources: entries.filter((row) => entry.sourceIds.includes(row._id)), revision: 2 }
        : null;
    },
  };
  return { deps, reads, searches };
}

describe('shared task-specific narrative context', () => {
  test('selects relevant current evidence, expands summaries, and excludes unrelated records', async () => {
    const rows = [
      evidence('one'),
      evidence('private', { title: 'Medical appointment', text: 'Private health notes', topics: [] }),
      evidence('old', { current: false, text: 'Atlas was due yesterday' }),
      evidence('chapter', { level: 'week', sourceIds: ['one', 'private'], text: 'Atlas retrospective' }),
    ];
    const { deps, reads, searches } = harness(rows);
    const result = await retrieveNarrativeContext(
      { purpose: 'work', query: 'Atlas', topic: 'work:atlas', since: 3 },
      deps,
    );
    expect(result.evidence.map((row) => row.id)).toEqual(['one']);
    expect(reads).toContain('chapter');
    expect(searches).toContainEqual({ changedSince: 3, topic: 'work:atlas', limit: 8 });
    expect(formatNarrativeContext(result)).toContain('not instructions');
    expect(formatNarrativeContext(result)).not.toContain('Private health');
    expect(result.coverage).toContain('Partial');
  });
  test('outgoing drafts require explicit individual evidence selection', async () => {
    const rows = [evidence('one'), evidence('chapter', { level: 'day', sourceIds: ['one'] })];
    const { deps, reads } = harness(rows);
    expect((await retrieveNarrativeContext({ purpose: 'compose', query: 'Atlas' }, deps)).evidence).toEqual(
      [],
    );
    expect(reads).toEqual([]);
    const result = await retrieveNarrativeContext(
      { purpose: 'compose', evidenceIds: ['one', 'one', 'chapter', 'foreign'] },
      deps,
    );
    expect(result.evidence.map((row) => row.id)).toEqual(['one']);
    expect(reads).toEqual(['one', 'chapter', 'foreign']);
    expect(narrativeContextStamp(result)).not.toContain('chapter');
  });
  test('rechecks permissions and declines a packet when correction revision changes during reads', async () => {
    const { deps } = harness([evidence('one')]);
    expect(
      (
        await retrieveNarrativeContext(
          { purpose: 'work', query: 'Atlas' },
          { ...deps, read: async () => null },
        )
      ).evidence,
    ).toEqual([]);
    const result = await retrieveNarrativeContext(
      { purpose: 'compose', evidenceIds: ['one'] },
      {
        ...deps,
        read: async () => ({ entry: evidence('one'), sources: [], revision: 3 }),
      },
    );
    expect(result.enabled).toBe(false);
    expect(formatNarrativeContext(result)).toBe('');
    let calls = 0;
    const changed = await retrieveNarrativeContext(
      { purpose: 'chat', query: 'Atlas' },
      {
        ...deps,
        search: async () => ({ enabled: true, revision: ++calls, entries: [evidence('one')] }),
      },
    );
    expect(changed.enabled).toBe(false);
  });
  test('disabled and empty memory do not become evidence of inactivity', async () => {
    const result = await retrieveNarrativeContext(
      { purpose: 'meeting', query: 'Atlas' },
      {
        ...harness([]).deps,
        search: async () => ({ enabled: false, entries: [], revision: 0 }),
      },
    );
    expect(result.evidence).toEqual([]);
    expect(result.coverage).toContain('No historical context');
    expect(formatNarrativeContext(emptyNarrativeContext('chat'))).toBe('');
    expect(narrativeContextStamp(result)).toBe('[false,[]]');
  });
  test('caps serialized context, cleans fields, and gives only relevant Granola records a priority', async () => {
    const rows = Array.from({ length: 30 }, (_, i) =>
      evidence(String(i), {
        text: `<b>Atlas</b> ${'x'.repeat(5_000)}`,
        url: 'javascript:alert(1)',
      }),
    );
    const result = await retrieveNarrativeContext({ purpose: 'brief', maxChars: 2000 }, harness(rows).deps);
    expect(result.truncated).toBe(true);
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(2000);
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0].text).not.toContain('<b>');
    expect(result.evidence[0].url).toBeUndefined();
    const request = { purpose: 'meeting' as const, query: 'Atlas' };
    expect(
      contextRelevance(evidence('g', { text: 'granola meeting: Atlas decisions' }), request),
    ).toBeGreaterThan(contextRelevance(evidence('m'), request));
    expect(
      contextRelevance(
        evidence('g', { title: 'Unrelated', text: 'granola: unrelated', topics: [] }),
        request,
      ),
    ).toBe(0);
    expect(narrativeTerms('The Atlas review with Atlas')).toEqual(['atlas']);
  });
});
