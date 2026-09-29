# Albatross release runbook

## Release model

Decided September 29, 2026: production is the only permanent hosted environment.
Staging was used as a CodeRabbit review stop, so review now happens on feature PRs
against `main`. Both Claude and Codex follow this workflow through `AGENTS.md`.

1. Branch from current `origin/main` and open a PR targeting `main`.
2. Wait for CI and CodeRabbit. Address findings and rerun affected checks.
3. Merge the reviewed PR. `Deploy Production` validates the source, versions the
   release, deploys Convex, and then deploys Railway.
4. Verify `https://mail.lab86.io/api/healthz` and the changed product flow.
5. The native production workflow consumes the immutable production release
   artifact. Native PR acceptance continues to build both iOS and macOS.

Production release automation pushes its version commit and tag. Preserve its
ability to do so when changing branch protection; a required human approval
would deadlock this single-maintainer repository. CI and CodeRabbit are the
review gates, and release-bot version commits use `[skip release]`.

## Production inventory

| Resource | Identity |
| --- | --- |
| GitHub | `Lab86-io/lab86-mail`, default branch `main` |
| Railway project | `919576b9-789c-4257-b6cc-250cf4a28ecb` (`lab86-mail`) |
| Railway environment | `c14045cd-da4a-4080-bc07-ff784f1e333d` (`production`) |
| Web service | `1ee5eac3-493e-4a4b-a6b4-cb89c6e0d179` (`web`) |
| Document service | `1c39c627-c46c-4318-88cc-8f121ecc2e65` (`documents`) |
| App origin | `https://mail.lab86.io` |
| Convex | `https://proficient-viper-594.convex.cloud` |
| Clerk frontend | `clerk.mail.lab86.io` |
| Nylas production application | `ca47917b-5177-46d7-810f-df7a04135491` |

Runtime variables are authoritative in Railway. GitHub's `production` environment
holds deploy credentials and non-secret deploy targets. Explicitly select the
production deployment when operating Convex: historical CLI project defaults
have resolved to a different deployment. Never assume `--prod` means the URL above.

## Isolated development

Use the local app, synthetic fixtures, and a local Convex deployment. For first-time
Convex configuration, `bunx convex dev --configure --dev-deployment local` selects
a local backend; verify the printed target and `.env.local` before using it.
Clerk development credentials can support local authentication without a second
hosted app. Retain only the development auth configuration actually needed.

Use test provider accounts when integration work needs real OAuth. Production
mail grants, database credentials, and runtime environment exports are not local
fixtures. The synthetic app workspace is available with `bun run dev:preview`.
A temporary hosted integration environment requires an explicit new decision;
it is not created automatically for PRs.

`NODE_ENV=development` enables development behavior. For local testing of a
production build, `LAB86_DEVELOPMENT_MODE=true` preserves scheduled-work suppression
and server feature defaults. Set matching public feature flags explicitly for
that build. Leave this mode unset in hosted production.

The browser Basic challenge is opt-in with `LAB86_MAIL_REQUIRE_BASIC_AUTH=1` and
`LAB86_BASIC_AUTH_USER` / `LAB86_BASIC_AUTH_PASSWORD`. Ordinary localhost development
does not require it. Clerk authentication and capability checks remain in effect.

## Provider changes

- Keep production Clerk users, billing, JWT templates, webhooks, and native
  associated domains intact. A development instance may belong to the same Clerk
  application as production; deleting that application would remove both.
- Keep production Nylas grants, connectors, webhook destination, and callbacks.
  Remove only confirmed staging applications and their grants.
- Google Drive OAuth, Apple push credentials, Browserbase, OpenRouter, and Resend
  were shared across both web environments at retirement. Remove obsolete staging
  callbacks where applicable; preserve credentials used by production or other apps.
- Cloudflare records for `mail.lab86.io` and `clerk.mail.lab86.io` serve production.
  Retire only records and paid resources positively attributed to staging.
- See [document deployment](deployment/documents.md) for Collabora/WOPI configuration.

## Recovery

Rollback code and recover data separately. Restore the previous healthy Railway
release and compatible Convex functions if needed, then verify the health endpoint
and affected flow. Database migrations and external mail/calendar/file writes are
not undone by redeploying old code. Keep a verified backup before destructive
schema or data changes and maintain compatibility while Convex and web deploy in
sequence.

See [hosted operations](hosted-operations.md) for export/restore, corpus maintenance,
account deletion, and incident response.

## Retirement evidence

See [the retirement record](operations/staging-retirement-2026-09-29.md) for resource
status, verification, remaining login requirements, and any costs that remain shared.
Historical staging instructions in older research notes describe past work only.
