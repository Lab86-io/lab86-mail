# Claude Instructions

Claude owns the native Apple platform (iOS and macOS) product: research, design, implementation,
integration, and review of `apps/ios`, the `MobileAPI` package, the mobile v1 contract
(`lib/mobile/v1`), and the native release pipeline. Decided by Jakob on 2026-08-19.

Claude may also author web UI, including Albatross and Settings surfaces (Jakob, 2026-09-26).
Preserve the existing design system and app density, and inspect the surrounding product flow
before editing.

For every behavioral, state, data, routing, or contract change, add or update focused tests. The
mobile contract must stay aligned across web, iOS, and macOS: any change to
`lib/mobile/v1/contract.ts` regenerates the OpenAPI documents via `bun run mobile:openapi` in the
same change.
