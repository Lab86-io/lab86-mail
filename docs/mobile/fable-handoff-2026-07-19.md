# Albatross iOS handoff for Fable

Date: 2026-07-19  
Repository: `/home/jjalangtry/repos/lab86-mail`  
Mac working copy: `/Users/jjalangtry/Developer/lab86-mail` via `ssh mac`

## Why this handoff exists

The goal was to turn the existing Albatross iOS code into a functional mobile counterpart to the desktop product. The user is moving UI work to Fable because the app still does not look or function at the desired level.

This document distinguishes implemented code from verified behavior. Several architectural pieces and screens now exist, but the complete product journey has **not** been accepted. Do not treat compilation or the sidebar screenshot as proof that Areas, briefs, Calendar, or Mail are production-ready.

## Product direction established in the conversation

- iOS 27+, Swift 6, SwiftUI-first.
- Brief is the default cold-launch destination.
- The desktop hierarchy matters more than a generic mobile tab layout:
  - Brief
  - Tasks
  - Calendar
  - Areas
  - Work, mail, events, tasks, projects, and context live inside an Area.
- No bottom tab bar.
- On iPhone, the current destination is full-screen. A leading hamburger reveals navigation underneath the page, following ChatGPT and Claude rather than presenting a floating drawer.
- On iPad, use a persistent `NavigationSplitView` backed by the same selection state.
- Area and Work briefs should render as documents, not dashboard cards.
- Open mail should occupy the page like Apple Mail, not sit inside a rounded card.
- Mail content should render immediately. A misleading “Load remote images” control must not gate the actual message body.
- Native Apple navigation and controls are preferred. Albatross identity belongs in typography, authored briefs, color, and restrained motion—not indiscriminate glass cards.
- Codex owns UI research and implementation directly. The old Opus/Claude UI requirement was explicitly removed.

## User-reported problems that motivated the work

1. Authentication regressed: successful Clerk sign-in was followed by “you need to sign in again,” duplicate alerts, or an empty app.
2. SwiftData/Core Data initially failed to create `Library/Application Support/AlbatrossMobileV1.store`; Core Data recovered after creating the missing directory.
3. Briefs did not resemble the desktop artifact.
4. Calendar events were missing.
5. Areas were not clickable and Area briefs did not render.
6. Mail showed controls that appeared to gate the message body.
7. Mail detail felt like an inset card rather than a native full-page document.
8. The bottom-tab information architecture did not match the desktop Albatross hierarchy.
9. The first custom sidebar implementation looked like a floating drawer and was rejected.

## What was implemented in this slice

### Navigation and shell

The five-tab shell was removed from `AppShellView`.

Current compact behavior:

- Brief, Tasks, Calendar, and Areas are root destinations.
- A system-toolbar hamburger opens navigation at root depth.
- Navigation is the underlying layer.
- The current page translates right, retains a visible trailing strip, receives continuous leading corners, and casts a restrained edge shadow.
- There is no dimming scrim.
- Tapping the exposed page dismisses navigation.
- A leading-edge right swipe reveals navigation; a left drag dismisses it.
- Reduce Motion disables the transition animation.
- Work, event, and thread detail are nested destinations and use the system back affordance instead of showing the hamburger.
- A selected Area is treated as a root document, so it retains the hamburger.

Current regular-width behavior:

- `NavigationSplitView` provides a persistent source list and detail.

The navigation source list now contains:

- Brief
- Tasks
- Calendar
- Areas
- Real user Areas under `Your areas`
- Settings anchored at the bottom

Primary implementation:

- `apps/ios/Lab86Mail/Features/Shell/AppShellView.swift`
- `apps/ios/Lab86Mail/Features/Shell/NavigationModel.swift`

### Typed Area and Work data

The local server tools were extended so an Area read can include authoritative durable Work records and an individual Work record can expose its plan brief.

- `area_home` aggregates `albatross.areaHome` and `albatrossWorkV2.areaWork`.
- New read-only `work_home` returns durable Work, Plan, Project, questions, application/provenance, artifact HTML, sources, assumptions, actions, and applied steps.
- Native models now include typed `AreaDetail.WorkRow` and `WorkDetail`.
- Work detail is cached through the existing `ProductStore` compatibility facade.
- A Work deep link may preserve its Area context.

Files:

- `convex/albatrossWorkV2.ts`
- `lib/tools/areas.ts`
- `lib/tools/index.ts`
- `tests/tools-areas.test.ts`
- `apps/ios/Lab86Mail/Core/Models/ProductModels.swift`
- `apps/ios/Lab86Mail/Core/Models/ProductCache.swift`
- `apps/ios/Lab86Mail/Core/Models/ProductStore.swift`
- `apps/ios/Lab86Mail/Features/Shell/NavigationModel.swift`

### Area and Work presentation

`AreaDetailView` was changed from a card/list treatment to a full-width document flow:

- Area brief lead
- Needs You
- Projects
- Work
- Events
- Mail
- Tasks
- Places
- Context

Work rows open a typed Work destination. Area mail and events preserve Area context when pushing detail.

`WorkDetailView` was added as a document surface:

- Desired outcome
- Durable status
- Summary or original wording
- Pending question routing
- Project context
- Applied and pending actions
- Rendered plan artifact HTML
- Assumptions and sources
- Assistant discussion action

Files:

- `apps/ios/Lab86Mail/Features/Work/AreaDetailView.swift`
- `apps/ios/Lab86Mail/Features/Work/WorkDetailView.swift`
- `apps/ios/Lab86Mail/Features/Work/WorkView.swift`
- `apps/ios/Lab86Mail/Features/Today/DailyBriefView.swift`

### Mail reading changes

The thread detail hierarchy was flattened into a full-page document:

- `ThreadView` moved from `List` and card-like message containers to `ScrollView`/`LazyVStack` with dividers.
- Sender metadata and bodies use the available width.
- `EmailHTMLView` no longer clips itself to a rounded card.
- Safe message HTML is rendered as content rather than hidden behind a remote-image button.
- The WebKit body budget increased from 1,600 to 12,000 points so normal messages remain part of the outer document scroll; only pathological HTML becomes internally scrollable.

Files:

- `apps/ios/Lab86Mail/Features/Mail/ThreadView.swift`
- `apps/ios/Lab86Mail/Features/Mail/EmailHTMLView.swift`

## Research completed

The durable research record is:

- `docs/mobile/research/hierarchical-navigation-area-work-mail.md`

Key sidebar references:

- ChatGPT navigation sidebar: https://mobbin.com/flows/ce303c5a-d3a2-4048-af5c-1e5c3f18f177
- Claude chats/sidebar: https://mobbin.com/flows/452dcc19-a390-4d80-80f0-5d01078c802e
- Claude pinning/sidebar state: https://mobbin.com/flows/7026177a-9967-4f9e-8860-06500a7c7763
- Apple WWDC26 SwiftUI guidance: https://developer.apple.com/videos/play/wwdc2026/269/
- Apple WWDC25 new SwiftUI design: https://developer.apple.com/videos/play/wwdc2025/323/
- SwiftUI `prominentDetail`: https://developer.apple.com/documentation/swiftui/navigationsplitviewstyle/prominentdetail
- SwiftUI `sidebarToggle`: https://developer.apple.com/documentation/swiftui/toolbardefaultitemkind/sidebartoggle

Observed ChatGPT/Claude pattern:

- The source list is flat and full-height.
- The active page moves; the sidebar does not float over it.
- A narrow strip of the active page remains visible.
- Claude rounds the foreground page’s leading edge and uses a subtle shadow.
- There is no dark scrim.
- Rows use quiet selection fills and semantic grouping.

## Verification completed

### Server and TypeScript

Executed from the Linux repository:

```bash
bun test tests/tools-areas.test.ts
bun run typecheck
```

Result:

- Area/Work tool tests: 20 passed, 0 failed.
- TypeScript typecheck: passed.

### iOS simulator

Built and tested with Xcode 27 beta on an iPhone 17 Pro iOS 27 simulator.

Targets exercised:

- `Lab86MailTests`
- `Lab86MailUITests`

Result:

- Unit suite passed.
- Simulator launch UI test passed.
- The UI test supports both the unauthenticated boundary and the authenticated navigation state.

### Physical iPhone

Device:

- Name: `ouch`
- Model: iPhone 17 Pro
- iOS: 27.0, build `24A5380h`
- CoreDevice identifier: `705B922C-6DC3-542E-BF65-DB021898BE0C`
- UDID: `00008150-000959282287801C`

The signed build was installed successfully and retained the authenticated user/cache across normal reinstalls.

Physical UI test:

```text
Lab86MailUITests/testLaunchesIntoConfigurationOrAuthenticationBoundary()
```

Result:

- Passed on the physical iPhone.
- Opened the hamburger navigation.
- Asserted that Brief and Areas exist.
- Captured an `Authenticated navigation overlay` attachment.
- Result bundle on the Mac: `/tmp/AlbatrossSidebarReview20260719.xcresult`

The captured sidebar showed the intended under-page composition with real Areas. No P0/P1 HIG issue was found in that one captured state.

## Important gaps and unverified behavior

These should be treated as active work, not polish.

### 1. Fresh authentication is not fully re-verified

The physical app retained an authenticated session and loaded the Brief after reinstall. This does **not** prove the original fresh-sign-in regression is gone.

Still required:

- Delete or sign out safely.
- Complete a fresh Clerk sign-in.
- Verify the root state transitions once, without duplicate alerts.
- Terminate and relaunch.
- Expire or invalidate the session and verify recovery.
- Sign out from loading, offline, and failed-sync states.

The noisy keyboard, RunningBoard, PointerUI, and prediction-cell constraint logs were mostly iOS/system messages. The duplicate SwiftUI alert presentation message was app-relevant and should be rechecked during auth failure.

### 2. The Daily Brief artifact still looks wrong on-device

Physical screenshots showed a very large, blurred/low-detail masthead image with clipped vertical spine text. The HTML is technically being rendered, but the mobile result does not yet resemble a carefully adapted version of the desktop artifact.

Likely owners:

- `apps/ios/Lab86Mail/Features/Today/DailyBriefView.swift`
- `lib/mail/report-artifact.ts`
- The generated/stored daily-report HTML and its mobile media queries

Do not solve this by replacing the artifact with unrelated native summary cards. The requirement is to preserve the authored desktop brief while making its HTML responsive and legible inside the native page.

### 3. Area and Work journeys are coded but not physically accepted

The physical UI test only opened the sidebar. It did not tap through:

- Area selection
- Area brief rendering
- Work selection
- Work plan artifact rendering
- Area → Mail → Thread
- Area → Event

These need screenshot evidence against real data, plus loading, empty, cached, and partial-failure states.

### 4. Calendar remains insufficiently verified

The user explicitly reported missing calendar events. No complete physical test in this conversation proved that real events now appear. Calendar CRUD was also outside this slice.

Verify account capability state, server response, cache decode, filtering/date intervals, and visible Calendar rendering before changing layout.

### 5. Mail is not replacement-grade or provider-validated

The code now presents a more native full-page thread, but the following were not physically accepted in this conversation:

- Real HTML across Gmail, Microsoft, iCloud, and generic IMAP
- Malformed MIME and charset fixtures on-device
- Inline CID images
- Tracking/remote-image policy
- Attachments and Quick Look
- Reply/reply-all/forward
- Draft synchronization
- Pagination/search/folders
- Archive/trash/snooze/labels
- Scheduled send and undo send
- Offline outbox behavior

The 12,000-point WebKit height cap is a pragmatic interim choice, not a performance acceptance result.

### 6. Server changes are local and may not be deployed

The debug iOS configuration points to:

```text
https://mail-staging.lab86.io
```

The new `area_home` aggregation and `work_home` tool exist in the local dirty worktree. Do not assume staging or production serves them until deployment is checked.

Deployment was intentionally not performed because the repository contains many unrelated uncommitted changes. Deploying the entire tree would be unsafe without isolating and reviewing the intended patch.

### 7. Architecture remains transitional

`ProductStore` is still the compatibility facade. This slice added typed models and routing but did not finish the planned domain-store migration.

Do not create another UI-only store or a second mobile reality. Continue migrating consumers toward typed repositories/stores while preserving the working data path.

### 8. Accessibility and adaptation need broader evidence

The sidebar code uses semantic styles, adaptive colors, labels, selected traits, 44-point targets, and Reduce Motion handling. Still render and inspect:

- Accessibility Dynamic Type
- Dark appearance
- Increase Contrast
- VoiceOver focus order
- Longer localized Area names
- Smallest supported iPhone
- iPad resize/multitasking

## Working-tree warning

The Linux repository is very dirty and contains substantial pre-existing/user work. `apps/ios/` and much of `docs/mobile/` are currently untracked from Git’s perspective.

Do not run broad reset, checkout, clean, or commit commands. Do not assume every modified file belongs to this slice. Review and isolate changes before committing or deploying.

The Mac working copy does not have the useful Git metadata used on Linux. Source was synchronized selectively from Linux to the Mac with `rsync`.

Current branch on Linux during this work:

```text
staging
```

## Development environment notes

- SSH alias: `mac`
- Mac project: `/Users/jjalangtry/Developer/lab86-mail`
- Xcode: `/Applications/Xcode-beta.app`
- Simulator: iPhone 17 Pro, `BCE03E32-BBA7-4EEB-B1A8-50AA955C355E`
- Known reusable derived data: `/tmp/Lab86MailDerived.llwvi9`
- Signed app output: `/tmp/Lab86MailDerived.llwvi9/Build/Products/Debug-iphoneos/Albatross.app`
- Simulator app output: `/tmp/Lab86MailDerived.llwvi9/Build/Products/Debug-iphonesimulator/Albatross.app`

Codesigning through a plain SSH-launched `xcodebuild` can fail with:

```text
errSecInternalComponent
```

The working workaround was to launch `xcodebuild` in the unlocked Mac Terminal via AppleScript, then install with `xcrun devicectl`.

## Recommended next sequence for Fable

1. Inspect the existing desktop Albatross Brief, Area, Work, Calendar, and Mail journeys in the running product.
2. Run the current iPhone build and capture baseline screenshots before changing code.
3. Fix and validate fresh authentication first; every other real-data journey depends on it.
4. Repair responsive Daily Brief artifact rendering without replacing the shared artifact semantics.
5. Validate Calendar data end-to-end before redesigning Calendar UI.
6. Validate Area → Area brief → Work brief with real production-backed data.
7. Validate Area → Mail → Thread and correct the full-page mail reader with real provider messages.
8. Isolate and deploy the required `area_home`/`work_home` server changes to staging.
9. Add physical-device journey tests and screenshots for every corrected loop.
10. Only after those loops work should visual refinement expand to the rest of the product.

## Acceptance posture

The sidebar interaction is implemented and physically verified, but the application as a whole is **not complete**. Authentication, artifact responsiveness, Calendar data, Area/Work detail, and real-provider Mail remain the most important acceptance gaps.
