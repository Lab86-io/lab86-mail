# Release 1 increment: contract, command, and sync foundation

Date: 2026-07-17

## Scope

This increment creates the additive typed path that native domains will migrate
onto. It does not remove `ProductStore`, `ProductSnapshot`, or `/api/tools/*`,
and it does not materially change a rendered UI.

## Ownership and data flow

1. Zod schemas in `lib/mobile/v1/contract.ts` own the public version 1 wire contract.
2. `bun run mobile:openapi` produces a checked-in OpenAPI 3.1 document and the
   source document consumed by Apple's Swift OpenAPI Generator.
3. `POST /api/mobile/v1/commands` authenticates, validates, rate-limits, stores,
   revision-checks, and claims a command before invoking an existing domain tool.
4. Convex `mobileCommands` owns durable idempotency and command status.
5. Convex per-domain sync heads, changes, and tombstones own mobile cursor history.
6. The generated `MobileAPI` client adds a fresh Clerk bearer token, timezone,
   and request id at the transport boundary for every request.
7. The SwiftData `CommandOutbox` owns pending native commands, sync cursors,
   typed route requests, and the one-time legacy-import marker for one Clerk user.
8. `CommandOutboxProcessor` submits commands sequentially, persists receipts,
   recovers abandoned submissions, and backs off retryable failures without
   converting them to success.
9. `AccountRepository` is the first domain seam: it validates bootstrap
   ownership, writes typed account/capability state to SwiftData, and advances
   only the Accounts cursor because bootstrap contains a complete account
   snapshot. `AccountStore` keeps cached account state visible when a live
   refresh fails.
10. Sync items are a generated discriminated union of typed mail, calendar,
    task, Work, approval, and undo changes. `MobileV1Client` maps that generated
    union into native domain values and rejects a response whose items do not
    match the requested domain.
11. Existing shared domain services still own provider mutations and audit/undo records.

## Policy decisions

- Reusing an idempotency key with different payload bytes is a conflict.
- A stale optional `baseRevision` creates a durable `conflicted` receipt and never executes.
- A calendar event with attendees becomes an existing desktop
  `calendar_invite` approval. A private hold can execute directly.
- The app may display pending, failed, conflicted, or needs-approval state, but
  only an `applied` receipt represents a confirmed mutation.
- A sync payload with an unknown property, missing domain identifier, or
  mismatched domain is rejected at the contract/client boundary.
- Sign-out purges the signed-in user's SwiftData outbox, cursors, route requests,
  account cache, and migration marker before Clerk teardown.

## Recovery states

| State | Durable behavior | Recovery |
|---|---|---|
| Offline before submit | Command remains `pending` in SwiftData. | Retry through the same idempotency key. |
| Interrupted HTTP request | Server row remains `queued` with a bounded execution lease. | A later request can reclaim an expired lease. |
| Provider or domain failure | Receipt becomes `failed` with a structured retry flag. | Inspect and retry without reporting success. |
| Stale base revision | Receipt becomes `conflicted`; no domain tool runs. | Refresh the domain, reconcile, and create a new command. |
| Protected action | Receipt becomes `needsApproval` with the shared approval id. | Approve or reject through Activity. |
| Duplicate request | Existing receipt is returned. | No second domain mutation is started. |
| Different payload with reused key | HTTP 409 with `IDEMPOTENCY_KEY_REUSED`. | Generate a new key for the new user intent. |
| Bootstrap ownership mismatch | No account or cursor data is written. | End the session and reauthenticate before retrying. |
| Bootstrap refresh offline | Typed cached accounts remain available and are marked as cached. | Retry refresh without blanking healthy local state. |
| Sign-out during sync | Per-owner sync tasks are cancelled and local records purged. | A new user bootstraps a separate cache. |

## Acceptance evidence

- Zod golden fixtures decode bootstrap, sync, command, and receipt payloads.
- Focused tests cover strict payload validation, canonical hashing, policy
  routing, checked-in OpenAPI parity, and durable schema/route wiring.
- The generated Swift package must compile and reference the generated `Client`.
- Swift tests cover idempotency, user isolation, cursor monotonicity, typed route
  durability, transport authentication headers, receipt/retry transitions,
  account-cache isolation, bootstrap owner validation, offline cache fallback,
  and sign-out purge behavior.
- TypeScript typecheck, the full Bun suite, Swift package tests, Xcode unit tests,
  and a code-signing-disabled iPhoneOS build must pass before this increment is complete.

### Verified 2026-07-17

- Biome passed for the mobile routes, schemas, Convex modules, generation script,
  and focused configuration/contract tests.
- TypeScript typecheck passed and the full Bun suite completed with 1,031 tests
  passing and zero failures.
- The generated `MobileAPI` Swift package completed 3 tests, including decoding
  the same checked-in bootstrap and command-receipt fixtures used by TypeScript.
- The iOS simulator suite completed 34 tests with zero failures. It was rerun
  against the existing simulator database after the account-cache change; the
  store opened in place without falling back to an in-memory container.
- A generic iPhoneOS build with code signing disabled succeeded using Xcode 27
  beta. Swift compiler warnings and the iPad orientation configuration warning
  found during the run were fixed.
- A signed device build currently reaches the CodeSign phase but SSH cannot use
  the Apple Development private key (`errSecInternalComponent`). This is an
  external Keychain authorization gate, not a compile or test failure. The
  connected iPhone must also be unlocked and available before the physical-device
  installation acceptance can be completed.

## Deferred migration work

- Domain-specific SwiftData entities and repositories beyond accounts,
  commands, cursors, routes, and migration metadata.
- Replacing each `ProductStore` consumer with its domain store.
- Recording revisions from every existing web mutation and provider webhook;
  `mobile.recordUpsert` and `mobile.recordDeletion` are the additive hooks.
- Producing a complete typed initial snapshot for every domain before advancing
  a new install to bootstrap head cursors. Incremental repositories must not
  assume command-only change history contains pre-existing domain data.
- Background command reconciliation after a process dies in the provider-write
  to receipt-recording window. Domain-level provider idempotency must close that
  final crash window before sends or destructive commands are queued offline.
