# Many Albatross threads at once, iOS design note (2026-10-08)

Status: design only. No production code changes. Branch `claude/albatross-threads`.

This note decides how the Albatross thread list, the hop between threads, and direct steering
look and behave on iPhone and iPad. The brief is `docs/albatross-threads.md` (stories T1 to T12,
the owner decisions, and the server contract). The thread itself is PR 1
(`docs/albatross-thread.md` and `docs/research/albatross-thread-ios-design-2026-10-07.md`). The
data contract of PR 1 is `lib/albatross/thread-contract.ts`. Where this note and the PR 1 note
differ, this note wins for the list, the receipts, and the composer route; the PR 1 note stays
valid for the run block, the forms, the plan sheet, and the page sheet.

The macOS designer reads this note too. Section 8 says which parts are shared.

The owner's words (2026-10-08): "this is much better. I should be able to have multiple threads
running. Like, when I click back it should show sort of a status preview like T3 Code's and I
should be able to hop between them. I should also be able to steer them effectively."

Sample data in this note is invented: Sam Rivera, (555) 010-0137, dmv.ny.gov, "Renew the car
registration", "Pay the water bill", "Plan the Lisbon trip", "Book the dentist for Sam Rivera",
"Cancel the gym membership", "File the expense report", "Return the library books", "Call the
plumber about the leak". Sites other than dmv.ny.gov use the `.example` domain.

## 0. What the code does today (mapped 2026-10-08)

- `Features/Work/WorkView.swift`: the list reads `store.allWork` (the `work_list` tool,
  `ProductStore.swift:1463` and `:1473`). A row (`WorkListRow`, lines 284 to 311) shows the
  title, `standingLine` (`WorkState.swift:295` to `:308`), the area name, and a `StateChip`. The
  groups follow `WorkState.order`. The list refreshes on pull and on bootstrap only. Nothing in
  the row says that a run works, which step it is on, or what is new.
- `Features/Work/WorkThreadModel.swift`: `followOpenRun()` polls `GET /runs` every 3 s only
  while a run is open or a turn streams. The poll stops when the view goes. The model is
  `@State` in `WorkThreadView`, so Back deallocates it, and `AssistantChatModel.stop()` cancels
  the stream task.
- `WorkThreadView.swift`: `@State private var draft` dies with the view. A draft is lost on Back.
- `AssistantComposer.swift`: the stop control calls `model.stop()`, which cancels the local task
  only (`AssistantChatModel.swift:401`). The server reply continues until the brief's change.
- `Core/Models/WorkThreadStore.swift`: `steer(_:note:transport:)` exists and no view calls it.
  Every message goes to the chat model through `WorkThreadModel.send`.
- `Features/Today/ReadyForYouSection.swift`: polls `GET /api/albatross/handoffs` every 20 s
  while the Brief is on screen. Its row shows a mini `ProgressView` for an open run, the
  headline, and one line (`StepRunCopy.readyRowLine`).
- `Core/Notifications/NotificationCoordinator.swift`: the `checkIn` and `mail` categories already
  use `UNTextInputNotificationAction` ("Reply", "Send"). A `work_question` push opens the thread
  through the deep link (`NavigationModel.swift:523` to `:528`).
- `Features/Shell/AppShellView.swift`: on regular width the shell is a `NavigationSplitView`
  with `SourceList` in the sidebar and `destinationStack` in the detail column.
- `RevealDot` (`Features/Assistant/RevealedMarkdownView.swift:172`): a 6 pt accent dot that
  breathes between 0.35 and 1.0 opacity, static under Reduce Motion.

## 1. Research findings

### 1.1 T3 Code (the owner's reference)

T3 Code is an open-source coding-agent app (`github.com/pingdotgg/t3code`, 26,249 stars on
2026-10-08). Its sidebar thread list is the owner's reference for "a status preview".

| Source | What it does | Decision it drives |
|---|---|---|
| [`apps/web/src/components/Sidebar.logic.ts`](https://github.com/pingdotgg/t3code/blob/main/apps/web/src/components/Sidebar.logic.ts), `resolveThreadStatusPill` | One pill for each row, by precedence: Pending Approval (5) > Awaiting Input (4) > Working or Connecting (3) > Waiting (2.5) > Plan Ready (2) > Completed (1). Only Working and Connecting pulse. A row with nothing to say shows no pill. | One status word for each row, in the contract's order: needs you first, then in progress, then the rest. Only the live states move. An idle row shows no status word (section 2.2). |
| Same file, `hasUnseenCompletion` and `resolveThreadLastVisitedAt` | "Completed" shows only when `latestRun.completedAt > lastVisitedAt`. The visited watermark comes from the server when the server tracks visits, so every device agrees. | Unread is `lastActivityAt > seenAt` on the server, as the contract says. The client clears it at once and posts `seen`; another device sees the same result (section 2.8). |
| Same file, `resolveSidebarRowAccessibility` | The row's accessible label is the title, then the status label, then the project. The title leads because users scan by title. | The VoiceOver label of a row is the title, the status word, the preview, the time, the area, then "Unread" (section 9). |
| Same file, `SidebarSection` ("pinned", "active", "working", "snoozed", "settled") | A "Working" shelf (beta) follows live status. It is neither a drag source nor a drop target, because the live state owns it. | The "In progress" section follows live status only. The user does not arrange it (section 2.4). |
| [PR #701](https://github.com/pingdotgg/t3code/pull/701) "Show Awaiting Input sidebar status" | Added "Awaiting Input" as a first-class pill and extracted the precedence into a pure, tested module. | `ThreadRowPresentation` is a pure file with the words, the sort, and the dot rules, with unit tests (section 8). |
| [PR #919](https://github.com/pingdotgg/t3code/pull/919) "Use live thread activities for sidebar status pills" | A memoized map went stale, so a thread showed Working while it waited for input. The fix derives the pill from live data at render time. | The row derives its state from the poll result alone. No per-row cache of status in the client (section 2.7). |
| [PR #1517](https://github.com/pingdotgg/t3code/pull/1517) "Show hidden thread status in sidebar" | A compact dot next to "Show more" carries the highest-priority status of the hidden rows. | "Show finished" never hides a row that needs you or runs. Those rows always sort into the open sections (section 2.4). |
| [Issue #877](https://github.com/pingdotgg/t3code/issues/877) | "A thread that is actively awaiting an answer is meaningfully different from one that is currently working or already completed." | "Needs your answer" is its own word and its own section, not a variant of "In progress". |
| [Issue #4952](https://github.com/pingdotgg/t3code/issues/4952) "Mobile thread list never shows Done" | Mobile lacked the "Done" overlay, so finished background work was easy to miss. | The iOS row shows "Done" with the unread mark the moment a run ends, and keeps the mark until the thread opens (section 2.2, T2). |
| [Discussion #14557](https://github.com/pingdotgg/t3code/discussions/14557) "Let agents set a short status line" | Asks for one muted line under the title that says where the thread is now, separate from the title, cleared when the thread settles. | The preview line is the contract's `statusLine` or `logLine`, never the title. It changes with the status and never sticks (section 2.2). |
| [`apps/mobile/src/widgets/AgentActivity.tsx`](https://github.com/pingdotgg/t3code/blob/main/apps/mobile/src/widgets/AgentActivity.tsx) | A Live Activity lists agents attention-first (needs input, failed, in flight, done). Past the stale date every in-flight row degrades to "Out of date" instead of a false "working". | The Live Activity is worth a PR of its own and this ordering is its shape. Not in this PR (section 6.3). |
| [`apps/mobile/src/features/threads/floating-working-status.ts`](https://github.com/pingdotgg/t3code/blob/main/apps/mobile/src/features/threads/floating-working-status.ts) | One floating pill in the thread changes its label in place: working with a start time, syncing, background work, connection. | The thread shows one quiet "Reply in progress" row at the bottom while a reply runs on the server, not a second pill (section 5.5). |
| [`apps/mobile/src/features/home/thread-swipe-actions.tsx`](https://github.com/pingdotgg/t3code/blob/main/apps/mobile/src/features/home/thread-swipe-actions.tsx) | At most two swipe actions of 58 pt each, a secondary tone for the non-destructive one, red only for Delete. Swipes are disabled while the list scrolls. | Two swipe actions at most. "Stop" is grey, not red. No full swipe (section 3.1). |

### 1.2 Mobbin screens (iOS)

Each row names the screen, what it does, what the design takes, and what it rejects.

| Screen | What it does | Taken | Rejected |
|---|---|---|---|
| [ChatGPT, Codex list, "Awaiting approval"](https://mobbin.com/screens/a1597bd2-c221-4647-b33a-42b0710dcd31) | A task row carries one green pill "Awaiting approval" at the trailing edge. | One state for each row, as words. | A coloured pill. Our word sits in the preview line in plain text; the dot carries the colour. |
| [ChatGPT, Codex list, spinner](https://mobbin.com/screens/b40da078-1e7a-469d-8a37-ac35c88e7aff) | A task that works shows a small spinner at the trailing edge and nothing else. | A live row needs motion. | A spinner. It says nothing about progress. We show the newest log line, and the `RevealDot` breathes. |
| [ChatGPT, research run](https://mobbin.com/screens/331e907c-fbaf-4b99-9140-6872d64839a9) | A plan card with checks, a one-line "Citing global and regional fertility trends…" status, a thin progress bar, and a stop control. | The one-line newest action as the live preview. | The progress bar. A run has no known length. |
| [ChatGPT, research stopped](https://mobbin.com/screens/d046e8d0-2f88-4f1a-a222-b8fd57d5917e) | A stopped run collapses to one line, "Research stopped". | "Stopped" as a quiet one-line state in the list. | Nothing. |
| [Slack, home](https://mobbin.com/screens/69a3f86a-b226-4d7e-b19b-6548dcb9a07d) | Tiles "Catch up · 2 new", "Huddles · 1 live". An "Unread DMs" section with count badges. | The idea of a count where the list is entered (the drawer row, section 6.2). | Count badges on rows. One row is one thread; a count adds nothing. |
| [Slack, direct messages](https://mobbin.com/screens/e077f262-c4f7-4ea6-ae23-2c96c8e25f90) | Unread rows are semibold with a count badge; "4m ago" at the trailing edge. | Semibold title as the unread mark. The time at the trailing edge. | The badge. The relative "4m ago" form; we use the clock time, so a stalled run reads as stalled (section 2.2). |
| [Slack, catch up](https://mobbin.com/screens/6cef9775-2f4a-413d-8a1e-0b0ef6f0e6cd) | "Keep unread" and "Mark as read" as two bottom buttons. | "Mark as unread" is a real need. | The buttons. Marking unread needs a contract change; it goes to the open questions (section 11). |
| [Lex, messages](https://mobbin.com/screens/35c40271-6d4c-4d71-90bb-e5645dc1ef78) | A small red dot before the avatar marks unread. | A leading dot slot of fixed width, so titles align. | Red. Our dot colours mean a state, not an alarm. |
| [Substack, chat list](https://mobbin.com/screens/351d6663-2d8a-4998-b188-1787731375c2) | An orange leading dot on unread rows, the preview in secondary, the date at the trailing edge. | The three-part row: dot, title and preview, time. | Nothing. |
| [Clubhouse, messages](https://mobbin.com/screens/90e00c59-ba63-4810-8e49-74dad4c0de9a) | A blue leading dot, and the unread preview is bold too. | Nothing. | Bold preview. The title is the unread mark; the preview stays regular so the status word reads calm. |
| [XChat, chat list](https://mobbin.com/screens/25ec665f-8d22-42a6-81c2-49315f75a565) | The unread dot sits under the time at the trailing edge. | Nothing. | A trailing dot. The leading slot is the one indicator (section 2.1). |
| [Linear, inbox](https://mobbin.com/screens/58a6ef8a-408a-4ce7-90d5-08033f7c5a47) | A blue dot before the title, a two-line preview in secondary, "now" and "17m ago" at the end. | A dot before the title and a two-line preview. | Nothing. |
| [Linear, inbox filter](https://mobbin.com/screens/f688fc71-2060-49c2-be67-bc6ab5e53bee) | A menu: "Show snoozed", "Show read", "Show unread first", "Show badge count", "Mark all as read". | Nothing for this PR. | A filter menu. Four text pills already exist on the list; a fifth control is noise. |
| [Linear, snoozed toast](https://mobbin.com/screens/3d9ccfd8-2425-49e9-a00b-27189140d3a3) | A dark toast "Notification snoozed" with "Undo". | The shape of the quiet confirmation after a list action. | A floating toast. Our receipt goes into the row's own preview line ("Sent to the run: …", section 3.3). |
| [Manus, parallel subtasks](https://mobbin.com/screens/349a056c-9781-458c-a31e-22863eb4df7f) | "Wide Research · 35 / 50" with check rows for finished subtasks. | Nothing. | A counter of parallel work. Each thread is its own row. |
| [Jira, work list](https://mobbin.com/screens/f206f339-e758-44fe-828e-a5c8644da613) | Rows with "TO DO", "DONE", "IN PROGRESS" chips. | Nothing. | ALL-CAPS chips. Our words are sentence case, inline. |
| [Notion Mail, swipe settings](https://mobbin.com/screens/991c9208-8165-4f58-b43d-735cdd52865a) | Two actions each side, colour coded, with icons. | Two actions at most on one side. | Icons on swipe buttons. Ours are text only. |
| [TextNow, blocked](https://mobbin.com/screens/4bb415b1-2a89-4c97-b713-f058f7e62e72) | A single text-only swipe action, "Unblock", red. | A text-only swipe button. | Red for a non-destructive verb. |
| [Grab Driver, add a quick reply](https://mobbin.com/screens/b391a3f5-1ec1-4cde-a62a-cb8598848776) | A half sheet: a title, one field, one full-width "Save", the keyboard up at once. | The one-field sheet with focus at once. | The full-width primary. Ours is "Send" in the sheet's bar, as every sheet in the app. |
| [Bumble, write a note](https://mobbin.com/screens/1c4a9679-bac7-4772-b06b-d44e72ab1ca9) | A sheet "Write a note to Tia" with a small context card ("Send a reply · To their photo") above the field. | The context above the field: the step and the newest log line, so the user knows what they steer (section 3.3). | The character counter. The cap is 2,000; a counter is noise. |
| [NYT Cooking, reply](https://mobbin.com/screens/7e2fdd79-0513-4f05-8350-186a0345047d) | Cancel on the leading edge, the title in the middle, the field below, "Post Reply" as a button. | Cancel leading. | A second submit control. One "Send" in the bar. |
| [Airbnb, send a message](https://mobbin.com/screens/8a9a4bf6-5142-4b62-80b3-e3e915e2fb55) | A one-line "why" under the sheet title, a tall field, a disabled primary until text exists. | "Send" stays disabled until the field has text. | The tall field. One to four lines. |
| [Future Pro, Live Activity](https://mobbin.com/screens/6053e355-c9b4-46be-b92e-c728d74a29f6) | A lock-screen banner with the exercise name, a progress bar, "14 MIN LEFT". | The banner shape for a later Live Activity PR. | A progress bar and ALL-CAPS. |
| [Oura, Live Activity](https://mobbin.com/screens/1e3c0935-bc5d-447e-b230-e25ae8f3c398) | One title, one number, one zone meter. | The restraint: one line and one number. | The meter. |
| [Granola, Dynamic Island](https://mobbin.com/screens/95fba3d5-1eac-4cd5-a356-6b3085529248) | A compact island with a logo and an elapsed time. | The elapsed time as the compact form. | Nothing. |
| [Claude, chats](https://mobbin.com/screens/7b603fb2-8d36-4c05-bad5-9185eadebfaf) | A menu from the list title: "All chats", "Starred". | Nothing. | A title menu. Our principal button already opens the plan; a second menu in the bar makes the bar ambiguous (section 4.1). |
| [Fabric, chat history](https://mobbin.com/screens/4dc51624-ca7a-486d-a79f-27055550d143) | A drawer over the chat lists recent chats. | Nothing. | A drawer over the thread. The list behind Back is one tap away and already live. |
| [Bumble, top toast](https://mobbin.com/screens/08068293-77c6-4ba2-908a-610e0671aa93) | A yellow top toast with a check and two lines, over the chat. | The in-app banner at the top of the thread for "another Albatross needs you" (section 6.1). | The icon, the colour. Ours is an elevated paper card with one line and "Open". |
| [inDrive, new messages](https://mobbin.com/screens/d1f18a3e-17a6-443d-868f-8317dc18a71d) | A "New messages" divider inside the chat where the unread part begins. | A quiet "New" divider above the first unseen item when a thread opens with unread activity (section 7, T2). | Nothing. |

### 1.3 Apple guidance

- [HIG, Lists and tables](https://developer.apple.com/design/human-interface-guidelines/lists-and-tables):
  keep item text succinct; give feedback on selection; a list that navigates a hierarchy
  persistently highlights the selected row. Decision: the preview is one to two lines; on iPad
  the open thread's row stays highlighted in the sidebar.
- [HIG, Context menus](https://developer.apple.com/design/human-interface-guidelines/context-menus):
  hide unavailable items, do not dim them; destructive items last and marked; make every
  context-menu item available in the main interface too; aim for a small number of items.
  Decision: the row menu shows only the verbs that apply to that status; "Archive…" is last and
  destructive; every verb also exists in the thread.
- [HIG, Sheets](https://developer.apple.com/design/human-interface-guidelines/sheets): Cancel
  on the leading edge, Done on the trailing edge; show one sheet at a time; a nonmodal sheet
  when the parent must stay usable. Decision: the quick-steer sheet is modal with a medium
  detent, Cancel leading and Send trailing; the answer sheet is large; the list never stacks
  sheets.
- [HIG, Live Activities](https://developer.apple.com/design/human-interface-guidelines/live-activities):
  for tasks with a defined beginning and end, under eight hours; glanceable; no sensitive
  content on the Lock Screen; a tap opens the app. Decision: a Live Activity fits a run (15
  minutes, $5 cap) and needs a widget extension target and push updates; it is a later PR
  (section 6.3).
- [HIG, Sidebars](https://developer.apple.com/design/human-interface-guidelines/sidebars): use
  `NavigationSplitView` to present a sidebar; at most two levels of hierarchy; let people hide
  it. Decision: on iPad the Albatross list is a column beside the thread (section 4.2).
- [SwiftUI, NavigationSplitView](https://developer.apple.com/documentation/swiftui/navigationsplitview):
  with narrow sizes the split view collapses its columns into a stack. The shell already is a
  `NavigationSplitView`; a second one in the detail column is not a supported layout. Decision:
  the iPad two-column Work layout is a custom `ThreadsSplitView` (section 4.2, open question 6).
- [SwiftUI, swipeActions](https://developer.apple.com/documentation/swiftui/view/swipeactions(edge:allowsfullswipe:content:)):
  actions appear in the order listed from the originating edge; a full swipe performs the first
  action by default; `allowsFullSwipe: false` opts out. Decision: no full swipe on any row. A
  full swipe must never stop a run or send a note by accident.

## 2. The list behind Back

### 2.1 The row

The row keeps today's card group (`secondarySystemGroupedBackground` on the shell today; the
`elevatedColor` of `Surface.swift` after this PR) and today's serif section rule. The content
changes.

```
[dot] Title (one line, tail)                              time
      Status word · preview (one to two lines)        area
      newest log line (in progress only, one line)
```

- The dot slot: a fixed 10 pt column before the title, so titles align with and without a dot.
  The dot is 7 pt (`@ScaledMetric`). It is the one indicator of the row. Its colour and motion
  say the state (section 2.2).
- The title: `.subheadline`. Semibold when the row is unread, regular when seen. The weight is
  the unread mark. No second mark.
- The status word: the first words of line 2, in `.caption` secondary, followed by " · " and the
  preview. An idle row has no status word; line 2 is the preview alone.
- The preview: `.caption` secondary, at most two lines, tail truncation.
- The log line: in progress only. `.caption2` tertiary, one line, tail truncation. It changes
  with every poll. It is the "live" part of the row.
- The time: `.caption2` tertiary, monospaced digits, at the trailing edge of line 1. Today
  "9:41"; yesterday "Yesterday"; this week "Mon"; else "Oct 6". The time is `lastActivityAt`.
  A run that stalls shows an old time while the clock moves. That is the honest signal.
- The area: `.caption2` tertiary, under the time, right-aligned. Hidden inside an Area, where
  it repeats the title bar.
- The whole row is one button (`openWork`). The row has `contextMenu` and `swipeActions`
  (section 3).

### 2.2 Status words and preview lines

The contract's `status` is one of `answering | in_progress | starts_soon | needs_answer |
ready_for_you | your_turn | done | did_not_finish | stopped | idle`. The row shows the
server's `statusLine` when it is present. The table gives the word, the dot, the client
fallback when `statusLine` is empty, and the line the server should send.

| `status` | Dot | Word | Line 2 (client) | Recommended server `statusLine` |
|---|---|---|---|---|
| `needs_answer` | steady, accent | Needs your answer | `statusLine`, else "One question waits for you." | The form title: "Which renewal term do you want?" |
| `your_turn` | steady, accent | Your turn | `statusLine`, else "Albatross waits for you on the page." | `next.detail`: "Sign in to dmv.ny.gov in the page, then press Continue." |
| `ready_for_you` | steady, accent | Ready for you | `statusLine`, else "Albatross has something for you." | `next.detail` or the summary: "Everything is filled in. Check it and pay the $35." |
| `in_progress` | breathes, accent-2 | In progress | "In progress · {stepTitle}", then line 3 = `logLine`, else "Albatross works on this step." | Not used; the row builds it from `stepTitle` and `logLine`. |
| `answering` | breathes, accent-2 | Reply in progress | `statusLine`, else "Albatross writes a reply." | "Reply to: {the first 60 characters of your message}" |
| `starts_soon` | steady, accent-2 | Starts soon | "Starts soon · {stepTitle}" | Not used. |
| `done` | none | Done | `statusLine`, else "Done." | The proof line: "Verified on the page · Renewed to March 2027" |
| `did_not_finish` | none | Did not finish | `statusLine`, else "Albatross could not finish this run." | The error in plain words: "The page did not load after three tries." |
| `stopped` | none | Stopped | `statusLine`, else "Stopped." | "Albatross stopped at its time limit." or "Stopped by you." |
| `idle` | none | none | Today's `standingLine`: "Next: {nextStep}", "Albatross is carrying this", "Waiting on somebody else", "You stopped this on purpose". | Not used. |

Notes on the words:

- "Reply in progress" is this note's proposal for the brief's "Answering". It has no -ing verb,
  it pairs with "In progress", and it says what runs (a reply, not a step). The owner accepted
  "Answering"; the lead decides (open question 1).
- "Stopped by you" needs a signal the enum lacks. The server's `statusLine` carries it
  (open question 2).
- The unread mark is independent of the status. An unread `done` row shows a steady primary
  dot, because an unread row with no state dot still needs the slot filled. A row that is both
  unread and needs you shows the accent dot and the semibold title.

The dot, in full:

| Row | Dot |
|---|---|
| `in_progress`, `answering` | accent-2, breathes (the `RevealDot` rule: 0.35 to 1.0 opacity, 0.85 to 1.0 scale) |
| `starts_soon` | accent-2, steady. Nothing moves yet, so the dot does not move. |
| `needs_answer`, `your_turn`, `ready_for_you` | accent, steady |
| any other status, unread | primary (label colour), steady |
| any other status, seen | none |

Accent is the user's colour and accent-2 is Albatross's colour, as the page sheet already says
(PR 1 note, section 2.7).

### 2.3 Reduced motion

With Reduce Motion on, every dot is steady. The words carry the state. Row moves between
sections use a crossfade, not a slide. The `RevealDot` already does this.

### 2.4 Sort and grouping

Sections, in order, with the serif rule and the hint under it:

1. "Needs you" — "Albatross cannot move these without you." Rows with `needsYou`
   (`needs_answer`, `your_turn`, `ready_for_you`, and today's `unresolved` state). The rule is
   the accent colour, as today. Sorted by `lastActivityAt`, newest first.
2. "In progress" — "Albatross works on these now." Rows with `in_progress`, `answering`,
   `starts_soon`. Hairline rule. Sorted by `lastActivityAt`, newest first. `starts_soon` rows
   sort last inside the section.
3. "Open" — "Nothing waits on you here." Every other row that is not closed and not on the
   Later shelf. Sorted by `lastActivityAt`, newest first. This section replaces today's
   `WorkState` groups "In progress", "Waiting", "Still asking", and "Paused". The old
   `standingLine` still says "Waiting on somebody else" or "You stopped this on purpose" in the
   row, so the information stays.
4. The Later shelf, unchanged.
5. The finished rows (done, put down, archived) behind "Show finished", unchanged. A row that
   needs you or runs never sits behind "Show finished", whatever its `workState`.

A row moves between sections when its status changes. The move animates with a crossfade
(0.2 s). While the user's finger is on the list, moves wait until the scroll rests, so a row
does not jump from under the finger. The list keeps its scroll offset across polls.

### 2.5 Filter

The pill row gains one pill: "Everything", "Needs you", "In progress", "No area yet" (the last
one only when an unhomed row exists, as today). "In progress" shows the rows of section 2 only.
The pills are glass capsules as today; text only. T12 is a web and Mac story; this is the iOS
form of it, and it costs one case in `WorkFilter`.

### 2.6 Empty states

- No rows at all: today's `ContentUnavailableView` and copy stay.
- "Needs you" with no rows: "Nothing needs you now." with the description "Albatross has the
  rest." and the button "Everything".
- "In progress" with no rows: "Nothing runs now." with the description "Press Handle it in an
  Albatross to start a run." and the button "Everything".
- Only finished rows: today's "Nothing open. Everything here is finished." stays.
- The threads read failed and the list has cached rows: today's `WorkRefreshWarning` line
  "Showing what was saved — couldn't refresh." with "Retry". Live fields go stale; the dots
  stop and the words stay. No row shows a false "In progress" for more than one missed poll:
  after two failed polls in a row, live rows change their word to "In progress · last seen
  9:41" (open question 8).

### 2.7 Live updates and pull to refresh

- One app-level `ThreadsStore` owns `GET /api/albatross/threads`. It polls every 5 s while the
  list is on screen and at least one row is live (`in_progress`, `answering`, `starts_soon`),
  else every 30 s while the app is active. It stops in the background and reads at once on
  `scenePhase == .active`, on Back from a thread, after every list action (steer, stop,
  answer), and on pull.
- The rows are `store.allWork` (the `work_list` read, which still owns the horizon, the shape,
  and the Later shelf) overlaid by the threads rows on `workId`. A Work with no threads row is
  `idle`. One struct, `ThreadListRow`, carries both.
- A revision counter drops a slow read that lands after a newer one, as `ReadyForYouStore`
  does.
- Pull to refresh runs both reads and waits for both.
- The row derives its words from the newest poll result every time. No per-row cache (T3 Code
  PR #919).

### 2.8 Seen

- The thread posts `POST /api/albatross/threads/seen { workId }` when it opens, and again
  (debounced to 1 s) whenever the threads row for that Work flips to `unread` while the thread
  is on screen. The client clears `unread` locally at once.
- Another device that has the thread open clears the same mark, because `seenAt` is on the
  server. The two devices agree on the next poll.
- The list never posts `seen`. A glance at the list is not a read.

## 3. Actions from the list (T10)

### 3.1 Swipe actions

Trailing edge only. Text-only buttons. `allowsFullSwipe: false`. At most two. Buttons are
listed from the edge inward.

| `status` | Buttons (edge first) | Tints |
|---|---|---|
| `needs_answer` | Answer | accent |
| `your_turn` | Open the page | accent |
| `ready_for_you` | none (the row opens the thread) | |
| `in_progress` | Steer, Stop | accent-2, grey |
| `answering` | Stop | grey |
| `starts_soon` | Stop | grey |
| `did_not_finish` | Try again | accent-2 |
| `stopped` | Continue | accent-2 |
| `done`, `idle` | none | |

- "Answer" opens the answer sheet (3.4). "Steer" opens the quick-steer sheet (3.3). "Stop"
  posts `cancel` for `latestRunId` (`starts_soon` and `in_progress`) or `POST /api/agent/stop`
  (`answering`) at once, with a light haptic; the row changes to "Stopped by you." on the next
  poll and the button leaves. No confirmation: a stopped run offers "Continue", so a wrong Stop
  costs one tap.
- "Try again" posts `start` for the step. "Continue" posts `resume` for `latestRunId`. Both
  change the row to "Starts soon" at once.
- "Open the page" calls `openWork(id:title:intent: .openPage)`.
- Grey is `Color.secondary`; it reads as a calm control, not an alarm. Red stays for
  "Archive…" in the menu.

### 3.2 Context menu

A long press shows only the verbs that apply (HIG: hide, do not dim). Items in order, then a
divider, then the Work verbs:

| `status` | Verbs |
|---|---|
| `needs_answer` | Answer…, Dismiss |
| `your_turn` | Open the page, Dismiss |
| `ready_for_you` | Open, Dismiss |
| `in_progress` | Steer…, Stop and redirect…, Stop |
| `answering` | Stop the reply |
| `starts_soon` | Stop |
| `did_not_finish` | Try again |
| `stopped` | Continue |
| every row | Copy the title, divider, "Put it down" (or "Pick it up"), "Set horizon…", divider, "Archive…" (destructive) |

"Dismiss" closes the handoff on the server, as the Brief's row does. "Stop and redirect…"
opens the quick-steer sheet in its redirect mode (3.3). Each verb has the same words in the
thread.

### 3.3 The quick-steer sheet

A `NavigationStack` sheet, detents `[.medium]`, drag indicator visible. The field has focus
when the sheet appears, so the keyboard is up at once.

```
Cancel              Pay the water bill                  Send
                    In progress · Pay the bill on the city site
  9:40  Typed your saved account number on springfield.example
  ┌────────────────────────────────────────────────────────┐
  │ Tell Albatross what to change                          │
  └────────────────────────────────────────────────────────┘
  Stop and redirect…
```

- The bar: "Cancel" leading, the Work title as the principal title with "In progress ·
  {stepTitle}" as the subtitle, "Send" trailing. "Send" is disabled until the field has text.
- Under the bar: the newest log line with its time, in the run log's row style
  (`StepRunLogView` with one line). It tells the user what they steer. If the row has no log
  line yet: "Albatross works on this step."
- The field: `TextField(axis: .vertical)`, one to four lines, 2,000 characters, placeholder
  "Tell Albatross what to change". The secret notice of the composer (`ComposerSecretNotice`)
  applies here too, with the same words.
- "Stop and redirect…": a quiet text button under the field. A tap turns the sheet into its
  redirect mode: the subtitle changes to "The run stops when you send. A new run starts with
  your note.", the trailing button reads "Stop and send", and the button under the field reads
  "Keep the run" (a tap goes back). The redirect mode also opens directly from the context menu.
- Send posts `{ action: 'steer', runId, note }` (or `redirect`). The sheet closes on success.
  The thread also keeps the note as a user message with `metadata.steer = { runId }`, as the
  contract says; the server writes that message, not the sheet.
- After send, the row's line 3 reads "Sent to the run: {note}" (one line, tail) until a newer
  log line arrives. The log line "Read your note: …" then takes its place.
- Errors stay in the sheet, under the field, in red `.footnote`: "Could not send. Try again."
  (network); "The run ended. Open the Albatross to continue." with an "Open" button (the server
  says the run is closed); "This run has its 10 notes. Stop and redirect to say more." (the
  cap), with the redirect mode offered.
- VoiceOver: the sheet announces "Steer Pay the water bill. In progress, Pay the bill on the
  city site." on open.

### 3.4 The answer sheet

A `NavigationStack` sheet, detents `[.large]`.

- The bar: "Cancel" leading, the Work title principal with the subtitle "Needs your answer",
  "Open" trailing (opens the thread and closes the sheet).
- The body: the PR 1 `FormQuestionCard` for the pending question, `allowsSkip: false`, inside a
  scroll view with the paper background. The sheet reads the runs of the Work
  (`WorkThreadStore.load`) and takes the question with `pendingQuestionId`. While it reads:
  "Loading the question…" with a small `ProgressView`.
- A submit posts the form answer (`WorkThreadStore.answer`). On success the sheet closes, the
  row changes to "Starts soon" at once, and the next poll changes it to "In progress".
- Field errors render in the card as in the thread. A send error stays under the card.
- If the question is no longer pending (answered on another device, or dismissed): "Answered
  on another device." or "This question was dismissed." with a "Close" button.
- An `allow_secure` handoff is not a question. Its row has no "Answer"; the row's swipe is
  "Open" and the identity check happens in the thread, as PR 2 decided.

### 3.5 What a list action never does

- It never opens the thread by itself. The user chose the list; the list keeps the user.
- It never posts `seen`. An answer from the list is an answer, not a read of the thread.

## 4. Hop (T4)

### 4.1 iPhone

Back is the hop. The list behind Back is live, keeps its scroll offset, and shows what every
thread does. One tap back, one tap in. Three things make this fast enough, and the note rejects
two faster forms.

What this PR adds:

1. **Thread models stay alive.** `AppEnvironment` keeps the last three `WorkThreadModel`s in a
   small cache keyed by `workId` (T3 Code prewarms three sidebar rows for the same reason). Back
   does not deallocate the model, so a return shows the thread at once with its scroll position,
   and a stream in flight on this device keeps its task. The fourth thread evicts the oldest;
   the server save (T5) still guarantees the reply.
2. **Drafts stay with their thread.** A `ComposerDraftStore` keeps the draft text and the
   pending files for each `workId` in memory only. A draft can hold a password or an ID number,
   so it never goes to `UserDefaults` or disk; a relaunch or sign-out drops it (lead decision
   4). `WorkThreadView` reads it on appear and writes it on every change. A sent message clears
   it.
   The quick-steer sheet does not keep a draft; it is one line.
3. **The banner.** When another thread needs you while you read this one, a one-line banner
   offers "Open" (section 6.1). That is the one hop that must not cost two taps.

Rejected:

- A thread switcher from the navigation title. The principal button already opens the plan
  sheet on tap (PR 1 note, section 2.2). A menu on the same title makes one control do two
  things; a chevron glyph before or after the title adds chrome. The Claude app's title menu
  filters a list; it does not switch between items.
- A horizontal swipe between threads. The leading-edge swipe is Back, the trailing edge belongs
  to the list rows, and the page sheet lives on top of the thread. A thread order to swipe
  through also changes under the user as rows move between sections.
- A long press on Back. iOS shows the system stack menu there, and the design keeps it.

### 4.2 iPad

On regular width, the Work column of the shell becomes a two-column `ThreadsSplitView`:
the Albatross list in a 320 pt column on the leading side and the open thread on the trailing
side. The shell's own `NavigationSplitView` keeps the drawer; a nested `NavigationSplitView` in
the detail column is not a supported layout (section 1.3), so this is a custom `HStack` with a
hairline between the columns.

- The list column is the same `WorkView` body with the same rows, pills, sections, swipe
  actions, and menus. The open thread's row carries the selected fill (`accentSoftColor`) and
  stays highlighted (HIG, lists). A tap on another row replaces the thread column.
- The list stays live in the column with the 5 s cadence while a row is live (T4).
- The thread column hosts `WorkThreadView` as it is. Its Back button hides; the column shows
  the principal title and the menu only.
- When nothing is open: the column shows "Choose an Albatross" in `.title3` secondary, centred.
- Below 700 pt of Work-column width (portrait with the drawer open, Slide Over, Stage Manager
  small windows) the split collapses to the iPhone stack with Back.
- The banner of section 6.1 does not show on iPad when the list column is on screen; the
  list already shows the change.
- Keyboard: ⌘↑ and ⌘↓ move the selection in the list column when a hardware keyboard is
  attached, as T3 asks for the Mac. The Mac designer owns the exact keys.

## 5. Steer in the thread (T5, T7 to T9, T11)

### 5.1 The composer while a run works (T7)

The route chip (`RouteChip`) gains a third route, "Run", with the accent-2 tint. While
`openRun != nil`:

- The chip reads "Run" by default, and the placeholder reads "Tell Albatross what to change"
  (PR 1 decision 11).
- Tab, or a tap on the chip, moves the route Run → Ask → Hold → Run. "Ask" sends to the chat model as
  today, with the placeholder "Ask Albatross a question". "Hold" makes new Work as today. A
  route the user chose stays pinned until the field clears, as today.
- Send with "Run" posts `{ action: 'steer', runId, note }` through `WorkThreadStore.steer`
  (the method exists). The message appears as a user bubble at once with `metadata.createdAt`
  and `metadata.steer = { runId }`. No chat turn runs. The composer's stop control does not
  appear, because nothing streams.
- When the run closes, the chip returns to "Ask" and the placeholder to the state's words.
- When the run has its 10 notes, the chip's "Run" route is unavailable: the placeholder reads
  "This run has its 10 notes. Stop and redirect to say more." and the chip reads "Ask".

This replaces PR 1's rule that every message goes to the chat agent, for the Run route only. A
written request that is not a steer note ("when is the court date?") still goes to the chat
model through "Ask".

### 5.2 Receipts under a sent note (T7)

A user bubble with `metadata.steer` gets one `.caption2` secondary line under it, right-aligned
under the bubble, `NoteReceiptView`:

| State | Line | Control |
|---|---|---|
| The post is in flight | (no line; the bubble is enough for under one second) | |
| Sent, the run has not read it | "Sent to the run" | |
| The run read it (`notes[].readAt` set) | "Read by Albatross · 9:41" | |
| The run ended before it read it, and a later run of the step read it | "Read by Albatross · 9:50" | |
| The run ended before it read it, and no run continues | "Not read: the run ended first" | "Send again" |
| The post failed | "Not sent. Check your connection." | "Send again" |
| A redirect note, sent | "Sent. The run restarts with this note." | |
| A redirect note, read | "Read by Albatross · 9:52" | |

- The run log still shows "Read your note: Use the Monday class" in the primary colour, as PR 1
  decided. The receipt and the log line say the same thing in two places on purpose: the
  receipt is next to what the user wrote, the log line is next to what Albatross did.
- The receipt matches a bubble to a note in `run.notes` by `runId` and `at`. The client sends
  `at` as the message's `createdAt`; the server stores that value as the note's `at` (open
  question 3).
- PR 1 decision 8 ("no extra sent-to-the-run line") is superseded by T7.
- VoiceOver reads the receipt after the bubble: "Use the Monday class. Read by Albatross,
  9:41."

### 5.3 A note that came too late, and "Send again" (T9)

- The contract carries an unread note to the next run of the step. So most late notes end as
  "Read by Albatross" under a later time, and the user does nothing.
- "Not read: the run ended first" appears only when the run is closed, the note has no
  `readAt`, and no later run of the step exists. The line stays. It is not an error colour; it
  is secondary text with one text button.
- "Send again" posts `steer` when a run of the step is open, else `{ action: 'start', stepKey,
  note }` to start the step with the note first. A new bubble appears with "Sent to the run";
  the old bubble keeps its line and loses its button.

### 5.4 Stop and redirect (T8)

- The open run block's button row becomes `[Stop and redirect] [Stop]`, both `.bordered`,
  "Stop" at the trailing edge as today.
- A tap on "Stop and redirect" arms the composer: a strip above the field (the same slot as
  the secret notice) reads "Stop and redirect: the run stops when you send." with "Cancel" at
  its trailing edge. The chip reads "Run" and cannot flip. The field gets focus. The send
  control's tint is accent-2.
- Send posts `{ action: 'redirect', runId, note }`. The strip leaves. The old block changes to
  "Stopped by you" with its summary. A new block appears, "Starts soon" then "In progress",
  with "Read your note: …" as its first log line. The bubble's receipt reads "Sent. The run
  restarts with this note."
- "Cancel" in the strip disarms the composer and keeps the draft.
- The redirect is also in the quick-steer sheet (3.3) and the row's context menu (3.2).

### 5.5 The reply that keeps going (T5)

- With the server change, Back no longer aborts a reply. On this device the cached model keeps
  its stream while cached (4.1). When the model is evicted, the device's request ends and the
  server finishes alone.
- When the thread opens and the threads row says `answering`, the thread shows one quiet row at
  the bottom, above the composer, "Reply in progress" with a `RevealDot`. The composer works;
  "Ask" queues no second turn while a reply runs (the send control is disabled with the
  placeholder "Albatross writes a reply"), and "Run" still sends to an open run.
- The thread reloads the session when `answering` flips to false in the `ThreadsStore` poll,
  and once more on `scenePhase == .active`. The new reply appears in place of the quiet row.
  The list's row shows "Reply in progress" meanwhile, then the unread mark (T2).
- Re-attaching to a stream in progress is not in this PR (open question 9).

### 5.6 Stop a reply (T11)

- The composer's stop control calls `chat.stop()` as today and posts
  `POST /api/agent/stop { sessionId }`. The partial reply stays, with today's "Continue"
  control under it. The list row leaves `answering` on the next poll.
- The list's "Stop" on an `answering` row (3.1) posts the same route.

## 6. Background awareness

### 6.1 The banner in the thread

When the `ThreadsStore` poll shows that another Work entered `needs_answer`, `your_turn`, or
`ready_for_you` after this thread opened, and that row is unread, the thread shows a banner.

- Placement: `safeAreaInset(edge: .top)` under the navigation bar. An `elevatedColor` card
  (`surfaceCard`) with one line and one text button, 44 pt tall, 12 pt inset.
- Copy: "{title} · Needs your answer" (or "Your turn", "Ready for you") and "Open" at the
  trailing edge. Two or more: "2 Albatrosses need you" and "Show", which goes back to the list with
  the "Needs you" pill selected.
- The banner slides in from the top (0.25 s; a crossfade under Reduce Motion). It leaves after
  10 s, on "Open", or on a swipe up. A new one replaces it with a crossfade.
- The banner never shows for `done`, `did_not_finish`, or `stopped`. Those become the unread
  mark on the list. T3 Code's "Completed" is quiet for the same reason.
- The banner waits while a sheet is up and shows when the sheet closes.
- On iPad with the list column on screen, no banner (4.2).
- VoiceOver announces the line once (`PlatformAccessibility.announce`), not again for the same
  Work.

### 6.2 The count at the entrance

The drawer's "Albatrosses" row shows the count of rows that need you as a quiet number at its
trailing edge, in `.caption` secondary, no badge colour (as Slack's "2 new", without the tile).
It reads from the same `ThreadsStore`. The Mac designer may mirror it in the sidebar. If the
drawer row has no slot for a trailing number, this item waits (open question 10).

### 6.3 A Live Activity

Recommendation: worth it, and a PR of its own after this one ships.

- Why it fits: a run has a start and an end, lasts minutes, and the user leaves the app while
  it works (T5, T6). The HIG names this case. T3 Code built `AgentActivity` for the same
  reason, attention-first: needs you, failed, in progress, done; past the stale date every
  live row reads "Out of date".
- What it would show: compact "2 in progress" or "Needs you"; expanded, up to four rows with
  the title and the status word; a tap deep-links to `lab86://work?work=<id>`. No log lines on
  the Lock Screen (HIG: no sensitive content).
- Why not this PR: it needs a widget extension target in `project.yml` with its own
  provisioning and Xcode Cloud settings, `NSSupportsLiveActivities`, ActivityKit push tokens
  sent to the server, and a server job that pushes updates and ends the activity. None of that
  is UI, and none of it can be verified without a device. The status vocabulary of this PR is
  what the activity would render; it must land first.

## 7. Stories as iPhone screen states

Sample threads for this section: "Renew the car registration" (Household, dmv.ny.gov), "Pay
the water bill" (Household, springfield.example), "Plan the Lisbon trip" (Travel), "Book the
dentist for Sam Rivera" (Health), "Cancel the gym membership", "File the expense report"
(Work), "Return the library books", "Call the plumber about the leak".

### T1. A live list

- The user presses Back from "Pay the water bill". The list shows: section "Needs you" with
  "Renew the car registration" (accent dot, "Needs your answer · Which renewal term do you
  want?", "9:41", "Household") and "Book the dentist for Sam Rivera" (accent dot, "Your turn ·
  Sign in to brightsmile.example in the page, then press Continue.", "9:12", "Health").
- Section "In progress": "Pay the water bill" (accent-2 dot breathes, "In progress · Pay the
  bill on the city site", line 3 "Typed your saved account number on springfield.example",
  "9:40"); "Plan the Lisbon trip" (accent-2 dot breathes, "Reply in progress · Reply to: which
  week in November is free?", "9:39", "Travel"); "Cancel the gym membership" (accent-2 dot
  steady, "Starts soon · Find the cancellation form", "9:38").
- Section "Open": "File the expense report" (primary dot, semibold, "Done · Verified on the
  page · Report 4471 sent", "Yesterday", "Work"); "Return the library books" (no dot, "Did not
  finish · The page did not load after three tries.", "Mon"); "Call the plumber about the
  leak" (no dot, "Next: Call (555) 010-0137 before Friday", "Oct 2", "Household").
- Five seconds later the poll lands: the water bill's line 3 reads "Pressed Pay now on
  springfield.example" and its time reads "9:41". Nothing else moves.

### T2. Unread

- The expense report run ended while the user was in another thread. Its row shows the primary
  dot and the semibold title until the user opens it. The user opens it: the thread posts
  `seen`, the dot leaves, and the title turns regular on return.
- Inside the thread, a hairline divider "New" sits above the first item newer than `seenAt`,
  in the style of PR 1's "From an earlier chat" divider. The list opens at the bottom as
  always; the divider is there for a scroll up.
- A log line alone never makes a row unread; a handoff, a question, a finished reply, or an
  ended run does, as the contract says.

### T3. Hop (web and Mac)

- Not an iPhone story. On iPad the list column is the rail (4.2), and the open row carries the
  selected fill.

### T4. Hop (iPhone and iPad)

- iPhone: Back shows the list in its last scroll position, live. A tap on "Renew the car
  registration" opens it at once from the model cache. The composer shows the draft the user
  left there ("Use the two-year term"). Back, then "Pay the water bill": the same.
- iPad landscape: the list column at 320 pt, the thread beside it. A tap on another row replaces
  the thread; the row takes the selected fill. ⌘↓ moves to the next row.

### T5. Threads keep working

- In "Plan the Lisbon trip" the user writes "which week in November is free?" and presses Back
  at once. The row reads "Reply in progress · Reply to: which week in November is free?". The
  user opens "Pay the water bill".
- Forty seconds later the Lisbon row reads regular "Open" section, semibold title, primary dot,
  and the preview "Replied: The week of November 9 is free on your calendar." (the server's
  `statusLine` after a finished reply; fallback "Albatross replied.").
- The user opens the Lisbon thread: the reply is there. The quiet "Reply in progress" row never
  showed, because the reply was done.

### T6. Several runs at once

- The user presses "Handle it" in four threads. The list's "In progress" section shows four
  breathing rows, each with its own log line. The eleventh run's row reads "Starts soon · Find
  the cancellation form" with a steady accent-2 dot. When one run ends, that row's dot begins to
  breathe and line 2 reads "In progress · Find the cancellation form".

### T7. Steer directly

- In "Pay the water bill", the chip reads "Run". The user types "Use the checking account, not
  the card" and sends. The bubble appears; under it "Sent to the run". The run block's log
  gains "9:41 Read your note: Use the checking account, not the card" in the primary colour;
  the receipt changes to "Read by Albatross · 9:41".
- From the list: swipe the water bill row, "Steer", type the same line, "Send". The row's
  line 3 reads "Sent to the run: Use the checking account, not the card" until the next log
  line.

### T8. Stop and redirect

- The run opens the wrong page. The user presses "Stop and redirect" in the block. The strip
  "Stop and redirect: the run stops when you send." appears over the composer with "Cancel".
  The user types "Go back and choose the Saturday session" and sends.
- The old block reads "Stopped by you" with its summary. A new block reads "Starts soon", then
  "In progress", its first log line "Read your note: Go back and choose the Saturday session".
  The bubble's receipt reads "Sent. The run restarts with this note.", then "Read by Albatross
  · 9:52".

### T9. A note that came too late

- The user sends "Skip the paperless option" at 9:43. The run ends at 9:43 with "Your turn".
  The user presses "I paid" at 9:48; the new run reads the note first. The receipt reads "Read
  by Albatross · 9:48".
- Another case: the run fails at 9:43 and nothing continues. The receipt reads "Not read: the
  run ended first" with "Send again". A tap posts `start` for the step with the note; a new
  bubble reads "Sent to the run".

### T10. Answer and steer from the list

- Swipe "Renew the car registration": "Answer". The sheet shows the form "Which renewal term do
  you want?" with "1 year · $35" and "2 years · $70 · Recommended: Matches what you said". The
  user chooses and presses "Continue" in the card. The sheet closes; the row reads "Starts soon
  · Fill in the renewal form", then "In progress".
- Swipe "Pay the water bill": "Steer", "Stop". Long press: "Steer…", "Stop and redirect…",
  "Stop", "Copy the title", "Put it down", "Set horizon…", "Archive…".

### T11. Stop a reply

- In the Lisbon thread the reply streams. The user presses the composer's stop control. The
  partial reply stays with "Continue" under it. On Back the Lisbon row has left "In progress"
  and sits in "Open" with the preview "Reply stopped by you." (server `statusLine`; fallback
  "Stopped.").

### T12. Find a thread (web and Mac)

- iOS form: the "In progress" pill (2.5). Search comes later on every platform.

### State matrix: the row

| `status` | Dot (seen) | Dot (unread) | Title weight (unread) | Word | Line 3 | Swipe |
|---|---|---|---|---|---|---|
| `needs_answer` | accent, steady | accent, steady | semibold | Needs your answer | — | Answer |
| `your_turn` | accent, steady | accent, steady | semibold | Your turn | — | Open the page |
| `ready_for_you` | accent, steady | accent, steady | semibold | Ready for you | — | — |
| `in_progress` | accent-2, breathes | accent-2, breathes | semibold | In progress | log line | Steer, Stop |
| `answering` | accent-2, breathes | accent-2, breathes | semibold | Reply in progress | — | Stop |
| `starts_soon` | accent-2, steady | accent-2, steady | semibold | Starts soon | — | Stop |
| `done` | none | primary, steady | semibold | Done | — | — |
| `did_not_finish` | none | primary, steady | semibold | Did not finish | — | Try again |
| `stopped` | none | primary, steady | semibold | Stopped | — | Continue |
| `idle` | none | primary, steady | semibold | — | — | — |

Reduce Motion: every "breathes" becomes "steady". The threads read failed twice: every
"breathes" becomes "steady" and the word gains " · last seen {time}".

### State matrix: a sent note

| Note | Run open | `readAt` | A later run of the step | Receipt | Control |
|---|---|---|---|---|---|
| post in flight | — | — | — | (none) | — |
| post failed | — | — | — | Not sent. Check your connection. | Send again |
| sent | yes | nil | — | Sent to the run | — |
| sent | yes | set | — | Read by Albatross · {time} | — |
| sent | no | set | — | Read by Albatross · {time} | — |
| sent | no | nil | exists, read it | Read by Albatross · {later time} | — |
| sent | no | nil | exists, not yet | Sent to the run | — |
| sent | no | nil | none | Not read: the run ended first | Send again |
| redirect, sent | new run opens | nil | — | Sent. The run restarts with this note. | — |
| redirect, read | — | set | — | Read by Albatross · {time} | — |

## 8. Component inventory

### 8.1 New

| File | What it holds |
|---|---|
| `Core/Models/ThreadListModels.swift` | `ThreadRowStatus` (the ten cases, JSON init with the same tolerance as `StepRunModels`), `ThreadsRow` (the contract's row), `ThreadListRow` (`WorkListItem` plus `ThreadsRow?`), `ThreadNote` (`at`, `text`, `readAt`). |
| `Core/Models/ThreadsStore.swift` | `GET /api/albatross/threads` with the 5 s / 30 s cadence, the revision counter, `seen(workId:)`, `stop(row:)`, `steer(row:note:redirect:)`, `tryAgain(row:)`, `continueRun(row:)`, `needsYouCount`, `transitions(since:)` for the banner. |
| `Core/Models/ComposerDraftStore.swift` | The draft text and pending files for each `workId`, in memory only; sign-out clears them. |
| `Core/Models/WorkThreadModelCache.swift` | The three newest `WorkThreadModel`s by `workId`, on `AppEnvironment`. |
| `Features/Work/ThreadRowPresentation.swift` | Pure rules: the word, the preview, the dot, the time label, the section, the sort, the VoiceOver label, the swipe and menu verbs for each status. Unit tests cover every row of the matrices. |
| `Features/Work/ThreadListRow.swift` | The row view (section 2.1), with `swipeActions`, `contextMenu`, and `accessibilityCustomActions`. |
| `Features/Work/QuickSteerSheet.swift` | Section 3.3, with the redirect mode. `QuickSteerForm` is the body without the sheet chrome, for the Mac. |
| `Features/Work/AnswerSheet.swift` | Section 3.4. `AnswerSheetBody` for the Mac. |
| `Features/Work/NoteReceiptPresentation.swift` | The pure receipt rule of section 5.2 and its tests. |
| `Features/Work/NoteReceiptView.swift` | The line under a steer bubble with "Send again". |
| `Features/Work/RedirectStrip.swift` | The composer strip of section 5.4. |
| `Features/Work/NeedsYouBanner.swift` | Section 6.1. |
| `Features/Work/ThreadsSplitView.swift` | The iPad two-column layout of section 4.2. |
| `Lab86MailTests/ThreadRowPresentationTests.swift`, `ThreadsStoreTests.swift`, `NoteReceiptPresentationTests.swift`, `ComposerDraftStoreTests.swift`, `QuickSteerSheetTests.swift` | The tests. Rendering tests write PNGs to the evidence directory for the Native acceptance CI: the list in mixed states, a swiped row, the steer sheet, a note with each receipt, the banner. |

### 8.2 Changed

- `Features/Work/WorkView.swift`: sections from `ThreadRowPresentation` (2.4), `ThreadListRow`
  in place of `WorkListRow` and `StateChip`, the "In progress" pill, the empty states of 2.6,
  the `ThreadsStore` poll task, the sheets of section 3, and `ThreadsSplitView` on regular
  width.
- `Features/Work/WorkState.swift`: `WorkFilter.inProgress`; `WorkGrouping.group` takes the live
  status; the old "In progress", "Waiting", "Still asking", "Paused" groups merge into "Open".
- `Features/Work/AreaDetailView.swift`: its Work rows use `ThreadListRow` with the area hidden.
- `Features/Work/WorkThreadView.swift`: the draft from `ComposerDraftStore`, the model from the
  cache, `NeedsYouBanner`, `RedirectStrip`, the "Reply in progress" row, `seen` on open.
- `Features/Work/WorkThreadModel.swift`: `steer(note:)`, `redirect(note:)`, `stopReply()`, the
  `answering` follow (5.5), `armRedirect`, `notes` lookup for receipts.
- `Core/Models/WorkThreadStore.swift`: `steer` gets a caller; `redirect(_:note:)`; `ThreadRunView`
  reads `notes`.
- `Features/Work/RunBlockView.swift`: the `[Stop and redirect] [Stop]` row; `RunBlockActions.redirect`.
- `Features/Work/RunBlockPresentation.swift`: `RunBlockCopy.stopAndRedirect`, the strip words.
- `Features/Assistant/RouteChip.swift` and `AssistantChatModel.swift`: the `.run` route, the
  three-way order, the placeholder by route, `stop()` posts to the server, a local user message
  with `metadata.steer` and no turn, the "New" divider position from `seenAt`.
- `Features/Assistant/AssistantComposer.swift`: the strip slot takes `RedirectStrip`; the
  disabled send while a reply runs on the server.
- `Features/Assistant/AssistantMessageRow.swift`: shows `NoteReceiptView` under a steer bubble.
- `Features/Shell/NavigationModel.swift`: `openWork` from the banner; the iPad selection
  binding; `WorkRoute.Intent.needsYouFilter` for "Show".
- `App/AppEnvironment.swift`: `threads` (`ThreadsStore`), `composerDrafts`, `threadModels`.
- `Features/Today/ReadyForYouSection.swift`: unchanged in this PR (open question 7).
- `Lab86MailTests/Tour/`: new tour screens `work-list-live`, `work-list-swipe`,
  `work-steer-sheet`, `work-thread-receipts`, `work-thread-redirect`, `work-thread-banner`,
  and an iPad `work-split`.

### 8.3 What the macOS designer takes

Shared, platform-neutral:

- `ThreadListModels`, `ThreadsStore`, `ComposerDraftStore`, `WorkThreadModelCache`.
- `ThreadRowPresentation` (the words, the dot rules, the sort, the sections, the VoiceOver
  label, the verbs for each status). The Mac rail must not differ from these.
- `NoteReceiptPresentation` and `NoteReceiptView`.
- `QuickSteerForm`, `AnswerSheetBody`, `RedirectStrip`, the `.run` route of the composer, the
  "Reply in progress" row.
- The copy tables of sections 2.2, 3, 5, and 6, and the two state matrices.

iOS only: `ThreadListRow` as a swipe row, `QuickSteerSheet` and `AnswerSheet` as sheets,
`NeedsYouBanner`, `ThreadsSplitView`. The Mac has its rail (T3) with the same row content, a
hover fill, the context menu, ⌘↑/⌘↓, and the filter (T12); the Mac note decides those.

## 9. Accessibility and dark mode

- **VoiceOver, the row.** One element (`accessibilityElement(children: .combine)`), trait
  button. Label: "{title}. {word}. {preview}. {log line}. {time}. {area}. Unread." with absent
  parts dropped. Example: "Pay the water bill. In progress, Pay the bill on the city site.
  Typed your saved account number on springfield.example. 9:40. Household." The dot is
  `accessibilityHidden`. `accessibilityCustomActions` carry the same verbs as the swipe and the
  menu ("Answer", "Steer", "Stop", "Open the page", "Try again", "Continue", "Dismiss"), so a
  VoiceOver user never needs a swipe gesture.
- **Live rows.** The log line has `.updatesFrequently`, so VoiceOver does not re-read it on
  every poll. The list announces at most one line per 10 s, only for a row that entered "Needs
  you" while the list is on screen: "Renew the car registration needs your answer." Two or
  more in the window: "2 Albatrosses need you." Nothing for log lines, nothing for "Done".
- **The thread.** PR 1's one-announcement-per-state rule stays. A receipt change announces
  nothing; it is read with the bubble. The banner announces once.
- **Dynamic Type.** The row stacks at accessibility sizes: dot and title, then the word and
  preview, then the log line, then time and area on one line, left-aligned. The dot scales with
  `@ScaledMetric`. Swipe buttons wrap their text at AX3 and above. The quick-steer sheet uses
  the large detent at accessibility sizes so the log line, the field, and the keyboard fit. At
  AX5 the field is three lines minimum.
- **Reduce Motion.** Section 2.3; the banner crossfades; row moves crossfade.
- **Colour.** The unread mark is weight, not colour alone. The dot colours each have a word
  next to them. "Stop" is grey and "Archive…" is red; both have words.
- **Dark mode.** The row card is `elevatedColor` (OKLCH 0.205), the list is `paperColor`, the
  hairline is `hairlineColor`. The dots use the accent and accent-2 dynamic colours; the
  primary dot is the label colour. The banner is `elevatedColor` with the light-mode-only
  shadow of `surfaceCard`. The selected row on iPad is `accentSoftColor`. The swipe buttons use
  the system tints, which adapt. No pure black and no pure white anywhere.

## 10. ASCII wireframes

Legend: `●` steady accent (needs you) · `◉` breathes, accent-2 (live) · `○` steady accent-2
(starts soon) · `•` steady primary (unread, no state) · a `*` after a title marks semibold.

### 10.1 The list, mixed states

```
‹                     Albatrosses                   Show finished

 (Everything) (Needs you) (In progress) (No area yet)

 ── Needs you   Albatross cannot move these without you.
 ┌──────────────────────────────────────────────────────────┐
 │ ● Renew the car registration *                    9:41   │
 │   Needs your answer · Which renewal term do you           │
 │   want?                                        Household  │
 ├──────────────────────────────────────────────────────────┤
 │ ● Book the dentist for Sam Rivera                 9:12   │
 │   Your turn · Sign in to brightsmile.example in the       │
 │   page, then press Continue.                      Health  │
 └──────────────────────────────────────────────────────────┘

 ── In progress   Albatross works on these now.
 ┌──────────────────────────────────────────────────────────┐
 │ ◉ Pay the water bill                              9:40   │
 │   In progress · Pay the bill on the city site             │
 │   Typed your saved account number on springfield.example  │
 ├──────────────────────────────────────────────────────────┤
 │ ◉ Plan the Lisbon trip                            9:39   │
 │   Reply in progress · Reply to: which week in             │
 │   November is free?                               Travel  │
 ├──────────────────────────────────────────────────────────┤
 │ ○ Cancel the gym membership                       9:38   │
 │   Starts soon · Find the cancellation form                │
 └──────────────────────────────────────────────────────────┘

 ── Open   Nothing waits on you here.
 ┌──────────────────────────────────────────────────────────┐
 │ • File the expense report *                   Yesterday  │
 │   Done · Verified on the page · Report 4471 sent    Work  │
 ├──────────────────────────────────────────────────────────┤
 │   Return the library books                          Mon  │
 │   Did not finish · The page did not load after            │
 │   three tries.                                            │
 ├──────────────────────────────────────────────────────────┤
 │   Call the plumber about the leak                 Oct 2  │
 │   Next: Call (555) 010-0137 before Friday      Household  │
 └──────────────────────────────────────────────────────────┘
```

### 10.2 A swiped row

```
 ┌──────────────────────────────────────────┬────────┬────────┐
 │ ◉ Pay the water bill                     │        │        │
 │   In progress · Pay the bill on the c…   │ Steer  │  Stop  │
 │   Typed your saved account number on…    │        │        │
 └──────────────────────────────────────────┴────────┴────────┘
                                             accent-2   grey
```

### 10.3 The quick-steer sheet

```
 ┌────────────────────────────────────────────────────────────┐
 │                          ────                              │
 │ Cancel            Pay the water bill                 Send  │
 │                   In progress · Pay the bill on the        │
 │                   city site                                │
 │                                                            │
 │  9:40   Typed your saved account number on                 │
 │         springfield.example                                │
 │                                                            │
 │  ┌──────────────────────────────────────────────────────┐  │
 │  │ Use the checking account, not the card|              │  │
 │  └──────────────────────────────────────────────────────┘  │
 │  Stop and redirect…                                        │
 │                                                            │
 │  [ q  w  e  r  t  y  u  i  o  p ]                          │
 └────────────────────────────────────────────────────────────┘
```

In redirect mode the subtitle reads "The run stops when you send. A new run starts with your
note.", the trailing button reads "Stop and send", and the quiet button reads "Keep the run".

### 10.4 The thread with a sent note and its receipt

```
 ‹ Albatrosses        Pay the water bill                    ⋯
                      Step 2 of 3 · Albatross works
 ─────────────────────────────────────────────────────────────
 │ ◉ In progress · Started by you
 │ Pay the bill on the city site
 │ ┌───────────────────────────────────────────────────────┐
 │ │ 9:38   Opened springfield.example/water               │
 │ │ 9:39   Typed your saved account number                │
 │ │ 9:41   Read your note: Use the checking account, not  │
 │ │        the card                                       │
 │ └───────────────────────────────────────────────────────┘
 │ Albatross is on the page · springfield.example      Open
 │                             [Stop and redirect]  [Stop]

                          ┌──────────────────────────────────┐
                          │ Use the checking account, not    │
                          │ the card                         │
                          └──────────────────────────────────┘
                                     Read by Albatross · 9:41

 ┌ Run ──────────────────────────────────────────────────────┐
 │ 📎  Tell Albatross what to change                   (↑)   │
 └───────────────────────────────────────────────────────────┘
```

A note the run never read:

```
                          ┌──────────────────────────────────┐
                          │ Skip the paperless option        │
                          └──────────────────────────────────┘
                   Not read: the run ended first · Send again
```

### 10.5 Stop and redirect, armed

```
 ┌───────────────────────────────────────────────────────────┐
 │ Stop and redirect: the run stops when you send.   Cancel  │
 │ ┌ Run ───────────────────────────────────────────────────┐│
 │ │ 📎  Go back and choose the Saturday session|     (↑)   ││
 │ └────────────────────────────────────────────────────────┘│
 └───────────────────────────────────────────────────────────┘
```

### 10.6 The banner in a thread

```
 ‹ Albatrosses        Pay the water bill                    ⋯
                      Step 2 of 3 · Albatross works
 ┌───────────────────────────────────────────────────────────┐
 │ Renew the car registration · Needs your answer      Open  │
 └───────────────────────────────────────────────────────────┘
 ...
```

## 11. Open questions for the lead designer

1. **"Answering" or "Reply in progress".** The owner accepted "Answering". This note
   recommends "Reply in progress": no -ing verb, pairs with "In progress", and names what runs.
   Recommendation: "Reply in progress" on all three platforms.
2. **"Stopped by you" in the contract.** `status` has one `stopped`. The row cannot tell a
   limit from a user stop. Recommendation: the server's `statusLine` carries "Stopped by you."
   or "Albatross stopped at its time limit."; no new enum case.
3. **Note identity for receipts.** The run view's `notes` carry `{ at, text, readAt }` and the
   message carries `metadata.steer = { runId }`. Recommendation: the client sends `at` as the
   message's `createdAt`, the server stores it as the note's `at`, and the receipt matches on
   `(runId, at)`. A `noteId` is cleaner if the lead prefers a contract change.
4. **The composer route while a run works.** The brief says the message goes straight to the
   run. A question ("when is the court date?") must still reach the chat model.
   Recommendation: the three-way chip Run → Ask → Hold with "Run" as the default while a run is
   open (5.1), on all platforms.
5. **Mark as unread.** A real need in a list of many threads; the contract has `seen` only.
   Recommendation: not in this PR; add `{ workId, seen: false }` later and a leading swipe
   "Unread".
6. **iPad layout.** A nested `NavigationSplitView` in the shell's detail column is not a
   supported layout. Recommendation: the custom `ThreadsSplitView` (4.2) with a 320 pt list
   column and the stack below 700 pt.
7. **Two polls on the Brief.** `ReadyForYouSection` polls `/handoffs` every 20 s and
   `ThreadsStore` polls `/threads`. Recommendation: leave the Brief alone in this PR; in a later
   PR the Brief's list reads the threads rows with `needsYou`, and `/handoffs` retires on
   native.
8. **Stale live rows.** After two failed polls, should live rows say "last seen 9:41"?
   Recommendation: yes, with the dots steady; a false "In progress" is worse than an honest
   stale mark (T3 Code's "Out of date" rule).
9. **Re-attach to a reply in progress.** The server saves the finished reply; the client waits
   for `answering` to flip. Recommendation: accept the wait in this PR (the quiet row covers
   it); a resume endpoint is a later PR.
10. **The count in the drawer.** Recommendation: add the quiet number to the "Albatrosses" row
    if the drawer row has a trailing slot; else skip it, because the banner and the list cover
    the need.
11. **The model cache size.** Three models keep three streams and three run lists alive.
    Recommendation: three, with eviction on a memory warning.
12. **A push for `your_turn` and `ready_for_you`.** This note assumes the `work_question` push
    exists and a handoff push exists too. If a handoff push does not exist, the banner and the
    list are the only signals while the app is open, and nothing reaches a closed app.
    Recommendation: confirm with the server owner before the Live Activity PR.
13. **Section name "Open".** It replaces four `WorkState` groups. Recommendation: "Open" with
    the hint "Nothing waits on you here."; the row's own standing line still says waiting or
    paused.

## 12. Build notes for the Mac builder (2026-10-08)

The iOS build landed in `apps/ios` with the lead decisions applied. The shared Swift the Mac
mounts, and the platform seams it must know:

Shared, platform-neutral (compiled into both targets):

- `Core/Models/ThreadListModels.swift`: `ThreadRowStatus`, `ThreadRow`, `ThreadNote`, `ThreadNoteID`.
- `Core/Models/ThreadsStore.swift`: the rows, the poll (`beginFollowing` / `endFollowing` /
  `pauseFollowing` / `resumeFollowing`; viewers count; 5 s while a row works, else 30 s),
  `markSeen`, `markUnread`, `stop`, `steer(redirect:)`, `continueRun`, `attention`,
  `needsYouCount` (the Dock badge reads it).
- `Core/Models/ComposerDraftStore.swift` and `Core/Models/WorkThreadModelCache.swift` (three warm
  models; the memory-warning hook is `#if os(iOS)`).
- `Features/Work/ThreadRowPresentation.swift`: `ThreadRowDot`, `ThreadListSection`,
  `ThreadRowVerb`, `ThreadListRow`, `ThreadRowPresentation`, `ThreadListGrouping`. The rail must
  read these words, dots, sections, sorts, and verbs; never a second copy.
- `Features/Work/ThreadListRowView.swift` (`ThreadListRowView`, `ThreadStatusDot`),
  `NoteReceiptView.swift` (`NoteReceipt`, `NoteReceiptPresentation`, `NoteReceiptView`),
  `NeedsYouBanner.swift`, `QuickSteerSheet.swift` (`QuickSteerForm` is the body without the sheet
  chrome), `AnswerSheet.swift`.
- `WorkThreadModel`: `replyInProgress`, `composerPlaceholder`, `runRouteLine`, `sendsAreHeld`,
  `syncRunRoute()`, `steer(_:)`, `receipt(for:)`, `canSendAgain(_:)`, `sendAgain(_:)`,
  `armRedirect(_:)`, `disarmRedirect()`, `sendRedirect(_:)`, `followServerReply()`.
- `AssistantChatModel`: `BarRoute.run`, `runRouteAvailable`, `setRunRouteAvailable(_:)`,
  `appendSteerMessage(_:id:runID:redirect:)`, `AssistantChatMessage.steer`, the server stop in
  `stop()`, and `sessionId` + `threadBaseUpdatedAt` in `requestBody()`.
- `AssistantComposer`: `routeLine`, `armed` (`ComposerArmedNotice`, `ComposerArmedStrip`),
  `sendDisabled`. `AssistantMessageRow` draws the receipt from `\.workThread`.
- `RunBlockActions.redirect` (optional; the "Stop and redirect" button shows only when set).

`#if os(macOS)` seams left in shared code:

- `WorkView.swift`: `horizontalSizeClass` and the iPad `split` are `#if os(iOS)`; the list style is
  `.inset` on the Mac and `.insetGrouped` on iOS (`threadListStyle()`); the Later shelf row keeps
  `MacLaterRuler` on the Mac. The Mac still mounts `WorkView` as the Work tab root with the live
  rows, swipes, and menus; the lead's sidebar section is the Mac builder's.
- `ThreadsSplitView.swift` is `#if os(iOS)` whole.
- `MacWorkThreadView` still creates its own `WorkThreadModel` and `RunBlockActions`; to get the
  warm models, the draft store, the seen mark, the banner, the server-reply placeholder, the Run
  route line, the redirect strip, and the receipts, mirror the `WorkThreadView` hooks listed above.
