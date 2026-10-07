import { describe, expect, mock, test } from 'bun:test';
import { getFunctionName } from 'convex/server';
import {
  bindSessionWriter,
  deleteContextsAtBrowserbase,
  forgetSavedSignIns,
  releaseSessionWriter,
  savedSignInState,
  sessionOptionsForUser,
} from '../lib/albatross/browser-contexts';

// Saved sign-ins: one context for each user, one writer session at a time
// (claimed atomically in Convex), and deletes that stay recorded until
// Browserbase confirms them.

const nameOf = (fn: any) => getFunctionName(fn);

function makeDeps(
  options: {
    saved?: { contextId: string; createdAt?: number; lastUsedAt?: number } | null;
    claim?: { contextId: string; persist: boolean } | null | Error;
    queryError?: unknown;
    forgotten?: string[] | undefined;
    configured?: boolean;
    deleteError?: (contextId: string) => Error | null;
  } = {},
) {
  const mutations: Array<[string, any]> = [];
  const queries: Array<[string, any]> = [];
  const deps = {
    convexQuery: mock(async (fn: any, args: any) => {
      const name = nameOf(fn);
      queries.push([name, args]);
      if (name === 'albatrossStepRuns:browserContext') {
        if (options.queryError !== undefined) throw options.queryError;
        return options.saved ?? null;
      }
      throw new Error(`unexpected query ${name}`);
    }) as any,
    convexMutation: mock(async (fn: any, args: any) => {
      const name = nameOf(fn);
      mutations.push([name, args]);
      if (name === 'albatrossStepRuns:forgetBrowserContext') return { contextIds: options.forgotten };
      if (name === 'albatrossStepRuns:claimContextWriter') {
        if (options.claim instanceof Error) throw options.claim;
        return options.claim === undefined ? { contextId: 'ctx-1', persist: true } : options.claim;
      }
      return true;
    }) as any,
    createBrowserContext: mock(async () => 'ctx-new') as any,
    deleteBrowserContext: mock(async (contextId: string) => {
      const error = options.deleteError?.(contextId);
      if (error) throw error;
    }) as any,
    configured: () => options.configured ?? true,
    newToken: () => 'token-1',
    reportError: mock(() => undefined) as any,
  };
  const names = () => mutations.map(([name]) => name);
  return { deps, mutations, queries, names };
}

describe('sessionOptionsForUser', () => {
  test('returns no options when Browserbase is not configured', async () => {
    const { deps, queries } = makeDeps({ configured: false });
    expect(await sessionOptionsForUser('user-1', deps)).toEqual({});
    expect(queries).toEqual([]);
  });

  test('an existing context claims the writer place and saves', async () => {
    const { deps, mutations } = makeDeps({ saved: { contextId: 'ctx-1' } });
    expect(await sessionOptionsForUser('user-1', deps)).toEqual({
      contextId: 'ctx-1',
      persist: true,
      writerToken: 'token-1',
    });
    expect(mutations).toEqual([
      ['albatrossStepRuns:claimContextWriter', { userId: 'user-1', token: 'token-1' }],
    ]);
    expect(deps.createBrowserContext).not.toHaveBeenCalled();
  });

  test('another writer holds the place: the session only reads', async () => {
    const { deps } = makeDeps({
      saved: { contextId: 'ctx-1' },
      claim: { contextId: 'ctx-1', persist: false },
    });
    expect(await sessionOptionsForUser('user-1', deps)).toEqual({ contextId: 'ctx-1', persist: false });
  });

  test('without a context, one is created and saved before the claim', async () => {
    const { deps, names, mutations } = makeDeps({ saved: null });
    await sessionOptionsForUser('user-1', deps);
    expect(names()).toEqual(['albatrossStepRuns:saveBrowserContext', 'albatrossStepRuns:claimContextWriter']);
    expect(mutations[0][1]).toEqual({ userId: 'user-1', contextId: 'ctx-new' });
  });

  test('a claim with no row, or any failure, starts without saved sign-ins', async () => {
    const empty = makeDeps({ saved: { contextId: 'ctx-1' }, claim: null });
    expect(await sessionOptionsForUser('user-1', empty.deps)).toEqual({});
    const failing = makeDeps({ queryError: new Error('Convex down') });
    expect(await sessionOptionsForUser('user-1', failing.deps)).toEqual({});
    expect(failing.deps.reportError).toHaveBeenCalledWith(
      '[browser-contexts] saved sign-ins unavailable',
      'Error',
    );
    const odd = makeDeps({ queryError: 'not an error' });
    expect(await sessionOptionsForUser('user-1', odd.deps)).toEqual({});
    expect(odd.deps.reportError).toHaveBeenCalledWith(
      '[browser-contexts] saved sign-ins unavailable',
      'error',
    );
  });
});

describe('the writer place', () => {
  test('bind answers whether the place is bound', async () => {
    const { deps } = makeDeps();
    expect(await bindSessionWriter('user-1', { persist: false }, 'bb-1', deps)).toBe(true);
    expect(await bindSessionWriter('user-1', { writerToken: 't' }, 'bb-1', deps)).toBe(true);
    deps.convexMutation = mock(async () => false) as any;
    expect(await bindSessionWriter('user-1', { writerToken: 't' }, 'bb-1', deps)).toBe(false);
    deps.convexMutation = mock(async () => {
      throw new Error('Convex down');
    }) as any;
    expect(await bindSessionWriter('user-1', { writerToken: 't' }, 'bb-1', deps)).toBe(false);
  });

  test('bind and release act only for a session that holds the place', async () => {
    const { deps, mutations } = makeDeps();
    await bindSessionWriter('user-1', { contextId: 'ctx-1', persist: false }, 'bb-1', deps);
    await releaseSessionWriter('user-1', { contextId: 'ctx-1', persist: false }, deps);
    expect(mutations).toEqual([]);
    await bindSessionWriter('user-1', { contextId: 'ctx-1', persist: true, writerToken: 't' }, 'bb-1', deps);
    await releaseSessionWriter('user-1', { contextId: 'ctx-1', persist: true, writerToken: 't' }, deps);
    expect(mutations).toEqual([
      ['albatrossStepRuns:bindContextWriter', { userId: 'user-1', token: 't', sessionId: 'bb-1' }],
      ['albatrossStepRuns:releaseContextWriter', { userId: 'user-1', token: 't' }],
    ]);
  });

  test('a failed bind or release never fails the session', async () => {
    const { deps } = makeDeps();
    deps.convexMutation = mock(async () => {
      throw new Error('Convex down');
    }) as any;
    await bindSessionWriter('user-1', { writerToken: 't' }, 'bb-1', deps);
    await releaseSessionWriter('user-1', { writerToken: 't' }, deps);
  });
});

describe('savedSignInState', () => {
  test('reports a saved context with its dates, or none', async () => {
    const saved = makeDeps({ saved: { contextId: 'ctx-1', createdAt: 1, lastUsedAt: 2 } });
    expect(await savedSignInState('user-1', saved.deps)).toEqual({
      saved: true,
      createdAt: 1,
      lastUsedAt: 2,
    });
    const none = makeDeps({ saved: null });
    expect(await savedSignInState('user-1', none.deps)).toEqual({ saved: false });
  });
});

describe('deletes', () => {
  test('a confirmed delete clears its record; a failed one stays for the retry', async () => {
    const { deps, mutations } = makeDeps({
      deleteError: (id) => (id === 'ctx-bad' ? new Error('Browserbase is down') : null),
    });
    expect(await deleteContextsAtBrowserbase(['ctx-1', 'ctx-bad'], deps)).toEqual({ deleted: 1, pending: 1 });
    expect(mutations).toEqual([
      ['albatrossStepRuns:completeContextDeletion', { contextId: 'ctx-1' }],
      ['albatrossStepRuns:failContextDeletion', { contextId: 'ctx-bad', error: 'Browserbase is down' }],
    ]);
  });

  test('a non-Error failure and a failed record write still continue', async () => {
    const { deps } = makeDeps({ deleteError: () => 'boom' as any });
    deps.deleteBrowserContext = mock(async () => {
      throw 'boom';
    }) as any;
    deps.convexMutation = mock(async (fn: any) => {
      if (nameOf(fn) === 'albatrossStepRuns:failContextDeletion') throw new Error('Convex down');
      return true;
    }) as any;
    expect(await deleteContextsAtBrowserbase(['ctx-1'], deps)).toEqual({ deleted: 0, pending: 1 });
  });

  test('without Browserbase every delete stays pending', async () => {
    const { deps } = makeDeps({ configured: false });
    expect(await deleteContextsAtBrowserbase(['ctx-1', 'ctx-2'], deps)).toEqual({ deleted: 0, pending: 2 });
    expect(deps.deleteBrowserContext).not.toHaveBeenCalled();
  });

  test('forgetSavedSignIns forgets the rows, then deletes at Browserbase', async () => {
    const { deps, names } = makeDeps({ forgotten: ['ctx-1', 'ctx-2'] });
    expect(await forgetSavedSignIns('user-1', deps)).toEqual({ forgotten: 2, pending: 0 });
    expect(names()).toEqual([
      'albatrossStepRuns:forgetBrowserContext',
      'albatrossStepRuns:completeContextDeletion',
      'albatrossStepRuns:completeContextDeletion',
    ]);
    const none = makeDeps({ forgotten: undefined });
    expect(await forgetSavedSignIns('user-1', none.deps)).toEqual({ forgotten: 0, pending: 0 });
  });
});
