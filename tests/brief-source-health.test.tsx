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
