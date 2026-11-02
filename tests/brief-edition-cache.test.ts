import { afterEach, describe, expect, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import {
  isAppSignOutInProgress,
  resetAppSignOutForTest,
  signOutAndClearStorage,
} from '../lib/auth/sign-out-storage';
import {
  BRIEF_CACHED_STAMP,
  BRIEF_EDITION_CACHE_KEY,
  bindBriefEditionCache,
  readBriefEditionCache,
  writeBriefEditionCache,
} from '../lib/brief/edition-cache';
import type { BriefViewResponse, BriefWebEdition } from '../lib/brief/web-view';

class MemoryStorage {
  values = new Map<string, string>();
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
}

const edition = (patch: Partial<BriefWebEdition> = {}): BriefWebEdition => ({
  _id: 'edition-a',
  kind: 'morning',
  generatedAt: 1,
  sections: { overflow: [] },
  ...patch,
});
const view = (patch: Partial<BriefViewResponse> = {}): BriefViewResponse => ({
  stamp: 'idle',
  pending: null,
  revision: 'rev-a',
  report: edition(),
  ...patch,
});
const LATEST = ['daily-report', 'latest'];

afterEach(() => resetAppSignOutForTest());

describe('the persisted edition', () => {
  test('a reload reads the edition of its owner', () => {
    const storage = new MemoryStorage();
    expect(writeBriefEditionCache('user-a', view(), storage, 100)).toBe(true);
    expect(readBriefEditionCache('user-a', storage, 200)).toMatchObject({
      owner: 'user-a',
      savedAt: 100,
      revision: 'rev-a',
      report: { _id: 'edition-a' },
    });
  });

  test("another user never reads it, and the first user's text leaves the disk", () => {
    const storage = new MemoryStorage();
    writeBriefEditionCache('user-a', view(), storage, 100);
    expect(readBriefEditionCache('user-b', storage, 200)).toBeNull();
    expect(storage.getItem(BRIEF_EDITION_CACHE_KEY)).toBeNull();
  });

  test('an old record, a damaged record, and no storage read as nothing', () => {
    const storage = new MemoryStorage();
    writeBriefEditionCache('user-a', view(), storage, 100);
    expect(readBriefEditionCache('user-a', storage, 100 + 8 * 86_400_000)).toBeNull();
    expect(storage.getItem(BRIEF_EDITION_CACHE_KEY)).toBeNull();
    storage.setItem(BRIEF_EDITION_CACHE_KEY, '{not json');
    expect(readBriefEditionCache('user-a', storage)).toBeNull();
    expect(storage.getItem(BRIEF_EDITION_CACHE_KEY)).toBeNull();
    storage.setItem(BRIEF_EDITION_CACHE_KEY, JSON.stringify({ owner: 'user-a', savedAt: Date.now() }));
    expect(readBriefEditionCache('user-a', storage)).toBeNull();
    expect(readBriefEditionCache('user-a', new MemoryStorage())).toBeNull();
    expect(readBriefEditionCache('user-a', null)).toBeNull();
    expect(writeBriefEditionCache('user-a', view(), null)).toBe(false);
  });

  test('storage that throws costs only the fast paint', () => {
    const blocked = {
      getItem() {
        throw new Error('blocked');
      },
      setItem() {
        throw new Error('quota');
      },
      removeItem() {
        throw new Error('blocked');
      },
    };
    expect(readBriefEditionCache('user-a', blocked)).toBeNull();
    expect(writeBriefEditionCache('user-a', view(), blocked)).toBe(false);
  });

  test('a pending read, a model-written page, and an oversized edition stay out', () => {
    const storage = new MemoryStorage();
    expect(
      writeBriefEditionCache('user-a', view({ pending: { reportId: 'b', phase: 'writing' } }), storage),
    ).toBe(false);
    expect(writeBriefEditionCache('user-a', view({ report: edition({ html: '<html />' }) }), storage)).toBe(
      false,
    );
    expect(writeBriefEditionCache('user-a', view({ report: undefined }), storage)).toBe(false);
    expect(storage.values.size).toBe(0);
    writeBriefEditionCache('user-a', view(), storage);
    const large = edition({ narrative: 'x'.repeat(600_000) });
    expect(writeBriefEditionCache('user-a', view({ report: large }), storage)).toBe(false);
    expect(storage.getItem(BRIEF_EDITION_CACHE_KEY)).toBeNull();
  });

  test('no edition on the server clears the copy on the disk', () => {
    const storage = new MemoryStorage();
    writeBriefEditionCache('user-a', view(), storage);
    expect(writeBriefEditionCache('user-a', view({ report: null, revision: null }), storage)).toBe(false);
    expect(storage.getItem(BRIEF_EDITION_CACHE_KEY)).toBeNull();
  });

  test('a one-time code never reaches the disk', () => {
    const storage = new MemoryStorage();
    const needsYou = {
      id: 'needs-you',
      items: [
        { id: 'code-row', kind: 'code', title: 'Sign-in code', code: '481516' },
        { id: 'mail-row', kind: 'reply', title: 'Reply to Maya', code: '234200' },
      ],
    };
    writeBriefEditionCache('user-a', view({ report: edition({ sections: { needsYou } }) }), storage);
    const raw = storage.getItem(BRIEF_EDITION_CACHE_KEY) ?? '';
    expect(raw).not.toContain('481516');
    expect(raw).not.toContain('234200');
    expect(raw).not.toContain('code-row');
    expect(raw).toContain('Reply to Maya');
  });

  test('a write during sign-out does nothing', async () => {
    const storage = new MemoryStorage();
    await signOutAndClearStorage(
      async () => undefined,
      {},
      {
        clearStorage: () => undefined,
        deleteDatabases: async () => undefined,
        navigate: () => undefined,
      },
    );
    expect(isAppSignOutInProgress()).toBe(true);
    expect(writeBriefEditionCache('user-a', view(), storage)).toBe(false);
    expect(storage.values.size).toBe(0);
  });
});

describe('the connection to the query client', () => {
  test('an empty latest query fills from the disk with its saved age', () => {
    const storage = new MemoryStorage();
    writeBriefEditionCache('user-a', view(), storage, 1_000);
    // A saved time older than the 7-day limit reads as nothing, so use a recent one.
    writeBriefEditionCache('user-a', view(), storage, Date.now() - 60_000);
    const savedAt = JSON.parse(storage.getItem(BRIEF_EDITION_CACHE_KEY) ?? '{}').savedAt;
    const client = new QueryClient();
    const stop = bindBriefEditionCache(client, 'user-a', storage);
    const data = client.getQueryData<BriefViewResponse>(LATEST);
    expect(data?.report?._id).toBe('edition-a');
    expect(data?.stamp).toBe(BRIEF_CACHED_STAMP);
    expect(data?.revision).toBe('rev-a');
    expect(client.getQueryState(LATEST)?.dataUpdatedAt).toBe(savedAt);
    stop();
  });

  test('the disk never replaces a read that already landed, and another user gets nothing', () => {
    const storage = new MemoryStorage();
    writeBriefEditionCache('user-a', view(), storage);
    const client = new QueryClient();
    client.setQueryData(LATEST, view({ report: edition({ _id: 'network' }), revision: 'rev-n' }));
    bindBriefEditionCache(client, 'user-a', storage)();
    expect(client.getQueryData<BriefViewResponse>(LATEST)?.report?._id).toBe('network');

    const other = new QueryClient();
    bindBriefEditionCache(other, 'user-b', storage)();
    expect(other.getQueryData(LATEST)).toBeUndefined();
  });

  test('a new latest read goes to the disk once, and other queries stay out', () => {
    const storage = new MemoryStorage();
    const client = new QueryClient();
    const stop = bindBriefEditionCache(client, 'user-a', storage);
    client.setQueryData(['daily-report', 'old-edition'], view({ report: edition({ _id: 'old' }) }));
    client.setQueryData(['threads'], { rows: [] });
    expect(storage.values.size).toBe(0);

    const writes: string[] = [];
    const write = storage.setItem.bind(storage);
    storage.setItem = (key, value) => {
      writes.push(key);
      write(key, value);
    };
    client.setQueryData(LATEST, view());
    client.setQueryData(LATEST, view({ pending: { reportId: 'new', phase: 'writing' } }));
    client.setQueryData(LATEST, view());
    expect(writes).toEqual([BRIEF_EDITION_CACHE_KEY]);
    client.setQueryData(LATEST, view({ report: edition({ _id: 'next' }), revision: 'rev-b' }));
    expect(writes).toHaveLength(2);
    stop();
    client.setQueryData(LATEST, view({ report: edition({ _id: 'after' }), revision: 'rev-c' }));
    expect(writes).toHaveLength(2);
  });
});
