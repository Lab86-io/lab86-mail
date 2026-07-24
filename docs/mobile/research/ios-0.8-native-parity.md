# iOS 0.8 native parity: identity media, categories, thread reader, brief masthead, sidebar scrub, kanban cleanup

Date: 2026-07-24

Status: Stage 1 (shared payloads, image identity, desktop fixes, research
doc) implemented. Stages 2-5 (mail categories/toolbar/thread redesign, brief
masthead/footer/regeneration parity, full-sidebar scrub navigation, kanban
drag repair) are scoped here for reference but implemented in later stages.

## Scope for this round

Five connected surfaces move from "functional" to "at parity with desktop
Albatross," native-idiomatic rather than a literal port:

1. Native bottom toolbar (search + create) replacing the current top-bar-only
   Mail chrome.
2. Mail categories reduced to Main/Codes/Orders/All Mail at presentation time
   (no stored migration — the underlying smart-category taxonomy is
   unchanged; only the tab surface groups it).
3. Thread reader redesigned against Apple Mail's reading pane patterns.
4. Daily Brief masthead/footer parity via the same server-derived
   deterministic art desktop uses.
5. Sender/company identity media (photo → company logo → initials; area
   image → favicon → monogram) so avatars and area marks stop being
   flat-color/monogram-only on native while desktop already resolves photos.

Plus two structural changes that ride along: a full-sidebar scrub navigation
gesture (350ms hold, magnetic highlight, read-only previews) and kanban
gesture cleanup (no swipe actions while a card is in board/drag mode).

Albatross colors, typography, paper treatment, and density (ThemeStore
paper/elevated/hairline colors, display fonts, InitialsAvatar) are preserved
throughout — this round changes what's shown and how it's fetched, not the
visual language.

## Native bottom toolbar

- [`DefaultToolbarItem`](https://developer.apple.com/documentation/swiftui/defaulttoolbaritem)
  provides the system search/sidebar/inspector toolbar items introduced
  alongside the new `ToolbarSpacer` API; combined with `.bottomBar` placement
  this is the sanctioned way to get a persistent bottom search field instead
  of hand-rolling a custom bottom bar.
- [Human Interface Guidelines: Search fields](https://developer.apple.com/design/human-interface-guidelines/search-fields)
  — search belongs where people expect it (a persistent field, not buried in
  a menu), and should not compete visually with primary content.
- Target layout: `DefaultToolbarItem(kind: .search, placement: .bottomBar)` +
  `ToolbarSpacer(.flexible, placement: .bottomBar)` + a trailing create
  (compose) item, mirroring Apple Mail's own bottom bar rather than Albatross
  inventing a new bar chrome.
- Inbox reference: [Apple Mail inbox](https://mobbin.com/screens/4a7b840c-5b83-4080-a5dd-829bbcfd05aa)
  — dateline-grouped rows, bottom search/compose bar, swipe actions scoped to
  the row.

## Thread reader

- Primary reference: [Apple Mail thread view](https://mobbin.com/screens/523cc9d8-8627-4ca4-9fc0-8010e11dbfd1)
  — sender identity (photo/initials) leads each message, collapsed quoted
  history, reply/reply-all/forward affordances anchored to the bottom, subject
  in the nav bar rather than repeated per message.
- Secondary reference: [Outlook thread view](https://mobbin.com/screens/86c0098c-39ff-4de8-a7bf-09513312e204)
  — used for how it handles long threads (message-count affordance,
  collapsed middle messages) since Albatross threads can run long.
  Apple Mail's pattern is primary; Outlook's collapsing behavior informs the
  long-thread case only.
- Sender identity in the reader depends on `MailIdentityStore` (this stage)
  being populated before the redesign lands in Stage 2 — the store and the
  inbox-row wiring ship now so the lookup is already warm by the time
  `ThreadView` restyles its sender headers.

## Mail categories: Main / Codes / Orders / All Mail

- Reduces the existing smart-category taxonomy (`SMART_CATEGORY_IDS`:
  primary/updates/promotions/social/forums/review + custom labels) to four
  presentation tabs on native, mapping many-to-one at render time:
  - **Main** — human/primary conversation categories.
  - **Codes** — verification/security/login-code mail.
  - **Orders** — receipts, shipping, bookings.
  - **All Mail** — unfiltered.
- No stored migration: `smartCategory.primary` on threads is untouched: the
  category id space server-side stays exactly what it is today. Only the
  native tab bar's category→tab grouping changes, symmetric with how desktop
  already re-labels categories per `lib/mail/smart-categories.ts`'s
  `SMART_CATEGORY_LABELS` without changing storage.
- Implemented in Stage 2, not this stage.

## Daily Brief masthead/footer parity

- Desktop derives one deterministic museum-art piece per calendar day from
  `getDailyArt()` (`lib/mail/daily-art.ts`): FNV-1a hash of the UTC date
  string picks a piece from `ART_POOL`, with up to two same-day fallbacks from
  different museums plus three bundled local images as a last resort. The
  same piece renders in the morning and evening editions and in history
  (keyed off `generatedAt`, not "now").
- This stage attaches `art: { imageUrl, fallbacks, credit, source }` to every
  server tool that serves a report to native (`get_latest_daily_report`,
  `get_daily_report`, `list_daily_reports`) — see "Server payload additions"
  below — so Stage 3's masthead rendering can reuse it directly instead of
  re-deriving art logic in Swift. `services` (source connections: gmail,
  outlook, github, slack…) already existed on `DailyReport` and now
  explicitly passes through unmodified for the branded footer.
- Actual masthead/footer view work is Stage 3.

## Full-sidebar scrub navigation

- 350ms press-and-hold on the sidebar area/mail rail enters "scrub" mode: the
  finger's vertical position magnetically highlights the nearest row (area or
  mailbox), and lifting selects it. While scrubbing, a read-only preview of
  the highlighted destination shows inline (no navigation commit until
  release) — this mirrors the iOS system Mail/Photos "hold the tab bar to
  peek" pattern rather than inventing new hold-to-scrub semantics.
- Implemented in Stage 4.

## Kanban gesture cleanup

- Board (kanban) mode disables row swipe actions on cards while a card is
  being dragged or the board is in drag-reorder mode, so a swipe gesture
  never race-conditions against a `.draggable`/`.dropDestination` gesture
  recognizer. Implemented in Stage 5 alongside the drag repair itself.

## Identity media contract (this stage)

Two independent identity chains, both image → secondary-image → monogram:

**Mail sender identity** (existing desktop contract, now exposed to native):
provider contact photo → company-domain logo → initials avatar. Desktop
already resolves this via the `resolve_photos` tool
(`lib/tools/photo-resolution.ts`, `lib/tools/photos.ts`) with a 7-day server
cache (including negative results). Native gets a client cache
(`MailIdentityStore`) fed by the same tool, keyed off `senderEmail`/
`fromEmail` now attached to every mail-thread/message payload
(`list_account_threads`, `get_thread`, `search_threads`, `corpus_search`).
`resolve_photos` itself is unchanged — its input/output schema is exactly
what desktop already calls.

**Area identity**: area's own image → area favicon → deterministic FNV-1a
monogram (existing `AreaMonogramPalette`, shared with `InitialsAvatar`'s
color derivation). Desktop's `AreaHome.tsx` `AreaMark` already gets this
order right (`imageUrl || faviconUrl`); `components/shell/Rail.tsx`'s
`AreaRailIcon` had it backwards (`faviconUrl || imageUrl`) — fixed this
stage, along with upgrading its single `failed` boolean to an attempt index
so a failed image falls through to the favicon before giving up to the
colored dot, instead of giving up immediately. Native gets the equivalent
ordered chain via a new `AreaIdentityMark` view (`AreaImageSource.ordered`
pure helper + Kingfisher `KFImage` with `.onFailure` advancing through
sources), replacing the monogram-only `AreaMonogram` in the sidebar and
Areas list — this reverses that view's original "avoid loading arbitrary
remote images on device" comment/decision, which predates the identity-media
parity requirement in this plan.

## Server payload additions (all optional/non-destructive)

- `senderEmail` (lowercased, from `fromAddress`/`from` via
  `emailFromHeader()`) on `list_account_threads`, `search_threads`, and
  `corpus_search` mail items.
- `fromEmail` (same derivation) on every message from `get_thread`, both the
  corpus-bundle fast path and the provider-hydration path.
- `art` + passthrough `services` on `get_latest_daily_report`,
  `get_daily_report`, and `list_daily_reports`. `art` is derived at read time
  from `generatedAt`, never persisted, and stored history is never mutated —
  matches the existing `withDisplayAreaBrief` clone-only-when-changed pattern
  in `lib/tools/daily-report.ts`.

## Native model changes

- `MailThreadSummary.senderEmail` / `MailMessage.fromEmail`: server field
  when present, else parsed from the same header string the display
  `sender`/`from` value comes from (`EmailTextNormalizer.email(from:)`,
  mirroring `lib/shared/format.ts`'s `emailFromHeader`). Optional on an
  already-`Codable` `MailThreadSummary`, so old cached snapshots still decode
  (synthesized `Codable` uses `decodeIfPresent` for `Optional` stored
  properties).
- `AreaSummary.imageURL` / `.faviconURL` and `AreaDetail.Identity.imageURL` /
  `.faviconURL` split from the previous merged `imageUrl || faviconUrl` single
  field. Both optional, so old cached snapshots (which only ever wrote the
  merged value into `imageURL`) still decode — they just skip straight past
  the favicon step to the monogram. Every existing read site
  (`AppShellView` sidebar, `WorkView` Areas list, `AreaDetailView` masthead)
  was audited and updated to use the ordered `imageURL → faviconURL` chain so
  none of them regress to a blank/never-favicon state after the split.

## MailIdentityStore

`@MainActor @Observable` store on `AppEnvironment` (alongside `ProductStore`/
`AccountStore`), constructed with the same `ToolInvoking` the rest of the app
uses. `resolve(entries:)` groups by account (a sender's provider contact
photo only resolves against the account that actually has them as a
contact), dedupes/lowercases/drops already-cached emails (positive or
negative), and issues one `resolve_photos` call per account group. Rendering
stays with callers — `MailThreadRow` shows `KFImage` when
`photoURL(for:)` resolves, else the existing `InitialsAvatar`, at a fixed
40pt frame so rows never reflow as photos stream in. `ThreadView` sender
headers pick this up in Stage 2; this stage only makes the lookup available
and wires the one row that already renders identity today.
