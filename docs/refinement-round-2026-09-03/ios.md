# iOS design note: refinement round 2026-09-03

Status: planning input for the iOS implementation subagent. Owner: Claude. Written 2026-09-03.

This note gives one chosen expression for each wave on iOS. It fits the existing design
system: `Surface.swift` paper and elevation, OKLCH accents, `InitialsAvatar`, display serif for
titles and datelines, `surfaceCard()` for one elevation step, glass capsules for floating chrome.
Taste rules apply: no sparkle or star icons, no icon before text, no ALL-CAPS labels, plain
verbs, and the word "AI" never appears in copy.

Tools used: Mobbin MCP (iOS, deep mode) and Browserbase from the shell. The `browserbase-key`
launcher looks for a retired OpenClaw path; the calls sourced `browserbase.env` instead.

Shared motion vocabulary:

- `settle`: `.snappy(duration: 0.32, extraBounce: 0.04)`, the curve the shell already uses.
- `rise`: `.smooth(duration: 0.26)` with an 8 pt vertical offset and opacity 0 to 1.
- `cross`: `.easeInOut(duration: 0.18)` for text and colour swaps.
- Reduce Motion replaces every move with `cross`. Nothing travels.
- Haptics use `.sensoryFeedback` on iOS. `PlatformHaptics` stays silent on the Mac.

---

## Wave A. Today cleanup, Later shelf, horizon control, wake nudge

### Findings

- Things 3, "Upcoming" ([screen](https://mobbin.com/screens/1f3adaff-5def-4789-a938-456435ecd4df)):
  each future day is a large numeral header, and deferred rows sit under it in a lighter tone,
  so the future reads as a calendar and not as a backlog.
- Things 3 support (https://culturedcode.com/things/support/articles/4001304/): a scheduled
  item "hops into Today, a gentle nudge of commitment"; projects in hibernation leave the
  sidebar; Someday items "take a backseat visually". This is the dormant contract.
- Microsoft Outlook, snooze sheet ([screen](https://mobbin.com/screens/946c0a3b-6b40-4070-8e80-805f3303c02d)):
  four presets show the resolved date on the right ("Next Week  Mon. 8:00 AM"), then one
  "Choose a Time" row. The user sees the real date before the tap.
- Mesh, defer menu ([screen](https://mobbin.com/screens/6bd1848f-4f4d-4f43-b22e-4832c55ab307)):
  "Tomorrow / Someday / Custom" tabs plus presets with the resolved date under each. Someday
  is a first-class option beside the dates.
- Duolingo Live Activity ([screen](https://mobbin.com/screens/97acbdbc-0d3b-4070-8711-fa4797ea9e66)):
  one line of text, one small action. The banner never explains itself.
- Canopi, "Next / Past" card row ([screen](https://mobbin.com/screens/a9768b9f-0911-498d-b64c-ee59b1c70fa8)):
  a date label above a horizontal row of small cards reads as a shelf, not as a list.

### Chosen expression

**Today.** Keep the masthead, the deck sentence, "Your day" (the ribbon), a new "Mail that
matters" section, and one "Next move" line. Remove "Do this next", "Needs you", "The plan
slipped", and "In motion". Remove `MissedMoveRecoveryView` from `CalendarView`.

- "Mail that matters": at most 4 rows. `InitialsAvatar` 32 pt, sender in the display face,
  subject in body, one secondary line with the reason ("Asked for the venue count"). Tap opens
  the thread. Hairline dividers, no card.
- "Next move": renders only when a move is scheduled for today. A 2 pt accent bar, the step
  title in `.subheadline` semibold, the time in secondary. Tap opens the Work. No empty state.
- Deck copy: `TodayComposition.dayShapeLine` drops the "carrying N things" clause. Example:
  "Three meetings. One reply owed. The afternoon is open."
**Later shelf (WorkView).** A horizontal timeline under the open groups and above "Areas",
shown only when dormant Work exists. Section rule "Later", note "Sleeps until its date."

- A 1 pt hairline rail runs the full width of a horizontal `ScrollView`. Month ticks sit on
  the rail in `.caption2` monospaced digits ("Oct", "Nov", "Jan").
- Each dormant Work is a `surfaceCard(cornerRadius: 14)`, 168 pt wide, placed at the x of
  its `notBefore` month. Cards in one month stack with an 8 pt offset at scale 0.96; a tap
  fans them open with `settle`.
- Card content: title (2 lines, `.subheadline`), horizon line in the display italic
  ("Back on Nov 1"), area name in `.caption2` secondary.
- The far end holds a "Someday" group: same cards, no tick, label "Someday".
- Motion: on first appearance the cards `rise` with a 40 ms stagger, left to right.
- Gestures: tap opens the Work. Long press: "Wake now", "Change horizon".
- Dynamic Type: at `.accessibility1` and larger the shelf becomes a vertical list with a
  leading date column.
- Accessibility: the shelf is one container labelled "Later, 4 items". A card reads
  "Passport renewal, back on November 1, Personal".
- Empty: the shelf does not render.

**Horizon control (WorkDetail).** `HorizonSheet`, detent `.medium`, opened from the lead's
state label and from the actions menu item "Set horizon".

- A segmented control with three words: "Now", "Later", "Someday".
- "Later" reveals presets with the resolved date on the right: "Next week  Mon 8 Sep",
  "Next month  1 Oct", "In three months  3 Dec", "Pick a date" (compact graphical picker).
- Under the presets, one text field, placeholder "Or say it: after the wedding". It calls
  `parseHorizonHint` on each keystroke and prints the result: "Back on Nov 1". Unparsed text
  shows "Kept as your words. No date." and stores `label` only.
- A disclosure row "Soft target" holds the optional `by` date. It never enforces.
- Confirm button: "Set". Cancel is the sheet swipe. Haptic `.selection` on segment change,
  `.success` on "Set".
- On "Set" the lead crossfades its state label to the horizon line. If the Work was opened
  from the open groups, the page pops to WorkView and the card `rise`s on the shelf.

**Wake nudge.** One copy on two surfaces: "{title} is back. Ready when you are."

- In app: `WakeNudgeBanner` slides in from the trailing edge under the navigation bar, a
  52 pt glass capsule, text on the left, one plain-text button "Open" on the right. `settle`
  on entry, auto-dismiss after 6 s with `cross`, or a swipe to the trailing edge. Haptic
  `.impact(flexibility: .soft)` once.
- Background: the notifications pipeline delivers the same line as a push from the
  `albatrossNotifications` row. Tap opens the Work. Shown once per wake (`wokeAt`).

### Component plan

- Change: `TodayView` (remove four sections, add `MailThatMattersSection`, `NextMoveLine`),
  `TodayComposition.dayShapeLine`, `CalendarView` (drop the missed-move banner), `WorkView`
  (add `LaterShelf`), `WorkDetailView` (lead label opens `HorizonSheet`; menu item),
  `WorkListItem` (`horizon`).
- New: `LaterShelf` (state: `dormantItems`, `months`, `expandedMonth`, `useVerticalLayout`),
  `LaterCard`, `HorizonSheet` (state: `kind`, `notBefore`, `by`, `hint`, `parsedLine`,
  `isSaving`), `WakeNudgeBanner` (state: `nudge`, `dismissAt`), `HorizonLine` helper that
  mirrors `lib/albatross/horizon.ts` and shares its fixtures.
- MobileAPI: `horizon` on the Work payload, `work.setHorizon` command.
- Mac branch likely: `LaterShelf` hover peek instead of long press; `WakeNudgeBanner` anchors
  top-trailing in the window; `HorizonSheet` presents as a popover from the label.

---

## Wave B. Calendar sync state on view open and pull to refresh

### Findings

- Telegram, chat list ([screen](https://mobbin.com/screens/a8d272e2-66cd-46d0-8761-f85b0dac21e0)):
  the title becomes "Updating…" with a small spinner, then returns. The state lives in the
  bar, not in a banner.
- Apple Mail iOS 26, inbox ([screen](https://mobbin.com/screens/29577d38-adb0-43cd-8d37-c6792146fc2f)):
  a secondary line under the title reads "Gmail · Updated Just Now". Freshness costs one line.
- Apple newsroom, iOS 26 design
  (https://www.apple.com/newsroom/2025/06/apple-introduces-a-delightful-and-elegant-new-software-design/):
  bars "give way to content" and "shrink to bring focus to the content" on scroll. A sync
  indicator must be a line, not a bar.

### Chosen expression

- Freshness line: the navigation subtitle (`navigationSubtitle`, iOS 26) reads "Updated just
  now", "Updated 4 min ago", or "Syncing…". It never states the reason.
- Sync line: a 2 pt line under the week strip, `hairlineColor` track. While a sync runs, a
  96 pt accent segment moves left to right on a 1.1 s linear loop. On success it stretches to
  the full width in 180 ms and fades in 220 ms. On failure it stops, turns `accent2Color`,
  fades after 400 ms, and the subtitle reads "Could not sync. Pull to try again."
- View open: on `task`, if `lastSyncedAt` is older than two minutes, call
  `calendar.resync(reason: .viewOpen)`. If `started` is false, the line never shows.
- Pull to refresh: `refreshable` calls `calendar.resync(reason: .pull)` and waits for the
  mirror read. Spinner and line show together. Haptic `.impact(flexibility: .soft)` on
  completion.
- Post-mutation: a new event renders at once with a dashed 1 pt border
  (`StrokeStyle(dash: [4, 3])`) and no attendee state. When the server copy lands, the border
  turns solid with `cross` and the attendee state fills in. Deleted events fade at once.
- Empty and error states keep the `ContentUnavailableView` copy; "Sync Now" becomes "Sync now".
- Accessibility: the line is hidden from VoiceOver. The subtitle carries the state, and
  completion announces "Calendar updated".

### Component plan

- Change: `CalendarView` (subtitle, `SyncLine`, resync on open and pull),
  `DayTimelineView.eventBlock` (dashed border for `isPendingServerCopy`), the calendar store
  (`calendarSyncState`, `lastSyncedAt`, `pendingEventIDs`).
- New: `SyncLine` (state: `phase` idle / running / done / failed), `CalendarFreshness` (pure
  subtitle formatter, unit tested).
- MobileAPI: `calendar.resync` with `reason`; response `{ started, lastSyncedAt }`.
- Mac branch likely: no pull; a toolbar "Sync" button drives the same `SyncLine`.

---

## Wave C. The lean brief

### Findings

- Finimize, "Your Daily Brief For May 14th" ([screen](https://mobbin.com/screens/5d326d90-9cdc-44c6-9572-1a45f22cfb64)):
  dated title, a two-sentence dek, then "Updated 14 May · 3 min read". The dek is the lede.
- NYTimes newsletter ([screen](https://mobbin.com/screens/67099920-2420-40a9-88e6-eacfba351d73)):
  each item is a bold lead phrase and one plain sentence with links inside it. Seven items
  read as a letter.
- Apple Mail VIP widget ([screen](https://mobbin.com/screens/0b546ef1-d424-47ba-b8b0-bda7fa5c51cc)):
  sender bold, subject regular, one preview line, date right. A real email row needs no more.
- Apple Support, Priority Messages (https://support.apple.com/en-gb/guide/iphone/iph9ae667055/ios):
  priority is a small group at the top of Primary, opt-in with "Show Priority", never a second
  inbox. The cap keeps it trustworthy.

### Chosen expression

The brief is a short letter. `BriefDocumentView` keeps the v2 node tree and renders fewer
nodes. Layout, top to bottom:

1. Lede: `DailyBriefLede` in the display face at 21 pt, max 4 sentences, no card. The
   standing line ("written 07:02") stays in the section rule.
2. Three lanes with the `todaySection` rule grammar: "Answer" (note "Replies you owe"),
   "Today" (note "Deadlines and the calendar"), "Know" (note "Worth a look"). An empty lane
   does not render.
3. Each item is a real email row: `InitialsAvatar` 32 pt, sender in the display face, subject
   in `.subheadline`, the model's line (max 20 words) in `.footnote` secondary, a trailing
   plain-text action "Reply", "Open", or "RSVP". The row opens the thread; the word runs the
   action. Calendar items show the time in the avatar slot ("14:00", monospaced digits).
4. Week ahead: one `.body` paragraph. Weekday names and dates render semibold through a
   client `AttributedString` pass, so "Thursday" and "Friday" catch the eye.
5. Areas: at most 3 rows, area name then one line, hairline dividers, tap opens the area.
6. Footer: one sentence from `stats`: "38 other messages arrived. None needed you."

- Motion: rows `rise` with a 40 ms stagger once per edition. "Writing…" shows three
  `subtleColor` placeholder bars (12 pt) under the lede position and the progress line.
- Empty edition: the lede stands alone; the footer reads "Nothing in your mail needs you this
  morning."
- No edition and error states keep the current copy; "Try Again" becomes "Try again".
- Dynamic Type: the action word moves under the text at `.xxxLarge` with `ViewThatFits`. The
  avatar hides at accessibility sizes.
- Accessibility: one element per row: "From Sarah Chen, Venue count, asked for the head count
  by Friday, action Reply".

### Component plan

- Change: `BriefDocumentView` (lane node), `BriefToolNodeViews` (`entity_list` items render
  `BriefMailRow` or `BriefEventRow`), `DailyBriefLede`, `DailyBriefFooter`,
  `TodayView.briefContent` (placeholder bars).
- New: `BriefLaneSection`, `BriefMailRow`, `BriefEventRow`, `WeekAheadText` (pure, unit
  tested), `BriefPlaceholderBars`.
- Remove: node views for `bulkTail`, `newPeople`, `fyi`, `tracked`. The WKWebView path in
  `DailyBriefView` stays for legacy editions only.
- Mac branch likely: the three lanes sit in the three-column newspaper layout on wide
  windows; on iOS they stack. `WeekAheadText` is shared.

---

## Wave D. Shapes: list, practice, project

### Findings

- Amie, list with inline add ([screen](https://mobbin.com/screens/8651d9b8-539c-4a87-af9a-53a2f492dc3a)):
  a ghost row "New todo" sits in the list; done items drop under "Hide 1 done". No header
  chrome.
- Crouton, ingredients ([screen](https://mobbin.com/screens/8a51253f-6f84-4b5f-aadc-3300a884bacf)):
  one column of check circles and text, the quantity in accent. Nothing else.
- Apple Support, Reminders (https://support.apple.com/en-gb/guide/iphone/iph3fb74d597/ios):
  "Completed items are hidden on your list", with "Show Completed" to reveal them.
- Noom, weight graph ([screen](https://mobbin.com/screens/dcd65d53-0134-419d-8a5a-3aa41ad45dfa)):
  Start, Current, Change on top; the goal as one labelled line. Future Pro
  ([screen](https://mobbin.com/screens/4d96c3e9-c7b8-4266-b086-ad92ec6c3c07)) draws a dashed
  target and one solid trend line.
- Apple Support, Fitness Trends (https://support.apple.com/guide/iphone/see-your-activity-summary-iph4c34a8a95/ios):
  an arrow plus one coaching sentence. pushr ([screen](https://mobbin.com/screens/bd1913f9-cb73-4126-9c41-fb92dfe61b97))
  shows a week as seven small pills, filled when logged.
- Marcus, transfer steps ([screen](https://mobbin.com/screens/0d72165f-a2d5-419d-91cc-cfd62115d7c1)):
  a vertical rail, filled check, hollow rings, a date under each step. Forest timeline
  ([screen](https://mobbin.com/screens/109be5af-6adf-4c93-9a14-76a8c86ecffe)): a log on a rail,
  times left, artifacts as cards.

### Chosen expression

**Shape shown and changed.** The lead's state label becomes "List · Open" (shape word, state).
Tap opens `ShapePickerSheet`, detent `.medium`: seven rows, the shape word in `.body` and one
meaning line in `.footnote` ("List — items to keep, nothing to plan."). The tap confirms.
Haptic `.selection`. The body crossfades to the new shape view. In `WorkView`, `StateChip`
shows the shape word for `list`, `practice`, and `project`.

**List (`ListWorkView`).** No section headers.

- Row 0 is the quick add: a borderless `TextField`, placeholder "Add an item", an empty circle
  on the left. Return adds, clears, keeps focus. The item `rise`s in.
- Items: 24 pt circle, `.body` text. Tap the circle to check. Haptic `.impact(weight: .light)`.
  The item strikes through, turns secondary, and settles to the bottom with `settle` through
  stable `id`s in a `ForEach` inside `withAnimation`.
- Done items hide by default. A trailing plain-text row "Show 3 done" reveals them.
- Long press: "Remove". Leading swipe also removes.
- Empty: the quick-add row alone, placeholder "Add the first item".
- Error: the field keeps the text; a footnote reads "Could not save. Try again."
- Accessibility: circle labels "Mark done", "Mark not done".

**Practice (`PracticeWorkView`).**

- Header: the current value in the display face at 44 pt (`@ScaledMetric`) with
  `contentTransition(.numericText())`, the unit in `.subheadline` secondary, one line
  "Down 2.4 lb since 4 Aug".
- Chart: Swift Charts, 140 pt. `LineMark` in accent, `PointMark` on the last entry, `RuleMark`
  at `target` dashed in `accent2Color` labelled "Target 165". No grid; x labels at week starts.
- Week strip: 12 pills for the last 12 weeks, filled when logged. Label:
  "Logged in 4 of the last 5 weeks."
- Review sentence, computed on device, no model call: "Down 2.4 lb in 5 weeks. The pace
  reaches the target by 20 Dec." With one entry: "One log so far. Add the next when you want."
- One button: "Log". `MetricLogSheet`, detent `.height(280)`: a decimal field prefilled with
  the last value, an optional note, "Save". The number ticks, the point `rise`s in. Haptic
  `.success`.
- Entries under the chart: value, date, note, newest first. Swipe to remove.
- Empty: header "No logs yet"; the chart draws only the target rule. Accessibility:
  `accessibilityChartDescriptor` on the chart; the strip reads "Four of five weeks logged".

**Project (`ProjectWorkView`).**

- Milestone rail: a vertical 2 pt `hairlineColor` rail. Each milestone is a 14 pt circle:
  filled accent when done, an accent ring for the first open one, a hairline ring for the
  rest. Title `.body`, done date `.caption` secondary.
- Tap toggles. Undo asks once: "Reopen this milestone?" with "Reopen". Fill animates with
  `settle`. Haptic `.impact(weight: .light)`.
- Trailing row "Add milestone" opens an inline field. Long press: "Rename", "Move", "Remove".
- Log: section rule "Log", note "Last touched 2 days ago". Rows are artifacts in time order:
  kind word ("Commit", "Pull request", "Doc"), title, relative time. Tap opens the URL.
- Empty: "No milestones yet. Add the first one."

### Component plan

- Change: `WorkDetailView` (branch by `work.shape`; lead label; menu item "Change shape"),
  `WorkView.StateChip`, `WorkDetail` model (`listItems`, `metric`, `milestones`,
  `metricEntries`, `artifacts`).
- New: `ShapePickerSheet` (state: `selected`, `isSaving`), `ListWorkView` (state: `draft`,
  `showsDone`, `items`, `pendingIDs`), `PracticeWorkView` (state: `entries`, `showsLog`),
  `MetricLogSheet` (state: `value`, `note`), `PracticeReview` (pure, unit tested),
  `ProjectWorkView` (state: `milestones`, `reopenTarget`, `draftTitle`), `MilestoneRail`.
- MobileAPI: new Work fields and `work.listAdd`, `work.listToggle`, `work.metricLog`,
  `work.milestoneToggle`, `work.setShape`.
- Mac branch likely: hover reveal for "Remove"; `MetricLogSheet` as a popover from "Log".

---

## Wave E. One bar for Ask and Hold

### Findings

- Perplexity, composer mode chip ([screen](https://mobbin.com/screens/3db38dd4-d867-4441-9ee2-cca6c3bdd464),
  [screen](https://mobbin.com/screens/69b31f7b-3188-4bbc-82f8-59a2a8cd7d92)): a chip inside the
  field reads "Search" or "Research", and the placeholder changes with it. The mode is one
  word in the field.
- Arc Search, bottom bar ([screen](https://mobbin.com/screens/8e0bf715-c93e-437b-ac0a-23db19501452)):
  a two-state toggle at the trailing edge; the page tint follows the mode. Colour carries the
  mode.
- MacStories on Arc Search (https://www.macstories.net/reviews/arc-search-for-iphone/):
  "Browse For Me" sits beside a suggestion; one field feeds two outcomes.
- Fi, "Is your issue resolved? No / Yes" under a reply
  ([screen](https://mobbin.com/screens/0057139c-e3f7-4a52-b796-4f6bd5d4e8b1)): a small plain
  action row under an assistant message is clear and quiet. "Hold this" takes that seat.

### Chosen expression

**The bar.** `AssistantChatView.composer` gains `RouteChip` inside the glass capsule, between
the field and the send circle. A 28 pt text capsule: "Ask" in `accentColor` soft fill, "Hold"
in `accent2Color` soft fill, `.footnote` semibold. The send circle takes the chip colour.

- Placeholder: "Ask or hold". With text present, the chip alone carries the state.
- Prediction: 400 ms after the last keystroke, call `assistant.route`. On `hold` with
  confidence at or above 0.6 the chip flips. Timeout or error keeps "Ask". A manual flip pins
  the route until the field clears.
- Flip: tap the chip, swipe horizontally on the chip, or press Tab on a hardware keyboard
  (`onKeyPress(.tab)`). Motion: `rotation3DEffect` 180° on the y axis over 0.28 s with the
  text swap at the midpoint. Haptic `.selection`.
- Return with "Ask" sends to chat. Return with "Hold" produces no chat reply.
- Empty field: the chip reads "Ask" at 50% opacity, disabled.
- Accessibility: a button labelled "Route: Hold", hint "Double tap to change to Ask". A flip
  announces the new route. The chip never truncates; at `.xxLarge` it moves under the field.

**The Hold landing.** Under 600 ms total.

1. 0 to 220 ms, `settle`: the text and the capsule collapse into `HoldCard`, a
   `surfaceCard(cornerRadius: 14)` in place of the composer, through `matchedGeometryEffect`.
   The card shows the parsed title in `.subheadline` semibold and one secondary line with the
   shape word and horizon ("Quick · By the trip").
2. 220 to 340 ms: the card holds. Haptic `.success`.
3. 340 to 600 ms, `.easeIn(duration: 0.26)`: the card moves toward the leading edge and
   scales to 0.6 with opacity to 0, toward the sidebar's Work row. The composer returns with
   `cross`.
4. A receipt row `rise`s into the transcript: "Held: Book the dentist" with a plain-text
   "Open" at the trailing edge. The receipt is client state, never a chat message.
- While capture runs, the card shows a small `ProgressView`. On failure the card returns to
  the composer with the text intact and a footnote reads "Could not hold that. Try again."

**"Hold this" on a reply.** Under an assistant message that contains a list or a plan, a
plain-text button "Hold this" in `.footnote` secondary at the trailing edge. Tap runs the same
landing from the message: the body dims to 40%, `HoldCard` rises over it with the returned
title, then travels. The label becomes "Held" and disables. Haptic `.success`.

**One entry point.** `GlobalCreateMenu` replaces "New intent" and "New chat" with one item
"Ask or hold" that opens the chat with the bar focused. `AssistantView` retires; its
`store.capture` path moves behind the Hold route. The chat zero state's second line becomes
"Ask a question, or hand over something to hold."

### Component plan

- Change: `AssistantChatView` (composer, receipt rows, "Hold this", zero state),
  `AssistantChatModel` (`route`, `holdDraft`, `captureFromChat`, `heldMessageIDs`),
  `GlobalCreateMenu` (one item), `AppShellView` (drop the `.assistant` sheet case),
  `NavigationModel` (`openChatWithBarFocused`).
- New: `RouteChip` (state: `route`, `isPinned`, `isEnabled`), `RoutePredictor` (debounce,
  timeout, confidence rule; pure, unit tested), `HoldCard` (state: `title`, `shapeWord`,
  `horizonLine`, `phase` collapse / hold / travel), `HoldReceiptRow`, `HoldThisButton`.
- MobileAPI: `assistant.route` and `work.captureFromChat`.
- Mac branch likely: the same bar in the chat panel and in the ⌘K position when the panel is
  closed. Tab moves focus on the Mac, so the Mac note must choose the flip key.

---

## Risks and what to avoid

- Do not put the Later shelf on Today. Today is the day, the mail, and one move.
- Do not render the shelf as a list at regular type sizes. The fallback is for accessibility.
- Do not add a "Snooze" verb. The words are "Later", "Someday", and "Back on {date}".
- Do not animate the sync line when `started` is false. A false line trains the user to
  ignore it.
- Do not exceed the tier budget in the brief, and never add "and 12 more".
- Do not summarise a summary. The model line is the only generated text on a brief row.
- Do not make a model call for the practice review sentence. `PracticeReview` is pure.
- Do not animate list items on server refresh. Animate only on a local toggle.
- Do not send a chat message when the route is "Hold". Intents and chats stay apart.
- Do not ship two capture entry points. `AssistantView` retires in the same change.
- Do not use `Label` with a system image for any new button. Text only.
- Keep the WKWebView fallback in `DailyBriefView` until the server stops emitting HTML.
