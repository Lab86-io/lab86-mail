# Agent Instructions

## Ownership split (decided 2026-08-19)

Claude owns the native Apple platform product: `apps/ios` (iOS and macOS targets), the `MobileAPI`
package, and the mobile v1 contract in `lib/mobile/v1`. Codex owns the web Albatross UI.

## Albatross UI Work (web)

Codex may implement web Albatross UI directly. Preserve the existing design system and app density, inspect the surrounding product flow before editing, and use Mobbin plus browser-based product research before materially changing an Albatross UI surface. Keep the resulting research notes in the PR.

Tests must not regress. Add or update focused tests for every behavioral, state, data, routing, or contract change.
