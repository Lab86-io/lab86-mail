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
