# Agent Instructions

## Release workflow (decided 2026-09-29)

Production is the only permanent hosted environment. Start feature branches from current `main`
and open PRs directly against `main`. Wait for CI and CodeRabbit, address review findings, then
merge; the production workflow deploys Convex before Railway. Use isolated local development
and synthetic data for experiments. Keep production credentials out of local test runs.

For deployment, provider configuration, or environment cleanup, read
[`docs/hosted-release-runbook.md`](docs/hosted-release-runbook.md). The old `staging` branch and
Railway `development` environment are retired; recreating hosted staging requires a new user decision.

## Ownership split (decided 2026-08-19)

Claude owns the native Apple platform product: `apps/ios` (iOS and macOS targets), the `MobileAPI`
package, and the mobile v1 contract in `lib/mobile/v1`. Web UI, including Albatross, is shared: Claude and
Codex may both implement it (updated 2026-09-26).

## Albatross UI Work (web)

Agents may implement web Albatross UI directly. Preserve the existing design system and app density, inspect the surrounding product flow before editing, and use Mobbin plus browser-based product research before materially changing an Albatross UI surface. Keep the resulting research notes in the PR.

Tests must not regress. Add or update focused tests for every behavioral, state, data, routing, or contract change.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
