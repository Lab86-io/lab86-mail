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
| GitHub staging deployment workflows | Disabled via GitHub API; removed by merged PR #304 |
| Agent instructions, review routing, local runtime controls | Merged in PR #304; full CI and coverage gate pass |
| Railway development environment | Deleted; read-back shows production only, two healthy services, no staging tokens, PR environments disabled |
| Convex staging | Deleted precise-skunk-847 through Browserbase after verified backup; API read-back returns 404, production returns 200 |
| Clerk staging | Same application as production; development instance retained for local auth. Staging webhook deleted and Paths checked: no staging URL |
| Nylas staging | All three sandbox apps deleted through Browserbase; only the live production app remains. Production grant IDs/statuses unchanged; retired staging key returns 401. |
| Cloudflare | Deleted mail-staging CNAME and Railway verification TXT; production DNS preserved. Workers and Pages have no projects; R2 is not enabled. Billing shows Workers Free and Teams Free Base, with no staging subscription. |
| Shared vendor subscriptions | Shared production credentials and subscriptions preserved. Blacksmith has no sticky disks; staging workflow usage stops with the deleted jobs. Google staging connector used Nylas-owned quickstart infrastructure. |
| GitHub branch/environments/secrets | Main requires CI and CodeRabbit; PR #114 retargeted; staging branch, both development environments and their secrets, and DEVELOPMENT_APP_URL deleted |
| GitHub storage | Deleted 589 artifacts belonging to staging runs (1,654,056,914 bytes) and its 35,349,280-byte cache; read-back shows no staging artifacts, caches, or active runs |
| Xcode Cloud | Disabled legacy staging iOS workflow; moved Mac distribution to production version tags; removed historical staging manual tag patterns from Production App Store |
| Shared Google OAuth callbacks | Verified live Railway and Nylas client IDs; removed only the mail-staging origin and redirect from each shared client. Read-back preserved every production/Nylas URI. No Google projects, clients, credentials, or service accounts were deleted. |

Configuration snapshots and data exports are stored privately outside Git under
`~/.local/state/lab86-staging-retirement-20260929/` with restricted permissions.
No credentials or mailbox data belong in this record.

## Validation

- Local full suite: 5,939 passing, 1 skipped, 0 failing.
- GitHub CI run `36599721958`: application and test typechecks, lint, test suite,
  coverage ratchet, and production build passed. Coverage remains 94.94%.
- Native release workflow tests: 7 passing. Native browser access tests: 20 passing.
- Two independent code reviews completed; the native browser capability gate was
  aligned with the explicit Basic Auth challenge, then focused tests were rerun.
- CodeRabbit approved the final PR #304 head. The PR merged at
  `c741b363ba565684251c8b4f2e95f5c4eb2ccd64`; production release run `36601628307`
  completed successfully. It deployed Convex before Railway, then passed the
  health check and published release `v0.16.14` at
  `d53dc9f89b68de49c90939b449062eca43c3d5a0`.
- The authenticated health response confirms version `0.16.14`, Railway deployment
  `72c98f6b-8cc8-472f-9d38-40fdbb8c2fa4`, environment `production`, and configured
  Clerk, Convex, and Nylas. Public health and sign-in endpoints return 200.
- Production Nylas still returns the same ten grant IDs and statuses after the
  sandbox and Google callback cleanup. Live Railway settings have no retired
  service references or staging/development control variables.

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

The free Cloudflare tunnel for `albatross.lab86.io` points to the local preview
server at `127.0.0.1:18901`; it is not a staging deployment and remains available.
Other applications' tunnels and production/shared subscriptions were preserved.
Clerk's paired development instance remains available for isolated local auth;
it is not a separately billed hosted application. No monthly savings estimate is
claimed before billing records reflect the removed usage.

Xcode Cloud workflow `304D20E5-2087-4E0D-8A6E-5E6025DEED36` (`Albatross`)
is disabled. Workflow `6599098c-463a-4ab2-ba3c-f35420545ae4` (`Albatross Mac`)
now starts from version tags with a `v` prefix, with its signing, build/archive
actions, and distribution unchanged. Production workflow
`d8ddca66-2576-4888-90df-7255572599fb` keeps its release tag targets; nine old
`ios-staging-*` manual targets were removed. API read-back confirmed the changes.
The update payloads follow Apple's [workflow update attributes](https://developer.apple.com/documentation/appstoreconnectapi/ciworkflowupdaterequest/data-data.dictionary/attributes-data.dictionary)
and [tag start condition](https://developer.apple.com/documentation/appstoreconnectapi/citagstartcondition)
schemas. No native application source changed.

Google Cloud project `lab86-mail-production` (`452431903621`) is live production
and also holds clients for another application. Its Drive OAuth client was matched
against the current Railway `GOOGLE_DRIVE_CLIENT_ID`; its mail OAuth client was
matched against the current production Nylas Google connector. In each client,
only `https://mail-staging.lab86.io` and
`https://mail-staging.lab86.io/api/files/oauth/callback` were removed. Saved
configuration was reopened to verify the exact remaining URI sets. Production
`mail.lab86.io` entries and Nylas's `api.us.nylas.com` origin and callback remain.
Both clients, their credentials, the production project, and the unrelated music
clients remain. The organization's project picker showed no project named for
mail staging/development; its other `My First Project` was not attributed to this
retirement and was left intact. The separate `lab86-mail-prod` project accessible
to the Gmail account is not the live project and was also left intact.

## CI follow-up

Native macOS acceptance passed in both runs `36595319165` and `36599722019`.
The final iOS run passed its 38 UI tests, then ran 712 tests with one failure:
`NativeWorkspaceBrowserTests` timed out at its local blob-download wait (line 79),
matching the earlier run. Its loopback fixture, all `apps/ios` source, and the
native acceptance script are unchanged from `107dfda`. This is separate from
the passing web tests and required main-branch review gates. Claude, as the native
owner, should investigate the preserved [failing acceptance run](https://github.com/Lab86-io/lab86-mail/actions/runs/36599722019);
do not remove the test to make CI green.

Production native builds started from the verified `v0.16.14` commit: Mac build
328 (`4f894629-0823-497d-b41a-7706d7c8d543`) was triggered by the version tag;
iOS build 329 (`bb0036ce-84fb-415e-944d-a934274762fc`) was started by production
trigger run `36603395176`. These distribution builds are separate from PR
acceptance; their start verifies the production release routing, not completion
of archive or TestFlight processing.
