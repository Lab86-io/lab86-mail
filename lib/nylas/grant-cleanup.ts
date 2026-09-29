// Owner-run cleanup of the Nylas grants that switched Google accounts keep
// (docs/google-direct-transport.md, "Cleanup"). A Google account that talks
// to Gmail directly keeps its old Nylas grant in `previousNylasGrantId`, so
// that `googleDirect:rollbackToNylas` can move it back. Nylas bills each
// grant. This module deletes those grants in Nylas (`DELETE /v3/grants/{id}`)
// and then clears the field. After that, the rollback does not work.
//
// The Convex query `googleDirect:nylasGrantCleanupPlan` decides which grants
// can go. This module adds the Nylas call, the dry run, and the report. The
// command is scripts/nylas-grant-cleanup.ts; it runs with the environment of
// the Railway `web` service, where the Nylas API key is.

import { isGoogleDirectGrant } from '@/lib/google/transport';

export interface NylasCleanupConnection {
  userId: string;
  accountId: string;
  email: string;
  grantId: string;
  switchedToGoogleAt: number | null;
}

export interface NylasCleanupItem {
  nylasGrantId: string | null;
  eligible: boolean;
  reason?: string;
  connections: NylasCleanupConnection[];
}

export interface NylasCleanupPlan {
  items: NylasCleanupItem[];
  truncated: boolean;
}

export type NylasCleanupTarget =
  | { kind: 'account'; userId: string; accountId: string }
  | { kind: 'age'; olderThanHours: number };

export type NylasCleanupPlanArgs =
  | { userId: string; accountId: string }
  | {
      switchedBefore: number;
    };

export type NylasCleanupOutcome = 'would_delete' | 'deleted' | 'already_gone' | 'skipped' | 'failed';

export interface NylasCleanupResult extends NylasCleanupItem {
  outcome: NylasCleanupOutcome;
  cleared?: number;
  error?: string;
}

export interface NylasCleanupReport {
  apply: boolean;
  target: NylasCleanupTarget;
  truncated: boolean;
  results: NylasCleanupResult[];
}

export interface NylasCleanupDeps {
  plan(args: NylasCleanupPlanArgs): Promise<NylasCleanupPlan>;
  clear(nylasGrantId: string): Promise<{ cleared: number }>;
  deleteGrant(grantId: string): Promise<'deleted' | 'not_found'>;
  now(): number;
}

const HOUR_MS = 3_600_000;
const DEFAULT_API_URI = 'https://api.us.nylas.com';

/** A Nylas answer that is not a success and not a 404. */
export class NylasGrantDeleteError extends Error {
  constructor(
    readonly status: number,
    detail: string,
  ) {
    super(`Nylas answered ${status}${detail ? `: ${detail}` : ''}`);
    this.name = 'NylasGrantDeleteError';
  }
}

/**
 * Deletes one grant with the Nylas v3 API. A 404 means that Nylas has no such
 * grant, so the cleanup counts it as done. A direct Google grant id never
 * goes to Nylas.
 */
export async function deleteNylasGrant(
  grantId: string,
  options: { apiKey: string; apiUri?: string; fetchImpl?: typeof fetch; timeoutMs?: number },
): Promise<'deleted' | 'not_found'> {
  const id = String(grantId || '').trim();
  if (!id) throw new Error('A Nylas grant id is necessary.');
  if (isGoogleDirectGrant(id)) throw new Error('A direct Google grant id is not a Nylas grant.');
  if (!options.apiKey) throw new Error('NYLAS_API_KEY is not set.');
  const base = (options.apiUri || DEFAULT_API_URI).replace(/\/+$/, '');
  const response = await (options.fetchImpl ?? fetch)(`${base}/v3/grants/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${options.apiKey}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
  });
  if (response.status === 404) return 'not_found';
  if (response.ok) return 'deleted';
  const payload = await response.json().catch(() => null);
  const detail = typeof payload?.error?.message === 'string' ? payload.error.message : '';
  throw new NylasGrantDeleteError(response.status, detail);
}

/** The arguments of the Convex plan query for a target. */
export function nylasCleanupPlanArgs(target: NylasCleanupTarget, now: number): NylasCleanupPlanArgs {
  if (target.kind === 'account') return { userId: target.userId, accountId: target.accountId };
  return { switchedBefore: now - target.olderThanHours * HOUR_MS };
}

/**
 * Plans, and with `apply`, runs the cleanup. The dry run (the default) calls
 * only the read-only plan query. With `apply`, each eligible grant is deleted
 * in Nylas first; only a success or a 404 clears the field. A failed delete
 * keeps the field, so the rollback still works for that account.
 */
export async function runNylasGrantCleanup(input: {
  target: NylasCleanupTarget;
  apply: boolean;
  deps: NylasCleanupDeps;
}): Promise<NylasCleanupReport> {
  const plan = await input.deps.plan(nylasCleanupPlanArgs(input.target, input.deps.now()));
  const results: NylasCleanupResult[] = [];
  for (const item of plan.items) {
    if (!item.eligible || !item.nylasGrantId) {
      results.push({ ...item, outcome: 'skipped' });
      continue;
    }
    if (!input.apply) {
      results.push({ ...item, outcome: 'would_delete' });
      continue;
    }
    try {
      const deleted = await input.deps.deleteGrant(item.nylasGrantId);
      const { cleared } = await input.deps.clear(item.nylasGrantId);
      results.push({ ...item, outcome: deleted === 'deleted' ? 'deleted' : 'already_gone', cleared });
    } catch (error) {
      results.push({
        ...item,
        outcome: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { apply: input.apply, target: input.target, truncated: plan.truncated, results };
}

const OUTCOME_LABEL: Record<NylasCleanupOutcome, string> = {
  would_delete: 'WOULD DELETE',
  deleted: 'DELETED',
  already_gone: 'ALREADY GONE',
  skipped: 'SKIPPED',
  failed: 'FAILED',
};

/** Report lines. They hold grant ids, account ids, and addresses; no key or token. */
export function formatNylasCleanupReport(report: NylasCleanupReport): string[] {
  const lines: string[] = [];
  const scope =
    report.target.kind === 'account'
      ? `account ${report.target.userId} / ${report.target.accountId}`
      : `switched accounts older than ${report.target.olderThanHours} hours`;
  lines.push(`${report.apply ? 'Apply' : 'Dry run'}: Nylas grant cleanup for ${scope}.`);
  if (!report.results.length) lines.push('No switched account keeps a Nylas grant.');
  for (const result of report.results) {
    lines.push(`${OUTCOME_LABEL[result.outcome]} ${result.nylasGrantId ?? '(no Nylas grant)'}`);
    for (const connection of result.connections) {
      const switched =
        connection.switchedToGoogleAt === null
          ? 'switch time not known'
          : `switched ${new Date(connection.switchedToGoogleAt).toISOString()}`;
      lines.push(
        `  ${connection.email} (user ${connection.userId}, account ${connection.accountId}, ${connection.grantId}, ${switched})`,
      );
    }
    if (result.reason) lines.push(`  reason: ${result.reason}`);
    if (result.cleared !== undefined) lines.push(`  cleared on ${result.cleared} connection(s)`);
    if (result.error) lines.push(`  error: ${result.error}`);
  }
  if (report.truncated) lines.push('The plan read its row limit. Run the command again for the rest.');
  const count = (outcome: NylasCleanupOutcome) =>
    report.results.filter((result) => result.outcome === outcome).length;
  if (report.apply) {
    lines.push(
      `Deleted ${count('deleted')}, already gone ${count('already_gone')}, skipped ${count('skipped')}, failed ${count('failed')}.`,
    );
    if (count('deleted') + count('already_gone') > 0) {
      lines.push('The rollback to Nylas does not work for the cleared connections.');
    }
  } else {
    lines.push(`Would delete ${count('would_delete')}, skip ${count('skipped')}. Add --apply to delete.`);
  }
  return lines;
}

export const NYLAS_CLEANUP_USAGE = [
  'Usage:',
  '  bun scripts/nylas-grant-cleanup.ts --user <userId> --account <accountId> [--apply]',
  '  bun scripts/nylas-grant-cleanup.ts --older-than-hours <N> [--apply]',
  'The default is a dry run. It lists what the command would delete and changes nothing.',
].join('\n');

/** Parses the command line. Exactly one target; `--apply` deletes, `--dry-run` (the default) does not. */
export function parseNylasCleanupArgs(
  argv: string[],
): { target: NylasCleanupTarget; apply: boolean } | 'help' {
  let userId: string | undefined;
  let accountId: string | undefined;
  let hours: number | undefined;
  let apply = false;
  let dryRun = false;
  const value = (index: number, flag: string) => {
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) throw new Error(`${flag} needs a value.`);
    return next;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') return 'help';
    if (arg === '--apply') apply = true;
    else if (arg === '--dry-run') dryRun = true;
    else if (arg === '--user') userId = value(index++, arg);
    else if (arg === '--account') accountId = value(index++, arg);
    else if (arg === '--older-than-hours') {
      hours = Number(value(index++, arg));
      if (!Number.isFinite(hours) || hours < 0)
        throw new Error('--older-than-hours needs a number of 0 or more.');
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (apply && dryRun) throw new Error('Use --apply or --dry-run, not both.');
  const oneAccount = userId !== undefined || accountId !== undefined;
  if (oneAccount && hours !== undefined)
    throw new Error('Name one account, or --older-than-hours. Not both.');
  if (oneAccount) {
    if (!userId || !accountId) throw new Error('Name both --user and --account.');
    return { target: { kind: 'account', userId, accountId }, apply };
  }
  if (hours === undefined) throw new Error('Name one account (--user and --account), or --older-than-hours.');
  return { target: { kind: 'age', olderThanHours: hours }, apply };
}
