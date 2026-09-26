import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { convexTest } from 'convex-test';
import { createSurfacesRoute } from '../app/api/account/surfaces/route';
import { api } from '../convex/_generated/api';
import schema from '../convex/schema';
import { persistedClientState, useClientStore } from '../lib/client-state';
import {
  resolveSurfaces,
  type SurfaceDependencies,
  setFilesSurface,
  surfaceDefaults,
} from '../lib/hosted/surfaces';
import { railSurfaces } from '../lib/shell/rail-surfaces';

function deps(stored: string | null, hasDocuments: boolean) {
  const written: string[] = [];
  const d: SurfaceDependencies = {
    readPref: mock(async () => stored),
    writePref: mock(async (_user, value) => {
      written.push(value);
    }),
    hasDocuments: mock(async () => hasDocuments),
  };
  return { d, written };
}

describe('Files behind Settings, Advanced', () => {
  test('the rail hides Files when the switch is off', () => {
    expect(railSurfaces({ boardEnabled: false, filesEnabled: false }).map((s) => s.view)).toEqual([
      'today',
      'albatrosses',
      'chat',
      'mail',
      'calendar',
    ]);
    expect(railSurfaces({ boardEnabled: true, filesEnabled: false }).map((s) => s.view)).toContain('tasks');
    expect(railSurfaces({ boardEnabled: false, filesEnabled: true }).map((s) => s.view)).toContain('files');
  });

  test('a new account starts off; an account with documents starts on; the first answer is kept', async () => {
    const fresh = deps(null, false);
    expect(await resolveSurfaces('u', fresh.d)).toEqual({ files: false });
    expect(fresh.written).toEqual(['off']);
    const owner = deps(null, true);
    expect(await resolveSurfaces('u', owner.d)).toEqual({ files: true });
    expect(owner.written).toEqual(['on']);
    // A stored choice wins, so a later Work deliverable does not turn Files on.
    const decided = deps('off', true);
    expect(await resolveSurfaces('u', decided.d)).toEqual({ files: false });
    expect(decided.d.hasDocuments).not.toHaveBeenCalled();
    expect(decided.written).toEqual([]);
    expect(await setFilesSurface('u', true, decided.d)).toEqual({ files: true });
    expect(decided.written).toEqual(['on']);
  });

  test('the default store keeps the choice per user', async () => {
    await surfaceDefaults.writePref('surface_user', 'on');
    expect(await surfaceDefaults.readPref('surface_user')).toBe('on');
    expect(await surfaceDefaults.readPref('other_surface_user')).toBeNull();
  });

  test('the client copy starts off and survives a reload', () => {
    expect(useClientStore.getState().filesSurfaceEnabled).toBe(false);
    useClientStore.getState().setFilesSurfaceEnabled(true);
    expect((persistedClientState(useClientStore.getState()) as any).filesSurfaceEnabled).toBe(true);
    useClientStore.getState().setFilesSurfaceEnabled(false);
  });

  test('the route reads and writes the choice', async () => {
    const route = createSurfacesRoute({
      requireCurrentUser: async () => ({ userId: 'u', email: '', name: '', source: 'clerk' }),
      resolveSurfaces: async () => ({ files: true }),
      setFilesSurface: async (_user, files) => ({ files }),
    });
    expect(await (await route.GET()).json()).toEqual({ ok: true, surfaces: { files: true } });
    const post = (body: unknown) =>
      route.POST(
        new Request('https://x/api/account/surfaces', { method: 'POST', body: JSON.stringify(body) }),
      );
    expect(await (await post({ files: false })).json()).toEqual({ ok: true, surfaces: { files: false } });
    expect((await post({ files: 'yes' })).status).toBe(400);
    const { AuthRequiredError } = await import('../lib/auth/current-user');
    const signedOut = createSurfacesRoute({
      requireCurrentUser: async () => {
        throw new AuthRequiredError();
      },
    });
    expect((await signedOut.GET()).status).toBe(401);
    const error = console.error;
    console.error = () => undefined;
    try {
      const broken = createSurfacesRoute({
        requireCurrentUser: async () => ({ userId: 'u', email: '', name: '', source: 'clerk' }),
        setFilesSurface: async () => {
          throw new Error('offline');
        },
      });
      expect(
        (await broken.POST(new Request('https://x', { method: 'POST', body: '{"files":true}' }))).status,
      ).toBe(500);
    } finally {
      console.error = error;
    }
  });
});

describe('Convex hasDocuments', () => {
  const SECRET = 'surfaces-secret';
  let previous: string | undefined;
  beforeAll(() => {
    previous = process.env.LAB86_CONVEX_INTERNAL_SECRET;
    process.env.LAB86_CONVEX_INTERNAL_SECRET = SECRET;
  });
  afterAll(() => {
    if (previous === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
    else process.env.LAB86_CONVEX_INTERNAL_SECRET = previous;
  });

  test('live documents or office files count; archived documents do not', async () => {
    const t = convexTest(schema, {
      '../convex/_generated/api.js': () => import('../convex/_generated/api.js'),
      '../convex/accounts.ts': () => import('../convex/accounts'),
    });
    const has = (userId: string) => t.query(api.accounts.hasDocuments, { internalSecret: SECRET, userId });
    expect(await has('none')).toBe(false);
    await t.run(async (ctx) => {
      const base = {
        documentId: 'd',
        kind: 'doc' as const,
        title: 'Plan',
        currentRevision: 1,
        sourceRefs: [],
        createdAt: 1,
        updatedAt: 1,
      };
      await ctx.db.insert('documents', { ...base, userId: 'archived', archivedAt: 2 } as any);
      await ctx.db.insert('documents', { ...base, userId: 'writer' } as any);
      await ctx.db.insert('officeDocuments', {
        userId: 'office',
        documentId: 'o',
        title: 'Budget',
        extension: 'xlsx',
        currentRevision: 1,
        createdAt: 1,
        updatedAt: 1,
      });
    });
    expect(await has('archived')).toBe(false);
    expect(await has('writer')).toBe(true);
    expect(await has('office')).toBe(true);
    await expect(
      t.query(api.accounts.hasDocuments, { internalSecret: 'x', userId: 'writer' }),
    ).rejects.toThrow();
  });
});

test('the default document check asks Convex for this user', async () => {
  const { spyOn } = await import('bun:test');
  const convex = await import('../lib/hosted/convex');
  const query = spyOn(convex, 'convexQuery').mockImplementation((async (fn: any, args: any) => {
    expect(String(fn[Symbol.for('functionName')])).toBe('accounts:hasDocuments');
    expect(args).toEqual({ userId: 'doc_user' });
    return true;
  }) as any);
  try {
    expect(await surfaceDefaults.hasDocuments('doc_user')).toBe(true);
  } finally {
    query.mockRestore();
  }
});
