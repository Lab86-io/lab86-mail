import type { PrimaryView } from '../shared/types';

export type SearchScope = 'all' | 'mail' | 'files' | 'calendar';
export interface CalendarSearchTarget {
  accountId: string;
  calendarId: string;
  eventId: string;
  startIso: string;
}
export type SearchTarget =
  | { kind: 'page'; view: PrimaryView }
  | { kind: 'settings' }
  | { kind: 'mail'; account: string; threadId: string }
  | { kind: 'document'; documentId: string }
  | { kind: 'google'; connectionId: string; fileId: string; mimeType: string }
  | { kind: 'external'; url: string }
  | { kind: 'calendar'; event: CalendarSearchTarget };
export interface SearchResult {
  id: string;
  title: string;
  detail: string;
  target: SearchTarget;
  timestamp?: number;
}
export interface SearchGroup {
  items: SearchResult[];
  warnings: string[];
}

export const SEARCH_PAGES: SearchResult[] = [
  { id: 'page:today', title: 'Today', detail: 'Daily Brief · home', target: { kind: 'page', view: 'today' } },
  {
    id: 'page:albatrosses',
    title: 'Albatrosses',
    detail: 'Work and plans',
    target: { kind: 'page', view: 'albatrosses' },
  },
  { id: 'page:mail', title: 'Mail', detail: 'Inbox and messages', target: { kind: 'page', view: 'mail' } },
  {
    id: 'page:calendar',
    title: 'Calendar',
    detail: 'Events and schedule',
    target: { kind: 'page', view: 'calendar' },
  },
  {
    id: 'page:files',
    title: 'Files',
    detail: 'Documents and connected drives',
    target: { kind: 'page', view: 'files' },
  },
  {
    id: 'page:areas',
    title: 'Areas',
    detail: 'Briefs and area inboxes',
    target: { kind: 'page', view: 'areas' },
  },
  {
    id: 'page:activity',
    title: 'Activity',
    detail: 'Recent updates and history',
    target: { kind: 'page', view: 'activity' },
  },
  {
    id: 'page:settings',
    title: 'Settings',
    detail: 'Accounts, connections and preferences',
    target: { kind: 'settings' },
  },
];

export function matchesSearch(text: string, query: string) {
  const haystack = text.toLocaleLowerCase();
  return query
    .trim()
    .toLocaleLowerCase()
    .split(/\s+/)
    .every((word) => haystack.includes(word));
}

export function searchPages(query: string) {
  return SEARCH_PAGES.filter((page) => matchesSearch(`${page.title} ${page.detail}`, query));
}

/** Provider-returned links are still untrusted navigation input. */
export function safeSearchUrl(value: string | undefined) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

export type SearchTool = <T>(name: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<T>;

export async function searchMail(
  query: string,
  accounts: Array<{ accountId: string; email: string }>,
  tool: SearchTool,
  signal?: AbortSignal,
): Promise<SearchGroup> {
  if (!accounts.length) return { items: [], warnings: ['Connect a mailbox in Settings to search mail.'] };
  const results = await Promise.allSettled(
    accounts.map(async (account) => {
      const data = await tool<{
        items: Array<{
          _id: string;
          subject?: string;
          fromAddress?: string;
          snippet?: string;
          lastDate?: number;
        }>;
      }>('search_threads', { account: account.accountId, query, max: 8 }, signal);
      return data.items.map(
        (item): SearchResult => ({
          id: `mail:${account.accountId}:${item._id}`,
          title: item.subject || '(no subject)',
          detail: [item.fromAddress, account.email, item.snippet].filter(Boolean).join(' · '),
          target: { kind: 'mail', account: account.accountId, threadId: item._id },
          timestamp: item.lastDate,
        }),
      );
    }),
  );
  signal?.throwIfAborted();
  return {
    items: results
      .flatMap((result) => (result.status === 'fulfilled' ? result.value : []))
      .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
      .slice(0, 16),
    warnings: results.flatMap((result, index) =>
      result.status === 'rejected'
        ? [`Could not search ${accounts[index].email}. Try again or check its connection in Settings.`]
        : [],
    ),
  };
}

export interface SearchCalendarEvent extends CalendarSearchTarget {
  title: string;
  endIso: string;
  allDay?: boolean;
  location?: string;
}
export async function searchCalendar(
  query: string,
  tool: SearchTool,
  signal?: AbortSignal,
): Promise<SearchGroup> {
  const { events } = await tool<{ events: SearchCalendarEvent[] }>(
    'calendar_search_events',
    { query, limit: 12 },
    signal,
  );
  return {
    items: events.map((event) => ({
      id: `calendar:${event.accountId}:${event.calendarId}:${event.eventId}`,
      title: event.title || '(untitled event)',
      detail: event.location || 'Calendar event',
      timestamp: Date.parse(event.startIso),
      target: { kind: 'calendar', event },
    })),
    warnings: [],
  };
}

export interface SearchCloudFile {
  id: string;
  name: string;
  provider: string;
  connectionId?: string;
  mimeType?: string;
  webUrl?: string;
  isFolder: boolean;
}
export function cloudFileResult(file: SearchCloudFile): SearchResult | null {
  // Folders open in their provider. Files without an openable destination must
  // not become dead keyboard targets.
  const googleNative =
    !file.isFolder &&
    file.provider === 'google_drive' &&
    file.connectionId &&
    [
      'application/vnd.google-apps.document',
      'application/vnd.google-apps.spreadsheet',
      'application/vnd.google-apps.presentation',
    ].includes(file.mimeType || '');
  const url = safeSearchUrl(file.webUrl);
  if (!googleNative && !url) return null;
  return {
    id: `cloud:${file.connectionId || file.provider}:${file.id}`,
    title: file.name,
    detail: `${file.provider === 'google_drive' ? 'Google Drive' : 'OneDrive'}${file.isFolder ? ' · Folder' : ''}`,
    target: googleNative
      ? { kind: 'google', connectionId: file.connectionId!, fileId: file.id, mimeType: file.mimeType! }
      : { kind: 'external', url: url! },
  };
}
export async function searchCloudFiles(
  query: string,
  tool: SearchTool,
  signal?: AbortSignal,
): Promise<SearchGroup> {
  const data = await tool<{ files: SearchCloudFile[]; errors?: unknown[] }>(
    'cloud_file_search',
    { query, limit: 12 },
    signal,
  );
  return {
    items: data.files.map(cloudFileResult).filter((item): item is SearchResult => item !== null),
    warnings: data.errors?.length
      ? ['Some connected drives could not be searched. Check their connections in Files.']
      : [],
  };
}

export function localFileResults(
  query: string,
  documents: Array<{ documentId: string; title: string; kind: string }>,
  uploads: Array<{ id: string; name: string; url?: string }>,
): SearchResult[] {
  return [
    ...documents
      .filter((doc) => matchesSearch(doc.title, query))
      .map(
        (doc): SearchResult => ({
          id: `document:${doc.documentId}`,
          title: doc.title,
          detail: `Albatross ${doc.kind}`,
          target: { kind: 'document', documentId: doc.documentId },
        }),
      ),
    ...uploads
      .filter((file) => matchesSearch(file.name, query) && safeSearchUrl(file.url))
      .map(
        (file): SearchResult => ({
          id: `upload:${file.id}`,
          title: file.name,
          detail: 'Uploaded file',
          target: { kind: 'external', url: safeSearchUrl(file.url)! },
        }),
      ),
  ].slice(0, 12);
}

export function searchFilePath(target: Extract<SearchTarget, { kind: 'document' | 'google' }>) {
  const params = new URLSearchParams({ view: 'files' });
  if (target.kind === 'document') params.set('document', target.documentId);
  else {
    params.set('provider', 'google_drive');
    params.set('connection', target.connectionId);
    params.set('file', target.fileId);
    params.set('mime', target.mimeType);
  }
  return `/?${params}`;
}
