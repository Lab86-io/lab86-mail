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

Open findings, ordered by priority:
1. Mail list rows print the raw `Name <address>` header; web shows the display name only.
   Desktop width makes this ugly (long private-relay addresses). Show the parsed display name.
2. Calendar paged TabViews leave phantom horizontal scroller artifacts on macOS (the .page
   style shim falls back to a default TabView). Replace the week strip/day pager with a
   Mac-appropriate control; agenda mode also anchors at the list top (July) instead of today.
3. Empty capsule renders in the Today toolbar's principal slot (likely the nav-title
   crossfade placeholder).
4. Sender identity avatars show initials only on the Mac (web shows brand photos) — verify
   MailIdentityStore photo loading on macOS.
5. Native category pills lack the web's custom smart labels (web shows Noise, Dev/Ops).
6. Activity sheet: stray floating glyph at the check-in editor's leading edge; rough padding.
7. Compose From row is cramped (avatar/label/picker collide); Mail rows are iOS-scale —
   desktop wants denser rows and eventually a list+reading-pane split.
8. Email bodies render left-anchored in the wide detail view; consider a centered column.
9. Signed-out iOS shows a default blue accent where the Mac shows the theme green — check
   accent tint application on a fresh iOS install.
10. Files location pills show two indistinguishable "Google Drive" chips — add the account
    email when a provider repeats.
