import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ONBOARDING_DISMISSED_STORAGE_KEY } from '../components/hosted/onboarding-state';
import {
  APP_DATABASE_NAMES,
  clearAppKeys,
  clearAppStorage,
  clearStorageAfterSessionEnd,
  createSessionEndWatcher,
  DEFAULT_SIGN_OUT_REDIRECT,
  deleteAppDatabases,
  isAppSignOutInProgress,
  isAppStorageKey,
  resetAppSignOutForTest,
  signOutAndClearStorage,
} from '../lib/auth/sign-out-storage';
import { verdictStorageKey } from '../lib/mail/sender-logo';
import { PINNED_MODELS_KEY } from '../lib/shell/pinned-models';
import { PROOF_DISMISSALS_KEY } from '../lib/shell/proof-dismissals';

beforeEach(() => resetAppSignOutForTest());

class MemoryStorage {
  readonly data = new Map<string, string>();

  constructor(entries: Record<string, string> = {}) {
    for (const [key, value] of Object.entries(entries)) this.data.set(key, value);
  }

  get length() {
    return this.data.size;
  }

  key(index: number) {
    return [...this.data.keys()][index] ?? null;
  }

  getItem(key: string) {
    return this.data.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.data.set(key, value);
  }

  removeItem(key: string) {
    this.data.delete(key);
  }
}

const APP_LOCAL_KEYS = [
  'lab86-mail-ui',
  PINNED_MODELS_KEY,
  PROOF_DISMISSALS_KEY,
  verdictStorageKey('example.com'),
  'lab86-mail-assistant-split',
  ONBOARDING_DISMISSED_STORAGE_KEY,
  'tasks-lens',
  'board-view:board_123',
  'calendar-settings-v2',
  'react-resizable-panels:lab86-mail-shell-v2:it',
];
const APP_SESSION_KEYS = ['albatross.notifications.v1:user_123'];
const THIRD_PARTY_KEYS = ['__clerk_environment', 'theme', 'react-resizable-panels:other-app', 'ph_session'];

function seeded(keys: string[]) {
  return new MemoryStorage(Object.fromEntries([...keys, ...THIRD_PARTY_KEYS].map((key) => [key, 'value'])));
}

const hadWindow = 'window' in globalThis;
const originalWindow = (globalThis as { window?: unknown }).window;
afterEach(() => {
  if (hadWindow) (globalThis as { window?: unknown }).window = originalWindow;
  else delete (globalThis as { window?: unknown }).window;
});

describe('app storage keys', () => {
  test('every key the app writes counts as an app key', () => {
    for (const key of [...APP_LOCAL_KEYS, ...APP_SESSION_KEYS]) expect(isAppStorageKey(key)).toBe(true);
  });

  test('keys that other code owns do not count', () => {
    for (const key of THIRD_PARTY_KEYS) expect(isAppStorageKey(key)).toBe(false);
  });

  test('the key list matches the literals in the source', () => {
    const source = (file: string) => readFileSync(path.join(process.cwd(), file), 'utf8');
    expect(source('lib/client-state.ts')).toContain("PERSIST_KEY = 'lab86-mail-ui'");
    expect(source('components/shell/AssistantWorkspace.tsx')).toContain("'lab86-mail-assistant-split'");
    expect(source('components/tasks/TasksSurface.tsx')).toContain("'tasks-lens'");
    expect(source('components/tasks/TasksSurface.tsx')).toContain(`\`board-view:\${boardId}\``);
    expect(source('components/calendar/engine/calendar-context.tsx')).toContain("'calendar-settings-v2'");
    expect(source('components/shell/AppShell.tsx')).toContain(`\`lab86-mail-shell-v2:\${permutation}\``);
    expect(source('components/notifications/NotificationsSurface.tsx')).toContain(
      `\`albatross.notifications.v1:\${userId}\``,
    );
    expect(source('components/compose/PendingSendProvider.tsx')).toContain(
      `DATABASE_NAME = '${APP_DATABASE_NAMES[0]}'`,
    );
  });
});

describe('clearAppStorage', () => {
  test('removes the app keys from both storages and keeps third-party keys', () => {
    const local = seeded(APP_LOCAL_KEYS);
    const session = seeded(APP_SESSION_KEYS);

    const removed = clearAppStorage({ local, session });

    expect(removed.sort()).toEqual([...APP_LOCAL_KEYS, ...APP_SESSION_KEYS].sort());
    expect([...local.data.keys()].sort()).toEqual([...THIRD_PARTY_KEYS].sort());
    expect([...session.data.keys()].sort()).toEqual([...THIRD_PARTY_KEYS].sort());
  });

  test('uses window storage by default', () => {
    const local = seeded(APP_LOCAL_KEYS);
    const session = seeded(APP_SESSION_KEYS);
    (globalThis as { window?: unknown }).window = { localStorage: local, sessionStorage: session };

    clearAppStorage();

    expect(local.data.has('lab86-mail-ui')).toBe(false);
    expect(session.data.has(APP_SESSION_KEYS[0])).toBe(false);
    expect(local.data.has('theme')).toBe(true);
  });

  test('does nothing on the server', () => {
    (globalThis as { window?: unknown }).window = undefined;
    expect(clearAppStorage()).toEqual([]);
  });

  test('does not throw when storage access throws', () => {
    (globalThis as { window?: unknown }).window = {
      get localStorage(): never {
        throw new DOMException('Blocked', 'SecurityError');
      },
      get sessionStorage(): never {
        throw new DOMException('Blocked', 'SecurityError');
      },
    };
    expect(clearAppStorage()).toEqual([]);

    const brokenLength = {
      get length(): number {
        throw new Error('no access');
      },
      key: () => null,
      removeItem: () => undefined,
    };
    expect(clearAppKeys(brokenLength)).toEqual([]);
  });

  test('one key that fails to go does not stop the others', () => {
    const local = seeded(['lab86-mail-ui', 'tasks-lens']);
    const removeItem = local.removeItem.bind(local);
    local.removeItem = (key: string) => {
      if (key === 'lab86-mail-ui') throw new Error('quota');
      removeItem(key);
    };

    expect(clearAppStorage({ local, session: null })).toEqual(['tasks-lens']);
    expect(local.data.has('lab86-mail-ui')).toBe(true);
  });
});

describe('deleteAppDatabases', () => {
  function fakeFactory(outcome: 'onsuccess' | 'onerror' | 'onblocked' | 'never' | 'throw') {
    const deleted: string[] = [];
    return {
      deleted,
      deleteDatabase(name: string) {
        if (outcome === 'throw') throw new Error('blocked');
        deleted.push(name);
        const request: Record<string, (() => void) | null> = {
          onsuccess: null,
          onerror: null,
          onblocked: null,
        };
        if (outcome !== 'never') queueMicrotask(() => request[outcome]?.());
        return request as unknown as IDBOpenDBRequest;
      },
    };
  }

  test('deletes each app database', async () => {
    for (const outcome of ['onsuccess', 'onerror', 'onblocked'] as const) {
      const factory = fakeFactory(outcome);
      await deleteAppDatabases(factory);
      expect(factory.deleted).toEqual([...APP_DATABASE_NAMES]);
    }
  });

  test('always resolves', async () => {
    await expect(deleteAppDatabases(fakeFactory('throw'))).resolves.toBeUndefined();
    await expect(deleteAppDatabases(fakeFactory('never'), 5)).resolves.toBeUndefined();
    await expect(deleteAppDatabases(null)).resolves.toBeUndefined();
    await expect(deleteAppDatabases()).resolves.toBeUndefined();
  });
});

describe('signOutAndClearStorage', () => {
  test('clears storage before sign-out, then clears again and loads the redirect URL', async () => {
    const calls: string[] = [];
    const options = { redirectUrl: '/sign-in' };
    await signOutAndClearStorage(
      async (callback, received) => {
        calls.push('signOut');
        expect(received).toBe(options);
        await callback();
      },
      options,
      {
        clearStorage: () => calls.push('clear'),
        deleteDatabases: async () => {
          calls.push('delete');
        },
        navigate: (url) => calls.push(`navigate:${url}`),
      },
    );

    expect(calls).toEqual(['clear', 'delete', 'signOut', 'clear', 'navigate:/sign-in']);
  });

  test("uses Clerk's default redirect and continues when the database delete fails", async () => {
    const calls: string[] = [];
    await signOutAndClearStorage(async (callback) => callback(), undefined, {
      clearStorage: () => calls.push('clear'),
      deleteDatabases: async () => {
        throw new Error('blocked');
      },
      navigate: (url) => calls.push(`navigate:${url}`),
    });

    expect(calls).toEqual(['clear', 'clear', `navigate:${DEFAULT_SIGN_OUT_REDIRECT}`]);
  });

  test('clears real storage and loads the page by default', async () => {
    const local = seeded(APP_LOCAL_KEYS);
    const session = seeded(APP_SESSION_KEYS);
    const assigned: string[] = [];
    (globalThis as { window?: unknown }).window = {
      localStorage: local,
      sessionStorage: session,
      location: { assign: (url: string) => assigned.push(url) },
    };
    let clearedBeforeSignOut = false;

    await signOutAndClearStorage(
      async (callback) => {
        clearedBeforeSignOut = !local.data.has('lab86-mail-ui');
        // A component writes the key again while Clerk ends the session.
        local.setItem('lab86-mail-ui', '{"state":{"account":"old"}}');
        await callback();
      },
      { redirectUrl: '/sign-in' },
    );

    expect(clearedBeforeSignOut).toBe(true);
    expect(local.data.has('lab86-mail-ui')).toBe(false);
    expect(session.data.size).toBe(THIRD_PARTY_KEYS.length);
    expect(assigned).toEqual(['/sign-in']);
  });

  test('the flag stays set after the sign-out, and a failed sign-out clears it', async () => {
    const deps = { clearStorage: () => undefined, deleteDatabases: async () => {}, navigate: () => {} };
    await signOutAndClearStorage(async (callback) => callback(), {}, deps);
    expect(isAppSignOutInProgress()).toBe(true);

    resetAppSignOutForTest();
    await expect(
      signOutAndClearStorage(
        async () => {
          throw new Error('network');
        },
        {},
        deps,
      ),
    ).rejects.toThrow('network');
    expect(isAppSignOutInProgress()).toBe(false);
  });

  test('a sign-out that fails still leaves storage clear', async () => {
    const local = seeded(APP_LOCAL_KEYS);
    await expect(
      signOutAndClearStorage(
        async () => {
          throw new Error('network');
        },
        {},
        { clearStorage: () => clearAppStorage({ local, session: null }), deleteDatabases: async () => {} },
      ),
    ).rejects.toThrow('network');
    expect([...local.data.keys()].sort()).toEqual([...THIRD_PARTY_KEYS].sort());
  });
});

describe('session end watcher', () => {
  test('fires once when a known user signs out or a different user replaces them', () => {
    let ended = 0;
    const watch = createSessionEndWatcher(() => {
      ended += 1;
    });

    watch({ isLoaded: false, userId: undefined });
    watch({ isLoaded: true, userId: null });
    expect(ended).toBe(0);

    watch({ isLoaded: true, userId: 'user_a' });
    watch({ isLoaded: true, userId: 'user_a' });
    // Clerk reports not loaded during the sign-out transition.
    watch({ isLoaded: false, userId: undefined });
    expect(ended).toBe(0);

    watch({ isLoaded: true, userId: null });
    expect(ended).toBe(1);
    watch({ isLoaded: true, userId: null });
    expect(ended).toBe(1);

    watch({ isLoaded: true, userId: 'user_b' });
    expect(ended).toBe(1);
    watch({ isLoaded: true, userId: 'user_c' });
    expect(ended).toBe(2);
  });

  test('cleanup does nothing while an app-started sign-out loads its own page', async () => {
    const calls: string[] = [];
    await clearStorageAfterSessionEnd({
      clearStorage: () => calls.push('clear'),
      deleteDatabases: async () => {
        calls.push('delete');
      },
      reload: () => calls.push('reload'),
      appSignOutInProgress: () => true,
    });
    expect(calls).toEqual([]);

    await signOutAndClearStorage(
      async (callback) => callback(),
      {},
      {
        clearStorage: () => undefined,
        deleteDatabases: async () => {},
        navigate: () => {},
      },
    );
    await clearStorageAfterSessionEnd({
      clearStorage: () => calls.push('clear'),
      reload: () => calls.push('reload'),
    });
    expect(calls).toEqual([]);
  });

  test('cleanup clears, deletes databases, clears again, then reloads', async () => {
    const calls: string[] = [];
    await clearStorageAfterSessionEnd({
      clearStorage: () => calls.push('clear'),
      deleteDatabases: async () => {
        calls.push('delete');
      },
      reload: () => calls.push('reload'),
    });
    expect(calls).toEqual(['clear', 'delete', 'clear', 'reload']);
  });

  test('cleanup uses window storage and reload by default', async () => {
    const local = seeded(APP_LOCAL_KEYS);
    let reloaded = 0;
    (globalThis as { window?: unknown }).window = {
      localStorage: local,
      sessionStorage: new MemoryStorage(),
      location: {
        reload: () => {
          reloaded += 1;
        },
      },
    };

    await clearStorageAfterSessionEnd();

    expect([...local.data.keys()].sort()).toEqual([...THIRD_PARTY_KEYS].sort());
    expect(reloaded).toBe(1);
  });
});
