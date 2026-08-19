# Albatross macOS plan

Date: 2026-08-19. Owner: Claude (native Apple platform; see CLAUDE.md ownership note).

Albatross ships as one native SwiftUI product on iPhone, iPad, and Mac. The macOS app is not a
port, a Catalyst wrapper, or a mail-only subset: it is the whole product — Mail, Today/Brief,
Calendar, Tasks, Work/Albatrosses, Assistant, Files, Activity, Settings — sharing the existing
`apps/ios` codebase, the `MobileAPI` package, and the same Xcode Cloud pipeline.

## Decisions

- **Native SwiftUI macOS target, no Catalyst.** The codebase is already SwiftUI with targeted
  UIKit bridges; Apple's 2026 guidance for new multiplatform work is native SwiftUI with
  AppKit escape hatches (`NSViewRepresentable`/`NSHostingView`) where needed.
- **Deployment floor macOS 27.0** (Apple Silicon only), matching the iOS 27.0 floor and the
  iOS-27-era APIs already in use. Built with Xcode 27.
- **Same bundle ID `io.lab86.mail`** on macOS: universal purchase, and the existing
  `webcredentials`/`applinks` associated-domain registrations (keyed on
  `TEAMID.io.lab86.mail`) carry over.
- **Same XcodeGen project.** A `Lab86MailMac` target in `apps/ios/project.yml` shares the
  `Lab86Mail/` and `Shared/` sources; Mac-only sources and resources live in `apps/ios/Lab86MailMac/`.
  `PRODUCT_MODULE_NAME` stays `Lab86Mail` so shared code and tests are unchanged.
- **Contract-first alignment.** The mobile v1 contract grows typed paged mail reads and a wider
  command set before the Mac UI lands, so iOS, macOS, and web ride the same spine and the known
  iOS debt (no pagination, untyped mail seam, no offline labels/snooze/send) is paid down once.
- **Lockstep client updates are acceptable.** The v1 sync/command schemas are strict; adding
  optional payload fields requires the installed TestFlight build to update in step. Sole-user
  product; documented here deliberately.

## Progress

- 2026-08-19: Phase 1 landed (typed paged mail reads, nine new commands, regenerated
  OpenAPI, full Bun suite green). Phase 2 landed: the complete product compiles and links
  for macOS 27 (`Lab86MailMac`), iOS still green; see `docs/mobile/macos-target.md` for
  Mac specifics and the external setup list.

## Phase 1 — Contract and server alignment (web/iOS/macOS one spine)

1. `convex/mailCorpus.ts`: additive `pageRecentCorpusThreads` query — `lastDate` before-cursor,
   `{ items, nextBefore }`, account-scoped or unified. (`queryCategoryThreads` already pages.)
2. `lib/mobile/v1/contract.ts`:
   - Typed reads: `MailThreadSummary`, `MailThreadPage`, `MailAttachment`, `MailMessage`,
     `MailThreadDetail`.
   - New commands: `mail.addLabel`, `mail.removeLabel`, `mail.snooze`, `mail.unsnooze`,
     `mail.mute`, `mail.restore`, `mail.send` (new/reply/replyAll/forward, no attachments —
     attachment sends stay on multipart `/api/compose`), `mail.saveDraft`, `mail.deleteDraft`.
   - Sync payload growth: thread changes gain `snoozedUntil`/`muted`, message changes gain
     `labelsAdded`/`labelsRemoved`, new `MailDraftSyncChange` variant.
3. `lib/mobile/v1/command-executor.ts`: map the nine new kinds onto existing tools
   (`add_label`, `remove_label`, `snooze_thread`, `unsnooze_thread`, `mute_thread`,
   `restore_from_trash`, `send_message`/`reply`/`reply_all`/`forward`, `save_draft`/`update_draft`,
   `delete_draft`).
4. New routes: `GET /api/mobile/v1/mail/threads` (accountID?, category?, cursor, limit ≤ 100)
   and `GET /api/mobile/v1/mail/threads/{threadID}` (corpus-first via the `get_thread` tool).
5. `lib/mobile/v1/openapi.ts`: new paths + discriminator mappings; `bun run mobile:openapi`
   regenerates both checked-in documents.
6. Focused Bun tests for every addition; existing suites stay green.

## Phase 2 — macOS target scaffolding

1. `project.yml`: `Lab86MailMac` app target (macOS 27.0, sandboxed) + `Lab86MailMacTests`;
   Mac Info.plist, entitlements (app sandbox, network client, aps-environment, App Group,
   associated domains — no AutoFill, no default-mail), asset catalog/icon reuse.
2. Compile `Core/` + `Features/` for macOS: `#if os(iOS)` / `canImport(UIKit)` conditionals for
   the UIKit bridges (WKWebView representable gains an `NSViewRepresentable` twin, sidebar
   wheel and haptics stay iOS-only, `FileProtectionType`/backup-exclusion guards, background
   refresh iOS-only, HorizonCalendar month view iOS-only with a SwiftUI Mac grid).
3. Mac shell: three-pane `NavigationSplitView` (sidebar / list / detail), menu-bar `Commands`
   with switchable shortcut schemes, ⌘K command palette, Settings scene, multiple windows,
   menu bar extra. Convex live subscriptions replace `BGAppRefreshTask` as the freshness path.

## Phase 3 — Typed mail seam + pagination on both platforms

`MailRepository` over the generated v1 client: paged thread list (infinite scroll), typed
thread detail, cursor persistence in the existing SwiftData outbox store, new commands wired
through `CommandOutbox` so labels/snooze/send queue offline. `ProductStore` mail paths migrate
to the repository; other domains follow the same seam later.

## Phase 4 — CI and release

Xcode Cloud builds the Mac scheme from the same repo/refs with `ci_post_clone.sh` unchanged in
policy (XcodeGen, ref validation, credential pinning). TestFlight for Mac distribution.

## Explicitly deferred

- Typed `AssistantEvent` SSE endpoint (assistant streaming stays on `/api/agent`).
- Mac AutoFill/credential-provider extension, share extension, widgets.
- `com.apple.developer.mail-client` (blocked on Apple grant).
- Renaming `apps/ios` (it now hosts both platforms; churn not worth it yet).

## External needs (Jakob)

Tracked in the running "needs from you" list in the working notes; summarized: App Store
Connect Mac platform + Xcode Cloud Mac workflow, Mac provisioning for `io.lab86.mail`
(App Group, push, associated domains), APNs unchanged (same key), Clerk unchanged (same
publishable key + existing AASA already covers the shared app identifier).
