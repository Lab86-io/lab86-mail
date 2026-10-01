# Direct Google transport

Status: in progress (branch `claude/casa-prep`; Gmail on `claude/google-gmail`, 2026-09-28). Owner: Claude.

## Goal

Google accounts talk to Google directly: Gmail, Google Calendar, and Google
contacts. Microsoft and iCloud accounts stay on Nylas. This work comes before
the Google verification submission, so that the CASA assessment sees the final
system. The Google scopes do not change.

## Decisions

- **Identity.** A Google account keeps its `accountId`. Nylas v3 stores Gmail's
  own thread, message, and event ids, so the corpus, labels, Jev verdicts,
  calendar rows, and area links stay valid. Only the grant id changes: it
  becomes `google:<random UUID>`, a new id for each connection
  (`newGoogleDirectGrantId` in `lib/google/transport.ts`). The id does not
  hold the account id: two users can share one accountId (a Nylas grant id
  is the accountId of the first connection, and one mailbox can be connected
  under two users). A lookup by grant id finds exactly one connection, and
  Convex refuses a state where two rows share a direct grant id. A reconnect
  keeps the grant id of its connection.
- **Router.** `requireNylas()` returns a proxy (`routeNylasClient` in
  `lib/nylas/client.ts`). A call on `messages`, `threads`, `folders`,
  `attachments`, `drafts`, `events`, `calendars`, `contacts`, or `grants` whose
  `identifier` (or `grantId`) starts with `google:` goes to the Google adapter
  (`lib/google/adapter/*`). All other calls go to Nylas. Callers do not change.
- **Adapter contract.** Each adapter method takes the same arguments as the
  Nylas SDK method and returns the same shape: lists return
  `{ data, requestId, nextCursor? }`, finds return `{ data, requestId }`,
  `attachments.download` returns a web `ReadableStream`. A method that does not
  exist rejects with `GoogleApiError(501)`.
- **HTTP.** All Google calls go through `googleFetch` / `googleJson`
  (`lib/google/http.ts`): bearer token, one refresh on 401, retry with backoff
  on 429 and 5xx, and errors with `statusCode` (the field that
  `nylasErrorStatus()` reads).
- **Tokens.** The refresh token is encrypted (`encryptSecret`) in
  `providerGrants.refreshTokenEncrypted`, on the one row whose `grantId` is
  the direct grant id. A token refresh writes only the row of its own
  (userId, accountId). `getGoogleAccessToken` caches the access token in
  memory and refreshes it. `invalid_grant` marks the account as needing a
  reconnect.
- **OAuth client.** `GOOGLE_MAIL_CLIENT_ID` / `GOOGLE_MAIL_CLIENT_SECRET`,
  with a fallback to `GOOGLE_DRIVE_CLIENT_ID` / `GOOGLE_DRIVE_CLIENT_SECRET`.
  The Drive client is in the same Google Cloud project (452431903621,
  `lab86-mail-production`) as the Nylas Google connector client, so the
  consent screen and the verification are the same.
- **Redirect URI.** The Google mail flow uses the redirect URI that the Drive
  client already has: `cloudFileOAuthRedirectUri()`
  (`/api/files/oauth/callback`). That route first tries the Google mail state
  store, then the Files state store. No Google Console change is necessary.
- **Scopes.** The same set as the production Nylas Google connector: `openid`,
  `userinfo.email`, `userinfo.profile`, `gmail.modify`, `calendar`,
  `contacts.readonly`, `contacts.other.readonly`, `directory.readonly`.
  `access_type=offline`, `prompt=consent`, PKCE.
- **Callback binding.** The web callback requires a signed-in session whose
  user id equals the state's user id. A native flow gets a single-use
  completion token in the shared completion store, and the signed-in app
  redeems it through the authenticated `/api/nylas/finalize` route.
- **Cutover.** Two paths:
  1. Switch an existing Nylas Google account in place. The OAuth email must
     equal the account email. The Nylas grant id is kept on the Google
     `providerGrants` row (`previousNylasGrantId`) for a rollback. The Nylas
     grant is destroyed when the user disconnects the account, or by the
     owner-run cleanup (section "Cleanup").
  2. New Google connections use the direct flow when `LAB86_GOOGLE_DIRECT=1`.
- **Sync.** A cron polls the Gmail History API every 2 minutes for each direct
  account (`history.list` from the stored `historyId`). A `404` (history too
  old) runs the normal reconcile path. Gmail push through Cloud Pub/Sub is in
  the code, but it is off until the owner sets its flags (section "Push").
  With healthy push, the cron reads a mailbox about every 15 minutes.
- **Scheduled send.** Gmail has no scheduled send. A direct account holds a
  scheduled message in the mail outbox (`mailOutbox`) with a future fire time.
  The list and cancel calls read the outbox.
- **Attachment ids.** Stored Nylas ids have the form
  `v0:<base64url name>:<base64url content type>:<n>`. The adapter resolves such
  an id by the file name and content type of the MIME part. It emits ids in the
  same form for new mail, so one decoder serves old and new rows.

## Calendar and contacts

- **Ids.** Nylas kept Google's own ids, and the adapter gives the same ids.
  A calendar id is the Google calendar id (the address for the primary
  calendar). A recurring instance is `<master>_<YYYYMMDDTHHMMSSZ>`, and
  `masterEventId` is Google's `recurringEventId`. A saved contact is `c123`
  (from `people/c123`), a directory person is the number, and an other
  contact keeps `otherContacts/c123`. Production rows show these forms
  (2026-09-28).
- **Field rules.** `lib/google/calendar-map.ts` and
  `lib/google/contacts-map.ts` hold the rules. All-day end dates are
  exclusive, as in Google. A timed event is always a `timespan`. `readOnly` is
  `true` on a calendar that the user cannot write. It is also `true` for an
  event that a different person organizes.
- **Unsubscribe.** `calendars.destroy` removes the calendar from the user's
  calendar list (`calendarList.delete`). It does not remove the calendar
  itself. Nylas removed a secondary calendar that the user owned.
- **Calendar list.** The adapter includes calendars that are hidden in the
  Google sidebar. Thus the sync prune does not remove their rows.
- **Working location.** `events.list` does not include working-location
  events. A caller can request that type.
- **Rate limits.** The Calendar API can send 403 for a rate limit. The
  adapter changes it to 429, because the callers read a 403 as a missing
  scope.
- **Contact search.** An `email` filter uses the search call of each source
  (saved contacts, other contacts, directory). It keeps only the persons
  with that address. The first search of a grant sends an empty warm-up
  query, as the Google documentation specifies.
- **Limits.** The People API has no read of one other contact. Thus
  `contacts.find` for an other contact rejects with 501. A direct account gets
  calendar push only with `LAB86_GOOGLE_CALENDAR_PUSH=1` (section "Push").
  Contacts get no push. The 15-minute poll, the daily full pass, and the sync
  after each write keep the mirror current.

## Gmail

These rules add to the decisions above or make them exact.

- **Switch gate.** `/api/google/connect?mode=switch&account=<email or
  accountId>` is enabled by `isDevelopmentRuntime()` (`lib/hosted/controls.ts`).
  This existing feature gate checks runtime mode, not the Convex target. Before
  local testing, verify that `CONVEX_DEPLOYMENT` and `NEXT_PUBLIC_CONVEX_URL`
  select local Convex, and use only test accounts and synthetic data. Keep
  `LAB86_DEVELOPMENT_MODE` unset in hosted production. In production the flow needs
  `LAB86_GOOGLE_DIRECT=1` or `LAB86_GOOGLE_DIRECT_SWITCH=1`. The Gmail address
  of the sign-in must equal the account address; the flow refuses another
  address and stores nothing.
- **Modes.** `switch` moves a Nylas account in place. `reconnect` renews the
  sign-in of a direct account. `new` connects a Google account; when the user
  has an account with the same address, `new` switches or reconnects it.
  After a switch or a new connection, the calendar sync and the contact sync
  start at once (forced), as after a Nylas sign-in.
- **Reconnect.** A request to `/api/nylas/connect` that names a direct
  Google account (`account=<accountId or email>`) reconnects that account
  directly, with the flag on or off. The Settings Reconnect link names its
  account. The native Reconnect names its account too
  (`WebAuthenticationCoordinator.mailboxConnectPath`), so a native reconnect
  of a direct account stays direct. A request that names no account is a new
  connection: direct with `LAB86_GOOGLE_DIRECT=1`, Nylas without it. So a
  user can always add a different Google account.
- **Native.** A native Google connection takes the same choice as a web one.
  The callback keeps the Google result in the shared completion store
  (`oauthCompletions`, kind `mail`) and opens
  `lab86://oauth/mail?nylas_completion=<token>`. The app redeems it at
  `/api/nylas/finalize`, as for Nylas; that route sends a Google result to
  `finalizeGoogleMailCompletion`. So the app needs no change.
- **Tokens.** An `invalid_grant` answer, or a missing token row, puts every
  account on the grant in the reconnect state. `lib/google/tokens.ts` calls
  `markGrantNeedsReconnect` (`lib/nylas/grant-health.ts`), which runs the
  Convex mutation `accounts.markGrantReconnectNeeded`. This is the same state
  as a dead Nylas grant.
- **Message shape.** `folders` are the Gmail label ids, as Nylas gives them.
  A message with only a text part gets that text as `body`, not escaped HTML:
  Nylas does the same, and the stored rows must stay equal. The corpus writer
  compares subject, addresses, attachments, and text; a difference clears the
  thread verdict, and Jev reads the thread again.
- **Attachment ids.** `<n>` in `v0:<name>:<content type>:<n>` is the decoded
  byte size (Gmail `body.size`). The content type is the whole `Content-Type`
  value of the part, with its parameters (for example
  `application/pdf; name=invoice.pdf`). A part without a name has an empty
  name. A download reads the message again and finds the part by name, type,
  and size, then by name and size, then by name and type, then by a single
  name. A raw Gmail attachment id also works.
- **Lists.** A plain list includes Spam and Trash, as Nylas does, so the
  repair sweep sees mail that moved there. A native search keeps Gmail's own
  search rules. Drafts are not messages.
- **Label changes.** A folder set replaces the labels, but UNREAD and STARRED
  change only through the `unread` and `starred` flags. DRAFT, SENT, and CHAT
  never change. A thread's labels are the union of its message labels.
- **Send.** The adapter sends RFC 2822 MIME through the upload endpoint (up
  to 35 MB) with the thread id of the parent message. A 5xx answer is not
  retried, because Gmail can send the message and still answer 5xx. Gmail
  writes the From header.
- **Scheduled send.** A held send is a `mailOutbox` row with `scheduled` and
  `accountId`. Its outbox key is the schedule id. A disconnect cancels the
  held sends of the mailbox and deletes their stored messages. The grant
  removal and the account removal both do this, so a failed grant removal
  does not keep a message. The disconnect cancels 50 sends in its own
  transaction and schedules bounded passes for the rest
  (`mailOutbox:cancelHeldSendsBatch`).
- **History sync.** The cron runs every 2 minutes and reads at most 400
  changed messages in a run; the rest comes in the next run. New mail is read
  with its headers. A label change is read without headers, so the stored
  headers stay. Nylas webhooks for the Nylas grant of a switched account are
  marked `processed` and ignored.
- **History failures.** Only a failed `history.list` (or a dead grant) keeps
  the stored History id. A message that cannot be read, a delete that fails,
  or a message that the corpus writer refuses is counted and skipped, and the
  id moves forward; the repair sweep reads recent mail again every 30
  minutes. A failed upsert batch is written again one message at a time. The
  id moves only forward (`googleDirect:advanceHistoryId` compares the ids as
  numbers), so two overlapping runs cannot move the sync back.
- **Disconnect.** The revoke comes before the account rows go, because the
  refresh token is in the `providerGrants` row. A network error, a 429, or a
  5xx gets two more tries. A failed revoke is logged, and the token row goes
  anyway. The Nylas grant of a switched account is destroyed at this time,
  but only when no other connection (of any user) still uses it.
- **One grant for mail and Drive.** Mail falls back to the Drive OAuth
  client. A Google revoke removes all the access that the user gave to the
  Google Cloud project, for all the OAuth clients of that project. So a
  revoke from one feature ends the other. This is also correct for a separate
  `GOOGLE_MAIL_CLIENT_ID` in the same project. The mail flow does not send
  `include_granted_scopes`. Before a revoke, the mail disconnect and the Files
  disconnect each check for a live connection of the other feature for the
  same user and Google address in the same project
  (`lib/google/shared-grant.ts`). The project number is the numeric start of
  the client id. If there is a connection, only our token row goes and no
  revoke is sent; the log says so. A failed check also skips the revoke. Only
  a mail OAuth client in another Google Cloud project ends the sharing. That
  project needs its own consent screen and verification (an owner decision).
- **No revoke outside production, or while Nylas uses the address.** A local
  OAuth test can share a Google Cloud project with production, so a revoke
  there could end production access for that address. Use isolated test accounts
  as described in the [release runbook](hosted-release-runbook.md). Only a deployment
  with `RAILWAY_ENVIRONMENT_NAME=production` (or `LAB86_GOOGLE_REVOKE=1`)
  revokes. Production also skips the revoke while another live Google
  connection of any user in the deployment uses the address: a Nylas or
  direct mail account, or a Google Drive connection, other than the one that
  goes (`googleDirect:googleAccessUsesAddress`).
  In each case only our token row goes (`googleRevokeBlockedReason` in
  `lib/google/shared-grant.ts`). The check finds a Drive connection by its
  stored address, so a Drive address is stored trimmed and in lower case
  (`cloudFiles:upsertConnection`), as a mail address is.
- **Rollback.** `googleDirect:rollbackToNylas` does not revoke the Google
  token. Google can revoke the whole project grant, and the production Nylas
  connector is in the same Google Cloud project. The token row is deleted.

### Runbook: switch one account

1. Validate locally with a test account, then release through a reviewed PR to
   `main` using the [release runbook](hosted-release-runbook.md). Verify the live
   production version and that `LAB86_GOOGLE_DIRECT=1` or
   `LAB86_GOOGLE_DIRECT_SWITCH=1` is enabled before switching a real account.
2. Sign in to `https://mail.lab86.io` as the account owner.
3. Open `/api/google/connect?mode=switch&account=<email>` in that browser.
4. On the Google screen, choose the same Google account and allow all access.
5. The app opens `/settings?nylas_connected=1&google_mail=switched`.
6. Check: in the Convex dashboard, `connectedAccounts.grantId` starts with
   `google:`, the `providerGrants` row has the same grant id, and
   `mailSyncStates.historyId` has a value.
7. Send a message to the account. It must show in the inbox within about
   2 minutes (the History cron).

### Runbook: roll back one account

1. In the Convex dashboard, run `googleDirect:rollbackToNylas` with
   `{ "userId": "<userId>", "accountId": "<accountId>" }`.
2. The result must be `{ ok: true, grantId: "<Nylas grant id>" }`.
3. Nylas webhooks for that grant are processed again. The corpus stays.
4. The Google access stays in the Google account permissions until the owner
   removes it there.
5. With Gmail or Calendar push on, the rollback removes the Google token
   before the app can stop the watch and the channels of the account. Google
   ends them at their expiration (at most 7 days). The push routes find no
   direct account or no row for them, so their messages do nothing. The
   hourly push cron removes their rows.

A rollback is not possible after the cleanup below.

### Cleanup

A switched Google account keeps its old Nylas grant in
`providerGrants.previousNylasGrantId`, for the rollback. Nylas bills each
grant. When the direct transport is stable, the owner deletes these grants
with `scripts/nylas-grant-cleanup.ts`.

**Warning.** After the cleanup, `googleDirect:rollbackToNylas` does not work
for the cleaned accounts. The rollback answers "The Nylas grant cleanup deleted
the Nylas grant." To go back to Nylas, the user must connect the mailbox
through Nylas again.

What the command does:

- It reads the plan from `googleDirect:nylasGrantCleanupPlan`. This query
  changes nothing.
- The default is a dry run. Only `--apply` deletes.
- For each eligible grant, `googleDirect:claimNylasGrantCleanup` first checks
  the grant again in one transaction. Then it moves the grant from
  `previousNylasGrantId` to `nylasGrantDeletePending` on each connection that
  keeps it. From this point, `rollbackToNylas` cannot use the grant.
- Then the command calls the Nylas v3 API `DELETE /v3/grants/{grantId}`. A
  success or a 404 counts as done. `googleDirect:finishNylasGrantCleanup`
  then sets `nylasGrantRevokedAt` on the connections that the claim holds.
- A failed delete gives the grant back to `previousNylasGrantId`, so the
  rollback still works for that account. The command then exits with code 1.
- If a run stops between the claim and the finish, the rows keep
  `nylasGrantDeletePending`. The dry run for that account tells you so.
- Nylas then sends `grant.deleted` for the grant. The webhook marks the
  accounts on that grant for a reconnect. No account is on it, so nothing
  changes.

The command keeps a Nylas grant in these cases:

- The account does not use a direct grant: its `grantId` does not start with
  `google:`.
- The direct connection is not `connected`. It can need the rollback.
- A connection of any user is on that Nylas grant now.
- One-account mode: another switched connection keeps the same Nylas grant
  (one mailbox under two users). Use the age mode for all of them.
- Age mode: a connection that keeps the grant switched less than N hours ago,
  or has no switch time. A switch records `switchedToGoogleAt`. A switch from
  before this field has no time. Clean up such an account with the one-account
  mode.

The Nylas API key is in the environment of the Railway `web` service. Convex
does not have it. Thus the command runs with `railway run`, from a checkout of
`main` that is linked to the `lab86-mail` Railway project. The first two lines
of the output show the Convex URL and the Nylas API URL. Check them before you
use `--apply`. The output shows grant ids, account ids, and addresses. It shows
no key and no token.

Get `userId` and `accountId` from the Convex dashboard, table
`connectedAccounts`.

1. Do a dry run for one account. It changes nothing:

   ```bash
   railway run --environment production --service web -- \
     bun scripts/nylas-grant-cleanup.ts --user <userId> --account <accountId>
   ```

2. Read the output. `WOULD DELETE <grant id>` names the grant that the command
   deletes. `SKIPPED` gives the reason to keep a grant.
3. Delete the grant of that account:

   ```bash
   railway run --environment production --service web -- \
     bun scripts/nylas-grant-cleanup.ts --user <userId> --account <accountId> --apply
   ```

4. For all switched accounts whose switch is older than N hours (for example
   168 hours, one week), do the dry run, and then the real run:

   ```bash
   railway run --environment production --service web -- \
     bun scripts/nylas-grant-cleanup.ts --older-than-hours 168
   railway run --environment production --service web -- \
     bun scripts/nylas-grant-cleanup.ts --older-than-hours 168 --apply
   ```

5. Do the dry run again. In the one-account mode, a cleaned account shows
   "The cleanup deleted the Nylas grant at <time>." In the age mode, a cleaned
   account is not in the list.

The age mode reads at most 500 token rows in one run. The output tells you when
it reads that limit. Then run the command again.

### Runbook: store old Drive addresses in lower case

Drive connections from before the change can have an address in mixed case.
Run this one time on each deployment. The fix reads the table in pages of
100 and is idempotent.

1. Do a dry run. It counts and writes nothing:
   `CONVEX_DEPLOYMENT=prod:proficient-viper-594 npx convex run cloudFiles:normalizeDriveAccountEmails '{"dryRun": true}'`
2. Read the totals in the deployment logs (`[drive address case]`).
3. Do the real pass:
   `CONVEX_DEPLOYMENT=prod:proficient-viper-594 npx convex run cloudFiles:normalizeDriveAccountEmails '{}'`
4. Do step 1 again. The logs must show `changed 0`.

Use the explicit production deployment above; the historical project default selected
a different deployment, so `--prod` alone is not a sufficient target check. Rehearse
with synthetic rows on local Convex before applying the pass to production.

### Variables

- `GOOGLE_MAIL_CLIENT_ID`, `GOOGLE_MAIL_CLIENT_SECRET` (optional; the Drive
  client is the fallback).
- `LAB86_GOOGLE_DIRECT=1`: new Google connections go direct.
- `LAB86_GOOGLE_DIRECT_SWITCH=1`: the switch works in production without the
  flag above.

## Push

Status: in the code, off by default (2026-10-01). A flag turns on each part.
No new OAuth scope is necessary. The scope `gmail.modify` lets the app call
`users.watch` and `users.stop`. The scope `calendar` lets it call
`events.watch` and `channels.stop`. The scope `drive.readonly` lets it call
`changes.watch` and `channels.stop`.

### Routes

| Route | Caller | Check |
|---|---|---|
| `POST /api/google/push/gmail` | Cloud Pub/Sub push subscription `gmail-push-albatross` | The OIDC token in `Authorization: Bearer`: a Google RS256 signature (keys from `https://www.googleapis.com/oauth2/v3/certs`), `iss` is `accounts.google.com`, `aud` is `LAB86_GOOGLE_PUBSUB_AUDIENCE`, `email` is `LAB86_GOOGLE_PUBSUB_SERVICE_ACCOUNT`, `email_verified` is `true`, and the token is not expired. |
| `POST /api/google/push/calendar` | Google Calendar channel | `X-Goog-Channel-ID` finds the row. The SHA-256 hash of `X-Goog-Channel-Token` is equal to the stored hash. `X-Goog-Resource-ID` is equal to the stored resource id. |
| `POST /api/google/push/drive` | Google Drive changes channel | The same checks as for Calendar. |
| `POST /api/cron/google-push` | Convex cron `googlePush:renewalTick`, each hour | The internal secret. |

Answers:

- When the flag of a route is off, the route answers 204 and does nothing.
- The Gmail route answers 401 when the token is not correct, or when a
  Pub/Sub variable is missing. Pub/Sub then sends the message again. All
  other answers are 204: also for a body that is not correct, and for an
  address that has no direct account. Thus Pub/Sub does not send bad input
  again.
- The Calendar and Drive routes answer 204, because Google does not send a
  message again after a 2xx answer. A message with an incorrect token, an
  incorrect resource, or an unknown channel does nothing.
- These two routes are public. Thus each app instance reads at most 600
  channel rows in one minute from Convex. It keeps a checked row in memory for
  5 minutes, and an unknown channel id for 10 minutes. A message over the read
  budget gets 503 before a read, and Google sends it again later.

What a message does:

- A message has no mail, event, or file data. It only starts a sync that the
  app has already: the History sync of the mailbox (`syncGoogleHistory`), the
  calendar sync of the account (`syncCalendarAccount`, window `auto`), or the
  content sync of the Drive connection (`syncCloudContent`).
- The sync starts 2 seconds (Gmail) or 5 seconds (Calendar, Drive) after the
  first message. More messages in that time start no more syncs. A message
  during a sync starts one more sync after it. A sync that was busy, or that
  has more to read, starts again after a short time. The number of these
  starts has a limit.
- A Calendar or Drive `sync` message (the first message of a new channel)
  starts no sync. It shows that the path from Google to the app works.
- The code is in `lib/google/push/` (`receive.ts`, `renewal.ts`,
  `calendar-poll.ts`, `oidc.ts`, `rules.ts`).

### State

The Convex table `googlePushChannels` (`convex/googlePushSchema.ts`) has one
row for each Gmail watch (one for each mailbox), each Calendar channel (one
for each calendar), and each Drive channel (one for each connection). A row
keeps the channel id (a random UUID), the resource id, the SHA-256 hash of the
channel token (not the token), the expiration, the time of the last watch call
(`requestedAt`), and the time of the last message (`lastMessageAt`). The
account deletion removes the rows. The data export does not include them.

### Watch and channel life

The Convex cron `google push renewal` runs each hour. It calls
`/api/cron/google-push` for each user with a connected direct Google account,
a connected Google Drive connection, or push rows. With all flags off and no
rows, the route does nothing. If not, `lib/google/push/renewal.ts` does these
steps for the user:

- Gmail (`LAB86_GOOGLE_GMAIL_PUSH=1`): it calls `users.watch` for each
  connected direct mailbox, with the topic `LAB86_GOOGLE_PUBSUB_TOPIC`. The
  watch does not include drafts (`labelIds: ["DRAFT"]`, `labelFilterBehavior:
  "exclude"`), because Gmail changes a draft many times while a person writes.
  A watch ends after 7 days. Google recommends one watch call each day, so the
  cron calls `users.watch` again after 20 hours.
- Gmail and Nylas: Gmail keeps one watch for each mailbox and Google Cloud
  project. The Nylas Google connector is in the same project, so a watch call
  of the app can replace a watch of Nylas, and a stop can end it. Thus a
  mailbox gets no Gmail watch while a Nylas grant has its address: a live
  Nylas connection of any user, or the Nylas grant that a switched account
  keeps for the rollback. The Nylas grant cleanup (section "Cleanup") ends
  that state for a switched account.
- Calendar (`LAB86_GOOGLE_CALENDAR_PUSH=1`): it calls `events.watch` for each
  calendar of each connected direct account. A channel has a life of 7 days.
  Two days before the end, the cron makes a new channel (a new id and a new
  token). Then it stops the channel that was there before (`channels.stop`).
  A calendar that Google cannot watch (for example a holiday calendar) gets a
  new try after 7 days.
- Drive (`LAB86_GOOGLE_DRIVE_PUSH=1`): it calls `changes.watch` for each
  connected Google Drive connection, from the stored page token of the content
  sync. This occurs only when content indexing is on for the user. The channel
  life and the replacement are the same as for Calendar.
- After Google refuses a watch call, the next try comes after 6 hours. A
  Gmail watch that continues to work stays active.
- One cron call makes at most 40 watch calls for one user. The next cron call
  makes the remaining calls.

Stop:

- When a flag is off, the cron stops the watches or channels of that type at
  Google and removes the rows.
- For a removed calendar, a disconnected mailbox, or a disconnected Drive
  connection, the cron stops the channel and removes the row.
- A mail disconnect (`grants.destroy`, also in the account deletion) stops the
  Gmail watch and the Calendar channels of the grant before the revoke. A
  Gmail stop ends the watch for all of the mailbox. Thus the app does not stop
  the watch while a different live Google connection (Nylas or direct, any
  user) has the same address. The same rule applies when a flag is off.
- A Drive disconnect (`/api/files/disconnect`) stops the Drive channel before
  the revoke.
- Without a sign-in that works (after a rollback to Nylas, a revoked grant, or
  an account deletion for Drive), the app cannot stop a watch or a channel.
  Google ends it at its expiration (at most 7 days). The routes ignore its
  messages, because they find no row and no direct account for them.
- With all flags off, a disconnect reads no push rows.

### Poll back-off

- Gmail: a mailbox has healthy push when its watch is active, ends in more
  than 10 minutes, and a push came after the last watch call and in the last
  26 hours. Each watch call makes Gmail send one push immediately. Thus a
  path that works shows this each day. The 2-minute History cron reads a
  healthy mailbox one time in each 15 minutes, at a time that is different for
  each mailbox. When the push stops (the watch ends, or no push comes in 26 hours),
  the cron reads the mailbox each 2 minutes again. No manual step is
  necessary.
- Calendar: an account has healthy push when each of its calendars has an
  active channel with a message after the last watch call, or Google cannot
  watch that calendar. The 15-minute calendar cron skips a healthy account,
  but it syncs the account when the last sync is one hour old, and for the
  daily full pass.
- Drive: no back-off. The 2-minute content cron also does other work.
- The mail repair sweep (each 30 minutes) does not change.

### Push variables

| Variable | Value | Default |
|---|---|---|
| `LAB86_GOOGLE_GMAIL_PUSH` | `1` turns on the Gmail watches and the Gmail route. | Off |
| `LAB86_GOOGLE_CALENDAR_PUSH` | `1` turns on the Calendar channels, the Calendar route, and the calendar poll back-off. | Off |
| `LAB86_GOOGLE_DRIVE_PUSH` | `1` turns on the Drive channels and the Drive route. | Off |
| `LAB86_GOOGLE_PUBSUB_TOPIC` | `projects/lab86-mail-production/topics/gmail-push` | None |
| `LAB86_GOOGLE_PUBSUB_AUDIENCE` | `https://mail.lab86.io/api/google/push/gmail` | None |
| `LAB86_GOOGLE_PUBSUB_SERVICE_ACCOUNT` | `gmail-push-invoker@lab86-mail-production.iam.gserviceaccount.com` | None |

The channel address is `LAB86_MAIL_PUBLIC_URL` with the route path. Google
accepts only HTTPS. Thus a local server makes no channel.

### Runbook: enable push

Do the steps in this order. Steps 1 and 2 change only Google Cloud. The app
does not change until step 3.

Before you start, run the Nylas grant cleanup for the switched mailboxes
(section "Cleanup", dry run first). A mailbox whose old Nylas grant still
exists gets no Gmail watch.

1. In Cloud Shell, as `jakob@lab86.io`, make the topic, the publisher
   binding, the invoker service account, the token creator binding, and the
   push subscription:

   ```bash
   gcloud config set project lab86-mail-production

   # APIs that push uses.
   gcloud services enable pubsub.googleapis.com gmail.googleapis.com \
     calendar-json.googleapis.com drive.googleapis.com

   # The topic that Gmail publishes to.
   gcloud pubsub topics create gmail-push

   # Gmail publishes as this Google service account.
   gcloud pubsub topics add-iam-policy-binding gmail-push \
     --member="serviceAccount:gmail-api-push@system.gserviceaccount.com" \
     --role="roles/pubsub.publisher"

   # The service account whose OIDC token Pub/Sub sends with each push.
   gcloud iam service-accounts create gmail-push-invoker \
     --display-name="Gmail push invoker"

   # Pub/Sub makes the token as its service agent. 452431903621 is the
   # project number.
   gcloud iam service-accounts add-iam-policy-binding \
     gmail-push-invoker@lab86-mail-production.iam.gserviceaccount.com \
     --member="serviceAccount:service-452431903621@gcp-sa-pubsub.iam.gserviceaccount.com" \
     --role="roles/iam.serviceAccountTokenCreator"

   # The push subscription to Albatross. The route checks the OIDC token.
   gcloud pubsub subscriptions create gmail-push-albatross \
     --topic=gmail-push \
     --push-endpoint="https://mail.lab86.io/api/google/push/gmail" \
     --push-auth-service-account="gmail-push-invoker@lab86-mail-production.iam.gserviceaccount.com" \
     --push-auth-token-audience="https://mail.lab86.io/api/google/push/gmail" \
     --ack-deadline=20 \
     --message-retention-duration=1d \
     --min-retry-delay=10s \
     --max-retry-delay=600s
   ```

   If the topic binding fails with a domain restriction error, an
   organization policy (`iam.allowedPolicyMemberDomains`) stops the Google
   service account. Ask the owner of the organization policy to add an
   exception for the project. Then do the binding again.

2. Check the result:

   ```bash
   gcloud pubsub topics get-iam-policy gmail-push
   gcloud pubsub subscriptions describe gmail-push-albatross \
     --format="yaml(pushConfig,ackDeadlineSeconds,messageRetentionDuration,retryPolicy)"
   gcloud iam service-accounts get-iam-policy \
     gmail-push-invoker@lab86-mail-production.iam.gserviceaccount.com
   ```

   The topic policy must show `gmail-api-push@system.gserviceaccount.com`
   with `roles/pubsub.publisher`. The subscription must show the endpoint,
   the service account, and the audience of step 1.

3. In the Railway dashboard (project `lab86-mail`, environment `production`,
   service `web`), set these variables in one change. Use the dashboard, so
   that no value goes into the shell history:

   ```text
   LAB86_GOOGLE_PUBSUB_TOPIC=projects/lab86-mail-production/topics/gmail-push
   LAB86_GOOGLE_PUBSUB_AUDIENCE=https://mail.lab86.io/api/google/push/gmail
   LAB86_GOOGLE_PUBSUB_SERVICE_ACCOUNT=gmail-push-invoker@lab86-mail-production.iam.gserviceaccount.com
   LAB86_GOOGLE_GMAIL_PUSH=1
   ```

4. After the deploy, wait for the next hourly push cron. In the Convex
   dashboard, table `googlePushChannels`, each direct mailbox must have a
   `gmail` row with `status` `active` and a `lastMessageAt` after its
   `requestedAt`. A `failed` row shows the Google error in `lastError`. A
   `403` from `users.watch` usually shows that the publisher binding of step 1
   is missing.
5. Send a message to a direct mailbox. It must show in the inbox in about 10
   seconds.
6. Set `LAB86_GOOGLE_CALENDAR_PUSH=1` in Railway. After the next hourly cron,
   each calendar of a direct account has a `calendar` row. Change an event in
   Google Calendar. The change must show in Albatross in about 10 seconds.
7. Set `LAB86_GOOGLE_DRIVE_PUSH=1` in Railway. After the next hourly cron,
   each Google Drive connection with content indexing on has a `drive` row.

Calendar and Drive need no Google Cloud step. Google posts to the HTTPS route
of each channel.

### Runbook: turn off push

1. In Railway, set the flag of the part to `0`, or delete the flag. After the
   deploy, the route answers 204 and does nothing.
2. In one hour or less, the push cron stops the watches or the channels of
   that part at Google and removes the rows. Then the polls are back at each
   2 minutes (Gmail) and each 15 minutes (Calendar). Until the rows go, a
   healthy mailbox can stay at the 15-minute poll.
3. Only to remove the Google Cloud setup too (not necessary for a turn-off):

   ```bash
   gcloud pubsub subscriptions delete gmail-push-albatross --project=lab86-mail-production
   gcloud pubsub topics delete gmail-push --project=lab86-mail-production
   gcloud iam service-accounts delete \
     gmail-push-invoker@lab86-mail-production.iam.gserviceaccount.com --project=lab86-mail-production
   ```

## Workstreams

- Gmail (messages, threads, labels, attachments, drafts, send, grants, tokens,
  OAuth, cutover, history sync): `lib/google/adapter/mail.ts` and
  `lib/google/*`.
- Calendar and contacts: `lib/google/adapter/calendar.ts`,
  `lib/google/adapter/contacts.ts`.

## Not in this change

Microsoft and iCloud stay on Nylas. Contacts get no push. Push is in the code
but off: the owner does the `gcloud` steps and sets the flags (section
"Runbook: enable push"). Drive push does not slow the 2-minute content cron.
