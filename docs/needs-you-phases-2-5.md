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
