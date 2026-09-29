/**
 * Sign-out clears the app data that the browser keeps (CASA S9, ASVS 8.2.3).
 *
 * The app writes these keys:
 * - localStorage `lab86-mail-ui`: the zustand UI state (account, last search, open Work).
 * - localStorage `lab86:pinned-models` and `lab86:proof-offer-dismissals`.
 * - localStorage `lab86-logo-v1:<domain>`: sender logo verdicts.
 * - localStorage `lab86-mail-assistant-split` and `lab86-mail-onboarding-dismissed-v1`.
 * - localStorage `tasks-lens`, `board-view:<boardId>`, and `calendar-settings-v2`.
 * - localStorage `react-resizable-panels:lab86-mail-shell-v2:<panes>`: the shell layout.
 * - sessionStorage `albatross.notifications.v1:<userId>`.
 * - IndexedDB `albatross-compose`: sends in the undo window, with the draft.
 *
 * Keys that other code owns (Clerk, next-themes) stay. Clerk removes its own session state.
 */

type StorageLike = Pick<Storage, 'length' | 'key' | 'removeItem'>;
type DatabaseFactory = Pick<IDBFactory, 'deleteDatabase'>;

/** Exact keys that the app writes. */
export const APP_STORAGE_KEYS: readonly string[] = ['tasks-lens', 'calendar-settings-v2'];

/** Key prefixes that only the app writes. */
export const APP_STORAGE_KEY_PREFIXES: readonly string[] = [
  'lab86-',
  'lab86:',
  'albatross.',
  'albatross:',
  'albatross-',
  'board-view:',
  // The panel library writes this key, but the id after the prefix is ours.
  'react-resizable-panels:lab86-',
];

/** IndexedDB databases that the app writes. */
export const APP_DATABASE_NAMES: readonly string[] = ['albatross-compose'];

/** Clerk's own default when a sign-out has no redirect URL. */
export const DEFAULT_SIGN_OUT_REDIRECT = '/';

const DATABASE_DELETE_TIMEOUT_MS = 1_000;

export function isAppStorageKey(key: string): boolean {
  return APP_STORAGE_KEYS.includes(key) || APP_STORAGE_KEY_PREFIXES.some((prefix) => key.startsWith(prefix));
}

function browserStorage(name: 'localStorage' | 'sessionStorage'): StorageLike | null {
  // Safari private mode and blocked storage throw on access.
  try {
    return typeof window === 'undefined' ? null : (window[name] ?? null);
  } catch {
    return null;
  }
}

function browserDatabases(): DatabaseFactory | null {
  try {
    return typeof indexedDB === 'undefined' ? null : indexedDB;
  } catch {
    return null;
  }
}

/** Removes the app keys from one storage area. Returns the keys it removed. */
export function clearAppKeys(storage: StorageLike | null): string[] {
  if (!storage) return [];
  const keys: string[] = [];
  try {
    // Read all keys first. Removal while the loop runs moves the index.
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key !== null && isAppStorageKey(key)) keys.push(key);
    }
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const key of keys) {
    try {
      storage.removeItem(key);
      removed.push(key);
    } catch {
      // One key that does not go must not stop the others.
    }
  }
  return removed;
}

export interface StorageTargets {
  local?: StorageLike | null;
  session?: StorageLike | null;
}

/** Removes the app keys from localStorage and sessionStorage. It does not throw. */
export function clearAppStorage(targets: StorageTargets = {}): string[] {
  const local = 'local' in targets ? targets.local : browserStorage('localStorage');
  const session = 'session' in targets ? targets.session : browserStorage('sessionStorage');
  return [...clearAppKeys(local ?? null), ...clearAppKeys(session ?? null)];
}

/**
 * Deletes the app IndexedDB databases. It always resolves. An open connection can block the delete;
 * the browser then completes it when the connection closes.
 */
export async function deleteAppDatabases(
  factory: DatabaseFactory | null = browserDatabases(),
  timeoutMs = DATABASE_DELETE_TIMEOUT_MS,
): Promise<void> {
  if (!factory) return;
  await Promise.all(
    APP_DATABASE_NAMES.map(
      (name) =>
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, timeoutMs);
          const done = () => {
            clearTimeout(timer);
            resolve();
          };
          try {
            const request = factory.deleteDatabase(name);
            request.onsuccess = done;
            request.onerror = done;
            request.onblocked = done;
          } catch {
            done();
          }
        }),
    ),
  );
}

export interface SignOutOptions {
  redirectUrl?: string;
  sessionId?: string;
}

/** Clerk's `signOut` in the form that takes a callback. Clerk then calls it in place of its own redirect. */
export type ClerkSignOut = (callback: () => Promise<void>, options?: SignOutOptions) => Promise<unknown>;

export interface SignOutStorageDeps {
  clearStorage?: () => unknown;
  deleteDatabases?: () => Promise<unknown>;
  navigate?: (url: string) => void;
}

function loadPage(url: string) {
  if (typeof window !== 'undefined') window.location.assign(url);
}

function reloadPage() {
  if (typeof window !== 'undefined') window.location.reload();
}

// True while signOutAndClearStorage runs. That sign-out clears storage and
// loads its own redirect URL, so the session-end cleanup must not reload the
// page at the same time.
let appSignOutInProgress = false;

/** True while an app-started sign-out runs. */
export function isAppSignOutInProgress(): boolean {
  return appSignOutInProgress;
}

/** Tests reset the flag; in the browser the next page load resets it. */
export function resetAppSignOutForTest() {
  appSignOutInProgress = false;
}

/**
 * Clears app storage, then signs out with Clerk.
 *
 * Clerk's own redirect is a client-side route change. The in-memory stores then stay, and the
 * zustand persist middleware writes its old state back on the next change. Thus Clerk gets a
 * callback: after the session ends, it clears again and loads the redirect URL as a new page.
 */
export async function signOutAndClearStorage(
  signOut: ClerkSignOut,
  options: SignOutOptions = {},
  deps: SignOutStorageDeps = {},
): Promise<void> {
  const clearStorage = deps.clearStorage ?? (() => clearAppStorage());
  const deleteDatabases = deps.deleteDatabases ?? (() => deleteAppDatabases());
  const navigate = deps.navigate ?? loadPage;
  appSignOutInProgress = true;
  clearStorage();
  await deleteDatabases().catch(() => undefined);
  try {
    await signOut(async () => {
      // The session is gone. Remove the keys that a component wrote in the meantime.
      clearStorage();
      navigate(options.redirectUrl || DEFAULT_SIGN_OUT_REDIRECT);
    }, options);
  } catch (error) {
    // The sign-out failed, so the session-end cleanup must work again.
    appSignOutInProgress = false;
    throw error;
  }
}

export interface AuthSnapshot {
  isLoaded: boolean;
  userId: string | null | undefined;
}

/**
 * Returns a function to call with each auth state. It calls `onEnd` when a known user signs out
 * or a different user replaces them. This catches the sign-outs that the app does not start:
 * Clerk's UserButton menu, a sign-out in another tab, and a revoked session.
 */
export function createSessionEndWatcher(onEnd: () => void) {
  let lastUserId: string | null = null;
  return (state: AuthSnapshot) => {
    if (!state.isLoaded) return;
    const userId = state.userId ?? null;
    const ended = lastUserId !== null && userId !== lastUserId;
    lastUserId = userId;
    if (ended) onEnd();
  };
}

export interface SessionEndDeps {
  clearStorage?: () => unknown;
  deleteDatabases?: () => Promise<unknown>;
  reload?: () => void;
  appSignOutInProgress?: () => boolean;
}

/** Clears app storage after a session ends, then reloads so no in-memory state writes it back. */
export async function clearStorageAfterSessionEnd(deps: SessionEndDeps = {}): Promise<void> {
  const clearStorage = deps.clearStorage ?? (() => clearAppStorage());
  const deleteDatabases = deps.deleteDatabases ?? (() => deleteAppDatabases());
  const reload = deps.reload ?? reloadPage;
  // An app-started sign-out clears storage and loads its own page.
  if ((deps.appSignOutInProgress ?? isAppSignOutInProgress)()) return;
  clearStorage();
  await deleteDatabases().catch(() => undefined);
  clearStorage();
  reload();
}
