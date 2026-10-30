# Needs you, phases 1.1 to 5: build plan

Design: `docs/needs-you.md`. Phase 1 plan and server notes:
`docs/needs-you-phase-1.md`. Shared contract: `lib/obligations/contract.ts`
(additive changes only; note each change in your report). Owner order
(2026-10-30): build all phases today. Everything stays behind
`LAB86_NEEDS_YOU`; users outside the flag see no change.

## What production showed after phase 1 (2026-10-30)

The 30-day fill for the owner made 31 items: 28 `change`, 2 `action`, 1
`reply`. Most changes need nothing from the user: terms and privacy updates,
renewal notices, security alerts that are already done. 15 were
`time_sensitive`, so they filled Now. Phase 1.1 fixes this first.

## Builders and the files they own

A builder edits only the files it owns. A builder that needs a change in
another builder's file writes the need in its report.

| Builder | Owns |
|---|---|
| S1 sources | `convex/obligations.ts`, the `obligations` table in `convex/schema.ts`, `lib/obligations/{rules,push-policy,delivery,service}.ts`, `lib/jev/*`, `convex/jev.ts`, `lib/content/*`, `convex/content*.ts`, `lib/mcp/sync.ts`, `convex/mcpSync*.ts`, calendar sync files, their tests |
| S2 consumers | new `convex/obligationViews.ts`, new `lib/obligations/{albatross,brief-region,views}.ts`, `app/api/obligations/[id]/albatross/`, `app/api/mobile/v1/needs-you/**`, `lib/mobile/v1/*` and the OpenAPI output, the brief generation (`lib/mail/agent-report*.ts`, `lib/shared/brief-document.ts`), `convex/_generated/api.d.ts`, their tests |
| W web | `components/needs-you/**`, the Work thread components (`components/albatross/WorkThread*.tsx`, `components/albatross/thread/**`), `components/report/brief-canvas/**`, `lib/brief/letter.ts`, `lib/obligations/{groups,labels,fixtures}.ts`, `app/dev/*-preview`, their tests |
| I iOS | `apps/ios/Lab86Mail/**`, `apps/ios/Packages/MobileAPI/**`, `apps/ios/Lab86MailTests/**`, `apps/ios/Shared/**` |
| M macOS | `apps/ios/Lab86MailMac/**` and its tests. Starts after I. |

## S1: rules and sources (phases 1.1, 2, 4)

1. **Change rules (1.1).**
   - Terms, privacy, policy, and renewal notices never open an item. Add a
     Jev mail question `routine_notice` (noul): "Is the latest inbound message
     a routine notice (a terms, privacy, or policy update, a renewal or
     billing reminder, or a feature announcement) with no problem the owner
     must fix?" Do not change `JEV_VERSION` or `JEV_QUESTION_VERSION`.
   - A `change` is `time_sensitive` only when it is new (source message
     inside `CHANGE_NOW_WINDOW_MS`) and is a problem: a failed payment, a
     cancelled or moved booking, an account lock or a revoked credential.
   - A change with no `action` closes by itself after `CHANGE_AUTO_CLOSE_MS`
     as `aged_out`.
   - The 30-day fill never makes a `time_sensitive` item. Repair the owner's
     current rows with an idempotent internal migration that applies the new
     rules to open rows (no pushes).
2. **Phase 1 gaps.**
   - Push one follow-up when a `waiting` item passes its `dueAt`.
   - Link a mail item to its Albatross: take `workId` from the content label
     of the same thread (`jev_content` labels mail content items too), and
     fill `workTitle`.
   - Close an item when its thread moves to Trash or Spam (`evidence`).
   - Remove closed rows after 30 days (bounded sweep, existing cron).
3. **Connected sources (phase 2).**
   - Open, update, and resolve items from content labels (`actionable`,
     `resolved`, `workId`, `kind`) for Slack, Atlassian, Granola, and Drive,
     where the item belongs to the owner (`ownerIdentities`). Set `source`,
     `sourceLabel`, `url`, and `asker`.
   - Add GitHub and Bitbucket items (`lib/mcp/sync.ts` loaders) to the
     content index, so `jev_content` classifies them: review requests,
     mentions, assigned issues, failed checks on the owner's branches.
   - Ask the `due` question for content too.
   - The same push rules as mail. A Slack, Jira, or GitHub item pushes only
     when it passes the bar.
4. **Calendar (phase 4).**
   - `rsvp`: an invitation from another person that still waits for the
     owner's answer, for an event in the next 14 days.
   - `prepare`: a Jev question `prepare` (noul) on events in the next 24
     hours with other people: "Does the owner have to prepare something
     before this event starts?"
   - Both close as `event_passed` when the event starts. `rsvp` also closes
     when the owner answers anywhere.
   - The action `{ action: 'rsvp', response }` in
     `lib/obligations/service.ts` sends the answer through the existing
     calendar path.

## S2: consumers (phase 3 server, phase 5 API)

1. **Albatross threads.** `convex/obligationViews.ts`:
   - `forWork` (query, signed-in user, `{ workId }`): the open items of that
     Albatross and the items closed today, as `ObligationView[]`.
   - `snapshotFor` (internal secret, `{ userId }`): the `NeedsYouSnapshot`
     for the mobile routes.
2. **Start in Albatross.** `POST /api/obligations/[id]/albatross` gives
   `ObligationAlbatrossResponse`. With a `workId`: put the item into that
   thread as input and start a run (the existing run start rules apply).
   Without: start a new Albatross from the item with the existing capture
   path. Set the item's `workId`.
3. **The brief (phase 3).** For a flag user, the daily edition has a lane
   `needs-you`, title "Needs you", in the place of the `answer` lane. Build it
   from the ledger (`BriefNeedsYouRegion`, at most `BRIEF_NEEDS_YOU_LIMIT`
   items, codes never). Each item uses the same item shape as the `answer`
   lane, so the current renderers show it. `closedSince` is one plain line at
   the end ("Closed by itself since yesterday's letter: ..."). Keep the region
   in `parseBriefDocument` (repair block) and in the edition size limits.
   Users outside the flag keep `answer`.
4. **Mobile API (phase 5).** Mobile v1 routes with the existing mobile auth:
   - `GET /api/mobile/v1/needs-you` gives `NeedsYouSnapshot`.
   - `POST /api/mobile/v1/needs-you/[id]` (ObligationAction),
     `.../[id]/draft`, `.../[id]/reply`, `.../[id]/albatross`: the same
     services and responses as the web routes.
   - Add the schemas to `lib/mobile/v1/contract.ts` and run
     `bun run mobile:openapi` in the same change.

## W: web (phases 2, 3, 4)

1. Source marks and labels for each source in the row and the detail
   (`OBLIGATION_SOURCE_LABELS`, `sourceLabel`). "Open in Slack" (or Jira,
   GitHub, ...) uses `url`.
2. The detail for `rsvp` (Yes, No, Maybe) and `prepare` (the event, its
   time, the people; Done, Later).
3. "Start in Albatross" for every kind except `code`, with the response
   `workId` opening that Albatross. Show `workTitle` in the row meta.
4. The Work thread shows its items (`obligationViews:forWork`) as messages
   in time order, with the same actions (mockup `05-albatross-thread.png`).
5. The brief lane `needs-you` (title "Needs you") in `lib/brief/letter.ts`
   and the brief canvas, in the place of `answer`.
6. Phase 1.1 on the page: no change in Now unless it is `time_sensitive`.

## I: iOS (phases 3 and 5)

1. A Needs you screen in the sidebar, with the same groups, rows, detail,
   and actions as the web page (Send reply with the draft, Done, Later, Not
   mine, Undo for 10 seconds, Copy code, RSVP, Start in Albatross). Data:
   the mobile routes above (`NeedsYouSnapshot` JSON = the contract shapes).
2. A tap on an `obligation` push opens the item in Needs you. A code push
   keeps the AutoFill wake (`codeAvailable`). Do not change it.
3. The brief lane `needs-you` in `BriefLetter.swift` `classify` and in the
   brief views, in the place of `answer`.
4. Show the screen only when the snapshot says `enabled`.

## M: macOS (phase 5)

The same as I, in the Mac target, with the Mac layout (list and detail side
by side). Reuse the shared models and clients that I adds.

## Done means

- `bun run typecheck`, `bun run typecheck:tests`, `bun run lint`, and the
  full `bun test` pass. The coverage gate passes.
- Native: no Mac is reachable. The Native acceptance workflow (iOS, macOS,
  and Release archive) on the PR compiles and tests the Swift code.
- Two PRs: server and web first, native second. CodeRabbit on each. The
  merge waits for the owner.

## S1 notes (2026-10-30)

These notes record the decisions of builder S1. The code is the authority.

### Phase 1.1: change rules

- Jev mail has the new question `routine_notice` (noul). The answer goes
  into `probabilities.routine_notice`. `JEV_VERSION` and
  `JEV_QUESTION_VERSION` do not change. An older verdict has no value.
- A `routine_notice` value of 0.75 or more removes the `change` and the
  `action` of the thread. A `reply` from a person stays.
- An older verdict without the answer reads set cues in the subject and in
  the start of the evidence text: terms, privacy, policy, agreement,
  renewal, and product news. A problem cue cancels these cues.
- A change is `time_sensitive` only when the three conditions that follow
  are correct. The source message is less than `CHANGE_NOW_WINDOW_MS` from
  the current time. The change probability is at or above the push bar. A
  problem cue of its subject type is in the subject or in the start of the
  evidence text.
- The problem cues are a payment that did not go through or that the bank
  declined (`finance`), a cancelled or moved booking (`booking`), and a locked,
  suspended, or revoked account or credential (`account`).
- A change with a source message older than `CHANGE_AUTO_CLOSE_MS` does
  not open. An open change closes as `aged_out` at that age.
- The 30-day fill (`fill: true`) makes no `time_sensitive` row.

### The sweep and the repair

- Each open row has `sweepAt`: the next time that it changes by itself. A
  time-sensitive change goes down to `normal` after 48 hours. A change
  closes as `aged_out` after 3 days. A calendar item closes as
  `event_passed` when its event starts.
- `obligations:sweep` operates at the start of the Jev cron (each 5
  minutes). It reads a maximum of 100 due rows and 100 closed rows that are
  older than 30 days. It removes those closed rows. A full batch starts the
  next sweep.
- The repair `jev:repairObligations` applies the new rules to the threads
  of the open mail rows of one user. It does not push. A row that the new
  rules remove closes at the time when the rules close it: at the message
  time, or at the end of its age limit. Thus these rows do not fill
  "Closed today". Then the fill steps of the connected sources and the
  calendar start. A second repair changes nothing.
- The Jev claim starts the repair one time for each user in the flag. The
  condition is a flag record with an older `rulesVersion`
  (`OBLIGATION_RULES_VERSION` = 2). No manual step is necessary. To start
  it manually:
  `npx convex run jev:repairObligations '{"userId": "<id>"}'`.

### Phase 1 open items

- Follow-up of `waiting`: a row with a future `dueAt` gets a held push with
  the hold cause `follow_up` until `dueAt`. The held-push path sends it, so
  quiet hours and the hourly limit apply. `followUpAt` records it, and the
  row gets no second follow-up. The fill and the repair set no follow-up.
- The held-push release reads the push settings again. A follow-up that a
  setting stops does not come back.
- Albatross link: the content label of the thread (`mail:<account>:<thread>`)
  gives `workId` and `workTitle`. A label sets the link only when the row
  has no link, so a link from "Start in Albatross" stays. A `proposal:` id,
  an Albatross of a different user, and a done or archived Albatross give
  no link. "Used in the last 7 days" reads `lastUserTouchAt`.
- Trash and Spam: the content change list (`content:mailChanges`) sends a
  tombstone for a thread in Trash or Spam that has an open item. The content
  upsert closes the items of a removed source item as `resolved`
  (`evidence`). A thread that comes back from Trash does not open its items
  again before a new message.

### Phase 2: connected sources

- `content:completeItem` has the argument `needsYou`. With the flag, the
  labels open, change, or close one `action` for each item. The answer is
  then `{ ok, obligationIds }`, and the content cycle pushes those ids.
- Sources: `slack`, `jira` (as `atlassian`), `granola`, `google_drive` and
  `onedrive` (as `drive`), `github`, and `bitbucket`. A mail item only
  gives its Albatross to the rows of its thread.
- An item opens when it is actionable, not resolved, not noise, and less
  than 30 days from its last change. `sourceKey` is the content item key.
- `asker` is the author of the connector row, or the source name.
  `sourceLabel` is "#channel" or "Direct message" (Slack), the issue key
  (Jira), "owner/repo #number" (GitHub, Bitbucket), or the title (Granola,
  Drive). `url` is the item link when it is https.
- Push: the same bar as mail. Slack, Jira, GitHub, and Bitbucket items can
  push. Drive and Granola items stay in the app. A content item is not
  `time_sensitive`.
- Labels have two new optional fields: `due` (a new content question) and
  `actionableProbability`. An older label without the probability is at
  the push bar (0.85).
- A close by the user stays until the item version changes. Not mine on a
  connected item writes no mail correction.
- GitHub: one GraphQL call in `lib/mcp/sync.ts` finds open review
  requests, mentions, assigned items, and checks that did not pass on the
  open pull requests of the owner. Bitbucket: the build statuses of the 5 newest
  open pull requests of the owner. The facts go into `raw.ownerFacts`, and
  the content text writes them as sentences. Only items with a fact change.
  If a read is not successful, the items stay as the loader gave them.

### Phase 4: calendar

- The calendar writes (`calendarData:upsertEventBatch`, `deleteEvent`,
  `reconcileWindow`) sync the rows of each changed event for a user in the
  flag. They use the flag record of the Jev claim. An unchanged event
  causes no read.
- `rsvp`: an invitation from a different person, with the owner status
  `noreply`, for an event in the next 14 days. A series has one row, with
  the series id in its key, at its next instance. It is in the app only:
  the invitation mail is the first notice. An answer from a different
  location closes it as `done` (`event_passed`). A cancel or a removed
  event closes it as `resolved`.
- `prepare`: the Jev sweep of a flag user claims a maximum of 6 events of
  the next 24 hours with other persons
  (`obligations:claimPrepareEvents`). Then it sends the `prepare` question
  (`lib/jev/calendar.ts`) and keeps the answers
  (`obligations:storePrepare`). One `userDocs` row of the type
  `needsYouPrepare` keeps one answer for each event revision. After a call
  without an answer, the claim tries again after 15 minutes, a maximum of 3
  times.
  A row opens at 0.75 and pushes at the push bar.
- The two types close as `expired` (`event_passed`) when the event starts.
- The action `{ action: 'rsvp', response }` sends the answer through
  `rsvpCalendarEvent`, then closes the row as `done` (`event_passed`). This
  action has no Undo.

### Contract and schema changes (additive)

- `lib/obligations/contract.ts`: no change.
- `obligations` table: `calendarId`, `sourceAt`, `sweepAt`, `followUpAt`,
  the hold cause `follow_up`, and the indexes `by_sweep` and `by_closed`.
- `ObligationRecord` (`lib/obligations/service.ts`): optional `calendarId`.
  `ObligationServiceDependencies`: optional `rsvp`.
- The page view (`obligationView`) also fills `sourceLabel`, `url`,
  `workTitle`, `eventId`, and `eventStart`.

## S2 notes (2026-10-30)

### Albatross threads (`convex/obligationViews.ts`)

- `forWork` (signed-in user, `{ workId }`): the open and snoozed items of
  that Albatross, and the items that closed since the start of the user's
  day. The order is `createdAt`, oldest first, so the newest item is last.
  A user outside the flag, or a call without a session, gets `[]`.
- `snapshotFor` (server secret, `{ userId }`): the same `NeedsYouSnapshot`
  as `api.obligations.needsYou`.
- `closedSinceFor` (server secret, `{ userId, since, limit? }`): the
  `ObligationClosedNote` list for the brief. It holds only the items that
  closed by themselves (`evidence`, `expired`, `event_passed`, `aged_out`),
  newest first. It never holds a code or a close by the user.
- `linkWork` (server secret, `{ userId, id, workId }`): sets `workId` and
  `workTitle` on the row. The Albatross must be the user's and must be open.
- Each view adds the row fields `sourceLabel`, `url`, `workTitle`, `eventId`,
  and `eventStart` when `obligationView` does not set them yet.

### Start in Albatross (`lib/obligations/albatross.ts`)

- Not in the flag, or the id of another user: 404. A code: 400. A closed
  item: 409. A snoozed item can start.
- The item has a `workId` and that Albatross is open: the route sets
  `workTitle`. A run that works now gets the item as a steer note. If no run
  works, a run starts with the note (`startStepRun`, trigger `user`). The
  run start rules apply. If a rule refuses the start, the item stays linked
  and the response has no `runId`. The user can press "Handle it" in the
  thread.
- No `workId`, or that Albatross is closed or gone: a new Albatross starts
  through the capture path (`captureWork` with one reviewed item, so no split
  call to a model). The route links the item to it. A new Albatross makes
  its plan first, so the route starts no run.
- The note gives the item, the asker, the place, the evidence, the source
  ids, and the link. `redactSecretShapes` removes secret shapes. The note
  has at most 2,000 characters (the steer limit).
- The route does not add a chat message. The Work thread shows the item
  from `forWork`.
- Contract change (additive): `ObligationAlbatrossResponse.runId?: string`.

### The brief (`lib/obligations/brief-region.ts`)

- The Node flag and `snapshotFor.enabled` must both be true. Then the
  edition stores `sections.needsYou` (`BriefNeedsYouRegion`). If the ledger
  read fails, the edition keeps the `answer` lane.
- The region: `items` are the Now group and then the Today group, from
  `groupNeedsYou` (the page rules), at most `BRIEF_NEEDS_YOU_LIMIT`. Codes
  never. `open`, `now`, and `dueToday` count the open groups without codes.
  `closedSince` holds the items closed by themselves since the previous
  edition, at most 5.
- The stored region has short text and no code value or draft state. It
  stays below 16,000 bytes (`BRIEF_NEEDS_YOU_BYTE_LIMIT`). The edition
  storage keeps it in every size step, and the read migration keeps it
  (`lib/store/daily-reports.ts`).
- `sections.answer` stays in the stored edition for older readers, the
  prose, the weekly review, and the widgets. Only the document changes.
- The document gets two regions in the place of `answer`:
  - `needs-you`: an `entity_list` with the title "Needs you" and emphasis
    `primary`. Each item has the item shape of the `answer` lane:
    - `ref`: a mail item is `thread` (account, thread id). A calendar item
      is `event`. A Slack, Jira, Granola, Drive, GitHub, or Bitbucket item
      is `mcp` (id = `sourceKey`). Any other item is `derived`
      (`obligation:<id>`). `label` is the item title.
    - `framing`: `lane: 'needs-you'`, `sender` (the asker), `age`
      ("Day 3" from `createdAt`), and `reason`. For a thread or an event,
      `reason` is the item title. For other items, `reason` is the place
      ("Slack, #release").
    - `actions`: the open action first (`open_thread`, `open_event`, or
      `open_url` for an https link). Then `draft_reply` for a mail reply,
      and `open_work` when the item has a `workId`. An item without an open
      action gets `open_view` with `{ view: 'notifications', obligationId }`.
  - `needs-you-note`: a `text` node, role `aside`. It is one plain line:
    "3 other open items are on the Needs you page." and "Closed by itself
    since yesterday's letter: Renewal notice (Northwind Billing)." The
    region is absent when the line is empty.
- A mail thread in the `needs-you` lane leaves the `today`, `know`, and
  `waiting` lanes. A lane that becomes empty goes.
- The document holds at most 12 regions. If the lane makes 13, the note
  goes first.
- The daily document is always an editorial document. The editorial
  modules make one module for each lane item (section `needs-you`, no lane
  title) and one module for the note. The regions are then
  `editorial-needs-you` and `editorial-needs-you-note`, unless the writer
  places the modules in other regions.

### Mobile API (`lib/mobile/v1/needs-you.ts`, phase 5)

| Route | Body | Response | Rate limit |
|---|---|---|---|
| `GET /api/mobile/v1/needs-you` | none | `NeedsYouSnapshot` | 120 a minute |
| `POST /api/mobile/v1/needs-you/[id]` | `ObligationAction` | `ObligationActionResponse` | 60 a minute |
| `POST /api/mobile/v1/needs-you/[id]/draft` | none | `ObligationDraftResponse` | 20 a minute |
| `POST /api/mobile/v1/needs-you/[id]/reply` | `{ body }` | `ObligationReplyResponse` | 30 a minute |
| `POST /api/mobile/v1/needs-you/[id]/albatross` | none | `ObligationAlbatrossResponse` | 20 a minute |

- The auth is the mobile session (`requireCurrentUser`). The services are
  the web services. The JSON field names are the names in
  `lib/obligations/contract.ts`. Times are epoch milliseconds (integers).
- A user outside the flag gets `{ enabled: false, timezone: 'UTC', items: [] }`
  from the GET route, with no Convex read. The other routes give 404.
- Errors use the mobile envelope `{ ok: false, requestID, error: { code,
  message, retryable } }`: 400 `INVALID_REQUEST`, 401 `AUTH_REQUIRED`, 403
  `FORBIDDEN`, 404 `NOT_FOUND`, 409 `CONFLICT`, 429 `RATE_LIMITED`, 5xx
  `SERVER_ERROR`. The message is the message of the web route.
- A response loses the keys that are not in the schema, so a strict decoder
  stays safe when the server adds a field.
- The OpenAPI document has the five routes and the schemas `NeedsYouSnapshot`,
  `ObligationView`, `ObligationActionRequest`, `ObligationActionResponse`,
  `ObligationDraftResponse`, `ObligationReplyRequest`,
  `ObligationReplyResponse`, and `ObligationAlbatrossResponse`. The Swift
  OpenAPI generator makes types and client calls from `openapi.yaml` when
  the package builds. Each response holds its own copy of `ObligationView`.
- `ObligationActionRequest` is one flat object: `action`, and `until` or
  `response` when the action needs them. Do not send a key with `null`.

## W notes (web, 2026-10-30)

What the web builder shipped on `claude/ny2-web`, and what it needs from the
other builders.

Pages and parts:

- Rows and details show the source word (`OBLIGATION_SOURCE_LABELS`) and the
  place in the source (`sourceLabel`): "Slack · #release". A person keeps
  initials. A meeting, an issue, a pipeline, and an event to prepare for get a
  monochrome glyph. "Open in Slack" (Jira, GitHub, ...) is a plain link to
  `url`. Only an `https` link renders.
- `rsvp`: the event card (title, start time, the people from `excerpt`), then
  Yes, No, Maybe, Later, Not mine. `prepare`: the same card, then Done, Later,
  Not mine. The event start comes from `eventStart`.
- "Start in Albatross" for every kind but `code`. With a `workId` it is the
  first action; without one it is a quiet link at the right of the action row.
  The response `workId` opens the thread. The row stays open. The row meta
  shows `workTitle`. The detail shows an Albatross card with "Open thread".
- The Work thread reads `obligationViews:forWork` and shows the items as
  cards in time order, after the conversation and before the Work questions.
  "Handle it" posts to `/api/obligations/[id]/albatross`. Done, Later, Not
  mine, and Yes/No/Maybe post to `/api/obligations/[id]`, with Undo.
- The brief lane `needs-you` renders in the place of `answer`: the accent
  surface, the kicker "Needs you", the region `summary` at the right, a "Due
  today" sub-label, and the closed line at the end.
- Phase 1.1 on the page: a `change` sits in Now only when it is
  `time_sensitive` and newer than `CHANGE_NOW_WINDOW_MS`. An older one goes to
  Today. Any other change goes by its due day and never into Now.
- Previews: `/dev/needs-you-preview?select=ob_slack_numbers` (and `ob_rsvp`,
  `ob_prepare`, `ob_jira_lab212`, `ob_drive_memo`, `ob_card`),
  `/dev/thread-preview?state=needsYou`, `/dev/brief-preview?layout=needs-you`.

Contract needs (S2 and the native builders):

- The `needs-you` region tree: an `entity_list` with the title "Needs you"
  alone, or a `stack` of that list and one `text` node (role `caption`) with
  the closed line: "Closed by itself since yesterday’s letter: ...". The web
  renders both shapes. `lib/obligations/fixtures.ts` `needsYouLetterFixture`
  shows the stack form.
- The region `summary` is the count sentence ("8 open · 2 now · 2 due today").
  The lane shows it at the kicker's right.
- Items in Now carry `framing.lane: 'now'`; items due today carry
  `framing.lane: 'today'`. The "Due today" sub-label sits before the first
  `today` item that follows a `now` item.
- `framing.age` carries the small label after the sender: the time for a
  mail item ("9:12 AM"), the source and the time for a connected item
  ("GitHub · 8:05 AM"). `framing.sender` is the asker.
- An Albatross question uses `ref.kind: 'work'` with `open_work`. A connected
  item uses `ref.kind: 'mcp'` with `open_url`. The brief has no action that
  closes an obligation; "Done" in the lane needs a new brief action.
- The chat (`components/shell/AIBar.tsx`, not a W file) has no slot for
  cards between messages. The thread shows the items in one block after the
  messages, in time order. True interleaving needs a `thread.extras` slot in
  the chat.
- The thread rail row ("Your turn · Priya asked for the Q3 numbers") is in
  `components/albatross/ThreadRail.tsx` and `lib/albatross/thread-list-view.ts`,
  not W files. It still reads the run state, not the obligations.
- The detail's Albatross card shows the title and "Open thread". The step line
  of the mockup ("Step 2 of 4 · Collect the numbers · Your turn") needs step
  data on the view; the contract has none.
