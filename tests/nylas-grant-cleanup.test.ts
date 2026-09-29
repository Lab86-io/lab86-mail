import { describe, expect, test } from 'bun:test';
import {
  deleteNylasGrant,
  formatNylasCleanupReport,
  type NylasCleanupDeps,
  type NylasCleanupItem,
  type NylasCleanupPlanArgs,
  NylasGrantDeleteError,
  nylasCleanupPlanArgs,
  parseNylasCleanupArgs,
  runNylasGrantCleanup,
} from '../lib/nylas/grant-cleanup';

const NYLAS_GRANT = 'd502cbfc-98b3-49f4-93a7-d0a5d825d7fa';
const connection = {
  userId: 'user_a',
  accountId: 'account_a',
  email: 'ann@example.com',
  grantId: 'google:11111111-1111-4111-8111-111111111111',
  switchedToGoogleAt: Date.UTC(2026, 8, 20),
};

function fakeFetch(status: number, body: unknown = {}) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return Response.json(body, { status });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe('deleteNylasGrant', () => {
  test('sends DELETE /v3/grants/{id} with the API key', async () => {
    const { calls, fetchImpl } = fakeFetch(200, { request_id: 'r1' });
    const result = await deleteNylasGrant(NYLAS_GRANT, {
      apiKey: 'nyk_test',
      apiUri: 'https://api.eu.nylas.com/',
      fetchImpl,
    });
    expect(result).toBe('deleted');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`https://api.eu.nylas.com/v3/grants/${NYLAS_GRANT}`);
    expect(calls[0].init?.method).toBe('DELETE');
    expect(new Headers(calls[0].init?.headers).get('authorization')).toBe('Bearer nyk_test');
  });

  test('uses the US API by default and counts a 404 as gone', async () => {
    const { calls, fetchImpl } = fakeFetch(404, { error: { message: 'grant not found' } });
    expect(await deleteNylasGrant(NYLAS_GRANT, { apiKey: 'nyk_test', fetchImpl })).toBe('not_found');
    expect(calls[0].url).toBe(`https://api.us.nylas.com/v3/grants/${NYLAS_GRANT}`);
  });

  test('other answers throw with the status and the Nylas message', async () => {
    const { fetchImpl } = fakeFetch(401, { error: { message: 'Unauthorized' } });
    const failure = await deleteNylasGrant(NYLAS_GRANT, { apiKey: 'nyk_test', fetchImpl }).catch((e) => e);
    expect(failure).toBeInstanceOf(NylasGrantDeleteError);
    expect(failure.status).toBe(401);
    expect(failure.message).toBe('Nylas answered 401: Unauthorized');

    const empty = fakeFetch(503, 'not json');
    const bare = await deleteNylasGrant(NYLAS_GRANT, {
      apiKey: 'nyk_test',
      fetchImpl: empty.fetchImpl,
    }).catch((e) => e);
    expect(bare.message).toBe('Nylas answered 503');
  });

  test('refuses a direct Google grant id, an empty id, and a missing key without a call', async () => {
    const { calls, fetchImpl } = fakeFetch(200);
    await expect(deleteNylasGrant(connection.grantId, { apiKey: 'nyk_test', fetchImpl })).rejects.toThrow(
      'not a Nylas grant',
    );
    await expect(deleteNylasGrant(' ', { apiKey: 'nyk_test', fetchImpl })).rejects.toThrow('necessary');
    await expect(deleteNylasGrant(NYLAS_GRANT, { apiKey: '', fetchImpl })).rejects.toThrow('NYLAS_API_KEY');
    expect(calls).toHaveLength(0);
  });
});

function harness(
  items: NylasCleanupItem[],
  options: { deleteResult?: 'deleted' | 'not_found' | Error } = {},
) {
  const planned: NylasCleanupPlanArgs[] = [];
  const deleted: string[] = [];
  const cleared: string[] = [];
  const deps: NylasCleanupDeps = {
    plan: async (args) => {
      planned.push(args);
      return { items, truncated: false };
    },
    deleteGrant: async (grantId) => {
      deleted.push(grantId);
      const result = options.deleteResult ?? 'deleted';
      if (result instanceof Error) throw result;
      return result;
    },
    clear: async (grantId) => {
      cleared.push(grantId);
      return { cleared: 1 };
    },
    now: () => Date.UTC(2026, 8, 29),
  };
  return { deps, planned, deleted, cleared };
}

const eligible: NylasCleanupItem = { nylasGrantId: NYLAS_GRANT, eligible: true, connections: [connection] };
const refused: NylasCleanupItem = {
  nylasGrantId: 'other-grant',
  eligible: false,
  reason: 'A connection switched too recently.',
  connections: [{ ...connection, accountId: 'account_b', switchedToGoogleAt: null }],
};

describe('runNylasGrantCleanup', () => {
  test('a dry run lists what it would delete and calls neither Nylas nor the clear mutation', async () => {
    const { deps, planned, deleted, cleared } = harness([eligible, refused]);
    const report = await runNylasGrantCleanup({
      target: { kind: 'age', olderThanHours: 72 },
      apply: false,
      deps,
    });
    expect(planned).toEqual([{ switchedBefore: Date.UTC(2026, 8, 29) - 72 * 3_600_000 }]);
    expect(report.results.map((result) => result.outcome)).toEqual(['would_delete', 'skipped']);
    expect(deleted).toEqual([]);
    expect(cleared).toEqual([]);
    const lines = formatNylasCleanupReport(report);
    expect(lines[0]).toBe('Dry run: Nylas grant cleanup for switched accounts older than 72 hours.');
    expect(lines).toContain(`WOULD DELETE ${NYLAS_GRANT}`);
    expect(lines).toContain('SKIPPED other-grant');
    expect(lines).toContain('  reason: A connection switched too recently.');
    expect(lines.some((line) => line.includes('switch time not known'))).toBe(true);
    expect(lines.at(-1)).toBe('Would delete 1, skip 1. Add --apply to delete.');
  });

  test('apply deletes an eligible grant, then clears it; a skipped item is left alone', async () => {
    const { deps, planned, deleted, cleared } = harness([eligible, refused]);
    const report = await runNylasGrantCleanup({
      target: { kind: 'account', userId: 'user_a', accountId: 'account_a' },
      apply: true,
      deps,
    });
    expect(planned).toEqual([{ userId: 'user_a', accountId: 'account_a' }]);
    expect(deleted).toEqual([NYLAS_GRANT]);
    expect(cleared).toEqual([NYLAS_GRANT]);
    expect(report.results[0]).toMatchObject({ outcome: 'deleted', cleared: 1 });
    const lines = formatNylasCleanupReport(report);
    expect(lines[0]).toBe('Apply: Nylas grant cleanup for account user_a / account_a.');
    expect(lines).toContain('  cleared on 1 connection(s)');
    expect(lines).toContain('Deleted 1, already gone 0, skipped 1, failed 0.');
    expect(lines.at(-1)).toBe('The rollback to Nylas does not work for the cleared connections.');
  });

  test('a grant that Nylas no longer has is cleared too', async () => {
    const { deps, cleared } = harness([eligible], { deleteResult: 'not_found' });
    const report = await runNylasGrantCleanup({
      target: { kind: 'age', olderThanHours: 0 },
      apply: true,
      deps,
    });
    expect(report.results[0].outcome).toBe('already_gone');
    expect(cleared).toEqual([NYLAS_GRANT]);
  });

  test('a failed delete keeps the field, so the rollback still works', async () => {
    const { deps, cleared } = harness([eligible], { deleteResult: new NylasGrantDeleteError(500, 'boom') });
    const report = await runNylasGrantCleanup({
      target: { kind: 'age', olderThanHours: 1 },
      apply: true,
      deps,
    });
    expect(report.results[0]).toMatchObject({ outcome: 'failed', error: 'Nylas answered 500: boom' });
    expect(cleared).toEqual([]);
    const lines = formatNylasCleanupReport(report);
    expect(lines).toContain('  error: Nylas answered 500: boom');
    expect(lines.at(-1)).toBe('Deleted 0, already gone 0, skipped 0, failed 1.');
  });

  test('an item with no Nylas grant is skipped; an empty and a truncated plan say so', async () => {
    const { deps, deleted } = harness([
      { nylasGrantId: null, eligible: false, reason: 'The account was not found.', connections: [] },
    ]);
    const report = await runNylasGrantCleanup({
      target: { kind: 'account', userId: 'u', accountId: 'a' },
      apply: true,
      deps,
    });
    expect(report.results[0].outcome).toBe('skipped');
    expect(deleted).toEqual([]);
    expect(formatNylasCleanupReport(report)).toContain('SKIPPED (no Nylas grant)');

    const empty = formatNylasCleanupReport({
      apply: false,
      target: { kind: 'age', olderThanHours: 24 },
      truncated: true,
      results: [],
    });
    expect(empty).toContain('No switched account keeps a Nylas grant.');
    expect(empty).toContain('The plan read its row limit. Run the command again for the rest.');
  });

  test('the plan arguments follow the target', () => {
    expect(nylasCleanupPlanArgs({ kind: 'account', userId: 'u', accountId: 'a' }, 5)).toEqual({
      userId: 'u',
      accountId: 'a',
    });
    expect(nylasCleanupPlanArgs({ kind: 'age', olderThanHours: 2 }, 10_000_000)).toEqual({
      switchedBefore: 10_000_000 - 7_200_000,
    });
  });
});

describe('parseNylasCleanupArgs', () => {
  test('one account or an age, dry run by default', () => {
    expect(parseNylasCleanupArgs(['--user', 'u1', '--account', 'a1'])).toEqual({
      target: { kind: 'account', userId: 'u1', accountId: 'a1' },
      apply: false,
    });
    expect(parseNylasCleanupArgs(['--older-than-hours', '72', '--apply'])).toEqual({
      target: { kind: 'age', olderThanHours: 72 },
      apply: true,
    });
    expect(parseNylasCleanupArgs(['--dry-run', '--older-than-hours', '0'])).toEqual({
      target: { kind: 'age', olderThanHours: 0 },
      apply: false,
    });
    expect(parseNylasCleanupArgs(['--help'])).toBe('help');
    expect(parseNylasCleanupArgs(['-h'])).toBe('help');
  });

  test('refuses unclear or incomplete commands', () => {
    expect(() => parseNylasCleanupArgs([])).toThrow('Name one account');
    expect(() => parseNylasCleanupArgs(['--user', 'u1'])).toThrow('Name both --user and --account.');
    expect(() => parseNylasCleanupArgs(['--account', 'a1'])).toThrow('Name both --user and --account.');
    expect(() => parseNylasCleanupArgs(['--user', 'u', '--account', 'a', '--older-than-hours', '1'])).toThrow(
      'Not both',
    );
    expect(() => parseNylasCleanupArgs(['--older-than-hours', '1', '--apply', '--dry-run'])).toThrow(
      'not both',
    );
    expect(() => parseNylasCleanupArgs(['--older-than-hours', '-1'])).toThrow('0 or more');
    expect(() => parseNylasCleanupArgs(['--older-than-hours', 'soon'])).toThrow('0 or more');
    expect(() => parseNylasCleanupArgs(['--user'])).toThrow('--user needs a value.');
    expect(() => parseNylasCleanupArgs(['--user', '--apply'])).toThrow('--user needs a value.');
    expect(() => parseNylasCleanupArgs(['--force'])).toThrow('Unknown argument: --force');
  });
});
