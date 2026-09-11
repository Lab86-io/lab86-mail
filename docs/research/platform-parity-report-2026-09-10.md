# Albatross platform parity report

Date: 2026-09-10. Author: Claude (native owner). Purpose: one list of every feature
difference between web production, web staging, iOS, and macOS, so Jakob can cut
tickets. This report does not change code.

Method: static review of the repository at `origin/main`, `origin/staging`, and the
uncommitted working tree on `codex/files-foundations`. No device or browser run was
part of this pass. Items marked **verify** need a device or browser check before a
ticket is final.

## 1. Baseline

| Target | Source | Notes |
| --- | --- | --- |
| Web production (mail.lab86.io) | `origin/main` at `9bff862`, tag `v0.14.5` | Released 2026-09-09 19:43 UTC |
| iOS production (TestFlight / App Store) | Xcode Cloud production build of tag `v0.14.5` | Trigger run succeeded 2026-09-09 19:46 UTC |
| Web staging | `origin/staging` at `d69a9d9` | `main` plus two web-only commits |
| macOS | `Lab86MailMac` target in `apps/ios` | Builds in CI. No TestFlight or App Store workflow exists. Local builds only |
| In flight | Working tree on `codex/files-foundations` | 63 modified files, about 40 untracked files. Not on staging |

Two facts shape the rest of this report:

- iOS production and web production are the same commit. Every iOS-versus-web gap
  below is a true cross-platform gap, not release lag.
- Both staging commits touch web files only. Staging has no native change.

## 2. Staging has, production does not (web)

| # | Feature | Files |
| --- | --- | --- |
| S1 | Files library API. Cursor paging over Albatross documents and uploads. Replaces the old 200-document search limit. | `app/api/files/library/route.ts`, `convex/fileLibrary.ts`, `lib/files/library-client.ts` |
| S2 | Global search reads the library with a bound of four pages per kind. It shows a notice when more matches exist. | `lib/search/global-search.ts`, `components/palette/CommandPalette.tsx` |
| S3 | Files surface rework. Location selector in the toolbar. Responsive columns. Load-more controls. Partial-result notices. Provider full-text matches kept. Thumbnail fallback. Drive failure recovery states. Editor assistant closed by default on narrow widths. | `components/files/FilesSurface.tsx` |
| S4 | Google document fidelity gate. Unsupported rich Google docs, sheets, and decks open read-only with an "Open in Google" link. Writes require the known revision. A conflict stops autosave and asks for reload or discard. | `lib/documents/google-fidelity.ts`, `lib/documents/google.ts`, `components/files/DocumentEditor.tsx` |
| S5 | Control system. One fill role for buttons and fields. Contact shadows. No ShineBorder on rail selection. No BorderBeam on search or the assistant launcher. Platform-aware shortcut label. | `components/ui/*`, `components/shell/ShellActions.tsx`, `components/shell/Rail.tsx`, `app/globals.css` |
| S6 | Soft-square corners with `corner-shape: superellipse(1.6)`. Progressive enhancement for Chromium 139 and newer. | `app/globals.css`, `docs/research/soft-square-corners.md` |
| S7 | Mobile web navigation. An in-flow top bar with a sidebar trigger and a "Search Albatross" button replaces the floating menu. | `components/shell/MobileNavigation.tsx` |
| S8 | Chat email draft card. The "Send" action becomes "Edit draft". On production the card opened the composer and then showed "Sent" without a send. Staging removes the false "Sent". The card still cannot send from chat. | `components/tool-ui/message-draft/*`, `components/ai-elements/tool-ui-part.tsx` |

## 3. In flight, not on staging (uncommitted working tree)

The accepted plan is `docs/research/workspace-round-2026-09-10.md`. Nothing here is
verified or deployed.

Web (Codex):

- Assistant workspace with corner, split, and full presentations. Chat becomes a rail
  destination. Presentation changes keep drafts, tool cards, and streams.
- Notifications as a first-class destination, separate from Activity. Footer becomes
  Settings, Notifications, Profile. To open a notification marks it read only.
- Appearance section inside Settings. The theme panel renders inline there.
- Mail foundations: avatar geometry, row and date separators, decoded snippet
  entities, mailbox sync readout.
- Document revisions API and version restore.
- Office pilot: Odoo spreadsheet engine under `public/vendor`, `app/api/office/*`,
  `components/files/OfficeEditor.tsx`, `convex/officeDocuments.ts`.

Native (Claude):

- Inline email draft artifact in chat. The card is editable, has an explicit Send,
  and survives relaunch. This is the fix for the compose-sheet bug (see C1 and C13).
- Tool cards persist into `/api/chats` history as `dynamic-tool` parts, the same
  shape the web writes.
- Compose "unconfirmed" state. A 2xx without a `sent` object is not "Sent".
- Ask/Hold route pin survives an empty field. Undo Send returns to the conversation.

Process note: the working tree mixes web and native changes on one branch. Commit
the native files in their own change so the staging PR stays web-only.

## 4. Web production has, iOS production does not

Priority: **P0** blocks a user or risks data. **P1** is a visible daily gap. **P2** is
polish or a small gap.

### 4.1 Shell, navigation, and chat presentation

| # | Pri | Gap | Evidence |
| --- | --- | --- | --- |
| C1 | P0 | Chat is a full-screen tab on iOS. On web it is a panel over the current page. Every agent tool that targets the page has no effect on iOS: `ui_open_compose`, `ui_open_reply`, `ui_focus_thread`, `ui_set_query`, `ui_switch_account`, `ui_toast`, `ui_close_bar`. The compose-sheet bug is one instance. The in-flight inline draft fixes the draft case only. The other six tools fall to a text summary. | `apps/ios/.../AssistantToolCards.swift` handles `show_*` only. `lib/tools/ui-tools.ts` |
| C2 | P1 | Global search ("Search everything") with Everything, Mail, Files, and Calendar scopes, page navigation, narrative entries, and settings. iOS has mail search and a Files search field only. No calendar search, no page jump, no narrative search on iOS or Mac. | `lib/search/global-search.ts`, `MailView.swift`, `FilesView.swift` |
| C3 | P2 | Command palette (⌘P). None on native. | `components/palette/CommandPalette.tsx` |
| C4 | P1 | Keyboard shortcuts. Web: `e` archive, `#` trash, `u` back, `n` capture, `c` compose, `s` summary, `t` triage, `?` sheet, `g i`, `g u`, `g s`, ⌘K, ⌘P, arrows, Enter. Mac: ⌘N, ⌘K, ⌘F, ⌘1 to ⌘4, ⇧⌘A, ⌘,, ⌘R, ⇧⌘H only. No archive, trash, triage, summary, or thread-move keys. No key for Mail or Files. iPad has only the cancel action. | `components/shell/ShortcutsBinding.tsx`, `apps/ios/.../AlbatrossCommands.swift` |
| C5 | P2 | The web "Show the board" advanced toggle hides or shows Tasks. iOS always shows the Tasks tab. The preference is not honored. | `app/settings/page.tsx` line 109, `NavigationModel.swift` |
| C6 | P2 | Theme controls. Web: 20-stop palette wheel, Brilliance, Depth, Tint, Grain, Grain size, Background wash, Rail wash, three accents. iOS: Automatic/Light/Dark, display type, presets, Hue, Intensity, Background wash, Navigation wash, Paper grain. Missing on iOS: Brilliance and Depth ladder, Tint, Grain size, third accent. Theme is stored per device on both platforms and does not sync. **verify** the web store. | `components/shell/ThemePanel.tsx`, `lib/theme/palette-presets.ts`, `ThemeStore.swift` |

### 4.2 Chat and assistant

| # | Pri | Gap | Evidence |
| --- | --- | --- | --- |
| C9 | P0 | Human-in-the-loop forms. Web renders `ask_user` (choice form), `ask_parameters` (sliders), `ask_preferences` (switches), and `ask_question_flow` (stepper). iOS handles `ask_approval` only. When the agent calls one of the other four on iOS, the turn waits and shows nothing. | `lib/ai/loop.ts` lines 275 to 390, `AssistantChatModel.swift` line 352 |
| C10 | P1 | Tool cards. Web renders 21 `show_*` tools. iOS renders 11: stats, table, plan, progress, citations, link preview, image, image gallery, weather, message draft, email preview, chart. Missing: `show_code`, `show_code_diff`, `show_terminal`, `show_map`, `show_audio`, `show_video`, `show_carousel`, `show_order_summary`, `show_social_post`. These fall to a one-line summary. | `AssistantToolCards.swift` lines 143 to 258 |
| C11 | P2 | Reasoning trace. Web shows the model's reasoning in a collapsible block. iOS shows tool activity only. | `components/shell/AIBar.tsx` |
| C12 | P1 | Transcript history. iOS production saves text parts only. Cards vanish when a chat reopens. Web saves tool parts. Fixed in flight. | `AssistantChatModel.swift` `transcriptJSON` |
| C13 | P1 | Email draft from chat. Production web: card Send opens the composer and shows a false "Sent". Staging web: "Edit draft", no send. iOS production: read-only card, tap opens the compose sheet under the full-screen chat, so no email is composed. Neither platform sends from the card today. In flight: iOS inline artifact with Send. Web still has no inline send. | S8, `docs/mobile/assistant-inline-email-draft-2026-09-10.md` |

### 4.3 Mail

| # | Pri | Gap | Evidence |
| --- | --- | --- | --- |
| C15 | P1 | Row classification menu. Web: "Why this is here", Apply labels, Fix classification (never Main, always Noise, move to category), Create label from this, Undo last smart rule. iOS: "Why this category?" and "Correct category" only. Missing on iOS: apply smart labels to a thread, create label from this, undo last smart rule. | `components/inbox/Inbox.tsx` near line 1540, `MailView.swift` line 386 |
| C16 | P2 | Noise category pill exists on web. iOS folds Noise into All Mail by design (`MailCategoryScope`). Decide if this stays a design choice. | `docs/mobile/macos-target.md` item 5 |
| C17 | P1 | Natural-language mail search. Web translates the query with `nl_search`, shows the translated filter as a chip, and lets the user edit it. iOS sends the raw text to `corpus_search` with no translation and no chip. | `Inbox.tsx` lines 240 to 253, `ProductStore.swift` `searchMail` |
| C18 | P2 | Smart rules. Web can toggle a rule (`set_smart_rule_enabled`) and undo the last rule. iOS has no rules list. | `Inbox.tsx` |

Mailbox lists match apart from Noise: Inbox, Unread, Starred, Important, Attachments,
This Week, Sent, Drafts, All Mail, Snoozed, Trash, plus Main, Codes, Orders.

### 4.4 Compose

| # | Pri | Gap | Evidence |
| --- | --- | --- | --- |
| C20 | P2 | Attachment sources. Web accepts drag and drop. iOS offers the Files picker only. No Photos library picker, no camera, no paste of an image. | `ComposeView.swift` uses `fileImporter` only. No `PhotosPicker` in the app |
| C21 | P2 | Scheduled-send management. Neither platform lists or cancels scheduled sends in the UI. Only the chat tools `list_scheduled` and `cancel_scheduled` can. Cross-platform gap. | `lib/tools/compose.ts` |

Cc/Bcc, schedule, undo window, draft autosave, AI draft, and Markdown preview exist on
both platforms.

### 4.5 Calendar

| # | Pri | Gap | Evidence |
| --- | --- | --- | --- |
| C23 | P2 | "Calendars & colours" popover with per-calendar colour change. iOS has calendar visibility. Colour change on iOS: **verify**. | `components/calendar/engine/calendar-header.tsx`, `CalendarView.swift` |
| C24 | P2 | Hour density ("Grow hours" / "Shrink hours"). iOS uses a fixed `hourHeight`. **verify** pinch support. | `CalendarView.swift` |
| C25 | P2 | Resize an event by drag. Web has `resizable-event.tsx`. iOS reschedules by drag; resize is **verify**. | `CalendarView.swift` |

RSVP, occurrence and series edit and delete, guests, repeat rules, video call links,
linked tasks, and resync exist on both platforms.

### 4.6 Tasks

Parity is good. Boards, columns, cards, due presets, comments, file and link
attachments, invites with access level, public link, projects with pause and resume,
priority, and assignee exist on both platforms.

| # | Pri | Gap | Evidence |
| --- | --- | --- | --- |
| C27 | P2 | Web has a Kanban view and a To-do list view toggle, and "Copy link" on a card. iOS has Board and List labels. Copy link on iOS: **verify**. | `components/tasks/TasksSurface.tsx` |

### 4.7 Albatrosses, Areas, and Work

| # | Pri | Gap | Evidence |
| --- | --- | --- | --- |
| C29 | P1 | Area home. Web has an Evidence section ("Filed by Area evidence"), Area mail search, "Move to another Area", and links to Open board, Open calendar, Open plans, Open tasks. iOS Area detail has Brief and Inbox, facts, places and map, project pulse, Suggested, identity picture, Manage Area, Archive, Remove from Area, Correct smart category. Missing on iOS: Evidence section, Area mail search, move to another Area (**verify** `mutateAreaMail`), cross-links. | `components/albatross/AreaHome.tsx`, `AreaDetailView.swift` |
| C30 | P1 | Area onboarding. Web has a first-run flow ("Name your first area", "Albatross is listening now"). iOS has mailbox onboarding only. | `components/albatross/AreaOnboarding.tsx` |
| C31 | P1 | Plans surface. Web has a plan dossier page reachable from "Open plans". iOS has "The plan" section inside Work detail only. | `components/albatross/PlansSurface.tsx`, `WorkDetailView.swift` |
| C32 | P2 | `components/albatross/AlbatrossSurfaces.tsx` (sprints, approval queue, noise rules, corrections) is not rendered on main. Cleanup, not parity. | `git grep` finds no import |

Guided work has parity: split, proof, forgiveness, later shelf, horizon, wake nudge,
shared browser, questions, teach.

### 4.8 Today, Brief, and Narrative

| # | Pri | Gap | Evidence |
| --- | --- | --- | --- |
| C34 | P1 | Narrative page. Web: editions list, depth filter (All depths, Weeks, Months), "Search your narrative", evidence trail, "Correct this observation", Sources & privacy, Narrative model picker, Meeting prep ("Before you meet"), narrative-grounded draft ("What should this email say?"), and the Today workspace. iOS reads `/api/narrative` for the brief and refresh only. None of the rest exists on iOS or Mac. | `components/narrative/*`, `NarrativeBriefStore.swift` |
| C35 | P2 | Brief print. Web prints the brief canvas. iOS has share only. | `components/report/brief-canvas/BriefCanvas.tsx` |
| C36 | P2 | Brief density toggle (compact). iOS adapts density but has no control. **verify**. | `components/report/brief-canvas/BriefActions.tsx` |

Past editions, regenerate, weather with location, day ribbon, masthead, and letter
brief exist on both platforms.

### 4.9 Files and documents

| # | Pri | Gap | Evidence |
| --- | --- | --- | --- |
| C38 | P0 | Google fidelity gate. Staging web refuses to write a rich Google document through the simplified round trip because it destroys structure. iOS still uses that round trip through `/api/files/google/editor` and "Apply and save to Google Drive". When S4 reaches production, iOS is the only client that can still overwrite structure. Add the same read-only path and revision guard on native. | `lib/documents/google-fidelity.ts`, `DocumentEditorView.swift` |
| C39 | P1 | Library paging and search (S1, S2). iOS lists documents and uploads with the old endpoints and limits. | `FilesView.swift` |
| C40 | P2 | Delete or rename a document or upload. Web has delete. iOS "Delete" applies to blocks and slides only. **verify**. | `FilesView.swift`, `DocumentEditorView.swift` |
| C41 | P2 | "Add sheet" (new tab in a sheet document). Web has it. iOS: not found. | `DocumentEditorView.swift` |
| C42 | P2 | Drop-zone upload with the 5 files / 25 MB limit. iOS uses the document picker. Platform difference, but the limits must match. | `FilesView.swift` |
| C43 | P2 | In-flight revisions and Office editor have no native plan. | Section 3 |

Drives, folder browse, grid view, doc, sheet, and deck editors, speaker notes, AI
suggestions, Import latest Google changes, Open in Google, and export exist on both.

### 4.10 Settings

| # | Pri | Gap | Evidence |
| --- | --- | --- | --- |
| C45 | P1 | Billing. Web has Checkout and Billing portal in Lab86 AI settings. iOS shows Plan and Usage read-only with no action and no link. | `app/settings/page.tsx` lines 1177 to 1193, `AISettingsView.swift` |
| C46 | P2 | AI provider list. iOS offers Anthropic, OpenAI, OpenRouter. Web settings show Anthropic and OpenRouter. The shared type allows all three. Align the lists. | `lib/ai/model-options.ts` line 1 |
| C47 | P2 | Display name. Web Account has "Display name (optional)". iOS has no field. | `app/settings/page.tsx`, `SettingsView.swift` |
| C48 | P2 | Timezone. Web uses a select. iOS uses a free-text field. | `NotificationSettingsView.swift` line 53 |
| C49 | P2 | Full mail re-index and Calendar resync buttons exist in iOS Mailboxes settings. Web has no re-index button in Settings. | `MailboxesSettingsView.swift` |
| C50 | P2 | Appearance placement. Web production keeps the theme panel in the rail. In flight moves it into Settings. iOS has it in Settings. Both should end in Settings. | Section 3 |

### 4.11 Notifications and push

| # | Pri | Gap | Evidence |
| --- | --- | --- | --- |
| C52 | P1 | Web Push covers Albatross notification kinds only (work, task, reflection, project, tomorrow). New mail, urgent mail, brief ready, and calendar suggestions deliver on APNs only. Web users get no mail push. | `lib/notifications/delivery.ts`, `lib/notifications/native-delivery.ts`, `public/albatross-sw.js` |
| C53 | P2 | Per-category push toggles (New mail, Urgent mail, Morning Brief, Calendar suggestions, Codes) exist on iOS only. Web has no equivalent because C52. | `NotificationSettingsView.swift` |

iOS Activity already exceeds the web bell: questions, approvals, check-in save and plan,
mark visible read, archived filter. In flight web adds a Notifications destination.

### 4.12 Onboarding, marketing, and legal

| # | Pri | Gap | Evidence |
| --- | --- | --- | --- |
| C55 | P2 | Web `/welcome` sets up a mailbox and AI provider. iOS onboarding connects a mailbox only ("Bring your inbox", "Skip for now"). **verify** the AI step. | `components/hosted/FirstBurden.tsx`, `MailboxOnboardingView.swift` |
| C56 | P2 | Web has `/pricing`, `/support`, `/privacy`, `/terms`. iOS has no in-app links to support, privacy, or terms. **verify** App Store metadata covers this. | `app/*/page.tsx` |

## 5. iOS production has, web production does not

| # | Pri | Feature | Evidence |
| --- | --- | --- | --- |
| D1 | P1 | Snooze from the row and the thread (Later today, Tomorrow morning, Next week) by swipe and context menu. Web has a Snoozed mailbox but no snooze control. Snooze on web works only through the chat tool `snooze_thread`. | `MailView.swift` line 36, `Inbox.tsx` has zero snooze matches |
| D2 | P1 | Star and Unstar, Mark Read and Mark Unread as row actions. Web rows expose Archive, Delete, and the classification menu. Web `s` is summary, not star. | `MailView.swift` lines 345 to 383, `ShortcutsBinding.tsx` line 124 |
| D3 | P1 | Add to Calendar from a thread. iOS proposes an event from the email and creates nothing until "Add". Web thread has no such action. Web relies on calendar suggestion notifications. | `ThreadView.swift` "Add to Calendar" |
| D4 | P1 | Offline cache and command outbox with idempotent receipts and undo. Pending state overlays the list. Web is online-only. | `Core/Sync/CommandOutbox.swift`, `lib/mobile/v1/command-executor.ts` |
| D5 | P2 | On-device Apple Intelligence summaries with an availability label. Web is server-only. Platform-native. | `Core/AI/ModelRouter.swift` |
| D6 | P2 | Siri and App Intents: Open Today, Capture Work, Search Mail, Compose Email, Open Check-in, plus the Mail App Schema intents. Platform-native. | `App/AppIntents.swift`, `App/MailAppSchemaIntents.swift` |
| D7 | P2 | Spotlight index of mail. Platform-native. | `Core/Spotlight/MailSpotlightIndexer.swift` |
| D8 | P2 | AutoFill one-time codes extension on iOS and Mac with "Offer codes from mail" and "Archive the email after filling". Web has the Codes mailbox only. A browser extension would be the web equivalent. Product decision. | `apps/ios/Lab86MailAutoFill` |
| D9 | P2 | Push actions inline: Mark Read, Archive, Add, View, Later, open brief. Web Push has a click handler only. | `NotificationCoordinator.swift` lines 266 to 317, `public/albatross-sw.js` |
| D10 | P2 | Area identity picture: Set picture, Upload image, Remove custom image. Web displays `imageUrl` but has no control to set it. | `AreaDetailView.swift`, `AreaHome.tsx` line 2579 |
| D11 | P2 | Mailboxes settings: Full mail re-index, Calendar resync, Refresh status, Disconnect and remove indexed data. | `MailboxesSettingsView.swift` |
| D12 | P2 | Copy Subject and New Email to sender in the thread menu. Small. | `ThreadView.swift` |
| D13 | P2 | Mac only: chat panel that tears out into a window, Later ruler, Horizon popover, ⌘R Sync Calendar, ⇧⌘H Horizon. iOS only: sidebar wheel scrub with haptics. Platform-native. | `apps/ios/Lab86MailMac/Shell/*`, `SidebarWheel*.swift` |

## 6. macOS gaps (against iOS in the same codebase)

| # | Pri | Gap | Evidence |
| --- | --- | --- | --- |
| E1 | P1 | No distribution. Xcode Cloud workflows build the iOS scheme only. The Mac target has no TestFlight or App Store path. Portal and App Store Connect steps are listed for Jakob. | `docs/mobile/macos-target.md` "External setup required" |
| E2 | P2 | Compose and sheet sizing not Mac-refined. No ⌘K palette (⌘K opens chat). No menu-bar extra. No multi-window scenes apart from chat tear-out. Document editor uses SwiftUI `TextEditor`. | `docs/mobile/macos-target.md` "Known Mac gaps" |
| E3 | P2 | Files import. `OpenInPlaceDocumentPicker` is iOS-only. **verify** the Mac import path. | `FilesView.swift` line 567 |
| E4 | P2 | Area view picker (Brief / Inbox) hidden on Mac. **verify** the Mac layout shows both. | `AreaDetailView.swift` line 225 |
| E5 | P1 | Shortcuts. See C4. ⌘1 to ⌘4 skip Mail and Files. ⌘F is mail only. | `AlbatrossCommands.swift` |

## 7. Contract and architecture drift (root causes)

| # | Finding |
| --- | --- |
| F1 | The mobile v1 contract covers 15 `mail.*` commands, `calendar.create`, `calendar.resync`, `task.create`, `task.setCompleted`, ten `work.*` commands, and two `approval.*` commands. Everything else on iOS goes through `/api/tools/<name>` passthrough (30 tool names, including 13 `tasks_*`, `calendar_update_event`, `area_home`, `work_home`, `save_draft`, `reply_all`, smart label CRUD, daily report) or bespoke web routes (`albatross/*`, `documents/*`, `files/*`, `mcp/*`, `nylas/*`, `narrative`, `chats`, `prefs`, `ai/settings`, `account`, `compose/*`). Passthrough calls are not idempotent, not in the outbox, not offline, and not in the OpenAPI document. Parity drifts each time a web tool changes shape. |
| F2 | Contract commands missing for actions the iOS UI already performs: calendar update, delete, RSVP; task update, move, delete, comment, attach; board and column management; reply, reply all, forward; smart label CRUD; area mutations; document mutations. |
| F3 | Sync domains are accounts, mail, calendar, tasks, today, work, assistant, activity. No domain for documents, notifications, areas, narrative, smart labels, or chats. Those fetch on demand. |
| F4 | The seven `ui_*` tools have no native handler. Native needs a UI-intent mapping in the assistant route or a contract event. |
| F5 | OpenAPI artifacts are in sync. `contract.ts`, `docs/mobile/openapi/mobile-v1.json`, and `MobileAPI/openapi.yaml` share commit `e321088`. |
| F6 | Web APIs added on staging (`files/library`) and in flight (`documents/revisions`, `office/*`) have no mobile consumer plan. |
| F7 | Chat transcripts differ by writer. Web writes tool parts. iOS production writes text only. Cross-device history renders differently until the in-flight fix ships. |
| F8 | Theme and appearance preferences live on each device. No server preference exists. **verify** the web store. |

## 8. Vocabulary and naming differences

| Concept | Web | iOS | Mac |
| --- | --- | --- | --- |
| Work tab | "Albatrosses" | "Albatrosses" | ⌘4 menu says "Areas"; shortcut sheet says "Albatrosses" |
| Home tab | "Today" / "The Daily Brief" | "Today" | ⌘1 menu says "Brief" |
| Assistant entry | "Ask Assistant"; in flight "Chat" | "Ask or hold"; shortcut sheet "Ask Albatross" | "Ask or Hold…" |
| Notifications | "Notifications" bell; in flight a destination | "Activity" sheet | "Activity" sheet |
| Trash action | "Delete" | "Move to Trash" / "Trash" | same as iOS |
| Mailbox labels | "All mail", "This week" | "All Mail", "This Week" | same as iOS |
| Timezone control | select | free text | free text |

## 9. Suggested epics for tickets

1. **Chat parity on native**: C1, F4, C9, C10, C11, C12, C13. Start with C9 and C1.
2. **Files fidelity on native**: C38 first. Then C39, C40, C41, C42, C43.
3. **Search parity**: C2, C3, C17.
4. **Mail row actions on web**: D1, D2, D3. **Mail classification on iOS**: C15, C18.
5. **Narrative on native**: C34, C35, C36.
6. **Areas and plans on native**: C29, C30, C31.
7. **Settings parity**: C45, C46, C47, C48, C49, C50, C5, C6, D10, D11.
8. **Web push parity**: C52, C53, D9.
9. **Mac release and shortcuts**: E1, E5, C4, E2, E3, E4.
10. **Contract hardening**: F1, F2, F3, F6, F7, F8.
11. **Vocabulary alignment**: section 8.
12. **Cross-platform gaps**: C21 scheduled sends, C20 attachment sources, C56 legal links.

P0 items: C1, C9, C38. Fix these before the next native release.
