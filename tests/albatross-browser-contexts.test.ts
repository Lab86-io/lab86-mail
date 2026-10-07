import { describe, expect, mock, test } from 'bun:test';
import { getFunctionName } from 'convex/server';
import {
  forgetSavedSignIns,
  savedSignInState,
  sessionOptionsForUser,
} from '../lib/albatross/browser-contexts';

// The api proxy mints a fresh reference per property access, so the fakes
// key on the exported function name.
const nameOf = (fn: any) => getFunctionName(fn);

function makeDeps(
  options: {
    saved?: { contextId: string; createdAt?: number; lastUsedAt?: number } | null;
    live?: number | Error;
    queryError?: unknown;
    forgotten?: string[] | undefined;
    configured?: boolean;
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
      if (name === 'albatrossBrowserSessions:liveSessionCount') {
        if (options.live instanceof Error) throw options.live;
        return options.live ?? 0;
      }
      throw new Error(`unexpected query ${name}`);
    }) as any,
    convexMutation: mock(async (fn: any, args: any) => {
      const name = nameOf(fn);
      mutations.push([name, args]);
      if (name === 'albatrossStepRuns:forgetBrowserContext') return { contextIds: options.forgotten };
      return { contextId: args.contextId, created: false };
    }) as any,
    createBrowserContext: mock(async () => 'ctx-new') as any,
    deleteBrowserContext: mock(async () => undefined) as any,
    configured: () => options.configured ?? true,
    reportError: mock(() => undefined) as any,
  };
  return { deps, mutations, queries };
}

describe('sessionOptionsForUser', () => {
  test('returns no options when Browserbase is not configured', async () => {
    const { deps, queries } = makeDeps({ configured: false });
    expect(await sessionOptionsForUser('user-1', deps)).toEqual({});
    expect(queries).toEqual([]);
  });

  test('an existing context is touched and saves when no session is live', async () => {
    const { deps, mutations, queries } = makeDeps({ saved: { contextId: 'ctx-1' }, live: 0 });
    expect(await sessionOptionsForUser('user-1', deps)).toEqual({ contextId: 'ctx-1', persist: true });
    expect(deps.createBrowserContext).not.toHaveBeenCalled();
    expect(mutations).toEqual([
      ['albatrossStepRuns:saveBrowserContext', { userId: 'user-1', contextId: 'ctx-1' }],
    ]);
    expect(queries.map(([name]) => name)).toEqual([
      'albatrossStepRuns:browserContext',
      'albatrossBrowserSessions:liveSessionCount',
    ]);
  });

  test('an existing context only reads when another session is live', async () => {
    const { deps } = makeDeps({ saved: { contextId: 'ctx-1' }, live: 1 });
    expect(await sessionOptionsForUser('user-1', deps)).toEqual({ contextId: 'ctx-1', persist: false });
  });

  test('a failed live count counts as a live session', async () => {
    const { deps } = makeDeps({ saved: { contextId: 'ctx-1' }, live: new Error('timeout') });
    expect(await sessionOptionsForUser('user-1', deps)).toEqual({ contextId: 'ctx-1', persist: false });
  });

  test('without a context, one is created and saved', async () => {
    const { deps, mutations } = makeDeps({ saved: null, live: 0 });
    expect(await sessionOptionsForUser('user-1', deps)).toEqual({ contextId: 'ctx-new', persist: true });
    expect(deps.createBrowserContext).toHaveBeenCalledTimes(1);
    expect(mutations).toEqual([
      ['albatrossStepRuns:saveBrowserContext', { userId: 'user-1', contextId: 'ctx-new' }],
    ]);
  });

  test('any failure gives no options and reports only the error name', async () => {
    const { deps } = makeDeps({ queryError: new TypeError('secret detail') });
    expect(await sessionOptionsForUser('user-1', deps)).toEqual({});
    expect(deps.reportError).toHaveBeenCalledWith(
      '[browser-contexts] saved sign-ins unavailable',
      'TypeError',
    );

    const thrown = makeDeps({ queryError: 'not an error' });
    expect(await sessionOptionsForUser('user-1', thrown.deps)).toEqual({});
    expect(thrown.deps.reportError).toHaveBeenCalledWith(
      '[browser-contexts] saved sign-ins unavailable',
      'error',
    );

    const create = makeDeps({ saved: null });
    create.deps.createBrowserContext = mock(async () => {
      throw new Error('Browserbase 500');
    }) as any;
    expect(await sessionOptionsForUser('user-1', create.deps)).toEqual({});
    expect(create.mutations).toEqual([]);
  });
});

describe('savedSignInState', () => {
  test('no saved context', async () => {
    const { deps } = makeDeps({ saved: null });
    expect(await savedSignInState('user-1', deps)).toEqual({ saved: false });
  });

  test('a saved context shows its dates and never its id', async () => {
    const { deps } = makeDeps({ saved: { contextId: 'ctx-1', createdAt: 100, lastUsedAt: 200 } });
    expect(await savedSignInState('user-1', deps)).toEqual({ saved: true, createdAt: 100, lastUsedAt: 200 });
  });
});

describe('forgetSavedSignIns', () => {
  test('deletes each forgotten context at Browserbase', async () => {
    const { deps, mutations } = makeDeps({ forgotten: ['ctx-1', 'ctx-2'] });
    expect(await forgetSavedSignIns('user-1', deps)).toEqual({ forgotten: 2 });
    expect(mutations).toEqual([['albatrossStepRuns:forgetBrowserContext', { userId: 'user-1' }]]);
    expect(deps.deleteBrowserContext.mock.calls).toEqual([['ctx-1'], ['ctx-2']]);
  });

  test('skips Browserbase when it is not configured', async () => {
    const { deps } = makeDeps({ forgotten: ['ctx-1'], configured: false });
    expect(await forgetSavedSignIns('user-1', deps)).toEqual({ forgotten: 1 });
    expect(deps.deleteBrowserContext).not.toHaveBeenCalled();
  });

  test('nothing to forget', async () => {
    const { deps } = makeDeps({ forgotten: undefined });
    expect(await forgetSavedSignIns('user-1', deps)).toEqual({ forgotten: 0 });
    expect(deps.deleteBrowserContext).not.toHaveBeenCalled();
  });
});
