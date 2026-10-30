# Needs you, phase 1: build plan (web)

Design: `docs/needs-you.md`. Web design note:
`docs/research/needs-you-web-design-2026-10-30.md`. Mockups:
https://files.lab86.io/needs-you-2026-10-30/ (local copy `/tmp/needs-you-mockup/`).
Shared contract: `lib/obligations/contract.ts`. Do not change the contract
without a note in the PR; changes must be additive.

Phase 1 scope: mail obligations from Jev, one-time codes, the Albatross items
that the Notifications page shows now, obligation pushes, the web Needs you
page, and the web notification settings. All behind `LAB86_NEEDS_YOU`
(`needsYouFlagFor`). With the flag off, nothing changes for the user, except
the code fix in item S6.

## Server (builder 1)

S1. **Jev `due` question.** Add `due` (choice: `today`, `soon`, `later`,
`none`) to `buildMailQuestions` in `lib/jev/mail.ts`, and an optional `due`
field to `jevAssessmentSchema`. Do NOT change `JEV_VERSION` or
`JEV_QUESTION_VERSION`: a change queues every thread again (cost and Convex
I/O). An old assessment without `due` reads as `none`.

S2. **Rules.** `lib/obligations/rules.ts`, pure:
- `mailObligations(assessment, thread, settings, now)` gives the wanted
  obligations of one thread: kind, title, asker, why, excerpt, due, dueAt,
  probability, pushLevel. Follow the rule table in `docs/needs-you.md`
  ("Part 2: rules decide the message"). Promotions and newsletters give none.
- `dueAtFromEvidence(text, due, timezone, now)`: an optional concrete time for
  plain phrases ("today", "tomorrow", a weekday, "by October 31"). Use
  `date-fns`. Return undefined when not sure.

S3. **Table and functions.** Convex table `obligations` with the fields in
`docs/needs-you.md` ("Data") and the indexes there. `convex/obligations.ts`:
- `syncThread` (internal): called inside `jev.storeAssessments` for each
  stored thread when the user is in the flag. It opens, updates, and resolves
  the obligations of that thread, in the same transaction. A kind that is gone
  from the new assessment closes as `resolved` (`evidence`), or as
  `sent_reply` when the newest message is the user's own reply. A user close
  stays closed. It returns the ids that need a push.
- `needsYou` (query, signed-in user): returns `NeedsYouSnapshot`.
- The mutations that the API routes use for actions, Undo, and codes.
- Add the table to `deleteUserCascade` (`convex/accounts.ts`) and to the data
  export. Hand-edit `convex/_generated/api.d.ts`. Never run `convex dev` or
  `convex codegen` here: it uploads to production.

S4. **Push delivery.** `lib/obligations/delivery.ts`:
- A new notification type `obligation` that points to the obligation row.
  Title: the asker. Body: the obligation title. The deep link opens the source
  thread, in the same format as the `mail_message` link, so the iOS app opens
  it without changes.
- Add `collapseId` to the APNs envelope (`apns-collapse-id` = the obligation
  id), so a change replaces the old push. `time_sensitive` uses the same
  interruption level as `urgent_mail`.
- Quiet hours and VIP rules from `lib/notifications/mail-push.ts`. A limit of
  `PUSH_HOURLY_LIMIT` pushes each hour, codes not included. Over the limit,
  the obligation stays in-app, and at most one summary push each hour says
  "N more things need you".
- `lib/jev/service.ts` dispatches the ids that `syncThread` returns.

S5. **Stop per-mail pushes for flag users.** In `lib/mail/urgent-detectors.ts`,
a flag user gets no `mail_message` rows and no new-mail digest. Language-urgent
mail without a code keeps `urgent_mail` in phase 1.

S6. **Codes.** For a flag user, a recorded code opens a `code` obligation and
pushes at once with `codeAvailable: true`, with no `urgent_mail` row. Quiet
hours and the hourly limit never hold a code. The consume route
(`/api/mobile/one-time-codes/consume`) closes it as `code_used`; expiry closes
it as `expired`. FOR ALL USERS: fix the defect where quiet hours hold a code
push and the held push loses `codeAvailable`.

S7. **API routes.** `POST /api/obligations/[id]` (ObligationAction),
`POST /api/obligations/[id]/draft`, `POST /api/obligations/[id]/reply`. The
response shapes are in the contract. `not_mine` writes a scoped Jev correction
(`lib/jev/contract.ts`). `done` on a reply without a sent reply closes as
`user_done_no_reply`. `undo` works only inside `UNDO_WINDOW_MS`. The reply
route uses the existing send path with its undo-send delay.

S8. **Settings.** An optional preference `obligationPushEnabled` (default on)
in `albatrossNotificationPreferences`, read by the delivery code.

## Web (builder 2)

W1. `lib/obligations/groups.ts`, pure: `groupNeedsYou(items, extras, now,
timezone)`. Order: `NEEDS_YOU_GROUP_ORDER`. Rules:
- Closed since the start of today: `closed_today`. A snoozed item before its
  time: hidden.
- `waiting`: `waiting`.
- Open codes, `time_sensitive` items, overdue items, and Albatross questions
  and approvals: `now`.
- `due` today or `dueAt` today: `today`. `soon` or `dueAt` in the next 7 days:
  `this_week`. `later` or a later `dueAt`: `after_this_week`. No date:
  `no_date`. Albatross check-ins: `today`.
- In a group, items with `dueAt` come first, by `dueAt`; then the newest first.

W2. The Needs you page in place of the Notifications page when
`NeedsYouSnapshot.enabled` is true: list, detail, actions, Undo, keyboard,
the empty and closed states. Follow the mockups and the design note.

W3. The rail bell count is the `now` group count for flag users. An in-app
toast shows a new `now` item while the page is open.

W4. Settings, Notifications for flag users: "Push me when something needs
me", quiet hours, VIP senders, verification codes. No per-mail push setting.

W5. `/dev/needs-you-preview` with fixtures (dev only, 404 in production), and
component tests.

## Done means

- `bun run typecheck`, `bun run typecheck:tests`, `bun run lint`, and the full
  test suite pass. The coverage gate passes: new lib files need full coverage,
  and changed lib files must not lose coverage.
- One PR to `main`. CodeRabbit once. The merge waits for Jakob.
- After the merge: set `LAB86_NEEDS_YOU` to Jakob's user id on Railway
  production (never `railway variables --kv`).
