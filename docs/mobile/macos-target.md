# Albatross macOS target

Date: 2026-08-19. Status: full product compiles, links, and runs unit tests on macOS 27.

## What exists

- `Lab86MailMac` application target and `Lab86MailMacTests` unit-test target in
  `apps/ios/project.yml`. Native SwiftUI, no Catalyst. macOS 27.0 floor, App Sandbox +
  hardened runtime, bundle identifier `io.lab86.mail` (universal purchase with iOS).
- Shared sources: the entire `Lab86Mail/` + `Shared/` trees compile for both platforms.
  Mac-only code lives in `apps/ios/Lab86MailMac/` (`MacAppDelegate`, `MacShellView`,
  `MacSourceList`, resources).
- Platform seams:
  - `Core/Platform/PlatformAdaptions.swift` — haptics, accessibility announcements,
    pasteboard, settings deep-link, size-class shim.
  - `Core/Platform/MacCompatibilityShims.swift` — `UIViewRepresentable` →
    `NSViewRepresentable` forwarding, iOS toolbar placements, `EditMode`,
    `navigationBarTitleDisplayMode`/keyboard/list no-ops, `Color(uiColor:)` mapping.
  - `Features/Shell/ShellChrome.swift` — `RootDestinationView`, `ShellStatusOverlay`,
    `PendingSendToast`, `shellToolbar`, notification-action consumption, shared by
    `AppShellView` (iOS) and `MacShellView` (macOS).
- iOS-only by design: sidebar wheel (`SidebarWheel*`, `SidebarScrub`), `BGTaskScheduler`
  refresh, AutoFill extension, HorizonCalendar month view (Mac falls back to agenda until
  the Mac month grid lands). The Mac stays fresh through Convex live queries, foreground
  activation, and APNs remote wakes (`.lab86RemoteWake`).
- Server: `/api/mobile/devices` and Convex accept `platform: "macos"`; the Mac registers
  APNs tokens with a persisted per-install identity.

## Building and testing locally

```sh
cd apps/ios && xcodegen generate
xcodebuild -project Lab86Mail.xcodeproj -scheme Lab86MailMac -destination 'platform=macOS' build
xcodebuild test -project Lab86Mail.xcodeproj -scheme Lab86MailMac -destination 'platform=macOS'
```

`ci_scripts/verify_built_configuration.sh` skips only local Debug builds (no Xcode Cloud
source identity + `CONFIGURATION=Debug`); every CI and Release path keeps the full gate.

## External setup required (Jakob)

1. **Apple Developer portal** — enable the macOS platform for the `io.lab86.mail` App ID
   (or confirm the existing identifier covers Mac provisioning) with capabilities: Push
   Notifications, Associated Domains, App Groups (`group.io.lab86.mail`), Time-Sensitive
   Notifications. Create/let Xcode manage a Mac development + distribution profile.
2. **App Store Connect** — add the macOS platform to the existing Albatross app record
   (universal purchase), then create an Xcode Cloud workflow for the `Lab86MailMac`
   scheme mirroring the iOS staging/production workflows (same branch/tag rules; the
   checked-in `ci_scripts` run unchanged). Enable TestFlight for Mac.
3. **APNs** — nothing new: the same APNs auth key serves macOS; the server already
   accepts the `macos` platform. Confirm `APNS_BUNDLE_ID` remains `io.lab86.mail`.
4. **Clerk** — nothing new for sign-in (same publishable key; ClerkKit supports macOS).
   Passkeys on the Mac use the same `webcredentials` association, which already targets
   `TEAMID.io.lab86.mail`; verify with `bun run ios:verify-auth` after the first signed
   Mac build.
5. **Local run** — sign into the team in Xcode and run the `Lab86MailMac` scheme; the
   sandboxed app needs at least ad-hoc signing to launch with entitlements.

## Known Mac gaps (tracked for the polish pass)

- Month calendar falls back to agenda (needs a Mac month grid).
- Compose/sheet sizing is functional, not yet Mac-refined; no dedicated ⌘K palette,
  menu-bar extra, or multiple-window scenes yet.
- Document editor uses SwiftUI `TextEditor` on the Mac (no NSTextView finesse yet).
- Notification-permission deep link opens System Settings' Notifications pane generically.

## Visual QA on production (2026-08-19)

Ran the Mac app against production (`Config/Local.xcconfig` production values; staging backup
at `/tmp/Local.staging.backup.xcconfig`, or `bun run ios:configure` to regenerate). Signed in
with a phone code; every surface loaded live data. Screenshots in `/tmp/albatross-*.png`.

Fixed during the pass:
- Settings/Activity sheets rendered with AppKit's legacy columnar Form (labels clipped off the
  window's leading edge). Fixed by `.formStyle(.grouped)` at the sheet mounts in MacShellView.

Confirmed working: sign-in, bootstrap, Brief masthead + sections, Mail categories/date groups,
HTML thread rendering (JS-free height measurement), calendar timeline, tasks board, areas,
files with drive connections, compose with account picker, Apple Intelligence availability,
sync ("Last sync N minutes ago"), keyboard shortcuts, session persistence across relaunch.

Findings resolved 2026-08-19 (same day, second pass):
1. ✅ Mail rows now print the parsed display name (`senderDisplayName`); raw headers stay in
   the thread detail. Applies to iOS too.
2. ✅ Calendar on macOS no longer uses paged TabViews (the phantom-scroller source): the week
   strip pages with chevrons, day/week render the selection directly, and agenda anchors to
   today on every platform.
3. ✅ The Today toolbar's empty principal capsule is gone (item mounts only when the inline
   dateline is showing).
4. ✅ Sender avatars were broken on iOS **and** macOS: the server answers company logos with
   site-relative `/api/logos/<domain>` paths, which the client rejected (`scheme != nil`) and
   cached as permanent misses. `MailIdentityStore` now resolves relative paths against the
   backend origin.
5. Deliberately unchanged: Noise/Dev-Ops pills exist on web but native intentionally folds
   noise into All Mail (`MailCategoryScope` design note) — not a defect.
6. Activity sheet stray glyph: still to verify visually after the grouped-form change.
7. ✅ Compose From row: AppKit's menu indicator/border doubled the custom chrome — hidden.
8. ✅ Email bodies cap at an 840pt centred reader column on macOS.
9. ✅ Signed-out Sign-in button now states the theme accent explicitly (iOS showed default blue).
10. ✅ Repeated drive providers now label chips with the account email.

New in the same pass:
- Chat on the Mac is a bottom-right bubble that opens a compact floating panel (360×480);
  the panel's header drags and magnetizes to any window corner, and can tear out into its
  own "Albatross Chat" window. ⌘K toggles it. The chat composer also collapsed to a pill on
  macOS (AppKit text fields hug content) — fixed with a plain style + flexible width.
- The sidebar gained the web rail's create (+) menu.
- Full screen works: SwiftUI scene windows were missing `fullScreenPrimary`; the Mac delegate
  restores it as windows become key.

**Local Debug signing (important):** sign Debug builds with the real "Apple Development"
certificate (automatic signing; pass `CODE_SIGN_ENTITLEMENTS=` until Mac provisioning
exists). Ad-hoc (`CODE_SIGN_IDENTITY=-`) re-signs every build with a new identity, and once
a Clerk session exists in the keychain the next build **hangs at launch** inside
`SecItemCopyMatching` on an invisible keychain-ACL prompt. If a build ever hangs at launch,
delete the stale items: `security delete-generic-password -s io.lab86.mail` (repeat until
exhausted) and sign in again.
