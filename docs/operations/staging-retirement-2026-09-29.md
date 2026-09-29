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
| GitHub staging deployment workflows | Disabled via GitHub API; removal prepared in code |
| Agent instructions, review routing, local runtime controls | Changes in progress |
| Railway development environment | Pending Browserbase deletion |
| Convex staging | Backup in progress; deletion pending |
| Clerk staging | Application/instance relationship and billing pending verification |
| Nylas staging | Application deletion pending |
| Cloudflare | Staging record/resource inventory pending |
| Shared vendor subscriptions | Preserve production usage; staging-specific items pending audit |
| GitHub branch/environments/secrets | Pending review gate migration and PR retargeting |

Configuration snapshots and data exports are stored privately outside Git under
`~/.local/state/lab86-staging-retirement-20260929/` with restricted permissions.
No credentials or mailbox data belong in this record.
