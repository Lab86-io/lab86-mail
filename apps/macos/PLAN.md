# Lab86 Mail for macOS — Native SwiftUI Port Plan

A ground-up native macOS client for Lab86 Mail: liquid glass, macOS 26 (Tahoe),
SwiftUI throughout, full feature parity with the web app, and Apple's on-device
Foundation Models replacing the hosted nano-tier LLM calls.

The app is a **client of the existing production backend** (Convex at
`proficient-viper-594.convex.cloud` + Next.js API at `mail.lab86.io`). It does
not run its own sync pipeline — Nylas webhooks, corpus backfill, and write-time
classification stay server-side, exactly as they are for the web app.

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│ Lab86Mail.app (SwiftUI, macOS 26)                        │
│                                                          │
│  UI: NavigationSplitView (rail | list | reader)          │
│  MailStore (@Observable) ── selection, scope, paging     │
│        │                                                 │
│  ConvexService ── convex-swift live queries (WebSocket)  │
│  MailAPI ──────── HTTPS to mail.lab86.io /api/*          │
│  LocalCache ───── SwiftData mirror (M5: offline/instant) │
│  Intelligence ─── FoundationModels (classify, summarize) │
│        │                                                 │
│  ClerkKit ─────── auth; JWT template "convex" → Convex,  │
│                   session Bearer token → /api routes     │
└──────────────────────────────────────────────────────────┘
```

- **Real-time reads** go through Convex live queries with the official
  `convex-swift` SDK (`ConvexClientWithAuth`): `liveMail:listThreads`,
  `liveMail:getThread`, `liveMail:categoryCounts`, `liveMail:listAccounts`.
  Convex pushes updates — unread badges and new mail appear with no polling.
- **Writes/actions** go through the web app's tool layer:
  `POST /api/tools/{name}` with a Clerk Bearer token. Thread mutations:
  `archive_thread`, `trash_thread`, `mark_thread_read` (`{account, threadId}`);
  message mutations: `star`, `unstar`, `mark_read`, `mark_unread`
  (`{account, messageId}`).
- **Send** goes through `POST /api/compose` (multipart form: `mode`, `account`,
  `to`, `cc`, `bcc`, `subject`, `body`, `html`, `threadId`, `messageId`,
  `undoSeconds`, `sendAt`, `attachments[]`), with
  `GET /api/compose/status/{id}` + `POST /api/compose/undo/{id}` for undo-send.
- **Attachments** download from
  `GET /api/attachments/{messageId}/{attachmentId}?account&name&mime`.
- **Auth**: ClerkKit (`clerk-ios`, native macOS 14+ support) with the same
  production publishable key. The Convex client gets JWTs minted from the
  `convex` JWT template (same template the web app uses); `/api/*` calls send
  the plain session token as `Authorization: Bearer`. Pattern copied from
  `treecaching/ios` (`TreeCachingConvexAuthProvider`).

### Hybrid local cache (decided)

Convex live queries are the source of truth while online; a SwiftData mirror of
the thread list + recently read messages gives instant cold launch and offline
reading. The mirror is write-through from live query results — never a second
sync protocol.

## On-device intelligence (decided: classification + summaries)

Apple Foundation Models (macOS 26, Apple Silicon, Apple Intelligence enabled —
the M3 Pro MacBook qualifies) replaces the **hosted nano tier**
(`LAB86_MAIL_OPENAI_FAST_MODEL`) when available, for cost and energy savings:

1. **Smart-category classification** — guided generation with a `@Generable`
   verdict struct mirroring the server's `llmCategory` shape
   (`primary` ∈ {main, needs_reply, codes, orders, finance_admin, noise,
   review}, `needsAttention`, `confidence`, `model: "apple_on_device"`).
   The Mac client sweeps the user's `llmPending` threads and writes verdicts
   back so the web app benefits too.
2. **Thread summaries** — generated in the reader entirely on-device, marked
   with an "On-device" badge. Long threads chunk; fallback to hosted models
   when the local model is unavailable/refuses.

**Required backend change (small, this repo):** the existing
`mailCorpus.storeLlmVerdicts` / `listLlmPending` functions require the internal
secret. Add Clerk-authenticated equivalents in `convex/liveMail.ts`
(`listMyLlmPending` query + `storeMyLlmVerdicts` mutation) that scope by
`ctx.auth` identity and reuse the same merge logic. Until deployed, the client
no-ops gracefully (verdicts kept local).

Everything bigger than nano (assistant chat, daily report, NL search, draft
critique) keeps using the hosted model routing through the existing endpoints.

## Liquid glass / native design

- macOS 26 design language: glass sidebar via `NavigationSplitView`,
  `.glassEffect` surfaces, `.buttonStyle(.glassProminent)` compose button,
  unified toolbars, morphing controls.
- The web app's Arc-style theming ports as a native `ThemeManager`:
  OKLCH→sRGB conversion implemented in Swift, the same accent presets
  (Forest 156 / Ocean 235 / Iris 290 / Rose 15 / Ember 60 / Mono 250) and
  custom hue/chroma sliders, background hue/tint wash, light/dark/auto.
- Editorial identity (Fraunces-style serif display type) maps to New York
  (`.fontDesign(.serif)`) for the daily report masthead and display text.
- HTML email renders in a sandboxed `WKWebView` (content JavaScript disabled,
  height self-measured, links open in the default browser, dark-mode
  adaptation via injected CSS) — the native analog of the web app's isolated
  iframe renderer.

## Milestones

- **M0 — Toolchain (this round):** `apps/macos` with XcodeGen project,
  sandbox + hardened runtime entitlements, remote-build scripts
  (rsync from lab86 → `ssh mac` → `xcodegen` + `xcodebuild`). Builds green.
- **M1 — Auth & accounts (this round):** Clerk sign-in (ClerkKitUI `AuthView`),
  Convex auth provider, `listAccounts` with sync status in the rail.
- **M2 — Mail core (this round):** live thread list with category rail +
  live unread badges, quick searches, full-text search box, thread reader
  with WKWebView message cards, attachments listing/download.
- **M3 — Actions & compose (this round, first pass):** archive/trash/star/
  mark-read, inline reply + new-message compose via `/api/compose`,
  undo-send window.
- **M4 — Search parity:** Swift port of the query AST parser
  (`lib/mail/search/parser.ts`) for typed operators; NL search stays hosted.
- **M5 — Hybrid cache:** SwiftData mirror, instant launch, offline reading,
  local search over cached mail.
- **M6 — On-device AI:** Foundation Models classifier + summarizer wired to
  the new authenticated Convex functions; settings toggle; energy/cost badge.
- **M7 — Full parity:** daily report (broadsheet rendering of the server
  `dailyReports` doc), AI assistant panel (streaming chat to the hosted agent
  + the `ui_*` tool handlers mapped to native navigation), command palette
  (⌘P), settings (mailbox management, AI mode, undo window), drafts, snooze,
  labels, schedule send, contact popovers, full keyboard shortcut map (j/k/e/#/
  r/c//, g-sequences, ⌘K).
- **M8 — Real signing & distribution:** App Store Connect record, a
  provisioned signing config (automatic signing with the dev/distribution
  cert) that adds back the `com.apple.developer.associated-domains:
  [webcredentials:clerk.mail.lab86.io]` entitlement — this UNLOCKS PASSKEYS,
  which are impossible under the current ad-hoc dev signing ("calling process
  does not have an application identifier"). Clerk already serves the matching
  AASA at `clerk.mail.lab86.io/.well-known/apple-app-site-association` with
  `5JZV7V6Y4Z.io.lab86.mail.mac`. Then TestFlight, then notarized DMG +
  Sparkle. Until M8, sign in with Google or email/password.

## Build & release workflow

Development happens on lab86 (this repo, branch `macos-native`); the Mac
(`ssh mac`, macOS 26.5.1, Xcode 26.3, M3 Pro) is the build/test machine:

```bash
apps/macos/scripts/remote-build.sh   # rsync sources → mac, xcodegen, xcodebuild
```

XcodeGen (binary release, no Homebrew on the Mac) generates
`Lab86Mail.xcodeproj` from `project.yml`, so the project file is never
hand-maintained or committed.

TestFlight prerequisites (M8, needs Jakob once): App Store Connect app record
for `io.lab86.mail.mac`, App Manager API key or signed-in Xcode account on the
Mac for `xcodebuild -exportArchive` + `altool`/Transporter upload, and a
`Apple Distribution` certificate (Xcode automatic signing can mint it).

## Risks / open questions

- **clerk-ios on macOS**: supported per Package.swift (`.macOS(.v14)`), but
  `AuthView` polish on macOS is less battle-tested than iOS. Fallback: custom
  email/OAuth sign-in UI on ClerkKit primitives.
- **Bearer auth to `/api/*`**: Clerk's Next.js middleware accepts
  `Authorization: Bearer <session token>` for cross-origin clients; must be
  verified against production early in M3 testing.
- **Live query depth**: `liveMail.listThreads` caps at 200 items with no
  cursor; deep pagination uses the HTTP tools path (`search` tool), same as
  the web app.
- **Foundation Models quality**: nano-tier classification quality must be
  spot-checked against the hosted model before enabling write-back by default.
- **Convex binary framework**: convex-swift ships a Rust xcframework; confirm
  the macOS slice links under the sandbox (it does for Mac Catalyst/macOS per
  upstream, verified at first build).
