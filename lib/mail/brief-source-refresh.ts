import { syncCalendarAccount } from '../calendar/sync';
import { syncCloudContent } from '../content/cloud-sync';
import { listCloudFileConnections } from '../files/connections';
import { api, convexQuery } from '../hosted/convex';
import { mapConcurrent } from '../jev/client';
import { listUserConnections } from '../mcp/connections';
import { syncConnection } from '../mcp/sync';
import { reconcileMailCorpusAccount } from './corpus-sync';

export interface BriefSourceCheck {
  source: string;
  status: 'checked' | 'unavailable';
}
const defaults = {
  accounts: (userId: string) =>
    convexQuery<Array<{ accountId: string; status: string }>>((api as any).accounts.listConnectedAccounts, {
      userId,
    }),
  connections: listUserConnections,
  files: listCloudFileConnections,
  mail: reconcileMailCorpusAccount,
  calendar: syncCalendarAccount,
  mcp: syncConnection,
  cloud: (userId: string, connectionId: string) => syncCloudContent(userId, undefined, [connectionId]),
  now: Date.now,
};

/** Check broadly before selecting a small writer packet. Provider feeds are
 * incremental/bounded: a successful check never establishes complete coverage.
 * Narrative callers pass their exact opt-in list; ordinary briefs honor each
 * connector's includeInBrief setting. In-flight work is shared per user/source.
 */
export function createBriefSourceRefresher(deps = defaults) {
  const flights = new Map<string, Promise<BriefSourceCheck>>();
  const recent = new Map<string, number>();
  return async (userId: string, sources?: readonly string[]): Promise<BriefSourceCheck[]> => {
    const allowed = (source: string) => !sources || sources.includes(source);
    const discover = <T>(read: () => Promise<T>) => Promise.resolve().then(read);
    const discovery = await Promise.allSettled([
      !sources || sources.some((s) => /^(mail|calendar):/.test(s))
        ? discover(() => deps.accounts(userId))
        : Promise.resolve([]),
      !sources || sources.some((s) => s.startsWith('mcp:'))
        ? discover(() => deps.connections(userId))
        : Promise.resolve([]),
      !sources || sources.some((s) => s.startsWith('files:'))
        ? discover(() => deps.files(userId))
        : Promise.resolve([]),
    ]);
    const checks: BriefSourceCheck[] = [];
    const jobs: Array<{ source: string; run: () => Promise<{ ok: boolean }> }> = [];
    const [accounts, connections, files] = discovery;
    discovery.forEach((result, i) => {
      if (result.status === 'rejected')
        checks.push({ source: ['mail/calendar', 'connected sources', 'files'][i], status: 'unavailable' });
    });
    if (accounts.status === 'fulfilled')
      for (const account of accounts.value) {
        if (account.status === 'disconnected') continue;
        if (allowed(`mail:${account.accountId}`))
          jobs.push({
            source: `mail:${account.accountId}`,
            run: () => deps.mail({ userId, accountId: account.accountId, limit: 20 }),
          });
        if (allowed(`calendar:${account.accountId}`))
          jobs.push({
            source: `calendar:${account.accountId}`,
            run: () => deps.calendar({ userId, accountId: account.accountId, reason: 'brief' }),
          });
      }
    if (connections.status === 'fulfilled')
      for (const connection of connections.value) {
        const source = `mcp:${connection.connectionId}`;
        if (
          connection.status === 'disconnected' ||
          !allowed(source) ||
          (!sources && !connection.includeInBrief)
        )
          continue;
        jobs.push({ source, run: () => deps.mcp(userId, connection.connectionId) });
      }
    if (files.status === 'fulfilled')
      for (const connection of files.value) {
        const source = `files:${connection.connectionId}`;
        if (!allowed(source)) continue;
        jobs.push({
          source,
          run: async () => ({
            ok: (await deps.cloud(userId, connection.connectionId)).every(
              (result) => result.ok && !result.pending,
            ),
          }),
        });
      }
    for (const [key, at] of recent) if (deps.now() - at >= 300_000) recent.delete(key);
    const results = await mapConcurrent(jobs, 3, async ({ source, run }) => {
      const key = JSON.stringify([userId, source]);
      if (recent.has(key)) return { source, status: 'checked' as const };
      let pending = flights.get(key);
      if (!pending) {
        pending = Promise.resolve()
          .then(run)
          .then((result): BriefSourceCheck => {
            if (result.ok) recent.set(key, deps.now());
            return { source, status: result.ok ? 'checked' : 'unavailable' };
          })
          .catch((): BriefSourceCheck => ({ source, status: 'unavailable' }))
          .finally(() => flights.delete(key));
        flights.set(key, pending);
      }
      return pending;
    });
    return [...checks, ...results];
  };
}

export const refreshBriefSources = createBriefSourceRefresher();
export function briefSourceCoverage(checks: BriefSourceCheck[]) {
  const unavailable = checks.filter((check) => check.status === 'unavailable').length;
  return `Checked ${checks.length - unavailable} connected source feeds for changes. ${unavailable ? `${unavailable} source checks could not establish freshness; saved evidence may be stale. ` : ''}Feeds are partial; missing records do not establish that nothing changed.`;
}
