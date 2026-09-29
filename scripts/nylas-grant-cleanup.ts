/**
 * Delete the Nylas grants that switched Google accounts keep for a rollback.
 *
 * DRY RUN BY DEFAULT. Without --apply it lists what it would delete and
 * changes nothing. With --apply it calls the Nylas v3 API
 * `DELETE /v3/grants/{grantId}` for each eligible grant. First it claims the
 * grant in Convex, so that a rollback cannot use it. On success (or a 404)
 * it records `nylasGrantRevokedAt`; on a failure it gives the grant back.
 * After that, `googleDirect:rollbackToNylas` does not work for the account.
 *
 * The procedure is in docs/google-direct-transport.md, section "Cleanup".
 *
 * Usage (with the environment of the Railway `web` service):
 *   railway run --environment production --service web -- \
 *     bun scripts/nylas-grant-cleanup.ts --user <userId> --account <accountId>
 *   railway run --environment production --service web -- \
 *     bun scripts/nylas-grant-cleanup.ts --older-than-hours 72 --apply
 *
 * Environment: NYLAS_API_KEY, NYLAS_API_URI, NEXT_PUBLIC_CONVEX_URL (or
 * CONVEX_URL), LAB86_CONVEX_INTERNAL_SECRET. The output holds no key or token.
 */
import { api, convexMutation, convexQuery } from '../lib/hosted/convex';
import { convexUrl } from '../lib/hosted/env';
import {
  deleteNylasGrant,
  formatNylasCleanupReport,
  NYLAS_CLEANUP_USAGE,
  type NylasCleanupClaim,
  type NylasCleanupPlan,
  parseNylasCleanupArgs,
  runNylasGrantCleanup,
} from '../lib/nylas/grant-cleanup';

let parsed: ReturnType<typeof parseNylasCleanupArgs>;
try {
  parsed = parseNylasCleanupArgs(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error(NYLAS_CLEANUP_USAGE);
  process.exit(2);
}
if (parsed === 'help') {
  console.log(NYLAS_CLEANUP_USAGE);
  process.exit(0);
}

const apiKey = process.env.NYLAS_API_KEY || '';
if (parsed.apply && !apiKey) {
  console.error('NYLAS_API_KEY is not set. Run the command with the environment of the web service.');
  process.exit(2);
}

// The targets, so the owner can confirm the deployment. URLs only, no key.
console.log(`Convex: ${convexUrl() || '(not set)'}`);
console.log(`Nylas: ${process.env.NYLAS_API_URI || 'https://api.us.nylas.com'}`);

const report = await runNylasGrantCleanup({
  target: parsed.target,
  apply: parsed.apply,
  deps: {
    plan: (args) => convexQuery<NylasCleanupPlan>(api.googleDirect.nylasGrantCleanupPlan, args),
    claim: (nylasGrantId, args) =>
      convexMutation<NylasCleanupClaim>(api.googleDirect.claimNylasGrantCleanup, { nylasGrantId, ...args }),
    finish: (nylasGrantId, holders, deleted) =>
      convexMutation<{ updated: number }>(api.googleDirect.finishNylasGrantCleanup, {
        nylasGrantId,
        holders,
        deleted,
      }),
    deleteGrant: (grantId) => deleteNylasGrant(grantId, { apiKey, apiUri: process.env.NYLAS_API_URI }),
    now: () => Date.now(),
  },
});
for (const line of formatNylasCleanupReport(report)) console.log(line);
if (report.results.some((result) => result.outcome === 'failed')) process.exitCode = 1;
