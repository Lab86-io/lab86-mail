# Many Albatross threads at once, macOS design note (2026-10-08)

Status: design, no code. The brief is `docs/albatross-threads.md` (stories T1 to T12, the owner
decisions, and the server contract). PR 1 is `docs/albatross-thread.md` and its Mac note,
`albatross-thread-macos-design-2026-10-07.md`. This note keeps every PR 1 decision and adds
only what many threads need on the Mac: the live list in the sidebar, the row, the hop, the
steer receipts, the menu commands, and the background signals.

The iOS designer owns the shared SwiftUI views and their copy. Where this note names a shared
view, it states an assumption and asks for a hook. Section 7 lists them.

Sample data is invented: "Sam Rivera", `sam.rivera@example.com`, "(555) 010-0100", the sites
`dmv.ny.gov` and `water.example.com`, and the Albatrosses "Renew the car registration", "Pay the
water bill", "Plan the Lisbon trip", "Book the dentist", "Cancel the gym membership", "Return the
library books", "Send Sam Rivera the lease", and "File the expense report".

## What the Mac does today

- The source list (`MacSourceList` in `MacShellView.swift`) lists the product tabs, Snoozed,
  the labels, and the Areas. It does not list Albatrosses.
- The Albatrosses page (`WorkView.swift`) is the detail column. It groups Work by state with a
  title, a `standingLine` ("Next: …"), and a state chip. The rows are not live.
- One thread at a time: `MacWorkThreadView` mounts one `WorkThreadModel`. Back replaces it. The
  chat stream aborts on the client, and the poll stops.
- The keyboard moves between tabs (⌘1 to ⌘9) and inside a thread (⌘↩, ⌘., ⌃⌘P, ⌃⌘I, ⌘K).
  Nothing moves between threads.
- The Dock icon has no badge. No notification category belongs to a run.

## 1. Research

### 1.1 T3 Code (the owner's reference)

T3 Code is open source. The findings come from its user docs, its sidebar source, and the
pull requests that shaped the sidebar.

- **The sidebar is the thread list.** T3 Code has no separate list column. The sidebar holds the
  threads, flat, with a project filter at the top. Sidebar V2 replaced a project-grouped tree
  with "a single flat list": active threads as rich cards, finished work in a compact "Settled"
  section with "show more" and a count
  ([video summary](https://openclawdatabase.com/news/videos/2026-07-27-t3-code-sidebar-v2/),
  [thread-sidebar.md](https://github.com/pingdotgg/t3code/blob/main/docs/user/thread-sidebar.md)).
  Taken: the list lives in the sidebar, flat, with the Area as a caption, not a group. Drives
  decision 2.1.
- **Status words and their precedence.** `resolveSidebarThreadStatus` ranks `approval`, then
  `input`, then `working`, then `waiting`, then `failed` or `limited`, then `ready`
  ([Sidebar.logic.ts](https://github.com/pingdotgg/t3code/blob/main/apps/web/src/components/Sidebar.logic.ts)).
  The row label set is "Working", "Waiting", "Approval", "Input", "Limited", "Failed", "Woke",
  "Done" ([Sidebar.tsx](https://github.com/pingdotgg/t3code/blob/main/apps/web/src/components/Sidebar.tsx),
  `topStatus`). A comment says "No shimmer: a label that animates forever is noise in a sidebar
  full of them". Taken: one status word per row, what needs a human first, and no label motion.
  Rejected: the glyph set beside each label; the Mac uses one dot and words. Drives 3.1 and 3.2.
- **Unread is a completion the user has not visited.** `hasUnseenCompletion` is true when the
  latest run completed after `lastVisitedAt`; a thread never visited counts as read, so a new
  sidebar does not "light up every historical thread as unread" (Sidebar.logic.ts). Taken: the
  seen rule is a time, set when the thread is on screen; the brief's `seenAt` matches. Drives 3.4.
- **A run in a thread you are not in.** The row shows "Working 3m" with an elapsed timer that ticks
  in its own component, outside the `role="status"` live region, so screen readers do not announce
  every second ([PR #4274](https://github.com/pingdotgg/t3code/pull/4274)). The same PR fades
  in-flight rows to 70% with normal weight: "in-flight threads aren't your problem yet".
  Taken: the elapsed time on an in-progress row, with a one-minute tick and no live-region
  announcement. Rejected: the fade. On macOS a dimmed row reads as disabled. The Mac keeps the row
  at full strength and uses weight and the dot for prominence. Drives 3.1 and 9.
- **Stale status is the worst bug.** [PR #919](https://github.com/pingdotgg/t3code/pull/919) fixed
  rows that still said "Working" while the thread waited for input, because a memoized map
  went stale. [PR #701](https://github.com/pingdotgg/t3code/pull/701) added "Awaiting Input" as a
  first-class status. Taken: the row reads the server's `status` field only, never a client
  guess, and the list polls faster while anything is in progress (the brief's 5 s rule).
- **The status slot yields to hover actions.** The trailing slot shows the status or time at rest;
  on hover or keyboard focus it shows Settle and Snooze, with no layout shift (Sidebar.tsx,
  `group/sidebar-status-slot`). Taken: the same slot rule for Answer, Steer, and Stop. Drives 3.3.
- **Keyboard movement.** `thread.previous` and `thread.next` are `mod+shift+[` and `mod+shift+]`;
  `mod+1` to `mod+9` jump to the first nine visible threads, desktop only, with hint pills while
  the modifier is held ([PR #1456](https://github.com/pingdotgg/t3code/pull/1456),
  [keybindings.md](https://github.com/pingdotgg/t3code/blob/main/docs/user/keybindings.md)).
  `thread.stop` has no default key. `thread.undo` (`mod+z`) reverses the last list action
  within five seconds. Taken: previous and next as menu commands with shortcuts, and Undo for a
  list action. Rejected: `mod+1` to `mod+9` (the Mac app binds them to tabs) and the hint pills.
  Drives section 4.
- **Settle and the next thread.** The sidebar Settle button moves to the next active thread; the
  `mod+shift+s` shortcut stays on the settled thread, and users filed it as a bug
  ([issue #16090](https://github.com/pingdotgg/t3code/issues/16090),
  [PR #8089](https://github.com/pingdotgg/t3code/pull/8089)). Taken: when the open thread leaves
  the list ("Mark done", "Archive", "Put it down"), the Mac opens the next thread that needs the
  user, else the Albatrosses page. Drives 4.3.
- **Hidden rows still signal.** [PR #1517](https://github.com/pingdotgg/t3code/pull/1517) put an
  aggregate status dot on the "Show more" button, because a project showed an indicator with no
  visible thread. Taken: the "Show N more" row carries a dot when a hidden row needs the user.
  Drives 3.5.
- **A status line the user asked for.** A user requested a short line under the title that says
  where the thread is now, "muted, truncated with an ellipsis, full text on hover", cleared when
  the thread settles ([discussion #14557](https://github.com/pingdotgg/t3code/discussions/14557)).
  The brief's `logLine` is this line. Taken: the preview line and its hover card.
- **Context menu and undo.** The desktop guide lists the thread context menu as "Rename, mark
  unread, copy ID, delete"
  ([desktop app guide](https://pingdotgg-t3code.mintlify.app/guides/desktop-app)). Unpin, settle,
  snooze, and archive each show a notification with Undo for five seconds (thread-sidebar.md).
  Taken: "Mark as Unread" in the context menu, and an undo notice after "Stop" from the list.
- **Warm threads.** The sidebar keeps a live detail subscription for at most three visible rows
  (`SIDEBAR_THREAD_PREWARM_LIMIT = 3`, Sidebar.logic.ts), "so opening a nearby thread usually
  reuses an already-hot subscription". Taken: the Mac keeps three thread models warm. Drives 5.4.
- **Working section (beta).** With the option on, threads in progress fold into a collapsed
  "Working" section, and "a thread returns to the top of the active list when it finishes, fails,
  or needs an approval or answer" (thread-sidebar.md). Taken: the sort groups of the brief
  (needs you, then in progress, then newest) and the one-time move of a row that starts to
  need the user. Rejected: a collapsed section for in-progress rows; the owner wants to see them.

### 1.2 Mobbin screens (platform: web, desktop widths)

Mobbin has no macOS filter and returned no Things 3 screen. Each line says what the Mac takes
and rejects.

- Cursor, agents list with a Status filter menu (Running, Finished, Error, Creating, Expired,
  Merged, Closed) ([screen](https://mobbin.com/screens/58450174-4034-4e5d-a126-9def2378b0a0)).
  Taken: a flat status filter. Rejected: seven values; the Mac has three (T12). Drives 3.5.
- Cursor, a new cloud agent row "Running · 4 Models · now"
  ([screen](https://mobbin.com/screens/96ac53d4-b268-413a-bad0-7a4f782b0a60)). Taken: the state
  word beside a compact time ("now"). Rejected: the model count.
- Cursor, setup run with "Get notified when finished" and "Turn On Notifications"
  ([screen](https://mobbin.com/screens/44239877-86ce-46c8-a615-273ec82046f5)). Taken: a
  notification only for a finish or a question. Rejected: the banner inside the thread; the Mac
  asks for notification permission in Settings, as today.
- Slack, sidebar with an unread channel in bold and a count badge "1"
  ([screen](https://mobbin.com/screens/b810edbe-d2f2-47d4-a133-607e6f1d3b14)). Taken: unread as a
  weight change; a count only for what needs the user. Rejected: the red "New" rule inside the
  conversation.
- Slack, "Moved 2 conversations to Social. Undo"
  ([screen](https://mobbin.com/screens/de9d3a84-c9d5-41ff-88a2-9e78c96d0969)). Taken: an undo
  notice after a list action.
- Linear, issue list with "All issues / Active / Backlog" tabs and group counts
  ([screen](https://mobbin.com/screens/be6c4ee4-aa93-42b4-89b3-dcfc8386f022)). Taken: three
  filter words at the head of the list, counts beside group names. Rejected: a status glyph per
  row; one indicator per row is the rule.
- Superhuman, list with a leading unread dot, hover actions at the trailing edge, and the
  "Marked as Done. UNDO" notice
  ([screen](https://mobbin.com/screens/b0cecd33-9403-4c15-af1c-033d84826cf5)). Taken: hover
  actions at the trailing edge with no reserved space, and the undo notice. Rejected: glyph-only
  actions; the Mac uses words.
- Superhuman, shortcuts pane with "Next Conversation J" and "Previous Conversation K"
  ([screen](https://mobbin.com/screens/0e821e22-026a-4641-a91b-ac63b0c9e4bc)). Taken: dedicated
  next and previous commands. Rejected: single letters; the composer owns letters.
- Notion Mail, three panes with a leading unread dot and the preview after the subject
  ([screen](https://mobbin.com/screens/6cbf9d6c-b0d2-4d89-9ee5-57bbd6fec0cf)). Taken: title then
  preview in the secondary colour. Rejected: one line per row; the sidebar is narrow, so the Mac
  stacks.
- Front, "Open 3" counts in the sidebar and rows with title, preview, and time
  ([screen](https://mobbin.com/screens/a25fd5f3-a74a-4abc-b5f5-11b38cb684fa)). Taken: the count
  beside the list name. Rejected: the priority tags.
- Plain, thread list with "Needs first response" written as words
  ([screen](https://mobbin.com/screens/6b03543c-d8bd-403c-a3eb-3c43783a0a23)). Taken: the state as
  a sentence, never colour alone.
- Superlist, a quiet dot on "Messages" in the sidebar for "1 new message"
  ([screen](https://mobbin.com/screens/46c6afcf-468d-473f-bbb3-9379104a05db)). Taken: a dot on the
  section header when the section is collapsed and something inside is new.
- Lemni, inbox row "Alex · Busy, unable to do teardown"
  ([screen](https://mobbin.com/screens/68aa3af4-c84d-4a60-bffc-8e3935bc4b63)). Taken: a human
  sentence as the preview line.
- Mistral, a research run with "Cancel" always visible
  ([screen](https://mobbin.com/screens/181ce284-3dcd-4d44-bb1f-368d2e5db997)). Taken: Stop is
  never hover-only inside the thread. Rejected: the time estimate.
- ClickUp, Replies with "Unread" and "Read" tabs
  ([screen](https://mobbin.com/screens/0b3a8bac-a1fd-43fe-a542-81621a337245)). Rejected: unread
  as a place. Unread is a mark on a row.

### 1.3 Apple Human Interface Guidelines (macOS)

- [Sidebars](https://developer.apple.com/design/human-interface-guidelines/sidebars): "In general,
  show no more than two levels of hierarchy in a sidebar"; "Using disclosure controls helps keep
  the sidebar's vertical space to a manageable level"; "Consider automatically hiding and
  revealing a sidebar when its container window resizes" (Mail is the example); "Avoid putting
  critical information or actions at the bottom of a sidebar"; on macOS "A sidebar's row height,
  text, and glyph size depend on its overall size, which can be small, medium, or large". Taken:
  the thread rows are one level under the "Albatrosses" row, under a disclosure; the row scales
  with the sidebar size setting; the collapse rule of PR 1 stays; nothing critical sits at the
  bottom. Drives 2.1 and 2.2.
- [Notifications](https://developer.apple.com/design/human-interface-guidelines/notifications):
  "Avoid sending multiple notifications for the same thing"; "Handle notifications gracefully
  when your app is in the foreground", for example "incrementing a badge or subtly inserting new
  data into the current view"; "Use an alert, not a notification, to display an error message";
  a badge on the app icon is a notification style; up to four actions. Taken: one notification
  per handoff, none while the app is frontmost, a Dock badge for what needs the user, and no
  notification for a client error. Drives section 6.
- [Dock menus](https://developer.apple.com/design/human-interface-guidelines/dock-menus): "Prefer
  high-value custom items"; "Make custom Dock menu items available in other places, too". Taken:
  the Dock menu lists the threads that need the user (phase 2), the same rows the sidebar shows.
- [Menus](https://developer.apple.com/design/human-interface-guidelines/menus): title-style
  capitalization; a verb for an action; an ellipsis when more input follows; "Show people when a
  menu item is unavailable": the item is dimmed, not hidden. Taken: the menu copy in section 4.
- [The menu bar](https://developer.apple.com/design/human-interface-guidelines/the-menu-bar):
  app-specific menus sit between View and Window; "Always show the same set of menu items";
  "Define custom keyboard shortcuts only when necessary"; "Prefer short, one-word menu titles".
  Taken: a one-word "Go" menu for movement; the thread actions stay in the Albatross menu.
- [Keyboards](https://developer.apple.com/design/human-interface-guidelines/keyboards): "Support
  Full Keyboard Access"; "Respect standard keyboard shortcuts"; Command-Period is "Cancel an
  operation"; list modifiers in the order Control, Option, Shift, Command. Taken: ⌘. stays Stop;
  the new shortcuts avoid every standard one; every hover action has a keyboard path.
- SwiftUI `List` with `.listStyle(.sidebar)` and a collapsible `Section(isExpanded:)`
  ([developer.apple.com](https://developer.apple.com/documentation/swiftui/section/init(isexpanded:content:header:)))
  gives a source-list disclosure with the system chevron. Taken for the "Albatrosses" section.

## 2. Window structure

### 2.1 The list lives in the sidebar

Decision: the thread list is a section of the current source list, not a second column.

Why:

- The owner's reference does it this way. T3 Code's sidebar is the thread list.
- PR 1 fixed the window at three columns: the source list, the conversation, and one trailing
  pane. A fourth column needs 1,600 points with the page open. Most Mac windows are not that wide.
- The sidebar already collapses first when the page pane needs room (PR 1, 2.2). A second column
  would need its own collapse rules and its own toggle.
- The HIG allows two levels in a sidebar. "Albatrosses" with its rows is two levels.

Rejected: a content column between the sidebar and the conversation (Mail's layout). It is the
right shape for hundreds of items with search. The owner has tens of Albatrosses, and search
comes later (T12).

Rejected: a popover list from the toolbar as the only list. A popover closes on every click, and
the owner wants to watch several runs at once.

### 2.2 Where the section sits, and its relation to Areas

The source list order becomes:

```
Search mail                                   ⌘F
Today
Albatrosses  3                              All ⌄      ← the row is a disclosure header
  ● Pay the water bill                        2m
  ● Send Sam Rivera the lease                 9m
  ◌ Renew the car registration                3m
  …
  Show 4 more
Chat
Mail
Calendar
Mailboxes
  Snoozed
Labels
  …
Your areas
  …
Settings
```

- The "Albatrosses" row stays a button to the Albatrosses page. It gains a disclosure chevron at
  the leading edge (system `Section(isExpanded:)`), the needs-you count at the trailing edge, and
  the filter pull-down beside the count. The disclosure state persists per user.
- The thread rows are the section's content, one level deep. Each row opens its thread in the
  detail column (`navigation.openWork`), the same as a click on the Albatrosses page.
- Areas keep their section. A thread row does not nest under an Area; the Area is a caption in
  the row's hover card and in the idle row's second line. The flat sort by need matters more than
  the Area a thread is filed under. An Area row still opens the Area page, which lists its own
  Work.
- The context menu of a row has "Show in Area", so the Area is one click away.
- The Albatrosses page (`WorkView`) stays the full list: the state groups, the Later ruler, the
  finished rows, the Areas footer. Its rows go live with the shared row rules (section 7), so
  Back shows the same status as the sidebar (T1).

### 2.3 Which rows the sidebar shows

The server returns one row per Work that is not archived. The sidebar does not show them all.

A row is "awake" when at least one is true:

1. It needs the user (`needs_answer`, `your_turn`, `ready_for_you`).
2. Something is in progress (`in_progress`, `answering`, `starts_soon`).
3. It is unread.
4. Its `lastActivityAt` is within seven days, and it is not done, put down, or dormant.

The section shows the awake rows in the brief's order: needs you, then in progress, then
`lastActivityAt` newest first. It shows at most 12 rows, then a quiet "Show N more" row that
reveals the rest of the awake set; "Show fewer" folds it back. The expanded state does not
persist. Done, put down, dormant, and older rows live on the Albatrosses page only.

The filter (T12) narrows the awake set: "All", "Needs you", "In progress". "In progress" includes
`answering` and `starts_soon`. A filter with no rows shows one line, "Nothing needs you." or
"Nothing in progress.", in the secondary colour.

### 2.4 Widths and collapse

| Measure | Value |
|---|---|
| Sidebar | min 220, ideal 280, max 400 (was 220 / 260 / 340). The thread rows need the extra room; every other row gains nothing and loses nothing. |
| Row height | two lines at rest (about 44 points at the medium sidebar size); three lines while in progress or a reply runs (about 60). The sizes follow the system sidebar size setting. |
| Title | one line, tail truncation. The full title is in the tooltip and the hover card. |
| Preview lines | one line each, tail truncation. |
| Time | tabular digits, 36 points reserved at the trailing edge of line 1 at rest. On hover the actions take the slot. |

The collapse rule of PR 1 stands: when the page pane needs room and the window is narrower than
1,220 points (960 + 260), the sidebar hides first. The thread list hides with it. Two things keep
the hop alive while the sidebar is hidden:

- The Go menu and its shortcuts (section 4) do not need the sidebar.
- A "Threads" toolbar item appears at the leading edge of the detail column's toolbar only while
  the sidebar is hidden (`Label("Albatrosses", systemImage: "list.bullet")`, icon only, help "Show
  the Albatrosses (Control-Command-S shows the sidebar)"). It shows a 6-point accent dot while a
  thread needs the user. A click opens a popover (360 wide, up to 560 tall) with the same rows and
  the same filter. A click on a row opens that thread and closes the popover. Escape closes it.

### 2.5 The conversation and the pane

Unchanged from PR 1: the conversation is the detail column, the composer docks at its bottom, the
trailing pane shows the page or the details. The open thread's row in the sidebar carries the
system selection fill (`listRowBackground`, `Color.primary.opacity(0.08)`), as the Area rows do.
Selection never changes the title weight; weight belongs to unread.

When the user hops (click, ⌥⌘↑, ⌥⌘↓), the detail column swaps the thread with no slide. A
crossfade of 0.15 seconds, none under Reduce Motion. The pane follows the thread's own pane state
(PR 1, S1): a thread with a live page reopens with the page.

## 3. The row

### 3.1 Anatomy

```
● Pay the water bill                                   2m      line 1: dot · title · time
  Needs your answer · Choose the payment account               line 2: status word · step
```

```
◌ Renew the car registration                           3m      line 1 (time = elapsed)
  In progress · Fill the renewal form                          line 2: status word · step
  Typed your saved Driver's license on dmv.ny.gov              line 3: newest log line
```

- **The dot** is the one indicator of the row (one indicator per row, no icon beside a chip). It
  sits at the leading edge of line 1, 7 points, centred on the title's x-height. Its colour and
  motion come from the state matrix (3.2). No dot means nothing is live and nothing is unseen.
- **The title** is `title`, one line. Semibold while the row needs the user or is unread; regular
  otherwise. Never a serif here; the sidebar is a system list.
- **The time** at the trailing edge of line 1, caption size, tabular digits, secondary colour. At
  rest it is a compact relative time: "now", "2m", "1h", "Mon", "Oct 1". While a run is in
  progress it is the elapsed time of the run: "<1m", "3m", "1h 12m". The tick is once a minute
  and never announces (9.1). A tooltip on the time shows the full date and time.
- **Line 2** is the status word, a middle dot, and the detail. The status word is the brief's
  fixed name. The detail is `stepTitle` for a run, else the next step, else the Area name. This
  line is the secondary colour, footnote size.
- **Line 3** exists only while `in_progress` or `answering`. It shows `logLine` (the newest log
  line that matters), or for a reply the first words of the reply so far (`statusLine`). It is the
  tertiary colour, footnote size, and it changes in place with a 0.2-second opacity crossfade.
- **Hover card.** After 0.8 seconds over a row, a tooltip-style card (320 wide) shows: the full
  title, the Area, the status word with the step, the newest three log lines with times, and
  "Started by you · 9:41" or "Started by the Brief · 7:02". It is read-only. It never opens on a
  row with an open inline steer field.

### 3.2 State matrix

| `status` | Dot | Motion | Title | Line 2 | Line 3 | Time | Hover actions | Group |
|---|---|---|---|---|---|---|---|---|
| `needs_answer` | accent, filled | none | semibold | "Needs your answer · {stepTitle}" | none | since the question | Answer | needs you |
| `your_turn` | accent, filled | none | semibold | "Your turn · {next.detail}" ("Sign in to dmv.ny.gov") | none | since the handoff | Open | needs you |
| `ready_for_you` | accent, filled | none | semibold | "Ready for you · {stepTitle}" | none | since the handoff | Open | needs you |
| `in_progress` | accent-2, filled | breathes (opacity 0.35 to 1, 1.6 s period) | regular | "In progress · {stepTitle}" | `logLine` | elapsed | Steer, Stop | in progress |
| `answering` | accent-2, filled | breathes | regular | "Albatross replies" (see 11.3) | first words of the reply, else none | "now" | Stop | in progress |
| `starts_soon` | accent-2, hollow (1-point ring) | none | regular | "Starts soon · {stepTitle}" | none | since queued | Stop | in progress |
| `done`, unread | green, filled | none | semibold | "Done · {proof word}" ("Verified on the page") | none | since done | none | newest |
| `done`, seen | none | none | regular | "Done · {stepTitle}" | none | since done | none | newest (seven days, then off the sidebar) |
| `did_not_finish`, unread | red, filled | none | semibold | "Did not finish · {stepTitle}" | none | since the failure | Try again | newest |
| `did_not_finish`, seen | none | none | regular | same | none | same | Try again | newest |
| `stopped`, unread | secondary, filled | none | semibold | "Stopped · {stepTitle}" | none | since the stop | Continue | newest |
| `stopped`, seen | none | none | regular | same | none | same | Continue | newest |
| `idle` | none | none | regular | "Next: {nextStep}" or the Area name | none | last activity | none | newest |

Rules:

- The dot colour never carries the meaning alone. The status word is always on line 2.
- "Unread" adds weight to the title and a filled dot to a finished row. It never adds a second
  mark. An in-progress row cannot be unread; it is live.
- Hover actions appear on hover and on keyboard focus (Full Keyboard Access), in the time's slot.
  The time hides while they show. The slot does not change width (T3 Code's rule).
- "Open" is listed for completeness: the row itself opens the thread, so no button is drawn for it.

### 3.3 Hover actions

Text buttons, footnote size, medium weight, borderless, no icons. Right to left in the slot:
the most destructive last.

- **Answer** (needs_answer). Opens the question in place: a popover anchored at the row's trailing
  edge (`arrowEdge: .leading`), 380 wide, with the shared `FormQuestionCard` for
  `pendingQuestionId`. The card is the same form as in the thread: the title, the detail, the
  fields, "Save to my details", and the submit (default "Continue"). Return submits from a field;
  Escape closes the popover and keeps the typed values until the row leaves the list. A submit
  posts the same answer route as the thread, closes the popover, and the row moves to its new
  group. The thread does not open. If the question is an allow (`allow_secure`) the popover shows
  one line, "Open the thread to allow this.", with "Open"; the identity check stays in the thread.
- **Steer** (in_progress). Replaces line 3 with a one-line field inside the row (3.6). The row
  grows to hold it. Focus goes to the field.
- **Stop** (in_progress, answering, starts_soon). Stops at once with no dialog. A stop is
  reversible from the thread ("Continue"), so the shell's undo notice shows "Stopped Renew the car
  registration" with "Undo" for ten seconds (`ProductStore.undoNotice`, `MacUndoBridge`). Undo
  posts `resume` on the cancelled run. For `answering`, Stop posts `POST /api/agent/stop` (T11)
  and the notice has no Undo.
- **Try again** (did_not_finish) and **Continue** (stopped) start the run from the row, the same
  calls as the block's buttons. They are hover actions because they are the one next step and
  they cost one click in the thread today.

### 3.4 Unread and seen

- `unread = lastActivityAt > seenAt` on the server, for activity that matters (a handoff, a
  question, a finished reply, a run that ends). A log line never sets unread.
- The Mac posts `seen` when a thread has been on screen for one second in the key window. A fast
  pass with ⌥⌘↓ across three rows does not mark the middle one seen. A thread on screen in a
  window that is not key (the user is in Safari) is not seen until the window is key again.
- While the thread is on screen and the window is key, new activity is seen at once; the row never
  flips to unread under the user's eyes.
- "Mark as Unread" (context menu, ⇧⌘U) sets `seenAt` to null through the same route with
  `{ workId, unread: true }`; see 11.9. "Mark as Read" is the same item while unread.

### 3.5 The filter and the count

- The filter is a pull-down at the trailing edge of the "Albatrosses" header: "All ⌄", "Needs
  you ⌄", "In progress ⌄". It is quiet text in the secondary colour, footnote size. The same three
  items sit in the View menu as a radio group. The choice persists per user.
- The count beside "Albatrosses" is the number of rows that need the user, in the secondary
  colour, tabular, with no capsule. It is the same number as the Dock badge. It shows under every
  filter. Zero shows nothing.
- When the section is collapsed, the header keeps the count and gains a 6-point accent dot after
  the title while any hidden row needs the user, and an accent-2 dot while any run is in progress
  and nothing needs the user. One dot, the more urgent colour.
- "Show N more" carries the same dot rule for the rows it hides (T3 Code, PR #1517).

### 3.6 Inline steer (T10)

```
◌ Plan the Lisbon trip                               Steer  Stop     ← hover
  In progress · Compare the fares
  [Prefer a morning flight on the way out              ] ↩          ← after Steer
```

- The field is a plain `TextField` with the prompt "Tell the run what to change", one line, no
  border, on the elevated colour with a hairline, inside the row. ↩ at the trailing edge is a
  hint, not a button. Return sends. Shift-Return does nothing (one line). Escape closes the field
  and keeps nothing.
- Send posts `{ action: 'steer', runId, note }`. The field closes. Line 3 reads "Sent to the run"
  for as long as `readAt` is null, then "Read by Albatross" for five seconds, then the newest log
  line again. If the run ends before it reads the note, line 3 reads "Not read: the run ended
  first" and the hover slot offers "Send again" (T9), which posts the note to the next run of the
  step as a `resume` note.
- The note also lands in the thread as a user message with `metadata.steer`, so the thread shows
  it with its receipt (section 5) when the user opens it.
- A row with an open field does not move when the sort changes. The move waits until the field
  closes.
- Only one inline field is open at a time. Steer on another row closes the first and discards its
  text.

### 3.7 Context menu

Title case, as the app's menus are.

```
Open
Answer…                       (needs_answer)
Steer…                        (in_progress; opens the inline field)
Stop                          (in_progress, answering, starts_soon)
Stop and Redirect…            (in_progress; opens the thread with the composer armed, 5.3)
Try Again                     (did_not_finish)
Continue                      (stopped)
──
Mark as Unread / Mark as Read
Show in Area
──
Put It Down / Pick It Up
Mark Done
──
Archive…
```

Items that do not apply are absent from a context menu (a context menu is contextual; the menu
bar keeps every item and dims it).

### 3.8 Motion

- A row that starts to need the user moves to the top of its group once, with the list's default
  move animation (0.25 s). It does not flash, bounce, or change colour.
- A row that stops to need the user (answered elsewhere) moves down the same way.
- Rows in progress do not reorder on every poll. The order inside "in progress" is by run start,
  newest first, and it changes only when a run starts or ends.
- The in-progress dot breathes. Nothing else in the sidebar animates on its own.
- Reduce Motion: no breath (the dot is solid), no move animation (rows jump), no crossfade.

## 4. Keyboard and menus

### 4.1 What is bound today

⌘N, ⌘K, ⌘R, ⇧⌘H, ⌘F, ⌘1 to ⌘9 (tabs), ⇧⌘A, ⌘, (`AlbatrossCommands`), ⌃⌘P, ⌃⌘I
(`MacThreadCommands`), ⌘↩ (the action that waits), ⌘. (Stop), ⌃⌘S (sidebar, system), ⌘Z (undo
bridge). ⌘↑ and ⌘↓ belong to the text view (start and end of the document), and the composer has
focus most of the time. ⌃⌘↑ and ⌃⌘↓ are Xcode's counterpart jump. ⌘[ and ⌘] are Back and Forward
in Finder and Safari. T3 Code's ⌘⇧[ and ⌘⇧] are Safari's tab switch.

### 4.2 New shortcuts

| Key | Command | Where |
|---|---|---|
| ⌥⌘↓ | Next Albatross | Go menu. The next row in the sidebar's current order and filter. Wraps to the first. |
| ⌥⌘↑ | Previous Albatross | Go menu. Wraps to the last. |
| ⌥⌘↩ | Next Albatross That Needs You | Go menu. The first needs-you row after the open one, then from the top. Dimmed when none. Pairs with ⌘↩, the action that waits in the open thread. |
| ⇧⌘. | Stop and Redirect… | Albatross menu. Stops the open run and arms the composer (5.3). Dimmed when no run is open. |
| ⇧⌘U | Mark as Unread / Mark as Read | Albatross menu. The open thread, or the focused row. Mail's shortcut. |
| ⌃⌘A | Answer… | Albatross menu. Focuses the first empty field of the newest form in the open thread; from a focused row, opens the Answer popover. Dimmed when nothing waits. |
| ⌘K | Ask or Hold… | Unchanged: focuses the composer while a thread is on screen. |
| ⌘. | Stop | Unchanged, plus T11: it also stops a server reply. |
| ⌘Z | Undo | Unchanged: the undo notice after Stop from the list. |

No shortcut for the filter words; they are View menu items without keys. No ⌘1 to ⌘9 jump; the
tabs own them, and the HIG says to add custom shortcuts only when necessary.

### 4.3 Movement rules

- ⌥⌘↑ and ⌥⌘↓ move through the rows the sidebar shows now (the filter and "Show more" apply).
  The row with the selection fill is the open thread, so the keys read like a list.
- The keys work with the sidebar hidden. The order is the same.
- The keys work from the composer. The draft of the thread the user leaves is kept by
  `assistantDrafts`, as today.
- After "Mark Done", "Archive", or "Put It Down" on the open thread, the Mac opens the next row
  that needs the user; else the next row; else the Albatrosses page (T3 Code, issue #16090).
- "Answer" from a row never moves the selection; the user asked for the question in place.

### 4.4 Menus

A new "Go" menu after View (HIG: app-specific menus between View and Window; one-word titles):

```
Go
  Next Albatross                      ⌥⌘↓
  Previous Albatross                  ⌥⌘↑
  Next Albatross That Needs You       ⌥⌘↩
  ──
  Albatrosses                         ⌘4   (the page; the current tab command moves here)
```

The Albatross menu gains a group after "Ask or Hold…":

```
  Do the Next Action                  ⌘↩
  Answer…                             ⌃⌘A
  Stop                                ⌘.
  Stop and Redirect…                  ⇧⌘.
  Mark as Unread                      ⇧⌘U
```

The View menu gains, after "Show Details":

```
  ──
  Show Albatrosses                    (toggles the sidebar section's disclosure)
  All Albatrosses                     ✓ radio
  Needs You
  In Progress
```

Every item stays visible and dims when it does not apply (HIG, the menu bar).

### 4.5 Full Keyboard Access in the sidebar

- Tab reaches the "Albatrosses" header, its filter, each row, and "Show N more". A focused row
  shows its hover actions; Tab moves into them; Escape returns to the row.
- Space or Return on a row opens the thread. ⌃↩ opens the context menu (system).
- The inline steer field is in the tab order while open.

## 5. Steer in the thread (T7 to T9, T5, T11)

### 5.1 The composer while a run works

PR 1 sent every message through the chat model, which chose to steer. The brief changes this:
a message to a thread with a run in progress goes straight to the run. The Mac shows the choice
in the route chip the composer already has (Ask / Hold, Tab flips):

| Thread state | Chip default | Placeholder | Tab flips to |
|---|---|---|---|
| A run in progress | "To the run" | "Tell the run what to change" | "Ask" (the chat model, for a question like "when is the court date?"), then "Hold" |
| A reply in progress (`answering`) | "Ask" | "Tell Albatross what to do" (the message queues after the reply) | "Hold" |
| Anything else | "Ask" | PR 1's placeholders | "Hold" |

The chip tint for "To the run" is accent-3 (the highlight voice); Ask stays accent, Hold stays
accent-2. The send control takes the same tint. A hover over the chip reads "Return sends this to
the run. Tab changes where it goes."

### 5.2 Receipts (T7, T9)

A steer note shows as the user's bubble, and a caption row sits under it at the trailing edge,
caption size, secondary colour:

- "Sent to the run" while `readAt` is null.
- "Read by Albatross · 9:44" once the run reads it. On hover, the tooltip shows the full time.
- "Not read: the run ended first" with a text button "Send again" when the run ended with the
  note unread and no run continues. "Send again" posts the note to a new run of the step
  (`resume` with the note). If a run continues (the next run of the step), the caption reads
  "Carried to the next run" and the new run's log shows "Read your note: …" when it reads it.

The run block shows "9:44  Read your note: Use the two-year renewal" in its log (PR 1, decision
8). The caption and the log line together are the receipt. PR 1's decision 8 ("no extra sent
line") is reversed by the brief; the caption is the reversal.

### 5.3 Stop and redirect (T8)

- The run block gains a second button beside "Stop": "Stop and redirect" (bordered, same size).
  The Albatross menu has "Stop and Redirect…" with ⇧⌘..
- Press: the run stops at once (`cancel`). The block reads "Stopped by you." with "Continue". The
  composer arms: the chip reads "Redirect" (accent), the placeholder reads "What should Albatross
  do instead?", and focus moves to the field. A line above the field reads "The run stopped. Your
  next message starts it again from here." in the secondary colour.
- Send: posts `resume` on the stopped run with the note. A new run block renders as a
  continuation ("Continued · 9:46"), and its first log line is "Read your note: Go back and choose
  the Saturday session".
- Escape, or a click on the chip, disarms. The run stays stopped. Nothing is lost: the block still
  offers "Continue".
- Why stop on press and not on send: the owner's story is a run that goes the wrong way on a slow
  page. The next wrong click is seconds away. The server contract's one-call `redirect` fits web
  and iOS; the Mac can call it instead if the lead prefers (11.4).

### 5.4 Threads keep working (T5)

- The server now keeps a reply alive after the client disconnects, and it saves the result
  (brief, "Background replies"). The Mac also keeps up to three `WorkThreadModel`s warm in a
  registry: the open thread and the two most recently opened. A warm model keeps its stream and
  its 3-second run poll. A hop back to a warm thread shows the reply as it streams, with no reload
  (T3 Code keeps three rows warm for the same reason).
- The fourth thread evicts the oldest warm model. Its stream closes on the client; the server
  finishes and saves. When the user returns, the thread loads the saved copy. If the session is
  still `answering`, the thread shows one reply bubble with a breath dot and "Albatross replies"
  and polls the session every 3 seconds until the reply lands.
- The row shows "Albatross replies" while the server marks the session `answering`, then the
  unread mark when it ends (3.2).

### 5.5 Stop a reply (T11)

The composer's stop control and ⌘. post `POST /api/agent/stop { sessionId }` and cancel the local
stream. The bubble keeps the text so far with the line "Stopped." under it, as today, and
"Continue" where the chat offers it. The row's "Stop" on an `answering` thread does the same.

### 5.6 Parallel runs (T6)

- Nothing in the Mac UI counts runs. "Handle it" and "Try again" always work. The eleventh run
  comes back as `queued`; its block and its row read "Starts soon", and its time is the time since
  it was queued. When a slot frees, the block flips to "In progress" with no user action.
- The Albatrosses header count does not count runs. The Dock badge does not count runs.

## 6. Background awareness

### 6.1 Dock badge

- The badge is the number of threads that need the user (`needs_answer`, `your_turn`,
  `ready_for_you`), the same number as the sidebar header. Not the unread count: a finished run
  is news, not a task. Zero clears the badge.
- `NSApp.dockTile.badgeLabel` updates from the list store on every poll or live update. The badge
  updates while the app is frontmost too (HIG: increment a badge in the foreground instead of a
  banner).
- The Dock icon never bounces. No `requestUserAttention`.
- Settings, Notifications gains one switch, "Badge the Dock with what needs you", on by default.

### 6.2 Notifications

- One category, `LAB86_ALBATROSS`, with the actions "Open" (foreground) and "Answer" (a text
  input action, button "Send", placeholder "Type your answer"). "Answer" posts the text as a chat
  message to the thread, which answers the form in the chat (PR 1, S11).
- The server sends one notification for each event that needs the user: a question, a sign-in or
  final-page handoff, a "Ready for you" handoff, and a run that did not finish. It sends one
  notification when a run the user did not start from this device finishes ("Done"). It never
  sends one for a log line, a queued run, a reply, or a stop by the user.
- Title: the Albatross title. Body: the status line, for example "Needs your answer: Which
  payment account?" or "Did not finish: dmv.ny.gov did not load after three tries." Title-style
  capitalization only in the title; the body is a sentence. No personal detail values in the
  body (HIG).
- While the app is frontmost, the Mac suppresses the banner (`willPresent` returns `[.list,
  .badge]`, no `.banner`, for this category). The row, the header count, and the Dock badge
  carry the news. Mail is the HIG example for this.
- A click on the notification opens the thread with `WorkRoute.intent = .focusComposer` for a
  question, `.openPage` for a page handoff, else none. The current `NotificationResponseRouter`
  gains the `workId` key.
- A client error (a failed poll, a refused action) is never a notification. It is the shell's
  alert or the block's red line, as today.

### 6.3 The sidebar without noise

- The only things that move on their own: the breath of an in-progress dot, and the one-time
  move of a row that starts to need the user.
- No sounds from the app. The notification sound is the system's, and only when the app is in
  the background.
- No colour wash on a row. The dot and the title weight are the whole signal.
- The header count and the Dock badge are the same number, so the user learns one number.

## 7. Shared and Mac-only code

### 7.1 Assumptions about the shared views (the iOS designer owns them)

The Mac assumes these shared pieces exist with these names. Where the iOS note chooses other
names, the Mac follows.

| Shared piece | What the Mac needs from it |
|---|---|
| `Core/Models/AlbatrossThreadsStore.swift` | The list: `rows: [AlbatrossThreadRow]` from `GET /api/albatross/threads`, `poll(every:)` with 5 s while any row is in progress else 30 s, `markSeen(workId:)`, `markUnread(workId:)`, `needsYouCount`, `filter`. The Mac passes a `RowsSource` (`.poll` or `.subscribe`), like `RunsSource` in PR 1. |
| `Core/Models/AlbatrossThreadRow.swift` | The contract row: `workId, title, areaName, workState, status, statusLine, stepTitle, logLine, needsYou, pendingQuestionId, latestRunId, answering, lastActivityAt, seenAt, unread`, plus `runStartedAt` (11.2). |
| `Features/Work/ThreadRowPresentation.swift` | The pure rules of 3.2: `statusWord`, `line2`, `line3`, `indicator` (`.none`, `.needsYou`, `.inProgress`, `.queued`, `.done`, `.failed`, `.stopped`), `titleWeight`, `timeLabel(now:)`, `hoverActions`, `group`, `sortKey`, and `isAwake(now:)`. Tested on both platforms. The iOS `WorkListRow` and the Mac row read the same rules, so Back on the phone and the sidebar on the Mac agree. |
| `WorkThreadModel` | `steer(_ note:)`, `redirect(_ note:)` (or stop then resume, 11.4), `stopReply()`, `markSeen()`, `routeDefault` (run, ask), `armRedirect()`, `receipt(for message:)`. |
| `AssistantComposer` and `RouteChip` | A third route `run` with its tint and placeholder, and the armed "Redirect" state. `#if os(macOS)`: the chip's hover help text. |
| `AssistantMessageRow` | The receipt caption under a user message with `metadata.steer`: "Sent to the run", "Read by Albatross · 9:44", "Not read: the run ended first" + "Send again", "Carried to the next run". `#if os(macOS)`: the time tooltip. |
| `RunBlockView` | The "Stop and redirect" button beside "Stop". |
| `FormQuestionCard` | Nothing new. The Mac mounts it in the Answer popover. It must not assume a thread environment; the Mac passes `onSubmit` directly. |
| `WorkView` (the Albatrosses page) | Its rows take `ThreadRowPresentation`, so the page is live on the Mac too (T1). |

### 7.2 Mac-only files

| File | What it holds |
|---|---|
| `Lab86MailMac/Shell/MacThreadRows.swift` | The "Albatrosses" section of `MacSourceList`: the disclosure header with the count and the filter pull-down, the rows, "Show N more", the empty lines. Reads `AlbatrossThreadsStore` from the environment. |
| `Lab86MailMac/Shell/MacThreadRow.swift` | One row: the dot (`MacThreadDot`, with the breath), the three lines, the time slot that yields to hover actions, the inline steer field, the context menu, the hover card, the accessibility label. |
| `Lab86MailMac/Shell/MacThreadListLayout.swift` | The pure Mac rules: the awake set, the cap of 12, the "Show N more" count, the sort inside groups, the hidden-row dot, `nextRow(after:)`, `nextNeedsYou(after:)`, the widths. Unit tests cover each row of 2.3 and 3.2. |
| `Lab86MailMac/Shell/MacAnswerPopover.swift` | The Answer popover around `FormQuestionCard`, with the allow fallback line. |
| `Lab86MailMac/Shell/MacThreadRegistry.swift` | The warm models: at most three `WorkThreadModel`s keyed by `workId`, LRU, with `model(for:)` and `evict()`. `MacWorkThreadView` asks it instead of `WorkThreadModel(…)`. |
| `Lab86MailMac/Shell/MacGoCommands.swift` | The Go menu. Requests go through `MacRequests` (`requestThreadMove(.next | .previous | .nextNeedsYou)`), so the shell answers them with or without a thread on screen. |
| `Lab86MailMac/Shell/MacThreadCommands.swift` | Adds the Albatross menu group (Do the Next Action, Answer…, Stop, Stop and Redirect…, Mark as Unread) and the View menu group (Show Albatrosses, the filter radio). |
| `Lab86MailMac/Shell/MacThreadsToolbarButton.swift` | The toolbar item for a hidden sidebar with its popover. |
| `Lab86MailMac/App/MacDockBadge.swift` | `NSApp.dockTile.badgeLabel` from `needsYouCount`, with the Settings switch. |
| `Lab86MailMac/App/MacAppDelegate.swift` | `willPresent` suppresses the banner for `LAB86_ALBATROSS` while frontmost. |
| `Lab86MailTests/Tour/NativeTourMacTests.swift` | New screens: `mac-sidebar-threads` (eight rows, mixed states), `mac-sidebar-threads-hover` (the inline steer field), `mac-sidebar-answer-popover`, `mac-work-thread-receipt` (a note with "Read by Albatross"), `mac-work-thread-redirect` (the armed composer). The tour cannot draw a popover; `mac-sidebar-answer-popover` renders the popover body alone. |

`#if os(macOS)` branches the Mac asks for in shared code: the route chip help text, the receipt
time tooltip, `RowsSource.subscribe` (11.5), and `WorkRoute.Intent.focusComposer` from a
notification action (exists).

### 7.3 Data source on the Mac

The brief names a Convex query `albatrossThreads.list`, live on web and polled by native. The
Mac already subscribes to Convex for runs (PR 1, decision 18). Recommendation: the Mac subscribes
to `albatrossThreads.list` when the Convex client is authorized, and polls as the fallback (11.5).
With a subscription, the row's line 3 moves with the run; with the poll, it moves every 5
seconds. Both satisfy T1.

## 8. The stories on the Mac

Copy is exact. Sentence case in the content; title case in the menus.

**T1. A live list.** Sam has four Albatrosses in flight. The sidebar reads, top to bottom:

```
Albatrosses  2                                          All ⌄
● Pay the water bill                                      2m
  Needs your answer · Choose the payment account
● Send Sam Rivera the lease                               9m
  Your turn · Sign in to leases.example.com
◌ Renew the car registration                              3m
  In progress · Fill the renewal form
  Typed your saved Driver's license on dmv.ny.gov
◌ Plan the Lisbon trip                                   now
  Albatross replies
  Three fares under $600 leave before noon on…
○ Book the dentist                                        1m
  Starts soon · Find an open slot
● Cancel the gym membership                               1h
  Done · Verified on the page
● Return the library books                               Mon
  Did not finish · Renew the loan
  File the expense report                                 Tue
  Stopped · Upload the receipts
  Show 4 more
```

The rows that need Sam come first, then the ones in progress, then the newest. Sam presses Back
in an open thread: the Albatrosses page shows the same words on its rows, under its state groups.

**T2. Unread.** The gym run finished while Sam was in another thread. Its row shows a filled green
dot and a semibold title, "Done · Verified on the page". Sam opens it. After one second, the dot
goes, the title is regular, and the Dock badge did not change (done is not a task). Sam presses
⇧⌘U: the dot and the weight return.

**T3. Hop.** The window is 1,440 wide. Sam clicks "Plan the Lisbon trip" in the sidebar. The
conversation crossfades to the Lisbon thread; its row takes the selection fill. Sam presses ⌥⌘↓:
"Book the dentist" opens. ⌥⌘↑ twice: "Renew the car registration". ⌥⌘↩: "Pay the water bill",
the first row that needs Sam. Each thread keeps its draft and its pane state.

**T4. Hop (iPad).** Not a Mac story. The iPad takes the shared rows in its sidebar; the iOS note
owns it.

**T5. Threads keep working.** In "Plan the Lisbon trip" Sam writes "Which fare has free
cancellation?" and presses ⌥⌘↓ at once. The row reads "Albatross replies" with a breath dot and
"now". Sam reads the dentist thread for a minute. The Lisbon row's dot turns to a filled accent-2
dot with no breath, and the title goes semibold: unread. Sam presses ⌥⌘↑. The reply is there,
complete, because the Lisbon model stayed warm. Had Sam opened four other threads first, the
reply would still be there from the server's saved copy.

**T6. Several runs at once.** Sam presses "Handle it" in four threads. All four rows breathe. The
Dock badge stays at 2. Later, an eleventh "Handle it" shows "Starts soon · Find an open slot"
with a hollow ring. When a run ends, the ring fills and breathes, and the block reads "In
progress".

**T7. Steer directly.** In "Renew the car registration" the chip reads "To the run". Sam writes
"Use the two-year renewal" and presses Return. The bubble appears with the caption "Sent to the
run". Six seconds later the caption reads "Read by Albatross · 9:44" and the block's log gains
"9:44  Read your note: Use the two-year renewal". The row's line 3 reads the same log line.

**T8. Stop and redirect.** The run opens the wrong form on a slow page. Sam presses "Stop and
redirect" (or ⇧⌘.). The block reads "Stopped by you." at once. The chip reads "Redirect", the
placeholder "What should Albatross do instead?", and the line above the field reads "The run
stopped. Your next message starts it again from here." Sam writes "Go back and choose the
two-year renewal, not the plates" and presses Return. A new block reads "Continued · 9:46" with
"9:46  Read your note: Go back and choose the two-year renewal, not the plates".

**T9. A note that came too late.** Sam writes "Skip the email receipt" one second before the run
hands off. The caption reads "Sent to the run", then "Not read: the run ended first" with "Send
again". Sam presses "Continue" on the handoff first; the caption flips to "Carried to the next
run", and the continuation's log reads "Read your note: Skip the email receipt". Had Sam pressed
"Send again" instead, the note would have started the continuation by itself.

**T10. Answer and steer from the list.** Sam hovers "Pay the water bill". The time hides and
"Answer" shows. A click opens the popover: "Which account pays this bill?" with two choices,
"Checking, last digits 0100" and "Savings, last digits 0200", and "Continue". Sam picks the first and
presses Return. The popover closes; the row moves down into "in progress" with "In progress ·
Pay the bill". Sam hovers "Plan the Lisbon trip": "Steer" and "Stop". A click on "Steer" opens
the inline field; "Prefer a morning flight on the way out", Return. Line 3 reads "Sent to the
run", then "Read by Albatross".

**T11. Stop a reply.** The Lisbon reply runs long. Sam presses ⌘. in the thread. The bubble keeps
its text with "Stopped." under it. The row loses its breath dot. On Sam's phone the same reply
is stopped, because the stop went to the server.

**T12. Find a thread.** Sam has 23 Albatrosses. The sidebar shows 12 and "Show 11 more". Sam
chooses "Needs you ⌄" in the header: three rows remain. "In progress ⌄": five rows, the four runs
and the queued one. "All ⌄": twelve rows again. The View menu shows the same three words with a
check mark.

## 9. Accessibility, dark mode, vibrancy

### 9.1 VoiceOver

- A row is one element. Label: "{title}. {status word}. {step or detail}. {log line}. {time}.
  Unread." in that order, with "Unread" only when unread. Example: "Renew the car registration.
  In progress. Fill the renewal form. Typed your saved Driver's license on dmv.ny.gov. 3 minutes."
  Traits: button; selected for the open thread.
- The hover actions are separate elements after the row, in the same order as on screen, so the
  rotor reaches "Answer", "Steer", and "Stop" without hover. The context menu is the second path.
- The elapsed time is not a live region. It ticks silently (T3 Code's lesson).
- `PlatformAccessibility.announce` fires once when a thread that is not on screen starts to need
  the user: "Pay the water bill needs your answer." It never announces a log line, a reply, or a
  finished run. The open thread's own announcements (PR 1, section 7) stay.
- The "Albatrosses" header has the label "Albatrosses, 2 need you, collapsed" or "expanded". The
  filter pull-down has the label "Filter" and the value "All".
- The inline steer field has the label "Note to the run for {title}" and the hint "Return sends.
  Escape cancels."
- The receipt caption is part of the bubble's label: "You: Use the two-year renewal. Read by
  Albatross at 9:44."

### 9.2 Full Keyboard Access

Section 4.5. Every hover action, the filter, the disclosure, "Show N more", and the inline field
are in the tab order. The popover traps focus while open and returns it to the row on close.

### 9.3 Dark mode

- The sidebar keeps its system vibrancy. The dots use the theme's `accentColor`, `accent2Color`,
  the system green and red, and the secondary colour; each passes 3:1 against the vibrant sidebar
  in both appearances (the palette sweep test covers the accents; green and red are system
  colours).
- The inline field uses `elevatedColor` with `hairlineColor`, so it reads as a field on a vibrant
  surface in both appearances.
- The popover is the system popover material. The form inside is the thread's card on paper.

### 9.4 Vibrancy and the tour

- The thread rows draw text and shapes only, no materials, so the sidebar's vibrancy stays as it
  is. `cacheDisplay` drops vibrancy in the tour; the rows still render true.
- The popover and the hover card do not appear in the tour; their bodies render alone.

## 10. Wireframes

Window 1,440 by 900. Sidebar 280, conversation 544, pane 616. "●" is a filled dot, "◌" a dot
that breathes, "○" a hollow ring.

### 10.1 The window with the threads sidebar and an open run (T1, T3, T7)

```
┌────────────────────────────┬────────────────────────────────────────────┬────────────────────────────────┐
│ Albatross            [+]   │ Renew the car registration                 │                  [◎] [▣] [⋯]   │
│                            │ Step 2 of 3 · Albatross works ⌄            │                                │
├────────────────────────────┼────────────────────────────────────────────┼────────────────────────────────┤
│ Search mail          ⌘F    │                                            │ ● Albatross is on the page     │
│                            │ Started on the step                        │   Fills the renewal form       │
│ Today                      │ ┃ ◌ In progress · Started by you · 9:41    │          [Take over]  Larger ⌄ │
│ ⌄ Albatrosses  2    All ⌄  │ ┃   Fill the renewal form                  ├────────────────────────────────┤
│   ● Pay the water bill  2m │ ┃   9:41  Opened dmv.ny.gov                │ ┌────────────────────────────┐ │
│     Needs your answer ·    │ ┃   9:42  Read your details: name,         │ │ NY DMV · Renew registration│ │
│     Choose the payment ac… │ ┃         address                          │ │                            │ │
│   ● Send Sam Rivera the l… │ ┃   9:43  Typed your saved Driver's        │ │ Plate        [ABC 1234   ] │ │
│     Your turn · Sign in to…│ ┃         license on dmv.ny.gov            │ │ License      [•••• 0100  ] │ │
│ ▸ ◌ Renew the car regist…  │ ┃   Show all 7 lines                       │ │ Term   (•) 2 years         │ │
│     In progress · Fill the…│ ┃   ● Albatross is on the page · dmv.ny.g… │ │        ( ) 1 year          │ │
│     Typed your saved Driv… │ ┃                            Hide the page │ │                            │ │
│   ◌ Plan the Lisbon trip   │ ┃            [Stop]   [Stop and redirect]  │ │ [Continue]                 │ │
│     Albatross replies  now │                                            │ │                            │ │
│     Three fares under $60… │                           ┌──────────────┐ │ │                            │ │
│   ○ Book the dentist    1m │                           │ Use the      │ │ │                            │ │
│     Starts soon · Find an… │                           │ two-year     │ │ │                            │ │
│   ● Cancel the gym memb… 1h│                           │ renewal      │ │ │                            │ │
│     Done · Verified on the…│                           └──────────────┘ │ │                            │ │
│   ● Return the library… Mon│                  Read by Albatross · 9:44  │ │                            │ │
│     Did not finish · Rene… │                                            │ │                            │ │
│     File the expense r… Tue│ ┃   9:44  Read your note: Use the two-year │ │                            │ │
│     Stopped · Upload the…  │ ┃         renewal                          │ └────────────────────────────┘ │
│     Show 4 more            │                                            │                                │
│ Chat                       │ ┌────────────────────────────────────────┐ │                                │
│ Mail                       │ │ (clip) Tell the run what to change     │ │                                │
│ Calendar                   │ │                        To the run (up) │ │                                │
│ Settings                   │ └────────────────────────────────────────┘ │                                │
└────────────────────────────┴────────────────────────────────────────────┴────────────────────────────────┘
```

"▸" marks the selection fill of the open thread (drawn as a fill, not a glyph). `[◎] [▣] [⋯]`
are the Page toggle, the Details toggle, and the menu (PR 1). "(clip)" is the attach control,
"(up)" the send control, "To the run" the route chip.

### 10.2 A hovered row with the inline steer field (T10)

At rest:

```
│   ◌ Plan the Lisbon trip                          now │
│     Albatross replies                                 │
│     Three fares under $600 leave before noon on…      │
```

On hover (the time yields to the actions):

```
│   ◌ Plan the Lisbon trip                   Steer  Stop│
│     In progress · Compare the fares                   │
│     Three fares under $600 leave before noon on…      │
```

After "Steer" (line 3 becomes the field; the row grows by one line):

```
│   ◌ Plan the Lisbon trip                              │
│     In progress · Compare the fares                   │
│     ┌───────────────────────────────────────────────┐ │
│     │ Prefer a morning flight on the way out      ↩ │ │
│     └───────────────────────────────────────────────┘ │
```

After Return:

```
│   ◌ Plan the Lisbon trip                          now │
│     In progress · Compare the fares                   │
│     Sent to the run                                   │
```

Then, when the run reads it:

```
│     Read by Albatross                                 │
```

### 10.3 The Answer popover (T10)

```
│   ● Pay the water bill                    Answer │ ┌──────────────────────────────────────┐
│     Needs your answer · Choose the payment ac…  │◂│ Which account pays this bill?         │
│                                                 │ │ The bill is $84.20, due October 15.   │
                                                    │                                      │
                                                    │ Account                              │
                                                    │ ( ) Checking, last digits 0100       │
                                                    │     Matches what you said            │
                                                    │ ( ) Savings, last digits 0200        │
                                                    │ ( ) Other  [                      ]  │
                                                    │                                      │
                                                    │                          [Continue]  │
                                                    └──────────────────────────────────────┘
```

### 10.4 The sidebar hidden: the toolbar item and its popover

```
┌────────────────────────────────────────────────────────────────────────────────────┐
│ ≡  [☰•]  Renew the car registration                              [◎] [▣] [⋯]       │
│          Step 2 of 3 · Albatross works ⌄                                           │
├────────────────────────────────────────────────────────────────────────────────────┤
│          ┌──────────────────────────────────────┐                                  │
│          │ Albatrosses  2                All ⌄  │                                  │
│          │ ● Pay the water bill             2m  │                                  │
│          │   Needs your answer · Choose the…    │                                  │
│          │ ● Send Sam Rivera the lease      9m  │                                  │
│          │   Your turn · Sign in to leases.e…   │                                  │
│          │ ◌ Renew the car registration     3m  │  ← selection fill               │
│          │   In progress · Fill the renewal…    │                                  │
│          │   …                                  │                                  │
│          └──────────────────────────────────────┘                                  │
```

`[☰•]` is the Threads toolbar item with its accent dot. It shows only while the sidebar is hidden.

## 11. Open questions for the lead designer

1. **A sidebar section, or a second column?** Recommendation: the sidebar section. It is the
   owner's reference, it keeps three columns, and the PR 1 collapse rule still works. If the owner
   reaches fifty live Albatrosses, revisit with search (T12's later step) and a content column.
2. **The awake rule and the cap of 12.** The server returns every non-archived Work. The Mac shows
   the awake set and caps at 12 with "Show N more". Recommendation: keep the client rule, and add
   `runStartedAt` to the contract row for the elapsed time (the brief's row has no start time).
   Alternative: the server marks `awake` itself, so all three clients agree.
3. **"Answering".** The brief allows a plain word. Recommendation: "Albatross replies". It matches
   the plan line's "Albatross works" (PR 1) and has no -ing form. The contract's `status` value
   stays `answering`; only the words change. If the lead prefers one word, "Reply" alone reads as
   a verb; avoid it.
4. **Stop and redirect: stop on press, or one call on send?** Recommendation on the Mac: stop on
   press (`cancel`), arm the composer, then `resume` with the note. The run cannot take one more
   wrong step while the user types. If the lead wants one behaviour on all platforms, the Mac can
   arm first and post `redirect` on send; then the line above the field must read "The run
   continues until you send."
5. **The list source on the Mac: subscribe or poll?** Recommendation: subscribe to
   `albatrossThreads.list` as the Mac does for runs (PR 1, decision 18), with the 5 s / 30 s poll
   as the fallback. Line 3 then moves with the run.
6. **Warm thread models.** Recommendation: keep three. Memory is one chat model and one run poll
   each. The server copy is the truth either way, so eviction is safe.
7. **Dock badge counts "needs you" only.** Recommendation: yes. Unread would badge every finished
   run, and the owner would stop to read the number. Mail badges unread because mail is read;
   Albatrosses are done.
8. **⌥⌘↑ / ⌥⌘↓ and ⌥⌘↩.** Recommendation: as in 4.2. ⌘↑ and ⌘↓ belong to the composer's text
   view; ⌃⌘↑ and ⌃⌘↓ are Xcode's. ⌥⌘↩ pairs with ⌘↩, which the owner already knows. If ⌥⌘↩
   collides with a system Input Source shortcut on the owner's Mac, the fallback is ⌃⌘↩.
9. **Mark as Unread.** The brief's `seen` route takes `{ workId }`. Recommendation: accept
   `{ workId, unread: true }` to clear `seenAt`, so ⇧⌘U works on every platform. If the lead
   declines, the Mac drops the item; T3 Code has it, and the owner's reference matters.
10. **The route chip's "To the run" default.** The brief says a message during a run goes straight
    to the run. Recommendation: the chip, default "To the run", Tab flips to "Ask". Without the
    chip, the owner cannot ask a question during a run; the question goes to the run instead.
11. **The Answer popover's scope.** Recommendation: forms only. An allow (`allow_secure`) and an
    identity check stay in the thread; the popover says so with "Open". A question from the
    planner (legacy choice) works, because `legacyQuestionToForm` makes it a form.
12. **Sidebar widths.** Recommendation: ideal 280, max 400. The change touches every tab, but
    only the thread rows use the room. If the lead keeps 260, the rows truncate harder and line 3
    drops the time.
13. **Notifications category and the foreground rule.** Recommendation: the one category with
    "Open" and "Answer", no banner while frontmost. This needs the server to send `workId`,
    `category`, and the status line. The iOS designer should confirm the same category fits the
    phone (banners while frontmost are fine there; the Mac suppresses them).
14. **Next thread after "Mark Done" or "Archive".** Recommendation: open the next row that needs
    the user, else the next row, else the page. T3 Code's users filed the opposite as a bug.
15. **The Dock menu (phase 2).** A Dock menu that lists the rows that need the user, each a jump.
    Recommendation: after the sidebar ships; the HIG wants the same items elsewhere first, and the
    sidebar is that place.

## Copy table (Mac additions)

Shared lines are in the iOS note's tables. These are Mac only, or new in PR 3 on the Mac.

| Where | Line |
|---|---|
| Sidebar header | "Albatrosses", the count as a number, "All", "Needs you", "In progress" |
| Row status words | "Needs your answer", "Your turn", "Ready for you", "In progress", "Albatross replies", "Starts soon", "Done", "Did not finish", "Stopped" |
| Row line 2 for idle | "Next: {nextStep}", else the Area name |
| Row times | "now", "{n}m", "{n}h", "{weekday}", "{Mon d}"; elapsed "<1m", "{n}m", "{n}h {m}m" |
| Show more | "Show {n} more", "Show fewer" |
| Empty filter | "Nothing needs you.", "Nothing in progress." |
| Hover actions | "Answer", "Steer", "Stop", "Try again", "Continue", "Send again" |
| Inline field | prompt "Tell the run what to change"; hint "Return sends. Escape cancels." |
| Row receipts | "Sent to the run", "Read by Albatross", "Not read: the run ended first", "Carried to the next run" |
| Undo notice | "Stopped {title}" with "Undo" |
| Answer popover fallback | "Open the thread to allow this." with "Open" |
| Hover card | "Started by you · 9:41", "Started by the Brief · 7:02" |
| Toolbar item (sidebar hidden) | help "Show the Albatrosses (Control-Command-S shows the sidebar)" |
| Composer chip | "To the run", "Ask", "Hold", "Redirect"; help "Return sends this to the run. Tab changes where it goes." |
| Composer placeholders | "Tell the run what to change", "What should Albatross do instead?" |
| Redirect line | "The run stopped. Your next message starts it again from here." |
| Thread receipts | "Sent to the run", "Read by Albatross · 9:44", "Not read: the run ended first" + "Send again", "Carried to the next run" |
| Run block | "Stop and redirect" |
| Go menu | "Next Albatross", "Previous Albatross", "Next Albatross That Needs You", "Albatrosses" |
| Albatross menu | "Do the Next Action", "Answer…", "Stop", "Stop and Redirect…", "Mark as Unread", "Mark as Read" |
| View menu | "Show Albatrosses", "Hide Albatrosses", "All Albatrosses", "Needs You", "In Progress" |
| Context menu | "Open", "Answer…", "Steer…", "Stop", "Stop and Redirect…", "Try Again", "Continue", "Mark as Unread", "Mark as Read", "Show in Area", "Put It Down", "Pick It Up", "Mark Done", "Archive…" |
| Settings, Notifications | "Badge the Dock with what needs you" |
| Notification | title = the Albatross title; body "Needs your answer: {question title}", "Your turn: {next.detail}", "Ready for you: {summary}", "Did not finish: {error}", "Done: {proof line}"; actions "Open", "Answer" (button "Send", placeholder "Type your answer") |
| VoiceOver | "{title}. {status}. {detail}. {log line}. {time}. Unread."; "Albatrosses, 2 need you, collapsed"; "Note to the run for {title}"; "{title} needs your answer." |
| Shortcut reference | "⌥⌘↓ Next Albatross", "⌥⌘↑ Previous Albatross", "⌥⌘↩ Next Albatross that needs you", "⇧⌘. Stop and redirect", "⇧⌘U Mark as unread", "⌃⌘A Answer" |

## 12. Build notes (2026-10-08)

The Mac pass landed in `apps/ios` with the lead decisions applied. Where the build departs from
the sections above, the lead decisions win.

- **Words.** The row reads the shared `ThreadRowPresentation` words: "Reply in progress", not
  "Albatross replies". Groups are "Needs you", "In progress", "Open". Line 2 is "Status word ·
  preview"; there is no third line. The hover placeholder is the shared "Tell Albatross what to
  change".
- **Data.** The section reads the shared `ThreadsStore` poll (5 s while a row works, else 30 s).
  No Convex subscription. The shell (`MacShellView`) is the poll's viewer for as long as the
  window exists; a hidden app pauses it, a hidden sidebar does not.
- **The section.** `MacThreadRows` is a `DisclosureGroup` whose label is the "Albatrosses" row,
  inside the primaries section of `MacSourceList`. The needs-you count and the filter pull-down
  sit in the label. The awake rule, the cap of 12, and "Show N more" are `MacThreadListLayout`.
- **Hover verbs.** Answer (a popover with the PR 1 form card, `MacAnswerPopover`), Steer (the
  inline field, sent with `steer`), Stop (no dialog; a "Stopped {title}" row with "Continue" for
  ten seconds under the rows, not the shell's undo notice), Continue, "Open the page". "Try again"
  is not a hover verb; the shared verbs have none. "Stop and redirect" from the context menu uses
  the inline field and one `redirect` call (lead decision 6).
- **Receipts in the row.** The list poll carries no run notes, so the row shows "Sent to the run"
  for six seconds after a note, then reads live again. The thread shows the full receipt.
- **The hop.** ⌥⌘↑ / ⌥⌘↓ move through every awake row under the filter, not only the twelve on
  screen. ⌥⌘↩ opens the next row that needs the user. After "Mark done" or "Archive" the next
  row that needs the user opens, else the next row, else the Albatrosses page.
- **Menus.** A "Go" menu (`MacGoCommands`); "Stop and Redirect…" (⇧⌘.) and "Mark as Unread"
  (⇧⌘U) in the Albatross menu; "Show Albatrosses" and the filter radio in the View menu.
- **The banner.** The thread shows the shared `NeedsYouBanner` only while the source list is
  hidden; with the list shown, its row shows the change.
- **Seen.** The thread marks itself seen on open and when new activity lands, as iOS does. ⇧⌘U
  on the open thread holds the unread mark until the next thread opens.
- **No toolbar item for a hidden sidebar.** The Go menu covers the hop; the toolbar item of 2.4
  is not built.
- **Dock badge.** `MacDockBadge` writes `needsYouCount`. No Settings switch in this pass.
- **No notification category.** Lead decision 10.
- **Tour.** `mac-work-thread-receipt` (the shell with the section and the note receipt) and
  `mac-sidebar-threads-steer` (the section alone with one inline field open, through the
  `initialSteerWorkID` seam).
