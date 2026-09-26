import { api, convexQuery } from '../hosted/convex';
import { isReconnectReason } from '../nylas/grant-health';
import type { DailyReport } from '../shared/types';

// The source health line (FEATURES item 18). The Today masthead lists the
// sources behind the edition with their last sync time, and flags each
// mailbox, calendar, or connected tool that needs the user to reconnect. A
// broken source must never read as a calm day. Web and native read the same
// summary through the `get_brief_sources` tool.

export type BriefSourceKind = 'mail' | 'calendar' | 'connector';
export type BriefSourceStatus = 'ok' | 'syncing' | 'stale' | 'reconnect' | 'error';

export interface BriefSourceHealth {
  /** `mail:<accountId>`, `calendar:<accountId>`, or `mcp:<connectionId>`. */
  id: string;
  kind: BriefSourceKind;
  /** The mailbox address, or the tool name. */
  label: string;
  /** google, microsoft, icloud, imap, github, bitbucket, jira, slack, granola. */
  provider: string;
  status: BriefSourceStatus;
  lastSyncedAt: number | null;
  /** The edition read this source. */
  inEdition: boolean;
  /** A web path that starts the reconnect, when the user must act. */
  reconnectPath: string | null;
  /** One short sentence for a status other than ok. */
  detail: string | null;
}

export interface BriefSourceHealthSummary {
  sources: BriefSourceHealth[];
  /** Sources that need the user: reconnect or error. */
  attention: number;
  /** One plain sentence for clients that show text only. */
  line: string;
  checkedAt: number;
}

export interface BriefSourceRows {
  accounts: Array<{
    accountId: string;
    email: string;
    provider: string;
    status: 'connected' | 'disconnected' | 'error';
    displayName?: string;
    lastSyncedAt?: number;
    error?: string;
  }>;
  mailSync: Array<{
    accountId: string;
    status: string;
    corpusReady: boolean;
    error?: string;
    lastIncrementalSyncAt?: number;
    lastBackfillAt?: number;
    updatedAt?: number;
  }>;
  calendarSync: Array<{
    accountId: string;
    status: string;
    error?: string;
    lastSyncedAt?: number;
    lastIncrementalSyncAt?: number;
  }>;
  connections: Array<{
    connectionId: string;
    server: string;
    status: 'connected' | 'disconnected' | 'error';
    authKind?: 'token' | 'oauth';
    displayName?: string;
    includeInBrief: boolean;
    lastSyncedAt?: number;
    error?: string;
  }>;
  connectorSync: Array<{ connectionId: string; status: string; lastSyncedAt?: number; error?: string }>;
}

/** A source that has not synced for this long reads as stale. */
export const BRIEF_SOURCE_STALE_MS = 6 * 3600_000;

const CONNECTOR_LABELS: Record<string, string> = {
  github: 'GitHub',
  bitbucket: 'Bitbucket',
  jira: 'Jira',
  slack: 'Slack',
  granola: 'Granola',
};

function newest(...values: Array<number | undefined | null>): number | null {
  const valid = values.filter((value): value is number => typeof value === 'number' && value > 0);
  return valid.length ? Math.max(...valid) : null;
}

function freshness(lastSyncedAt: number | null, now: number): BriefSourceStatus {
  return lastSyncedAt !== null && now - lastSyncedAt > BRIEF_SOURCE_STALE_MS ? 'stale' : 'ok';
}

function mailReconnectPath(provider: string) {
  return `/api/nylas/connect?provider=${encodeURIComponent(provider)}&redirectTo=${encodeURIComponent('/?view=today')}`;
}

export function briefSourceHealth(
  rows: BriefSourceRows,
  options: { now?: number; report?: Pick<DailyReport, 'accounts' | 'sourceChecks' | 'sections'> | null } = {},
): BriefSourceHealthSummary {
  const now = options.now ?? Date.now();
  const report = options.report ?? null;
  const checked = new Set((report?.sourceChecks ?? []).map((check) => check.source));
  const editionAccounts = new Set(report?.accounts ?? []);
  const editionServers = new Set((report?.sections?.mcp ?? []).map((item) => item.server));
  const mailSync = new Map(rows.mailSync.map((row) => [row.accountId, row]));
  const calendarSync = new Map(rows.calendarSync.map((row) => [row.accountId, row]));
  const connectorSync = new Map(rows.connectorSync.map((row) => [row.connectionId, row]));
  const sources: BriefSourceHealth[] = [];

  for (const account of rows.accounts) {
    if (account.status === 'disconnected') continue;
    const label = account.email;
    const reconnect = account.status === 'error' && isReconnectReason(account.error);
    const sync = mailSync.get(account.accountId);
    const mailLast = newest(sync?.lastIncrementalSyncAt, sync?.lastBackfillAt, account.lastSyncedAt);
    let mailStatus: BriefSourceStatus;
    let mailDetail: string | null = null;
    if (reconnect) {
      mailStatus = 'reconnect';
      mailDetail = `${label} needs you to sign in again. Mail from it is paused.`;
    } else if (account.status === 'error' || sync?.status === 'error') {
      mailStatus = 'error';
      mailDetail = `${label} could not sync. It will try again.`;
    } else if (sync && !sync.corpusReady && sync.status !== 'ready') {
      mailStatus = 'syncing';
      mailDetail = `${label} is still downloading.`;
    } else {
      mailStatus = freshness(mailLast, now);
      if (mailStatus === 'stale') mailDetail = `${label} has not synced for more than six hours.`;
    }
    sources.push({
      id: `mail:${account.accountId}`,
      kind: 'mail',
      label,
      provider: account.provider,
      status: mailStatus,
      lastSyncedAt: mailLast,
      inEdition: editionAccounts.has(account.accountId) || checked.has(`mail:${account.accountId}`),
      reconnectPath: mailStatus === 'reconnect' ? mailReconnectPath(account.provider) : null,
      detail: mailDetail,
    });

    const calendar = calendarSync.get(account.accountId);
    if (!calendar) continue;
    const calendarLast = newest(calendar.lastIncrementalSyncAt, calendar.lastSyncedAt);
    let calendarStatus: BriefSourceStatus;
    let calendarDetail: string | null = null;
    if (reconnect || calendar.status === 'unauthorized') {
      calendarStatus = 'reconnect';
      calendarDetail = reconnect
        ? `The calendar for ${label} is paused until you sign in again.`
        : `The calendar for ${label} needs calendar access. Reconnect to grant it.`;
    } else if (calendar.status === 'error') {
      calendarStatus = 'error';
      calendarDetail = `The calendar for ${label} could not sync. It will try again.`;
    } else if (calendar.status === 'idle' && !calendarLast) {
      calendarStatus = 'syncing';
      calendarDetail = `The calendar for ${label} has not synced yet.`;
    } else {
      calendarStatus = freshness(calendarLast, now);
      if (calendarStatus === 'stale')
        calendarDetail = `The calendar for ${label} has not synced for more than six hours.`;
    }
    sources.push({
      id: `calendar:${account.accountId}`,
      kind: 'calendar',
      label,
      provider: account.provider,
      status: calendarStatus,
      lastSyncedAt: calendarLast,
      inEdition: editionAccounts.has(account.accountId) || checked.has(`calendar:${account.accountId}`),
      reconnectPath: calendarStatus === 'reconnect' ? mailReconnectPath(account.provider) : null,
      detail: calendarDetail,
    });
  }

  for (const connection of rows.connections) {
    if (connection.status === 'disconnected' || !connection.includeInBrief) continue;
    const name = CONNECTOR_LABELS[connection.server] ?? connection.server;
    const sync = connectorSync.get(connection.connectionId);
    const last = newest(sync?.lastSyncedAt, connection.lastSyncedAt);
    let status: BriefSourceStatus;
    let detail: string | null = null;
    if (connection.status === 'error') {
      status = 'reconnect';
      detail = `${name} needs you to connect it again.`;
    } else if (sync?.status === 'error') {
      status = 'error';
      detail = `${name} could not sync. It will try again.`;
    } else if (!last) {
      status = 'syncing';
      detail = `${name} has not synced yet.`;
    } else {
      status = freshness(last, now);
      if (status === 'stale') detail = `${name} has not synced for more than six hours.`;
    }
    sources.push({
      id: `mcp:${connection.connectionId}`,
      kind: 'connector',
      label: connection.displayName?.trim() || name,
      provider: connection.server,
      status,
      lastSyncedAt: last,
      inEdition:
        checked.has(`mcp:${connection.connectionId}`) || editionServers.has(connection.server as any),
      reconnectPath:
        status !== 'reconnect'
          ? null
          : connection.authKind === 'oauth'
            ? `/api/mcp/oauth/start?server=${encodeURIComponent(connection.server)}`
            : '/settings?tab=connections',
      detail,
    });
  }

  const attention = sources.filter((source) => source.status === 'reconnect' || source.status === 'error');
  return { sources, attention: attention.length, line: briefSourceLine(sources), checkedAt: now };
}

function joinNames(names: string[]) {
  if (names.length <= 1) return names.join('');
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')}, and ${names.at(-1)}`;
}

/** "From 2 mailboxes, 1 calendar, and GitHub. work@example.com needs you to sign in again." */
export function briefSourceLine(sources: BriefSourceHealth[]): string {
  if (!sources.length) return 'No sources are connected. Connect a mailbox to fill the brief.';
  const mail = sources.filter((source) => source.kind === 'mail').length;
  const calendars = sources.filter((source) => source.kind === 'calendar').length;
  const tools = sources.filter((source) => source.kind === 'connector').map((source) => source.label);
  const parts = [
    ...(mail ? [`${mail} ${mail === 1 ? 'mailbox' : 'mailboxes'}`] : []),
    ...(calendars ? [`${calendars} ${calendars === 1 ? 'calendar' : 'calendars'}`] : []),
    ...tools,
  ];
  const problems = sources
    .filter((source) => source.status === 'reconnect' || source.status === 'error')
    .map((source) => source.detail)
    .filter((detail): detail is string => Boolean(detail));
  return [`From ${joinNames(parts)}.`, ...problems].join(' ');
}

export async function loadBriefSourceRows(
  userId: string,
  query: typeof convexQuery = convexQuery,
): Promise<BriefSourceRows> {
  return query<BriefSourceRows>((api as any).dailyReports.briefSourceRows, { userId });
}
