import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { persistedClientState, useClientStore } from '../lib/client-state';
import { calendarSearchEvent, type SearchEventDetail } from '../lib/search/calendar-event';
import {
  cloudFileResult,
  localFileResults,
  matchesSearch,
  type SearchTool,
  safeSearchUrl,
  searchCalendar,
  searchCloudFiles,
  searchFilePath,
  searchMail,
  searchPages,
} from '../lib/search/global-search';
import { focusSearchAfterSelection, navigateSearchTarget } from '../lib/search/navigation';

const event = {
  accountId: 'account-a',
  calendarId: 'calendar-a',
  eventId: 'event-a',
  startIso: '2027-05-20T14:00:00Z',
  endIso: '2027-05-20T15:00:00Z',
  title: 'Planning',
  description: 'Agenda',
  readOnly: true,
  allDay: false,
  location: 'Office',
  participants: [{ email: 'person@example.com' }],
};
const file = {
  id: 'f',
  name: 'Plan',
  provider: 'google_drive',
  connectionId: 'g',
  isFolder: false,
  mimeType: 'application/vnd.google-apps.document',
};
const mockTool = (fn: (name: string, args: Record<string, unknown>, signal?: AbortSignal) => unknown) =>
  (async (name, args, signal) => fn(name, args, signal)) as SearchTool;

describe('global search sources', () => {
  test('page aliases, multiple words, case and empty queries', () => {
    expect(searchPages('')).toHaveLength(8);
    expect(searchPages('HOME')[0].target).toEqual({ kind: 'page', view: 'today' });
    expect(searchPages('calendar')[0].title).toBe('Calendar');
    expect(searchPages('preferences')[0].target).toEqual({ kind: 'settings' });
    expect(matchesSearch('Connected drives and documents', ' DRIVES documents ')).toBe(true);
    expect(searchPages('no-such-page')).toEqual([]);
  });
  test('rejects unsafe and malformed provider URLs', () => {
    for (const value of [
      undefined,
      '',
      'javascript:alert(1)',
      'data:text/plain,test',
      '/relative',
      'not a URL',
    ])
      expect(safeSearchUrl(value)).toBeNull();
    expect(safeSearchUrl('https://example.com/file')).toBe('https://example.com/file');
    expect(safeSearchUrl('http://example.com')).toBe('http://example.com/');
  });
  test('mail searches each owning account with cancellation and preserves colliding thread IDs', async () => {
    const signal = new AbortController().signal;
    const calls: unknown[] = [];
    const result = await searchMail(
      'subject:Plan',
      [
        { accountId: 'a', email: 'a@example.com' },
        { accountId: 'b', email: 'b@example.com' },
      ],
      mockTool((name, args, s) => {
        calls.push([name, args, s === signal]);
        return {
          items: [
            {
              _id: 'same',
              subject: 'Plan',
              fromAddress: 'sender',
              snippet: 'preview',
              lastDate: args.account === 'a' ? 1 : 2,
            },
          ],
        };
      }),
      signal,
    );
    expect(calls).toEqual(
      ['a', 'b'].map((account) => ['search_threads', { account, query: 'subject:Plan', max: 8 }, true]),
    );
    expect(result.items.map((item) => item.id)).toEqual(['mail:b:same', 'mail:a:same']);
    expect(result.items[0].target).toEqual({ kind: 'mail', account: 'b', threadId: 'same' });
    expect(result.warnings).toEqual([]);
  });
  test('mail isolates failures, handles missing subjects and empty account scope', async () => {
    const tool = mockTool((_, args) => {
      if (args.account === 'bad') throw new Error('offline');
      return { items: [{ _id: '1' }, { _id: '2' }] };
    });
    const result = await searchMail(
      'x',
      [
        { accountId: 'bad', email: 'bad@example.com' },
        { accountId: 'good', email: 'good@example.com' },
      ],
      tool,
    );
    expect(result.items).toHaveLength(2);
    expect(result.items[0].title).toBe('(no subject)');
    expect(result.warnings[0]).toContain('bad@example.com');
    expect((await searchMail('x', [], tool)).warnings[0]).toContain('Connect a mailbox');
    expect((await searchMail('x', [{ accountId: 'bad', email: 'bad' }], tool)).items).toEqual([]);
  });
  test('aborted fan-out rejects instead of displaying stale failures', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      searchMail(
        'old',
        [{ accountId: 'a', email: 'a' }],
        mockTool(() => ({ items: [] })),
        controller.signal,
      ),
    ).rejects.toThrow();
  });
  test('mail results are bounded', async () => {
    const result = await searchMail(
      'x',
      [{ accountId: 'a', email: 'a' }],
      mockTool(() => ({ items: Array.from({ length: 30 }, (_, i) => ({ _id: String(i), lastDate: i })) })),
    );
    expect(result.items).toHaveLength(16);
    expect(result.items[0].timestamp).toBe(29);
  });
  test('calendar preserves account, calendar and event identity plus dates', async () => {
    const signal = new AbortController().signal;
    const result = await searchCalendar(
      'Planning',
      mockTool((name, args, s) => {
        expect([name, args, s]).toEqual(['calendar_search_events', { query: 'Planning', limit: 12 }, signal]);
        return { events: [event, { ...event, accountId: 'other', title: '', location: '' }] };
      }),
      signal,
    );
    expect(result.items[0].target).toEqual({ kind: 'calendar', event });
    expect(result.items[0].timestamp).toBe(Date.parse(event.startIso));
    expect(result.items[1].id).not.toBe(result.items[0].id);
    expect(result.items[1].title).toBe('(untitled event)');
    expect(result.items[1].detail).toBe('Calendar event');
  });
  test('native Google files open in-app; folders and other files use safe provider links', () => {
    expect(cloudFileResult(file)?.target).toEqual({
      kind: 'google',
      connectionId: 'g',
      fileId: 'f',
      mimeType: file.mimeType,
    });
    for (const mimeType of [
      'application/vnd.google-apps.spreadsheet',
      'application/vnd.google-apps.presentation',
    ])
      expect(cloudFileResult({ ...file, mimeType })?.target.kind).toBe('google');
    expect(cloudFileResult({ ...file, isFolder: true })).toBeNull();
    expect(
      cloudFileResult({ ...file, isFolder: true, webUrl: 'https://drive.google.com/f' })?.detail,
    ).toContain('Folder');
    expect(
      cloudFileResult({
        ...file,
        provider: 'onedrive',
        connectionId: undefined,
        mimeType: undefined,
        webUrl: 'https://example.com/file',
      })?.target.kind,
    ).toBe('external');
    expect(cloudFileResult({ ...file, provider: 'onedrive', webUrl: 'javascript:alert(1)' })).toBeNull();
    expect(cloudFileResult({ ...file, connectionId: undefined })).toBeNull();
  });
  test('cloud partial failures preserve openable matches', async () => {
    const signal = new AbortController().signal;
    const result = await searchCloudFiles(
      'Plan',
      mockTool((name, args, s) => {
        expect([name, args, s]).toEqual(['cloud_file_search', { query: 'Plan', limit: 12 }, signal]);
        return { files: [file, { ...file, isFolder: true }], errors: ['offline'] };
      }),
      signal,
    );
    expect(result.items).toHaveLength(1);
    expect(result.warnings).toHaveLength(1);
    expect(
      (
        await searchCloudFiles(
          'x',
          mockTool(() => ({ files: [] })),
        )
      ).warnings,
    ).toEqual([]);
  });
  test('local documents and safe uploads search names without dead targets', () => {
    const result = localFileResults(
      'plan',
      [
        { documentId: 'd', title: 'PLAN', kind: 'document' },
        { documentId: 'e', title: 'other', kind: 'sheet' },
      ],
      [
        { id: 'u', name: 'plan.pdf', url: 'https://example.com/plan' },
        { id: 'bad', name: 'plan.pdf', url: 'data:bad' },
      ],
    );
    expect(result.map((r) => r.target.kind)).toEqual(['document', 'external']);
    expect(
      localFileResults(
        '',
        Array.from({ length: 20 }, (_, i) => ({ documentId: String(i), title: 'Plan', kind: 'document' })),
        [],
      ),
    ).toHaveLength(12);
  });
  test('deep links encode IDs and do not inherit stale file or area state', () => {
    expect(searchFilePath({ kind: 'document', documentId: 'a&b' })).toBe('/?view=files&document=a%26b');
    const path = searchFilePath({
      kind: 'google',
      connectionId: 'a/b',
      fileId: 'f&x',
      mimeType: file.mimeType,
    });
    const params = new URL(path, 'https://example.com').searchParams;
    expect(params.get('connection')).toBe('a/b');
    expect(params.get('file')).toBe('f&x');
    expect(params.has('document')).toBe(false);
  });
});

describe('search navigation and selection', () => {
  test('selection hands focus to stable chrome, with a connected fallback only', () => {
    let focused = '';
    const previous = {
      isConnected: true,
      focus: () => {
        focused = 'previous';
      },
    } as HTMLElement;
    const launcher = {
      focus: () => {
        focused = 'launcher';
      },
    };
    focusSearchAfterSelection({ querySelector: () => launcher } as unknown as ParentNode, previous);
    expect(focused).toBe('launcher');
    const emptyRoot = { querySelector: () => null } as unknown as ParentNode;
    focusSearchAfterSelection(emptyRoot, previous);
    expect(focused).toBe('previous');
    focused = '';
    focusSearchAfterSelection(emptyRoot, { ...previous, isConnected: false } as HTMLElement);
    focusSearchAfterSelection(emptyRoot, null);
    expect(focused).toBe('');
  });
  let previous = useClientStore.getState();
  beforeEach(() => {
    previous = useClientStore.getState();
  });
  afterEach(() => useClientStore.setState(previous, true));
  test('opening and dismissing the overlay preserves the underlying workspace', () => {
    useClientStore.setState({
      primaryView: 'areas',
      selectedAreaId: 'area',
      selectedThreadId: 'thread',
      query: 'from:friend',
    });
    useClientStore.getState().setPaletteOpen(true);
    useClientStore.getState().setPaletteOpen(false);
    const state = useClientStore.getState();
    expect([state.primaryView, state.selectedAreaId, state.selectedThreadId, state.query]).toEqual([
      'areas',
      'area',
      'thread',
      'from:friend',
    ]);
  });
  test('explicit page navigation clears detail selection and uses fresh routes', () => {
    const paths: string[] = [];
    useClientStore.setState({ selectedWorkId: 'stale', selectedAreaId: 'area', selectedThreadId: 'stale' });
    navigateSearchTarget({ kind: 'page', view: 'areas' }, useClientStore.getState(), (path) =>
      paths.push(path),
    );
    expect(paths).toEqual(['/?view=areas']);
    expect(useClientStore.getState().selectedWorkId).toBeNull();
    expect(useClientStore.getState().selectedAreaId).toBeNull();
    expect(useClientStore.getState().selectedThreadId).toBeNull();
    navigateSearchTarget({ kind: 'page', view: 'today' }, useClientStore.getState(), (path) =>
      paths.push(path),
    );
    navigateSearchTarget({ kind: 'settings' }, useClientStore.getState(), (path) => paths.push(path));
    expect(paths.slice(-2)).toEqual(['/?view=today', '/settings']);
  });
  test('mail selection uses owning account without rewriting search scope', () => {
    useClientStore.setState({ accountFilter: ['a', 'b'], query: 'in:inbox' });
    const paths: string[] = [];
    navigateSearchTarget({ kind: 'mail', account: 'b', threadId: 't' }, useClientStore.getState(), (path) =>
      paths.push(path),
    );
    const state = useClientStore.getState();
    expect([
      state.primaryView,
      state.threadAccount,
      state.selectedThreadId,
      state.query,
      state.accountFilter,
    ]).toEqual(['mail', 'b', 't', 'in:inbox', ['a', 'b']]);
    expect(paths).toEqual(['/?view=mail']);
  });
  test('calendar selection is transient and cleared when leaving the calendar', () => {
    navigateSearchTarget({ kind: 'calendar', event }, useClientStore.getState(), () => {});
    expect(useClientStore.getState().calendarSearchTarget).toEqual(event);
    expect(useClientStore.getState().primaryView).toBe('calendar');
    expect(persistedClientState(useClientStore.getState())).not.toHaveProperty('calendarSearchTarget');
    useClientStore.getState().setPrimaryView('files');
    expect(useClientStore.getState().calendarSearchTarget).toBeNull();
    useClientStore.getState().setCalendarSearchTarget(event);
    useClientStore.getState().setQuery('is:unread');
    expect(useClientStore.getState().calendarSearchTarget).toBeNull();
    useClientStore.getState().setCalendarSearchTarget(event);
    useClientStore.getState().setSmartCategory('main');
    expect(useClientStore.getState().calendarSearchTarget).toBeNull();
  });
  test('documents and Google results open Files with exact deep links', () => {
    const paths: string[] = [];
    navigateSearchTarget({ kind: 'document', documentId: 'doc' }, useClientStore.getState(), (path) =>
      paths.push(path),
    );
    expect(useClientStore.getState().primaryView).toBe('files');
    expect(paths[0]).toBe('/?view=files&document=doc');
    navigateSearchTarget(
      { kind: 'google', connectionId: 'g', fileId: 'f', mimeType: file.mimeType },
      useClientStore.getState(),
      (path) => paths.push(path),
    );
    expect(paths[1]).toContain('provider=google_drive');
  });
  test('calendar detail uses full authoritative metadata and rejects invalid dates', () => {
    const result = calendarSearchEvent(event);
    expect([
      result.id,
      result.startDate,
      result.endDate,
      result.accountId,
      result.calendarId,
      result.readOnly,
      result.participants,
    ]).toEqual([
      event.eventId,
      event.startIso,
      event.endIso,
      event.accountId,
      event.calendarId,
      true,
      event.participants,
    ]);
    expect(calendarSearchEvent({ ...event, description: '' }).description).toBe('');
    expect(() => calendarSearchEvent({ ...event, startIso: 'invalid' })).toThrow('invalid date');
    expect(() => calendarSearchEvent({ ...event, endIso: 'invalid' } as SearchEventDetail)).toThrow(
      'invalid date',
    );
  });
  test('settings mounts global search and Files listens for in-place selection', () => {
    expect(readFileSync('app/settings/page.tsx', 'utf8')).toContain('<CommandPalette />');
    expect(readFileSync('components/files/FilesSurface.tsx', 'utf8')).toContain(
      "addEventListener('lab86-mail:files-navigate'",
    );
    expect(readFileSync('components/calendar/CalendarSurface.tsx', 'utf8')).toContain(
      '<CalendarSearchSelection />',
    );
  });
});
