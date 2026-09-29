# Staging retirement — September 29, 2026

User authorized retirement of all staging-only services and charges, preserving
production and isolated local development. This record distinguishes completed
work from pending work; a removed hostname alone does not establish canceled billing.

## Verified baseline

- GitHub `main` and `staging` were identical at `107dfda1118e3128ad16cf05cf8d4ada2bfcfb48`.
- Production web v0.16.13 deployment `6a15e387-dd1a-412f-aa6e-5e2bfb8979ba` was healthy.
- Railway staging was environment `development` (`be41491e-6d1b-45f7-b85a-299540ac125e`),
  containing `web` and `documents-staging`, with no attached volumes or buckets.
- Staging Convex was `precise-skunk-847`; production is `proficient-viper-594`.
- Staging Nylas app `a533e241-ce5e-48f0-a0d0-880c2d893972` is a sandbox.
  Production Nylas app `ca47917b-5177-46d7-810f-df7a04135491` is production.
- Staging Clerk frontend is `together-sawfish-53.clerk.accounts.dev`.
- Google Drive OAuth, APNs, Browserbase, OpenRouter, and Resend credentials are shared.
  Production uses a different mail encryption key and different Nylas/Clerk secrets.

## Progress

| Area | Status |
| --- | --- |
| GitHub staging deployment workflows | Disabled via GitHub API; removed in PR #304 |
| Agent instructions, review routing, local runtime controls | Implemented in PR #304; full CI and coverage gate pass |
| Railway development environment | Deleted; read-back shows production only, two healthy services, no staging tokens, PR environments disabled |
| Convex staging | Deleted precise-skunk-847 through Browserbase after verified backup; API read-back returns 404, production returns 200 |
| Clerk staging | Same application as production; development instance retained for local auth. Staging webhook deleted and Paths checked: no staging URL |
| Nylas staging | All three sandbox apps deleted through Browserbase; only the live production app remains. Production grant IDs/statuses unchanged; retired staging key returns 401. |
| Cloudflare | Deleted mail-staging CNAME and Railway verification TXT; production DNS preserved. Billing shows Workers Free and Teams Free Base, with no staging subscription. |
| Shared vendor subscriptions | Shared production credentials and subscriptions preserved. Blacksmith has no sticky disks; staging workflow usage stops with the deleted jobs. Google staging connector used Nylas-owned quickstart infrastructure. |
| GitHub branch/environments/secrets | Main requires CI and CodeRabbit; PR #114 retargeted; staging branch, both development environments and their secrets, and DEVELOPMENT_APP_URL deleted |

Configuration snapshots and data exports are stored privately outside Git under
`~/.local/state/lab86-staging-retirement-20260929/` with restricted permissions.
No credentials or mailbox data belong in this record.

## Validation

- Local full suite: 5,939 passing, 1 skipped, 0 failing.
- GitHub CI run `36595319126`: application and test typechecks, lint, test suite,
  coverage ratchet, and production build passed. Coverage remains 94.94%.
- Native release workflow tests: 7 passing. Native browser access tests: 20 passing.
- Two independent code reviews completed; the native browser capability gate was
  aligned with the explicit Basic Auth challenge, then focused tests were rerun.

## Restore boundary

The deleted staging branch matched production exactly. A local archival ref
`refs/archive/staging-retired-20260929` preserves that commit. The private Convex
snapshot contains 117 table exports and 169 storage entries; every ZIP entry was
checked for integrity. Restoring staging would require intentionally provisioning
new services and credentials; ordinary PRs cannot recreate it.

## Additional retired resources

Convex also contained two unused cloud deployments: `enduring-gazelle-752`
(`dev/jjalangtry`, last deployed three months earlier, 57 documents and no files)
and `fastidious-crab-76` (`production-cf64bdc7`, no application documents or files).
Both were running scheduled jobs. Both were exported with storage,
ZIP-validated, then deleted through Browserbase. Read-back returned 404 for all
three retired cloud deployments and 200 for `proficient-viper-594`.

The existing checkout's ignored `.env.local` was backed up privately, selected
onto local Convex at `127.0.0.1:3210` / `3211`, and updated to localhost app URLs.
Retired Nylas credentials were removed. No production credentials were copied.
The local backend starts on demand with `bunx convex dev` and is not a billed
cloud deployment. There were no project-level default Convex environment variables.

Nylas sandboxes removed: `a533e241-ce5e-48f0-a0d0-880c2d893972`
(Lab86 Mail Dev, four grants), `a0327d4f-cde6-4ebb-b49d-5baf9f366e31`
(Lab86 Mail Production, five grants, no API requests for 14 days), and
`efb07a62-97ee-44c6-8818-b72e83454464` (My first app, one grant needing attention).
The user explicitly confirmed removing both older sandboxes after the live
production app was identified. The production app retains its original ten
grants: nine valid and one already invalid before this work.

## CI follow-up

Native macOS acceptance passed in run `36595319165`. iOS compiled and ran 712
tests, but `NativeWorkspaceBrowserTests` timed out at its local blob-download
wait (line 79); its loopback fixture and all `apps/ios` source are unchanged from
`107dfda`. This is separate from the passing web tests and main-branch review
gates. Preserve the failure evidence; do not remove the test to make CI green.
