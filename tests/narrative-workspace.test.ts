import { beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { getFunctionName } from 'convex/server';
import * as hosted from '../lib/hosted/convex';
import type { NarrativeEntry } from '../lib/narrative/core';
import * as narrative from '../lib/narrative/service';
import {
  evidenceComposition,
  hydrateWorkspace,
  workspaceCandidates,
  workspaceCompositionSchema,
  workspaceSource,
} from '../lib/narrative/workspace';
import {
  clearWorkspaceCache,
  loadNarrativeWorkspace,
  saveWorkspaceFeedback,
} from '../lib/narrative/workspace-service';

const now = Date.now();
function source(id: string, extra: Partial<NarrativeEntry> = {}): NarrativeEntry {
  return {
    _id: id,
    key: id,
    level: 'observation',
    title: 'Atlas launch',
    text: 'QA is pending.',
    source: 'work',
    sourceIds: [],
    topics: ['work:owned'],
    trust: 'reported',
    occurredAt: now,
    observedAt: now,
    updatedAt: now,
    current: true,
    pinned: false,
    ...extra,
  };
}
const composition = {
  threads: [
    {
      title: 'Move Atlas forward',
      summary: 'QA is pending, not complete.',
      sourceIds: ['E1'],
      nextStep: 'Review the QA checklist.',
    },
  ],
};
function harness() {
  const snapshot = {
    entry: source('brief', { level: 'day', text: 'Atlas launch needs QA.' }),
    sources: [source('one')],
    revision: 3,
  };
  return {
    snapshot: mock(async () => structuredClone(snapshot)) as any,
    work: mock(async (_u: string, id: string) => ({
      id,
      title: 'Launch Atlas',
      state: 'active',
      guided: true,
    })) as any,
    generate: mock(async () => ({ text: JSON.stringify(composition) })) as any,
    record: mock(async () => ({ ok: true })) as any,
  };
}
beforeEach(clearWorkspaceCache);
describe('Today workspace composition and trust boundary', () => {
  test('live work hydration preserves its shape and safely defaults unknown shapes', async () => {
    const enabled = spyOn(narrative, 'narrativeEnabled').mockReturnValue(true);
    const read = spyOn(narrative, 'readNarrative').mockResolvedValue({
      entry: source('brief', { level: 'day', text: 'Atlas launch needs QA.' }),
      sources: [source('one')],
      revision: 3,
    });
    let detail: any = {
      work: { title: 'Launch Atlas', workState: 'active', shape: 'list' },
      execution: { currentStep: { title: 'Review QA' } },
    };
    const query = spyOn(hosted, 'convexQuery').mockImplementation(async (fn, args) => {
      expect(args.userId).toBe('owner');
      if (getFunctionName(fn) === 'narrative:brief') return { enabled: true, entry: { _id: 'brief' } };
      expect(getFunctionName(fn)).toBe('albatrossWorkV2:workDetail');
      expect(args.workId).toBe('owned');
      return detail;
    });
    try {
      const result = await loadNarrativeWorkspace('owner', now);
      expect(result.threads[0].work).toMatchObject({
        id: 'owned',
        title: 'Launch Atlas',
        state: 'active',
        shape: 'list',
        guided: true,
        nextStep: 'Review QA',
      });
      clearWorkspaceCache();
      detail = { work: { rawText: 'Legacy work', status: 'open', shape: 'unknown' } };
      const legacy = await loadNarrativeWorkspace('owner', now);
      expect(legacy.threads[0].work).toMatchObject({
        title: 'Legacy work',
        state: 'open',
        shape: 'quick',
        guided: false,
      });
      clearWorkspaceCache();
      detail = null;
      expect((await loadNarrativeWorkspace('owner', now)).threads[0].work).toBeUndefined();
    } finally {
      query.mockRestore();
      read.mockRestore();
      enabled.mockRestore();
      clearWorkspaceCache();
    }
  });
  test('model selects bounded evidence, never executable UI or arbitrary IDs', () => {
    expect(() => workspaceCompositionSchema.parse({ threads: [] })).toThrow();
    expect(() =>
      workspaceCompositionSchema.parse({ ...composition, html: '<script>bad</script>' }),
    ).toThrow();
    expect(() =>
      workspaceCompositionSchema.parse({ threads: Array(4).fill(composition.threads[0]) }),
    ).toThrow();
    expect(() =>
      hydrateWorkspace(
        { threads: [{ ...composition.threads[0], sourceIds: ['E999'] }] },
        [source('one')],
        [],
        'v',
        'generated',
      ),
    ).toThrow();
    expect(() =>
      hydrateWorkspace(
        { threads: [composition.threads[0], composition.threads[0]] },
        [source('one')],
        [],
        'v',
        'generated',
      ),
    ).toThrow();
  });
  test('source cards keep real dates, trust, and safe links', () => {
    const card = workspaceSource(
      source('one', { source: 'mcp:github', url: 'javascript:alert(1)', title: '<b>PR</b>' }),
    );
    expect(card).toMatchObject({
      kind: 'development',
      title: 'PR',
      trust: 'reported',
      occurredAt: now,
      href: '/narrative?id=one',
    });
    expect(card.originalUrl).toBeUndefined();
    expect(
      workspaceSource(source('two', { source: 'mcp:granola', url: 'https://example.test/meeting' }))
        .originalUrl,
    ).toBe('https://example.test/meeting');
  });
  test('large old work lists cannot crowd out fresh meetings and development', () => {
    const rows = Array.from({ length: 40 }, (_, i) =>
      source(`old-${i}`, { occurredAt: now - 30 * 86_400_000 }),
    );
    const candidates = workspaceCandidates(
      [
        ...rows,
        source('meeting', {
          source: 'mcp:granola',
          title: 'Design discussion',
          occurredAt: now - 5 * 86_400_000,
        }),
        source('pr', { source: 'mcp:github', title: 'Integration patch', occurredAt: now - 5 * 86_400_000 }),
      ],
      'Atlas launch',
      now,
    );
    expect(candidates.length).toBeLessThanOrEqual(18);
    expect(candidates.map((e) => e._id)).toContain('meeting');
    expect(candidates.map((e) => e._id)).toContain('pr');
    expect(evidenceComposition(candidates).threads.length).toBe(1);
  });
  test('empty consent avoids generation, work lookups and stale cache', async () => {
    const deps = harness();
    await loadNarrativeWorkspace('owner', now, true, undefined, deps);
    deps.snapshot.mockResolvedValue(null);
    const response = await loadNarrativeWorkspace('owner', now, true, undefined, deps);
    expect(response).toMatchObject({ enabled: false, threads: [] });
    expect(deps.generate).toHaveBeenCalledTimes(1);
    expect(deps.work).toHaveBeenCalledTimes(1);
  });
  test('structured output is preferred and a throwing getter falls back to text', async () => {
    const deps = harness();
    deps.generate.mockResolvedValue({ text: 'not JSON', output: composition });
    expect((await loadNarrativeWorkspace('structured', now, true, undefined, deps)).mode).toBe('generated');
    deps.generate.mockResolvedValue({
      text: JSON.stringify(composition),
      get output() {
        throw new Error('unavailable');
      },
    });
    expect((await loadNarrativeWorkspace('text', now, true, undefined, deps)).mode).toBe('generated');
  });
  test('empty model composition uses evidence and can be retried', async () => {
    const deps = harness();
    deps.generate.mockResolvedValue({ text: '{"threads":[]}' });
    const fallback = await loadNarrativeWorkspace('owner', now, true, undefined, deps);
    expect(fallback.mode).toBe('evidence');
    expect(fallback.threads).toHaveLength(1);
    deps.generate.mockResolvedValue({ text: JSON.stringify(composition) });
    expect((await loadNarrativeWorkspace('owner', now, true, undefined, deps)).mode).toBe('generated');
  });
  test('GET is read-only; POST composes once and cache is user-scoped', async () => {
    const deps = harness();
    expect((await loadNarrativeWorkspace('owner', now, false, undefined, deps)).mode).toBe('evidence');
    expect(deps.generate).not.toHaveBeenCalled();
    const result = await loadNarrativeWorkspace('owner', now, true, undefined, deps);
    expect(result.mode).toBe('generated');
    expect(result.threads[0].work?.id).toBe('owned');
    await loadNarrativeWorkspace('owner', now, true, undefined, deps);
    expect(deps.generate).toHaveBeenCalledTimes(1);
    await loadNarrativeWorkspace('other', now, true, undefined, deps);
    expect(deps.generate).toHaveBeenCalledTimes(2);
    expect(deps.generate.mock.calls[0][0]).toMatchObject({ userId: 'owner', speed: 'fast', maxRetries: 0 });
    expect(deps.record).not.toHaveBeenCalled();
  });
  test('bad model output and provider errors leave exact usable evidence', async () => {
    for (const text of [
      'not json',
      JSON.stringify({ threads: [{ ...composition.threads[0], sourceIds: ['E888'] }] }),
    ]) {
      clearWorkspaceCache();
      const deps = harness();
      deps.generate.mockResolvedValue({ text });
      const result = await loadNarrativeWorkspace('owner', now, true, undefined, deps);
      expect(result.mode).toBe('evidence');
      expect(result.threads[0].summary).toBe('QA is pending.');
    }
    clearWorkspaceCache();
    const deps = harness();
    deps.generate.mockRejectedValue(new Error('private provider detail'));
    expect((await loadNarrativeWorkspace('owner', now, true, undefined, deps)).mode).toBe('evidence');
  });
  test('revocation or a changed narrative during generation discards the result', async () => {
    const deps = harness();
    const initial = await deps.snapshot();
    deps.snapshot.mockResolvedValueOnce(initial).mockResolvedValueOnce(null);
    await expect(loadNarrativeWorkspace('owner', now, true, undefined, deps)).rejects.toMatchObject({
      status: 409,
    });
    expect(deps.record).not.toHaveBeenCalled();
  });
  test('a failed composition can recover on explicit retry', async () => {
    const deps = harness();
    deps.generate.mockRejectedValueOnce(new Error('Temporary failure'));
    expect((await loadNarrativeWorkspace('owner', now, true, undefined, deps)).mode).toBe('evidence');
    expect((await loadNarrativeWorkspace('owner', now, true, undefined, deps)).mode).toBe('generated');
    expect(deps.generate).toHaveBeenCalledTimes(2);
  });
  test('failed live ownership lookup cannot produce a work action', async () => {
    const deps = harness();
    deps.work.mockRejectedValue(new Error('Not owned'));
    const result = await loadNarrativeWorkspace('owner', now, true, undefined, deps);
    expect(result.threads[0].work).toBeUndefined();
  });
  test('feedback accepts only the current evidence and records the user’s choice', async () => {
    const deps = harness();
    const current = await loadNarrativeWorkspace('owner', now, false, undefined, deps);
    await saveWorkspaceFeedback(
      'owner',
      { at: now, stamp: current.stamp, sourceIds: ['one'], action: 'defer' },
      deps,
    );
    expect(deps.record.mock.calls[0][1]).toContain('not completion or cancellation');
    expect(deps.record.mock.calls[0][2]).toEqual(['one']);
    await expect(
      saveWorkspaceFeedback('owner', { at: now, stamp: 'stale', sourceIds: ['one'], action: 'defer' }, deps),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      saveWorkspaceFeedback(
        'owner',
        { at: now, stamp: current.stamp, sourceIds: ['someone-else'], action: 'correct', note: 'No' },
        deps,
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(deps.record).toHaveBeenCalledTimes(1);
  });
  test('aborted requests do not start paid composition', async () => {
    const deps = harness();
    const controller = new AbortController();
    controller.abort();
    await expect(loadNarrativeWorkspace('owner', now, true, controller.signal, deps)).rejects.toThrow();
    expect(deps.generate).not.toHaveBeenCalled();
  });
  test('one caller cancelling cannot cancel another caller’s shared generation', async () => {
    const deps = harness();
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    let providerSignal: AbortSignal | undefined;
    deps.generate.mockImplementation(async (options: any) => {
      providerSignal = options.abortSignal;
      started();
      await gate;
      return { text: JSON.stringify(composition) };
    });
    const controller = new AbortController();
    const first = loadNarrativeWorkspace('owner', now, true, controller.signal, deps).catch((error) => error);
    await entered;
    const second = loadNarrativeWorkspace('owner', now, true, undefined, deps);
    controller.abort();
    expect((await first).name).toBe('AbortError');
    release();
    expect((await second).mode).toBe('generated');
    expect(providerSignal?.aborted).toBe(false);
    expect(deps.generate).toHaveBeenCalledTimes(1);
  });
});
