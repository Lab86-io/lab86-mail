# iOS UI round — 2026-07-20 design plan

Inputs: `mobbin-research.md` (20 inspected references + depth playbook), `swift-libraries.md`
(native-first verdict, zero new required dependencies), the desktop parity map (globals.css
OKLCH surface system, AIBar, IntentCapture, AreaHome, InlineComposer, ThreadView, Inbox),
and the current iOS implementation map (near-flat: 3 glassEffect uses, 2 shadows app-wide).

Hard rules carried through: no sparkle/star icons, no icons before text, no ALL-CAPS
micro-labels, restrained Linear-calibrated motion, backgrounds never pure white/black,
display serif only for wordmark/titles/sender names/subjects/datelines/initials.

## Foundation (new `Core/Theme/Surface.swift`)

Port the desktop surface system into ThemeStore:

- Paper/elevated/subtle surface colors from the existing OKLCH pipeline, tinted by the
  accent hue (light ≈ L 0.977 paper / 0.995 elevated; dark ≈ 0.145 / 0.205) — desktop's
  "never pure white/black" floor.
- Hairline stroke token; layered "soft" shadow (1pt key + 24pt ambient, light mode only —
  dark mode elevates tone-on-tone, per the Mobbin depth playbook).
- `surfaceCard()` modifier = one elevation step (elevated fill + hairline + soft shadow).
- Avatar palette: five hue-rotated OKLCH colors derived from the live accent (desktop
  `--color-avatar-1..5`), FNV-picked by seed; initials set in the display face.
- Display italic face (Fraunces-SemiBoldItalic) for datelines/summary labels.

## Surfaces

1. **Inbox (MailView)** — Apple Mail masthead structure + desktop row grammar: initials
   avatars (accent-derived), display-font sender, unread accent dot in a stable gutter,
   2-line snippet, display-italic datelines ("Today", "Yesterday", month buckets), a
   horizontal text-only category pill row (selected = accent-soft fill) replacing the
   buried category menu. Swipe actions/search/scopes unchanged.
2. **Thread view (ThreadView)** — document header (subject in display font + meta line)
   instead of nav-title-only; messages become one-elevation-step cards (avatar, sender →
   recipient, collapsed snippet, expanded HTML); Spark-style quarantined summary card
   (accent rail + display-italic "Summary" label) replacing the plain glass card; Outlook
   style floating glass reply capsule at the bottom (Reply · Reply all · Forward · Archive)
   replacing the buried actions menu (menu retained for destructive/rare actions).
3. **Compose (ComposeView)** — Apple Mail authoring model: From-account identity chip
   (multi-account, Outlook steal), hairline recipient rows with collapsed "Cc/Bcc" line,
   subject as a display-font headline field, borderless body, attachments as hairline rows,
   schedule-send presets (in 1 hour / tomorrow 9:00 / custom — desktop InlineComposer
   parity), circular accent send button. Send contract untouched.
4. **Chat (AssistantChatView)** — Notion zero-state: display-font greeting + "Suggested"
   quiet vertical list of four text-only rows; assistant text stays bubble-less; user
   bubbles get the elevated-surface treatment; tool cards move to the shared surfaceCard
   depth with internal hairlines (Navigator grammar); composer becomes a floating glass
   capsule detached from the bottom edge (keeps the `Message Albatross` field the UI test
   asserts).
5. **Intent capture (AssistantView)** — desktop IntentCapture parity in a sheet: paper
   backdrop, display-font prompt "What are you trying to get out of your head?", large
   borderless text area with accent caret, "Get it out" accent pill (desktop copy), quiet
   on-device-intelligence line, saved beat ("Got it. Making Work.") then auto-dismiss.
   Capture pipeline (`store.capture` → advance) untouched.
6. **Area brief full screen (AreaDetailView)** — nav bar fully hidden on the area surface;
   masthead bleeds under the status bar; frosted glass circle top-left opens the sidebar
   (new `NavigationModel.requestSourceList` bridge), floating glass capsule top-right holds
   the Brief|Inbox switch and the area menu (Timepage zero-chrome + "frosted circles for
   nav" pattern). Pushed destinations (thread/work/event) keep their normal bars.

## Explicitly out of scope this round

Daily brief artifact HTML, calendar, tasks/kanban, settings, web app. No new SPM
dependencies (native Liquid Glass APIs only), no server/contract changes.
