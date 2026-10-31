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
- The repair operates in pages. One page reads a maximum of 40 threads
  (`BACKFILL_THREADS`) in the order of the source key. A closed row keeps
  its position in this order, so no page skips a thread. Each page records
  its last key (`repairAfter`) and the time (`repairAt`) in the flag record,
  and starts the next page.
- The Jev claim starts the repair for each user in the flag. The
  condition is a flag record with an older `rulesVersion`
  (`OBLIGATION_RULES_VERSION` = 2). The last page records the new version.
  If a page fails, the next claim after 30 minutes (`REPAIR_LEASE_MS`)
  continues at `repairAfter`. No manual step is necessary. To start
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
- A calendar write syncs only a changed event. Thus the Jev claim of a
  flag user starts `obligations:fillCalendar` a maximum of one time each
  hour (`CALENDAR_FILL_EVERY_MS`). The fill reads a maximum of 200 events
  of the next 14 days. An unchanged invitation that comes into the 14-day
  window then opens its `rsvp` row. One `userDocs` row of the type
  `needsYouCalendarFill` keeps the time of the last fill.
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

## I notes (iOS, 2026-10-30)

What was built: the Needs you page in the sidebar (shown while the snapshot
says `enabled`), the detail with every action, the push tap, the brief lane
`needs-you`, and Swift Testing tests. Design note:
`docs/research/needs-you-ios-design-2026-10-30.md`.

What the macOS builder can reuse. Every file below is in `Lab86Mail/`, so
the Mac target compiles it already:

- `Core/Models/ObligationModels.swift`: `ObligationView`,
  `NeedsYouSnapshot`, `ObligationAction` (with `body`), the responses, and
  the tolerant decode. Unknown `kind`, `source`, and `closeReason` values
  keep the row.
- `Core/Models/NeedsYouGrouping.swift`: `NeedsYouGrouping.groups(items:
  extras:now:timezone:)`, `summary(of:)`, `laterOptions(now:timezone:)`,
  `settleExpiredCodes`, `nextCodeExpiry`, and `NeedsYouClock`. Same answers
  as `lib/obligations/groups.ts`.
- `Core/Models/NeedsYouLabels.swift`: the words of `labels.ts`.
- `Core/Models/NeedsYouStore.swift`: `environment.needsYou`. `load`,
  `refreshOnForeground`, `refreshAfterPush`, `act`, `undoLast`,
  `prepareDraft`, `sendReply`, `startAlbatross`, `item(id:)`,
  `item(accountID:threadID:)`, `groups(now:extras:)`, `nowCount(now:)`.
  The transport is `any BackendExchanging`; pass `environment.backend`.
- `Features/NeedsYou/NeedsYouPresentation.swift`: the lead, the source
  line, the meta line, the first button, the quiet links, and the extras
  from `ProductStore.pendingQuestions` and `approvals`.
- `Features/NeedsYou/NeedsYouRow.swift`: `NeedsYouObligationRow`,
  `NeedsYouExtraRow`, `NeedsYouLeadView`, `NeedsYouCodeLine`,
  `NeedsYouDueColumn`. They fit a Mac list column as they are.
- `Features/NeedsYou/ObligationDetailView.swift`: `ObligationDetailView(id:)`
  reads the item live from the store. It fits a Mac detail pane. The action
  bar is a `safeAreaInset`.
- `Features/Shell/NavigationModel.swift`: `PrimaryTab.needsYou`,
  `PrimaryTab.sourceList(showsFiles:showsNeedsYou:)`, `openNeedsYou(_:)`,
  `consumeObligation()`, `needsYouEnabled`, and the `/?view=needs-you` links.
- `Core/Notifications/NotificationResponseRouter.swift`:
  `ObligationNotificationTap`. The Mac delegate goes through the same
  `NotificationResponseApplier`, so a tap routes the same way.

What the Mac shell must add (`MacShellView.swift`, `MacSourceList`):

1. `PrimaryTab.sourceList(showsFiles:showsNeedsYou: environment.needsYou.isEnabled)`.
2. In the shell `.task`: `environment.needsYou.activate(ownerID:)`, then
   `environment.navigation.needsYouEnabled = environment.needsYou.isEnabled`
   before `consumeAppIntentRequests()`, then `await environment.needsYou.load(environment.backend)`.
3. On `didBecomeActiveNotification`: the same flag line, then
   `await environment.needsYou.refreshOnForeground(environment.backend)`.
4. On `.lab86RemoteWake`: `await environment.needsYou.refreshAfterPush(environment.backend)`.
5. A list and detail side by side: `NeedsYouView` works as the list; a
   `NavigationSplitView` can put `ObligationDetailView(id:)` in the detail
   column instead of the push.

Push payload (I2). The phase 1 push carries `route`, `accountId`,
`threadId`, `messageId`, and `codeAvailable`, not `type` or an obligation
id (`lib/notifications/apns.ts`, `buildAPNsPayload`). The app routes a tap
by the thread while `needsYouEnabled` is true, and falls back to the thread
when the list has no item. Server ask: add `type: envelope.type` and, for
obligations, `obligationId: envelope.collapseId` to the APNs payload. The
app already reads both keys.

Brief lane (I3). `BriefLetterLayout.classify` reads `needs-you` as an
`entity_list` (the Answer item shape) or as a `stack` of an `entity_list`
and a `text`. The closing line is the last `text` child under the region.
If S2 stores the line in another place, change `closedLine(in:)` only.

## Integration notes (2026-10-30)

The integrator merged S1, S2, W, and I into `claude/needs-you-2` in that
order. Only this document had merge conflicts. All notes sections stay. This
section replaces the parts of the S2 and I notes that it names.

### What changed after the merge

1. Albatross link. The S1 sync writes `workId` and `workTitle` only when the
   source gives an Albatross. A sync with no label keeps the link that "Start
   in Albatross" set. An integration test holds this for mail and Slack.
2. One snapshot loader. `loadNeedsYouSnapshot` in `convex/obligations.ts`
   gives the snapshot to `obligations:needsYou` (web) and to
   `obligationViews:snapshotFor` (mobile, brief). The S2 copy and its
   `withSourceFields` mapping are gone. Each view comes from `viewOf`.
3. Mobile actions. `POST /api/mobile/v1/needs-you/[id]` accepts
   `{ action: 'rsvp', response }`. A second `bun run mobile:openapi` gives no
   change. The iOS store reads the server line from `error.message` of the
   mobile error envelope. It used to read `error` as a string.
4. Push payload. The APNs payload has `type` when the notification has one,
   and `obligationId` when the push names one item. The summary push names no
   item. `codeAvailable` did not change.
5. The brief lane. See the next section.
6. TestFlight. `start-xcode-cloud.mjs` names a pending Apple Developer
   Program License Agreement after a 500 at the build start.

### The brief lane: one shape

Real daily editions are editorial documents. Web and iOS render an editorial
region node by node. They use the letter renderers only for a document with
the letter layout. Thus the lane has one letter region and one editorial
module, and the server makes the module from the region.

- Letter region `needs-you`. The summary is the count sentence, for example
  "8 open · 2 now · 2 due today". A count of zero is not in the sentence. The
  tree is an `entity_list` with the title "Needs you". Each item has the item
  shape of the `answer` lane and `framing.lane` `now` or `today`. A closed
  line makes the tree a `stack` of the list and one `text` node with the role
  `caption`. A lane with no items is a `stack` of the caption only. There is
  no `needs-you-note` region. That region id stopped the letter layout on
  both clients.
- Closed line. "Closed by itself since yesterday’s letter: A (Asker); B." A
  lane with no items starts with "None is due today. N open items are on the
  Needs you page." The region stores `previousGeneratedAt`. Thus the
  composed letter and each live refresh write the same words.
- Editorial module `needs-you`. The lane is one module, as "What Albatross
  did" is. Its story is a `group` with the title "Needs you" and the count
  sentence as the kicker. The children are the Now rows, a `kicker` text
  "Due today", the rows due today, and the closed line as a `caption`. The
  rows have no `framing.lane`, so the generic renderers show no lane word.
  The story is two levels deep, so the writer can put it at any plan level.
- Clients. Web and iOS render the group with no lane code. Older iOS builds
  render it too. The web letter shows a lane that has a closed line and no
  rows.
- Live refresh. `projectBriefMail` (`lib/jev/report.ts`) recomposed the
  letter without the lane, so each read showed Answer again. It now places
  the lane.
- Region limit. `defaultEditorialPlan` puts the last sections into one
  region when a full letter and the two live sections make more than 12.
- Fallback letter. `briefLetterFromReport` shows the lane in the place of
  Answer when the edition has `sections.needsYou`. `DailyReport.sections`
  has `needsYou?: BriefNeedsYouRegion`.
- `open_view` with `view: 'notifications'` and an `obligationId` opens that
  item. Web: `BriefCanvas` and the artifact frame of `DailyReport`. iOS: the
  Needs you page (`TodayBriefNavigationIntent.obligation`).
- Previews: `/dev/brief-preview?layout=needs-you` (letter) and
  `/dev/brief-preview?layout=needs-you-editorial` (editorial).

### Open items

1. The brief has no action that closes an obligation. "Done" in the lane
   needs a new brief action on web, iOS, and the server (W).
2. The Work thread shows its items in one block after the messages. Items
   between the messages need a `thread.extras` slot in
   `components/shell/AIBar.tsx` (W).
3. The thread rail row (`ThreadRail.tsx`, `lib/albatross/thread-list-view.ts`)
   reads the run state, not the obligations (W).
4. The step line of the Albatross card ("Step 2 of 4 · ... · Your turn")
   needs step data on `ObligationView`. The contract has none (W).
5. The brief lane holds obligations only. Albatross questions and approvals
   (the extras of the page) are not in the lane. The W fixture shows one.
6. `framing.age` is "Day N" from `createdAt`, or empty on the first day. For a
   connected item, `framing.reason` is the place ("Slack, #release"). The W
   design shows the time ("9:12 AM") and "GitHub · 8:05 AM" in `age`.
7. The iOS letter form shows no count sentence and no "Due today" label.
   Real editions are editorial and show both. A stored letter document is
   rare: old editions, or an editorial layout that did not compose.
8. The deterministic HTML artifact (`buildNativeDailyReportArtifact`,
   `compositionFromReport`) shows the old lanes, not Needs you. The web and
   iOS show it when the composition fails and the edition has no document.
9. The prose writer reads `sections.answer`, not the ledger. The lede can
   name a thread that the page shows under Needs you. The editorial writer
   reads the lane module.
10. The macOS shell must add the steps of "What the Mac shell must add" in
    the I notes (M).
11. Swift edits of the integrator (`NeedsYouStore.swift`, the `open_view`
    route, their tests) compile only in the Native acceptance workflow.

## M notes (macOS, 2026-10-30)

What was built. The Mac shows Needs you as a list beside the detail, as
Mail shows the reading pane. The files are in `Lab86MailMac/NeedsYou/`:

- `MacNeedsYouSplitView.swift`: the `HSplitView`, the list, the detail, the
  Undo notice, the push target, and the keys.
- `MacNeedsYouRow.swift`: the row with the hover verb, the Later popover,
  and the detail of an Albatross question or approval.
- `MacNeedsYouLayout.swift`: the pure rules. The visible rows, the key
  moves, the selection after a row leaves, the key actions, the copy items,
  the hover verb, and the words and states of the Needs You menu.
- `MacNeedsYouCommands.swift`: the Needs You menu.

What was reused as it is. The models, the grouping, the labels, the store,
`NeedsYouPresentation`, `NeedsYouLeadView`, `NeedsYouCodeLine`,
`NeedsYouDueColumn`, `NeedsYouExtraRow`, `ObligationDetailView(id:)`, the
navigation model, the push router, and the brief lane. The brief view is
shared, so M4 needs no Mac code.

The shell (`MacShellView.swift`). `MacRootDestinationView` shows the split
for `.needsYou` and the shared switch for the other tabs. The shell adds
the five lines from the I notes. The sidebar row shows "N now" at its
trailing edge.

The keys. The list is one focusable view. A click on a row gives it the
keyboard. Up, Down, j, and k move the selection across the groups. Home
and End go to the first and the last row. Return opens the selected row;
an Albatross row opens its thread. The key e marks Done. The key l opens
the Later popover beside the row. Command-C copies the code of an open code
row, through `.copyable` and the menu item. After a row leaves the list,
the selection moves to the row after it, then to the row before it.

The Needs You menu. Mark Done (Shift-Command-D), Later with its three
times, Not Mine, Copy Code (Command-C), Start in Albatross, and Open in
Mail (or Slack, Jira, ...). The items work only while the page is up with
no sheet over it, and only on a row that has the action. The bare keys
are not menu items: a bare letter as a menu key equivalent fires inside
every text field. The menu is part of `MacGoCommands`. The shared app file
needs no change.

Not built. Command-Return for Send reply. The shared `ObligationDetailView`
holds the edited draft text, so a menu item cannot reach it. A small seam
in that view (a trigger token for the first button) would make it possible.

Tests. `Lab86MailTests/MacNeedsYouLayoutTests.swift` covers the rules
above, the menu requests, the sidebar row, and the push tap on the Mac.
`NativeTourMacTests` gains the screen `mac-needs-you`, drawn from a seeded
snapshot with invented people.
