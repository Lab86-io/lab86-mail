import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { convexTest } from 'convex-test';
import { renderToStaticMarkup } from 'react-dom/server';
import { BriefSourceLineView, syncedAgo } from '../components/report/BriefSourceLine';
import { api } from '../convex/_generated/api';
import schema from '../convex/schema';
import {
  BRIEF_SOURCE_STALE_MS,
  type BriefSourceRows,
  briefSourceHealth,
  briefSourceLine,
  loadBriefSourceRows,
} from '../lib/brief/source-health';
import { reconnectReason } from '../lib/nylas/grant-health';
import type { DailyReport } from '../lib/shared/types';
import { migrateDailyReport } from '../lib/store/daily-reports';

const NOW = Date.parse('2026-09-26T11:00:00Z');
const SECRET = 'source-health-secret';

function rows(overrides: Partial<BriefSourceRows> = {}): BriefSourceRows {
  return {
    accounts: [
      {
        accountId: 'gmail',
        email: 'me@gmail.com',
        provider: 'google',
        status: 'connected',
        lastSyncedAt: NOW - 30 * 60_000,
      },
      {
        accountId: 'work',
        email: 'me@work.com',
        provider: 'microsoft',
        status: 'error',
        error: reconnectReason('grant expired'),
      },
      { accountId: 'gone', email: 'old@example.com', provider: 'google', status: 'disconnected' },
    ],
    mailSync: [
      {
        accountId: 'gmail',
        status: 'ready',
        corpusReady: true,
        lastIncrementalSyncAt: NOW - 4 * 60_000,
      },
    ],
    calendarSync: [
      { accountId: 'gmail', status: 'ready', lastSyncedAt: NOW - 10 * 60_000 },
      { accountId: 'work', status: 'ready', lastSyncedAt: NOW - 10 * 60_000 },
    ],
    connections: [
      {
        connectionId: 'gh',
        server: 'github',
        status: 'connected',
        authKind: 'oauth',
        includeInBrief: true,
        lastSyncedAt: NOW - 2 * 3600_000,
      },
      { connectionId: 'jira', server: 'jira', status: 'error', authKind: 'token', includeInBrief: true },
      { connectionId: 'slack', server: 'slack', status: 'connected', includeInBrief: false },
    ],
    connectorSync: [],
    ...overrides,
  };
}

describe('brief source health', () => {
  test('lists each source with its sync time and flags the ones that need the user', () => {
    const report = {
      accounts: ['gmail'],
      sourceChecks: [{ source: 'mcp:gh', status: 'checked' as const }],
      sections: { mcp: [] },
    } as unknown as DailyReport;
    const health = briefSourceHealth(rows(), { now: NOW, report });
    expect(health.sources.map((source) => [source.id, source.status, source.inEdition])).toEqual([
      ['mail:gmail', 'ok', true],
      ['calendar:gmail', 'ok', true],
      ['mail:work', 'reconnect', false],
      ['calendar:work', 'reconnect', false],
      ['mcp:gh', 'ok', true],
      ['mcp:jira', 'reconnect', false],
    ]);
    expect(health.sources[0].lastSyncedAt).toBe(NOW - 4 * 60_000);
    expect(health.attention).toBe(3);
    expect(health.sources.find((source) => source.id === 'mail:work')?.reconnectPath).toBe(
      '/api/nylas/connect?provider=microsoft&redirectTo=%2F%3Fview%3Dtoday',
    );
    expect(health.sources.find((source) => source.id === 'mcp:jira')?.reconnectPath).toBe(
      '/settings?tab=connections',
    );
    expect(health.line).toBe(
      'From 2 mailboxes, 2 calendars, GitHub, and Jira. me@work.com needs you to sign in again. Mail from it is paused. The calendar for me@work.com is paused until you sign in again. Jira needs you to connect it again.',
    );
    expect(health.line).not.toMatch(/\bAI\b/);
  });

  test('tells syncing, stale, error, and missing calendar access apart', () => {
    const health = briefSourceHealth(
      {
        accounts: [
          { accountId: 'new', email: 'new@example.com', provider: 'google', status: 'connected' },
          {
            accountId: 'old',
            email: 'old@example.com',
            provider: 'google',
            status: 'connected',
            lastSyncedAt: NOW - BRIEF_SOURCE_STALE_MS - 1,
          },
          {
            accountId: 'broken',
            email: 'broken@example.com',
            provider: 'imap',
            status: 'error',
            error: 'boom',
          },
        ],
        mailSync: [
          { accountId: 'new', status: 'backfilling', corpusReady: false },
          { accountId: 'old', status: 'ready', corpusReady: true },
        ],
        calendarSync: [
          { accountId: 'new', status: 'idle' },
          { accountId: 'old', status: 'unauthorized' },
          { accountId: 'broken', status: 'error' },
        ],
        connections: [
          { connectionId: 'gh', server: 'github', status: 'connected', includeInBrief: true },
          {
            connectionId: 'bb',
            server: 'bitbucket',
            status: 'connected',
            includeInBrief: true,
            displayName: 'Team Bitbucket',
            lastSyncedAt: NOW - BRIEF_SOURCE_STALE_MS - 1,
          },
          { connectionId: 'granola', server: 'granola', status: 'connected', includeInBrief: true },
        ],
        connectorSync: [{ connectionId: 'granola', status: 'error', lastSyncedAt: NOW }],
      },
      { now: NOW },
    );
    expect(health.sources.map((source) => `${source.id}:${source.status}`)).toEqual([
      'mail:new:syncing',
      'calendar:new:syncing',
      'mail:old:stale',
      'calendar:old:reconnect',
      'mail:broken:error',
      'calendar:broken:error',
      'mcp:gh:syncing',
      'mcp:bb:stale',
      'mcp:granola:error',
    ]);
    expect(health.sources.find((source) => source.id === 'mcp:bb')?.label).toBe('Team Bitbucket');
    expect(health.sources.find((source) => source.id === 'calendar:old')?.detail).toContain(
      'calendar access',
    );
    expect(health.sources.every((source) => !source.inEdition)).toBe(true);
  });

  test('says plainly when nothing is connected', () => {
    expect(briefSourceLine([])).toBe('No sources are connected. Connect a mailbox to fill the brief.');
    const one = briefSourceHealth(
      { ...rows(), accounts: [rows().accounts[0]], calendarSync: [], connections: [] },
      { now: NOW },
    );
    expect(one.line).toBe('From 1 mailbox.');
  });

  test('the edition keeps the source checks it made', () => {
    const migrated = migrateDailyReport({
      _id: 'r',
      kind: 'morning',
      generatedAt: NOW,
      accounts: [],
      title: 'Brief',
      narrative: '',
      sections: {},
      stats: {},
      sourceChecks: [
        { source: 'mail:gmail', status: 'checked' },
        { source: 'mcp:gh', status: 'weird' },
        { bad: true },
      ],
    } as any);
    expect(migrated.sourceChecks).toEqual([
      { source: 'mail:gmail', status: 'checked' },
      { source: 'mcp:gh', status: 'checked' },
    ]);
  });
});

describe('brief source rows in Convex', () => {
  const previous = process.env.LAB86_CONVEX_INTERNAL_SECRET;
  beforeEach(() => {
    process.env.LAB86_CONVEX_INTERNAL_SECRET = SECRET;
  });
  afterEach(() => {
    if (previous === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
    else process.env.LAB86_CONVEX_INTERNAL_SECRET = previous;
  });

  test('returns only display fields for the user, never grant ids', async () => {
    const t = convexTest(schema, {
      '../convex/_generated/api.js': () => import('../convex/_generated/api.js'),
      '../convex/dailyReports.ts': () => import('../convex/dailyReports'),
    });
    await t.run(async (ctx) => {
      await ctx.db.insert('connectedAccounts', {
        userId: 'u1',
        accountId: 'a1',
        email: 'u1@example.com',
        provider: 'google',
        status: 'connected',
        scopes: [],
        grantId: 'secret-grant',
        createdAt: 1,
        updatedAt: 1,
      });
      await ctx.db.insert('mailSyncStates', {
        userId: 'u1',
        accountId: 'a1',
        grantId: 'secret-grant',
        provider: 'google',
        status: 'ready',
        cursor: 'secret-cursor',
        corpusReady: true,
        lastIncrementalSyncAt: NOW,
        createdAt: 1,
        updatedAt: 1,
      });
      await ctx.db.insert('calendarSyncStates', {
        userId: 'u1',
        accountId: 'a1',
        grantId: 'secret-grant',
        provider: 'google',
        status: 'ready',
        lastSyncedAt: NOW,
        createdAt: 1,
        updatedAt: 1,
      });
      await ctx.db.insert('mcpConnections', {
        userId: 'u1',
        connectionId: 'c1',
        server: 'github',
        serverUrl: 'https://api.github.com',
        authKind: 'oauth',
        status: 'connected',
        scopes: [],
        includeInBrief: true,
        includeInSearch: true,
        createdAt: 1,
        updatedAt: 1,
      });
      await ctx.db.insert('mcpSyncStates', {
        userId: 'u1',
        connectionId: 'c1',
        server: 'github',
        status: 'ready',
        lastSyncedAt: NOW,
        lastCursor: 'secret-cursor',
        createdAt: 1,
        updatedAt: 1,
      });
      await ctx.db.insert('connectedAccounts', {
        userId: 'someone-else',
        accountId: 'a2',
        email: 'other@example.com',
        provider: 'google',
        status: 'connected',
        scopes: [],
        grantId: 'other-grant',
        createdAt: 1,
        updatedAt: 1,
      });
    });
    const result = await loadBriefSourceRows('u1', ((fn: any, args: any) =>
      t.query(fn, { ...args, internalSecret: SECRET })) as any);
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(result.accounts.map((row) => row.email)).toEqual(['u1@example.com']);
    expect(result.connections[0]).toMatchObject({
      server: 'github',
      includeInBrief: true,
      authKind: 'oauth',
    });
    expect(briefSourceHealth(result, { now: NOW }).sources.map((source) => source.status)).toEqual([
      'ok',
      'ok',
      'ok',
    ]);
    await expect(t.query((api as any).dailyReports.briefSourceRows, { userId: 'u1' })).rejects.toThrow();
  });
});

describe('the masthead source line', () => {
  test('puts a source that needs the user first, with the reconnect link', () => {
    const health = briefSourceHealth(rows(), { now: NOW });
    const html = renderToStaticMarkup(<BriefSourceLineView health={health} now={NOW} />);
    expect(html.indexOf('me@work.com needs you to sign in again')).toBeLessThan(html.indexOf('Sources:'));
    expect(html).toContain('href="/api/nylas/connect?provider=microsoft&amp;redirectTo=%2F%3Fview%3Dtoday"');
    expect(html).toContain('>Reconnect</a>');
    expect(html).toContain('me@gmail.com');
    expect(html).toContain('synced 4 min ago');
    expect(html).toContain('Calendar (me@gmail.com)');
    expect(html).toContain('synced 2 hours ago');
  });

  test('shows the empty line and the syncing state', () => {
    expect(
      renderToStaticMarkup(
        <BriefSourceLineView health={{ sources: [], attention: 0, line: 'Nothing.', checkedAt: NOW }} />,
      ),
    ).toContain('Nothing.');
    const syncing = briefSourceHealth(
      {
        ...rows(),
        accounts: [{ accountId: 'n', email: 'n@example.com', provider: 'google', status: 'connected' }],
        mailSync: [{ accountId: 'n', status: 'backfilling', corpusReady: false }],
        calendarSync: [],
        connections: [],
      },
      { now: NOW },
    );
    expect(renderToStaticMarkup(<BriefSourceLineView health={syncing} now={NOW} />)).toContain(
      'still syncing',
    );
  });

  test('says how long ago a source synced', () => {
    expect(syncedAgo(null, NOW)).toBe('not synced yet');
    expect(syncedAgo(NOW - 10_000, NOW)).toBe('just now');
    expect(syncedAgo(NOW - 3600_000, NOW)).toBe('1 hour ago');
    expect(syncedAgo(NOW - 26 * 3600_000, NOW)).toBe('1 day ago');
    expect(syncedAgo(NOW - 72 * 3600_000, NOW)).toBe('3 days ago');
  });
});

describe('connector sync problems in the source line (AI-7)', () => {
  const connector = (overrides: Record<string, unknown>) => ({
    connectionId: 'c',
    server: 'github',
    status: 'connected' as const,
    authKind: 'token' as const,
    includeInBrief: true,
    lastSyncedAt: NOW - 10 * 60_000,
    ...overrides,
  });

  function health() {
    return briefSourceHealth(
      {
        accounts: [],
        mailSync: [],
        calendarSync: [],
        connections: [
          // Part of the last sync failed; the same run saved items.
          connector({
            connectionId: 'gh',
            lastSyncError: 'account check: rate limited',
            lastSyncErrorAt: NOW - 10 * 60_000,
            lastSyncOkAt: NOW - 10 * 60_000,
          }),
          // The whole last run failed after an older good sync.
          connector({
            connectionId: 'jira',
            server: 'jira',
            lastSyncError: 'socket hang up',
            lastSyncErrorAt: NOW - 5 * 60_000,
            lastSyncOkAt: NOW - 40 * 60_000,
          }),
          // The sign-in failed.
          connector({
            connectionId: 'granola',
            server: 'granola',
            authKind: 'oauth',
            status: 'error',
            error: 'Reconnect Granola: its sign-in expired.',
            lastSyncError: 'Reconnect Granola: its sign-in expired.',
            lastSyncErrorAt: NOW - 5 * 60_000,
          }),
        ],
        // The sync-state row still says error for both sync problems.
        connectorSync: [
          { connectionId: 'gh', status: 'error', lastSyncedAt: NOW - 10 * 60_000 },
          { connectionId: 'jira', status: 'error', lastSyncedAt: NOW - 40 * 60_000 },
        ],
      },
      { now: NOW },
    );
  }

  test('only a failed sign-in asks for a reconnect; a sync problem says the last sync had a problem', () => {
    const summary = health();
    const byId = Object.fromEntries(summary.sources.map((source) => [source.id, source]));
    expect(byId['mcp:gh']).toMatchObject({
      status: 'stale',
      reconnectPath: null,
      detail: 'Part of the last GitHub sync had a problem. Some items can be missing.',
    });
    expect(byId['mcp:jira']).toMatchObject({
      status: 'error',
      reconnectPath: null,
      detail: 'The last Jira sync had a problem. It will try again.',
    });
    expect(byId['mcp:granola']).toMatchObject({
      status: 'reconnect',
      reconnectPath: '/api/mcp/oauth/start?server=granola',
    });
    expect(summary.attention).toBe(2);
    expect(summary.line).toBe(
      'From GitHub, Jira, and Granola. The last Jira sync had a problem. It will try again. Granola needs you to connect it again.',
    );
  });

  test('the masthead shows Reconnect only for the source that needs it', () => {
    const html = renderToStaticMarkup(<BriefSourceLineView health={health()} now={NOW} />);
    expect(html.match(/>Reconnect</g)).toHaveLength(1);
    expect(html).toContain('The last Jira sync had a problem. It will try again.');
    expect(html).toContain('data-brief-source-status="stale"');
  });

  test('a partial problem on a source older than six hours still reads as not synced', () => {
    const summary = briefSourceHealth(
      {
        accounts: [],
        mailSync: [],
        calendarSync: [],
        connections: [
          connector({
            lastSyncedAt: NOW - BRIEF_SOURCE_STALE_MS - 1,
            lastSyncError: 'details unavailable',
            lastSyncErrorAt: NOW - BRIEF_SOURCE_STALE_MS - 1,
            lastSyncOkAt: NOW - BRIEF_SOURCE_STALE_MS - 1,
          }),
        ],
        connectorSync: [],
      },
      { now: NOW },
    );
    expect(summary.sources[0]).toMatchObject({
      status: 'stale',
      detail: 'GitHub has not synced for more than six hours.',
    });
  });

  test('Convex passes the connector sync problem fields to the source line', async () => {
    const previous = process.env.LAB86_CONVEX_INTERNAL_SECRET;
    process.env.LAB86_CONVEX_INTERNAL_SECRET = SECRET;
    try {
      const t = convexTest(schema, {
        '../convex/_generated/api.js': () => import('../convex/_generated/api.js'),
        '../convex/dailyReports.ts': () => import('../convex/dailyReports'),
      });
      await t.run(async (ctx) => {
        await ctx.db.insert('mcpConnections', {
          userId: 'u1',
          connectionId: 'c1',
          server: 'github',
          serverUrl: 'https://api.github.com',
          authKind: 'token',
          status: 'connected',
          scopes: [],
          includeInBrief: true,
          includeInSearch: true,
          lastSyncedAt: NOW,
          lastSyncError: 'rate limited',
          lastSyncErrorAt: NOW,
          lastSyncOkAt: NOW,
          createdAt: 1,
          updatedAt: 1,
        });
      });
      const result = await loadBriefSourceRows('u1', ((fn: any, args: any) =>
        t.query(fn, { ...args, internalSecret: SECRET })) as any);
      expect(result.connections[0]).toMatchObject({
        status: 'connected',
        lastSyncError: 'rate limited',
        lastSyncErrorAt: NOW,
        lastSyncOkAt: NOW,
      });
      expect(briefSourceHealth(result, { now: NOW }).sources[0].status).toBe('stale');
    } finally {
      if (previous === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
      else process.env.LAB86_CONVEX_INTERNAL_SECRET = previous;
    }
  });
});
