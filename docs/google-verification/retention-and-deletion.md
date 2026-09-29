# Retention and deletion

Product: Albatross, from Lab86. Status of this text: 2026-09-28, branch
`claude/casa-verify`.

This document gives each data table, its retention rule, and the code that
deletes the data. The mark "(after the casa-prep round)" identifies a
statement that is correct only when the named work of that round is merged and
deployed. "Open item" identifies a problem that no workstream of this round owns.

## Rules in short

- Albatross keeps Google data while the mailbox or the Drive connection stays
  connected and the user account is not deleted.
- Disconnect of a mailbox deletes the mail, calendar, and contact data of that
  mailbox. Some derived rows stay until account deletion (see "Open items").
- Disconnect of Google Drive deletes the Drive token and the Drive index. It
  also asks Google to revoke the token. It does not ask when another Google
  connection of the same address uses the same Google project. A failed
  revoke does not stop the disconnect.
- Account deletion deletes all data of the user in Convex, and the Clerk user.
- A mailbox that stays in an error state for 30 days loses its mail data.
- Webhook rows, OAuth states, one-time codes, and rate-limit rows expire.
- Albatross never deletes mail, events, contacts, or files at Google because of
  a disconnect or an account deletion.

## Tables and rules

Column keys: **Disconnect** = mailbox disconnect
(`convex/accounts.ts:514-550`). **30 d** = dead-account purge
(`convex/deadAccounts.ts`). **Delete** = account deletion
(`convex/accounts.ts:552-640`).

### Mail, calendar, and contacts

| Table | Content | Retention rule | Disconnect | 30 d | Delete |
|---|---|---|---|---|---|
| `connectedAccounts` (`convex/schema.ts:144-173`) | Address, provider, scopes, grant id, status | Kept while connected | Yes, immediately | Row stays; `corpusPurgedAt` is set | Yes |
| `providerGrants` (`convex/schema.ts:175-190`) | Encrypted tokens, grant id | Kept while connected | Yes, immediately | No (open item) | Yes |
| `mailCorpusThreads`, `mailCorpusMessages`, `mailLabelMembership` | Thread and message headers, snippets, labels | No age limit | Yes, in batches | Yes | Yes |
| `mailCorpusBodies` (`convex/schema.ts:457-472`) | Text body (32,000 characters maximum) and HTML body (200,000 maximum) | No age limit | Yes, in batches | Yes | Yes |
| `mailSyncStates` | Sync cursor | Kept while connected | Yes, immediately | Yes, first | Yes |
| `mailSnoozes` | Snooze times | Until wake | Yes | Yes | Yes |
| `mailOneTimeCodes` | Sign-in codes found in mail | 2 to 30 minutes (default 10); deleted 1 day after expiry | Yes | Yes | Yes |
| `mailOutbox` (`convex/schema.ts:84-102`) | Outgoing message payload | Payload deleted at send or cancel; row and payload deleted 7 days after queue | No (no account id) | No | Yes |
| `calendars`, `calendarEvents` | Calendars; events −92 to +366 days, history 5 years | Events that Google no longer returns in the window are deleted | Yes | Yes | Yes |
| `contacts`, `contactEmails` | Saved, other, and directory contacts | Deleted 30 days after the last good contact sync when the mailbox is not connected (`lib/contacts/model.ts:32`) | Yes | No (own 30-day rule) | Yes |
| `correspondents` | Recipient counts from mail | Kept while connected | Yes | Yes | Yes |
| Attachment files in Convex file storage | Mail attachments. | 60 days. 25 MB maximum for each file. (After the casa-prep round, item: "attachment files stored in Convex file storage".) | Yes (after the casa-prep round). | See the attachments workstream. | Yes. |

Today, Albatross does not keep attachment files. The attachment route streams
the file with `cache-control: private, no-store`
(`app/api/attachments/[messageId]/[attachmentId]/route.ts:56`).

### Search index and derived data

| Table | Content | Retention rule | Disconnect | 30 d | Delete |
|---|---|---|---|---|---|
| `contentItems`, `contentChunks` (`convex/contentSchema.ts:9-46`) | Text of mail threads (last 60 days), attachment text, and Drive text. Vectors with 1,536 dimensions. | Deleted with the source. | Mail: yes (after the casa-prep round, item: "disconnect deletes the content index too"). Drive: yes. | Yes (`convex/deadAccounts.ts:145-157`) | Yes |
| `userDocs` (`convex/schema.ts:479-495`) | Daily Brief editions, chat sessions (80 messages each), drafts, thread notes | No age limit | No (open item) | No | Yes |
| `albatrossEvidence`, `narrativeEntries`, `areaArtifactLinks` | Derived notes that point to mail or events | No age limit | `areaArtifactLinks`: yes. Others: no (open item) | No | Yes |
| `albatrossNotifications` | Notification title and body | Rows expire but stay | No (open item) | No | Yes |
| `aiUsageEvents` (`convex/schema.ts:273-288`) | Model, feature, tokens, cost. No mail content | No age limit | No | No | Yes |

### Google Drive

| Table | Content | Retention rule | Drive disconnect | Delete |
|---|---|---|---|---|
| `cloudFileConnections`, `cloudFileCredentials` | Connection and encrypted tokens | Kept while connected | Yes, after the Google revoke | Yes |
| `contentItems` and `contentChunks` of the connection | Drive text and vectors | Kept while connected | Yes, in batches of 25 (`convex/cloudFiles.ts:371-405`) | Yes |
| `officeDocuments`, `officeVersions` | Office working copies of Drive files | No age limit | No (open item) | Yes |
| `documents` linked to Google | Albatross documents imported from Drive | Kept until the user deletes the document | No | Yes |

### Short-lived rows

| Table | Retention rule | Code |
|---|---|---|
| `mailWebhookEvents` (ids only, no mail) | Processed: 14 days. Error: 30 days. Received: 30 days | `convex/retention.ts:12-22`; sweep `:46-102`; hourly cron `convex/crons.ts:167` |
| `nylasOAuthStates` | 10 minutes; swept after 1 day | `app/api/nylas/connect/route.ts:92`; `convex/retention.ts:78-88` |
| `cloudFileOAuthStates` | 10 minutes | `lib/files/connections.ts:102`; `convex/retention.ts:90-97` |
| `cloudFileOAuthCompletions` | 5 minutes, single use | `lib/files/connections.ts:141` |
| `rateLimits` | Window start plus two windows | `convex/rateLimits.ts:21`; `convex/retention.ts:71-76` |

## Mailbox disconnect

Entry point: Settings > Mailboxes > the menu of the mailbox > "Remove account &
data" (`app/settings/page.tsx:929-935`, `:1087-1092`). The web and iOS apps call
`POST /api/nylas/disconnect` (`app/api/nylas/disconnect/route.ts:10-40`).

1. `deleteNylasAccount` runs first in Convex (`lib/nylas/provider.ts:1127-1138`).
2. `deleteConnectedAccount` deletes the small tables immediately:
   `connectedAccounts`, `providerGrants`, `mailSyncStates`, `calendars`,
   `calendarSyncStates`, `contactSyncStates` (`convex/accounts.ts:524-538`).
3. It schedules `purgeAccountDataBatch` over `ACCOUNT_BULK_TABLES`, 250 rows
   for each pass (`convex/accounts.ts:341-358`, `:486-512`).
4. It schedules the purge of the recipient counts of the mailbox
   (`convex/accounts.ts:544-547`).
5. Then it destroys the Nylas grant. An error of this call is ignored
   (`lib/nylas/provider.ts:1132-1136`).

After the casa-prep round:

- The purge also deletes the `contentItems` and `contentChunks` of the mailbox
  (item: "disconnect deletes the content index too").
- The purge deletes the attachment files of the mailbox (item: "attachment
  files stored in Convex file storage").
- For a direct Google account, the disconnect sends the refresh token to
  `https://oauth2.googleapis.com/revoke`, then deletes the token row
  (`lib/google/adapter/mail.ts`, `destroyGrant`). A Google revoke ends the
  access of the whole Google Cloud project for that address. So the disconnect
  does not send the revoke in three cases, and deletes only our token row:
  a Google Drive connection of the same user and address shares the grant;
  another live Google connection of any user in the deployment (a Nylas or
  direct mailbox, or a Google Drive connection) uses the address; or the
  deployment is not production and `LAB86_GOOGLE_REVOKE=1` is not set. Local
  OAuth tests can share the production Google project, so keep that override
  unset for local testing: it allows a reachable disconnect to revoke the shared
  grant even outside production. `lib/google/shared-grant.ts` has these rules.

## Google Drive disconnect

Entry point: Files > Google Drive > "Disconnect". The route is
`POST /api/files/disconnect` (`app/api/files/disconnect/route.ts:25`).

1. `disconnectCloudFileConnection` sends the refresh token (or the access
   token) to `https://oauth2.googleapis.com/revoke`. A `400` answer counts as
   "already revoked" (`lib/files/connections.ts:344-396`). It does not send
   the revoke when a direct Google mailbox of the same user and address uses
   the same Google grant (`lib/google/shared-grant.ts`). A Google revoke ends
   the access of all the Google Cloud project, so it can stop that mailbox
   too. For the same reason it does not send the revoke outside the
   production deployment, or while another live Google connection of any
   user in the deployment uses the address.
2. If the revoke fails, the code logs a warning and continues.
3. `cloudFiles.disconnect` deletes the connection and the credentials
   (`convex/cloudFiles.ts:338-369`).
4. `purgeConnectionContent` deletes the Drive index items, their vectors, and
   the sync cursor (`convex/cloudFiles.ts:371-405`).

## Account deletion

Entry point: Settings > Account > "Delete account"
(`app/settings/page.tsx:1561-1595`). The user can export the data first
(`app/api/account/export/route.ts`).

1. `DELETE /api/account` (`app/api/account/route.ts:10-38`) calls
   `deleteUserData` (`lib/security/account-deletion.ts:29-45`).
2. `deleteUserData` disconnects each mailbox as above.
3. If a disconnect throws, the deletion stops. The user can try again.
4. `deleteUserCascade` (`convex/accounts.ts:552-640`) stops active brief jobs,
   deletes the small tables and their files in storage, deletes agent uploads with
   their files, deletes boards and cards, and deletes the `users` row. It
   schedules `purgeUserDataBatch` for the large tables (`convex/accounts.ts:441-477`).
5. The route then deletes the Clerk user (`app/api/account/route.ts:30-31`).
6. If the user is deleted in Clerk first, the Clerk `user.deleted` webhook runs
   the same deletion (`app/api/clerk/webhook/route.ts:44-57`).

A test fails when a Convex table with a user id is not in the cascade
(`tests/account-cascade-coverage.test.ts`). The list of exempt tables is empty
(`convex/accounts.ts:719`).

Open items for account deletion:

- Account deletion does not revoke the Google Drive token at Google. It
  deletes the encrypted token rows only.
- `mailWebhookEvents` rows without a user id expire by their TTL.

## 30-day dead-account purge

- Rule: an account is purged when its status is `error`, it has no
  `corpusPurgedAt`, and 30 days passed since `errorSince` (or since
  `updatedAt`) (`convex/deadAccounts.ts:16-17`, `:61-75`).
- An account goes to `error` when Nylas reports `grant.expired` or
  `grant.deleted`, or when sync finds the grant gone
  (`convex/accounts.ts:246-274`).
- Schedule: daily at 10:13 UTC (`convex/crons.ts:171-176`), 100 accounts for
  each page.
- Each pass deletes the sync state first, then the mail tables, the calendar
  events, the webhook rows, the snoozes, and the one-time codes
  (`convex/deadAccounts.ts:26-38`). Then it deletes the index items and their
  vectors, five items for each pass (`convex/deadAccounts.ts:145-157`).
- The last pass sets `corpusPurgedAt` and deletes the recipient counts.
- A reconnect stops the purge and starts a new sync.
- The account row and the encrypted token row stay, so Settings can show
  "Reconnect". The purge does not delete `providerGrants` (open item).

## Data outside Convex

| Place | Retention | Owner step |
|---|---|---|
| Google | Albatross does not delete Google data. The user removes access at <https://myaccount.google.com/permissions>. | None |
| Nylas | Today, Nylas holds the Google tokens and caches mail for its API. Disconnect destroys the grant. | Confirm the Nylas data retention terms. |
| OpenRouter and model providers | The setting is `data_collection: deny` (after the casa-prep round). With it, OpenRouter does not use a provider that can train on the data or store it for a long time. This is not zero data retention. A provider can keep a request for a short time for abuse checks. OpenAI and Anthropic keep requests for up to 30 days. | Turn on the same setting for the OpenRouter account. |
| Railway logs | Kept under the Railway plan. Logs do not hold mail intentionally (see `data-flow.md`, step 7). | Confirm the Railway log retention. |
| Browserbase | Session recordings of the guided-work browser. | Confirm the Browserbase retention for recordings. |
| Resend | The brief e-mail, if the user turned it on. | Confirm the Resend log retention. |
| Convex backups | Under the Convex plan. | Confirm the backup retention. |

## Open items for the integrator

These gaps are not in the list of work for the casa-prep round:

1. Disconnect does not delete `userDocs`, `albatrossEvidence`,
   `narrativeEntries`, `albatrossNotifications`, `suggestions`,
   `mobileSyncChanges`, or `briefPreparations` rows that came from the
   mailbox. Only account deletion deletes them.
2. The dead-account purge keeps `providerGrants` (encrypted tokens) and does
   not destroy the Nylas grant.
3. Drive disconnect keeps `officeDocuments` and `officeVersions`.
4. Account deletion does not revoke Google Drive tokens at Google.
5. `app/privacy/page.tsx:94-102` says that disconnect deletes "index rows".
   This is correct only after the casa-prep round.
