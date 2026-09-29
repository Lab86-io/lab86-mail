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
     grant is destroyed only when the user disconnects the account.
  2. New Google connections use the direct flow when `LAB86_GOOGLE_DIRECT=1`.
- **Sync.** A cron polls the Gmail History API every 2 minutes for each direct
  account (`history.list` from the stored `historyId`). A `404` (history too
  old) runs the normal reconcile path. Pub/Sub push is not built (see "Not in
  this change").
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
  no calendar or contact push. The 15-minute poll, the daily full pass, and
  the sync after each write keep the mirror current.

## Gmail

These rules add to the decisions above or make them exact.

- **Switch gate.** `/api/google/connect?mode=switch&account=<email or
  accountId>` works on staging (`RAILWAY_ENVIRONMENT_NAME=development` or
  `staging`) with no change of variables. In production it needs
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
  does not keep a message.
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
- **No revoke outside production, or while Nylas uses the address.** Staging
  and local development use the production Google Cloud project, so a revoke
  there would end the production access for that address. Only a deployment
  with `RAILWAY_ENVIRONMENT_NAME=production` (or `LAB86_GOOGLE_REVOKE=1`)
  revokes. Production also skips the revoke while another live Google
  connection of any user in the deployment uses the address: a Nylas or
  direct mail account, or a Google Drive connection, other than the one that
  goes (`googleDirect:googleAccessUsesAddress`).
  In each case only our token row goes (`googleRevokeBlockedReason` in
  `lib/google/shared-grant.ts`).
- **Rollback.** `googleDirect:rollbackToNylas` does not revoke the Google
  token. Google can revoke the whole project grant, and the production Nylas
  connector is in the same Google Cloud project. The token row is deleted.

### Runbook: switch one account

1. Deploy the branch to staging. No variable change is necessary on staging.
2. Sign in to the staging web app as the account owner.
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

### Variables

- `GOOGLE_MAIL_CLIENT_ID`, `GOOGLE_MAIL_CLIENT_SECRET` (optional; the Drive
  client is the fallback).
- `LAB86_GOOGLE_DIRECT=1`: new Google connections go direct.
- `LAB86_GOOGLE_DIRECT_SWITCH=1`: the switch works in production without the
  flag above.

## Workstreams

- Gmail (messages, threads, labels, attachments, drafts, send, grants, tokens,
  OAuth, cutover, history sync): `lib/google/adapter/mail.ts` and
  `lib/google/*`.
- Calendar and contacts: `lib/google/adapter/calendar.ts`,
  `lib/google/adapter/contacts.ts`.

## Not in this change

Microsoft and iCloud stay on Nylas. Pub/Sub push is not built: the History
sync polls. A push route needs a topic and a subscription in
`lab86-mail-production` (a `gcloud` step for the owner).
