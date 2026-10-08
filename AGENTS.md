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
