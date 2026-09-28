# Direct Google transport

Status: in progress (branch `claude/casa-prep`, 2026-09-28). Owner: Claude.

## Goal

Google accounts talk to Google directly: Gmail, Google Calendar, and Google
contacts. Microsoft and iCloud accounts stay on Nylas. This work comes before
the Google verification submission, so that the CASA assessment sees the final
system. The Google scopes do not change.

## Decisions

- **Identity.** A Google account keeps its `accountId`. Nylas v3 stores Gmail's
  own thread, message, and event ids, so the corpus, labels, Jev verdicts,
  calendar rows, and area links stay valid. Only the grant id changes: it
  becomes `google:<accountId>` (`lib/google/transport.ts`).
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
  `providerGrants.refreshTokenEncrypted`, on the row whose `grantId` is
  `google:<accountId>`. `getGoogleAccessToken` caches the access token in
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
  completion token, and the signed-in app redeems it through an authenticated
  finalize route. This is the Files pattern.
- **Cutover.** Two paths:
  1. Switch an existing Nylas Google account in place. The OAuth email must
     equal the account email. The Nylas grant id is kept on the Google
     `providerGrants` row (`previousNylasGrantId`) for a rollback. The Nylas
     grant is destroyed only when the user disconnects the account.
  2. New Google connections use the direct flow when `LAB86_GOOGLE_DIRECT=1`.
- **Sync.** A cron polls the Gmail History API every 2 minutes for each direct
  account (`history.list` from the stored `historyId`). A `404` (history too
  old) runs the normal reconcile path. A Pub/Sub push route exists behind env
  configuration and is off until a subscription exists.
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

## Workstreams

- Gmail (messages, threads, labels, attachments, drafts, send, grants, tokens,
  OAuth, cutover, history sync): `lib/google/adapter/mail.ts` and
  `lib/google/*`.
- Calendar and contacts: `lib/google/adapter/calendar.ts`,
  `lib/google/adapter/contacts.ts`.

## Not in this change

Microsoft and iCloud stay on Nylas. Pub/Sub push needs a subscription on the
topic in `lab86-mail-production` (a `gcloud` step for the owner).
