# Google OAuth scopes: use and justification

Product: Albatross, from Lab86. Google Cloud project: `lab86-mail-production`
(452431903621). Status of this text: 2026-09-29, branch `claude/casa-verify-gaps`.

This document gives one section for each Google scope. Each section tells the
user feature, the code that uses the scope, the reason that a narrower scope
does not work, and the reviewer demo step. Paths are relative to the repository
root.

## How Albatross gets the scopes

Albatross has two Google consent flows. Both flows use OAuth clients in project
452431903621, so the consent screen shows the name "Albatross".

1. **Mailbox connect** (Gmail, Google Calendar, Google contacts). The user
   starts it from Settings > Mailboxes > "Connect Gmail"
   (`app/settings/page.tsx:948-962`).
   - Today, the flow goes through Nylas hosted OAuth
     (`app/api/nylas/connect/route.ts:94-108`). The Nylas Google connector
     uses the Albatross client of project 452431903621. On 2026-09-28 we read
     the connector from the Nylas API. Its scope list is `openid`,
     `userinfo.email`, `userinfo.profile`, `gmail.modify`, `calendar`,
     `contacts.readonly`, `contacts.other.readonly`, `directory.readonly`.
   - After the casa-prep round (item: "Google accounts talk to Gmail,
     Calendar, and People APIs directly"), a Google account uses a direct
     Google OAuth flow with the same scopes. The flow uses PKCE,
     `access_type=offline`, and `prompt=consent`
     (`docs/google-direct-transport.md`, section "Scopes"). The Google API
     calls go through `lib/google/http.ts` and the adapters in
     `lib/google/adapter/`.
2. **Google Drive connect** (Files view). The user turns on Settings >
   Advanced > "Show Files" (`app/settings/page.tsx:152-163`). Then the user
   clicks "Connect" for Google Drive in the Files view
   (`components/files/FilesSurface.tsx:1595-1612`). The scopes are in
   `lib/files/providers.ts:46-52`. The flow uses PKCE,
   `access_type=offline`, and `prompt=consent`
   (`lib/files/providers.ts:92-117`).

Albatross does not use these scopes for sign-in to Albatross. Clerk hosts
sign-in. The app reads only the Clerk profile and does not read Google data
through Clerk (`lib/auth/current-user.ts:21-68`).

## Summary

| Scope | Class | Flow | User feature |
|---|---|---|---|
| `openid` | Non-sensitive | Mailbox, Drive | Identify the connected Google account |
| `userinfo.email` (`email`) | Non-sensitive | Mailbox, Drive | Show and bind the connected address |
| `userinfo.profile` | Non-sensitive | Mailbox | Basic profile of the connected account |
| `gmail.modify` | Restricted | Mailbox | Mail: read, search, send, label, archive, trash |
| `calendar` | Sensitive | Mailbox | Calendar: read, create, change, delete, RSVP, remove calendars |
| `contacts.readonly` | Sensitive | Mailbox | Recipient autocomplete from saved contacts |
| `contacts.other.readonly` | Sensitive | Mailbox | Recipient autocomplete from "Other contacts" |
| `directory.readonly` | Sensitive | Mailbox | Recipient autocomplete from the Workspace directory |
| `drive.readonly` | Restricted | Drive | Browse, search, open, and index Drive files; read Docs, Sheets, and Slides |
| `drive.file` | Non-sensitive | Drive | Create Google Docs, Sheets, and Slides files from Albatross documents, and write to them |
| `documents` | Sensitive | Drive | Save edits back to an existing Google Doc |

Albatross does not ask for `spreadsheets`, `presentations`, or the full
`drive` scope (owner decision of 2026-09-29, see "Notes for the owner").

## openid

- **Feature.** Albatross identifies the Google account that the user connects.
- **Code.** Nylas adds `openid` to each Google OAuth call. The Nylas Google
  guide says so: <https://developer.nylas.com/docs/provider-guides/google/create-google-app/>.
  The Drive flow includes it in `lib/files/providers.ts:47`. The direct flow
  includes it after the casa-prep round.
- **Narrower scope.** Google has no narrower scope. `openid` is the minimum
  OpenID Connect scope.
- **Demo.** Show the consent screen at mailbox connect and at Drive connect.

## userinfo.email

- **Feature.** Albatross shows each connected mailbox by its address. It binds
  the grant to that address.
- **Code.**
  - The mailbox callback keeps the address of the grant
    (`app/api/nylas/callback/route.ts:62-74`).
  - The direct cutover compares the OAuth address with the account address
    (`docs/google-direct-transport.md`, section "Cutover").
  - The Drive flow includes the `email` alias (`lib/files/providers.ts:48`).
    It reads the address from `oauth2/v2/userinfo`
    (`lib/files/connections.ts:195-210`).
- **Narrower scope.** No narrower scope gives the account address.
- **Demo.** Show Settings > Mailboxes with the connected address.

## userinfo.profile

- **Feature.** The basic profile of the connected Google account.
- **Code.** Nylas adds `userinfo.profile` to each Google OAuth call (Nylas
  Google guide, link above). Albatross does not keep the profile name or the
  photo from this grant. The callback writes only the address, the grant id,
  the scopes, and the encrypted tokens
  (`app/api/nylas/callback/route.ts:62-74`). The owner keeps this scope for the
  direct flow (decision of 2026-09-28).
- **Narrower scope.** Google has no narrower scope. The scope is non-sensitive.
- **Demo.** Show the consent screen.

## gmail.modify (restricted)

- **Feature.** The Mail view and the features that read mail.
  - Read, search, and show threads and messages.
  - Send new mail, replies, and forwards. Send at a time that the user sets.
  - Archive, move to Trash, and move back to the inbox.
  - Mark as read or unread. Star or unstar.
  - Create labels. Add labels to threads and remove labels from threads.
  - Snooze, mute, and block a sender. These actions change labels.
  - Unsubscribe from a list by a `mailto:` message.
  - The Daily Brief, Areas, and search read mail to show the user a summary.
- **Code today (through Nylas).** All calls use the Nylas SDK in
  `lib/nylas/provider.ts`.

  | Operation | Code |
  |---|---|
  | List and search threads | `lib/nylas/provider.ts:405`, `:435` |
  | Read a thread, a message, headers | `lib/nylas/provider.ts:512`, `:538`, `:558` |
  | Mail sync into the Albatross index | `lib/mail/corpus-sync.ts:140`, `:275`, `:418`, `:550`, `:735` |
  | List and create labels | `lib/nylas/provider.ts:575`, `:594` |
  | Change labels, read state, star | `lib/nylas/provider.ts:831` (messages), `:625`, `:981` (threads) |
  | Archive, Trash, back to inbox (Gmail label rules) | `lib/nylas/provider.ts:649-656` |
  | Send, reply, forward, send at a set time | `lib/nylas/provider.ts:1030` |
  | Scheduled sends: list, find, cancel | `lib/nylas/provider.ts:1061`, `:1078`, `:1100` |
  | Download an attachment | `lib/nylas/provider.ts:1120` |

  The web entry points are `app/api/compose/route.ts`,
  `app/api/attachments/[messageId]/[attachmentId]/route.ts`, the tool route
  `app/api/tools/[name]/route.ts`, and the mail tools in `lib/tools/mail.ts`
  and `lib/tools/mail-mutate.ts`.
- **Code after the casa-prep round.** The same calls go to the Gmail API
  (`GMAIL_API` in `lib/google/http.ts:113`) through
  `lib/google/adapter/mail.ts`. Sync reads the Gmail History API. A scheduled
  send stays in the Albatross mail outbox until its send time
  (`docs/google-direct-transport.md`, sections "Sync" and "Scheduled send").
- **Narrower scope.**
  - `gmail.readonly` cannot send mail or change labels.
  - `gmail.send` can only send.
  - `gmail.compose` can make drafts and send. It cannot change labels on
    received mail.
  - `gmail.labels` can only create, read, change, and delete label
    definitions. It cannot put a label on a message.
  - `gmail.metadata` cannot read message bodies.
  - Archive removes the `INBOX` label. Trash adds the `TRASH` label. Read
    state is the `UNREAD` label. These are label changes on messages. The
    Gmail methods `users.messages.modify` and `users.threads.modify` accept
    only `https://mail.google.com/` or `gmail.modify`
    (<https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/modify>).
  - `gmail.modify` is the narrowest scope that lets the product read, send,
    and change labels together.
  - Albatross never deletes mail permanently. The code has no
    `messages.delete`, `threads.delete`, or `batchDelete` call. Thus
    Albatross does not include `https://mail.google.com/`.
- **Demo.**
  1. Open Mail. Open a thread. Show the message body.
  2. Reply to the thread. Show the sent reply in Gmail.
  3. Archive the thread. Show that the thread left the Gmail inbox.
  4. Mark a thread as unread. Add a label. Show the two changes in Gmail.
  5. Move a thread to Trash. Show it in Gmail Trash.

## calendar (sensitive)

- **Feature.** The Calendar view and the Daily Brief.
  - Show all calendars of the account and their events.
  - Create, change, and delete events. Add a Google Meet link to a new event.
  - Answer an invitation (RSVP).
  - Remove a calendar at the user's request. The provider call deletes an
    owned secondary calendar or removes a subscribed calendar.
- **Code today (through Nylas).**

  | Operation | Code |
  |---|---|
  | List calendars | `lib/calendar/sync.ts:720` |
  | List and read events (−92 to +366 days) | `lib/calendar/sync.ts:16-22`, `:752-758`, `:688` |
  | Create an event, with Google Meet | `lib/calendar/mutate.ts:98-100`, `:112` |
  | Change an event | `lib/calendar/mutate.ts:282` |
  | Delete an event | `lib/calendar/mutate.ts:378` |
  | Remove a calendar | `lib/calendar/mutate.ts:441-453` |
  | Answer an invitation | `lib/calendar/mutate.ts:507` |

  The Calendar view calls these from `components/calendar/CalendarSurface.tsx`
  (create `:215`, change `:239`, delete `:268`). The assistant versions get
  the approval of the user first (`lib/ai/approval.ts:47-57`).
- **Code after the casa-prep round.** The same calls go to the Google Calendar
  API (`CALENDAR_API` in `lib/google/http.ts:114`) through
  `lib/google/adapter/calendar.ts`.
- **Narrower scope.**
  - `calendar.readonly`, `calendar.events.readonly`, and `calendar.freebusy`
    cannot write.
  - `calendar.events` writes events. It cannot delete a calendar or remove a
    calendar from the calendar list.
  - `calendar.events.owned` includes only calendars that the user owns. Users
    also change events on shared calendars where they have write access.
  - `calendar.app.created` includes only calendars that the app made.
  - Google's `calendars.delete` method accepts only `calendar`,
    `calendar.app.created`, or `calendar.calendars`
    (<https://developers.google.com/workspace/calendar/api/v3/reference/calendars/delete>).
  - Thus three narrower scopes together are necessary for the feature set:
    `calendar.events`, `calendar.calendarlist`, and `calendar.calendars`.
    Together they give almost the same access as `calendar`. The owner keeps
    one scope, `calendar` (decision of 2026-09-28).
- **Demo.**
  1. Open Calendar. Show events from the Google calendar.
  2. Make an event with a Google Meet link. Show it in Google Calendar.
  3. Change the time of the event. Then delete it. Show the two changes in Google
     Calendar.
  4. Answer "Yes" to an invitation. Show the answer in Google Calendar.

## contacts.readonly (sensitive)

- **Feature.** Recipient autocomplete in the composer, and sender names in the
  Daily Brief. The source is the user's saved Google contacts.
- **Code.**
  - Sync reads contacts with source `address_book`
    (`lib/contacts/sync.ts:169`; scope map in `lib/contacts/model.ts:80-84`).
  - Autocomplete: `components/compose/RecipientInput.tsx:38` calls
    `/api/contacts/recipients`, which reads `convex/correspondents.ts:358-463`.
  - After the casa-prep round the calls go to the People API (`PEOPLE_API` in
    `lib/google/http.ts:115`) through `lib/google/adapter/contacts.ts`.
  - Albatross never writes contacts. The Convex writes change only the local
    copy (`convex/contacts.ts:297`, `:366`).
- **Narrower scope.** `contacts.readonly` is the read-only scope for saved
  contacts. The full `contacts` scope is wider.
- **Demo.** In a new message, type the first letters of a saved contact. Show
  the suggestion.

## contacts.other.readonly (sensitive)

- **Feature.** Recipient autocomplete from Google "Other contacts". These are
  people that the user wrote to but did not save.
- **Code.** Sync reads source `inbox` (`lib/contacts/sync.ts:169`; scope map
  in `lib/contacts/model.ts:80-84`). The autocomplete path is the same as
  above.
- **Narrower scope.** No other scope reads "Other contacts". The People API
  method `otherContacts.list` accepts only this scope.
- **Demo.** Type the first letters of a person from "Other contacts". Show the
  suggestion.

## directory.readonly (sensitive)

- **Feature.** For a Google Workspace user, recipient autocomplete from the
  domain directory.
- **Code.** Sync reads source `domain` (`lib/contacts/sync.ts:169`; scope map
  in `lib/contacts/model.ts:80-84`). The autocomplete path is the same as
  above.
- **Narrower scope.** No other scope reads the Workspace directory. The People
  API method `people.listDirectoryPeople` accepts only this scope.
- **Demo.** With a Workspace test account, type the first letters of a
  coworker. Show the suggestion.

## drive.readonly (restricted)

- **Feature.** The Files view and search.
  - Browse and search all files of My Drive and shared drives.
  - Open a Google Doc, Sheet, or Slides file in the Albatross editor.
  - Albatross keeps a text index of Drive files. The index finds files in
    search and gives sources to the Daily Brief.
- **Code.**
  - Browse and search: `lib/files/browse.ts:70-104`, folder lookup `:205`.
    Route `/api/files/browse`, called from
    `components/files/FilesSurface.tsx:410`.
  - Index: the Drive change feed and the file download are in
    `lib/content/cloud-sync.ts:94-116` and `:160-190`. Docs export as text,
    Sheets as `.xlsx`, and Slides as `.pptx`.
  - File metadata for import: `lib/documents/google-import.ts:65`.
  - Import of a Google Sheet or Slides file into the Albatross editor:
    `lib/documents/google-import.ts:128`, `:145`, `:301`, `:314`. The Sheets
    method `spreadsheets.get` and the Slides method `presentations.get`
    accept `drive.readonly`
    (<https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/get>,
    <https://developers.google.com/workspace/slides/api/reference/rest/v1/presentations/get>).
    Thus Albatross does not ask for `spreadsheets` or `presentations`.
- **Narrower scope.**
  - `drive.file` includes only files that the app made or that the user opened
    through the app. The user browses and searches all Drive files.
  - `drive.metadata.readonly` cannot read file content. Search and the index
    must read the text.
  - `drive.readonly` is the narrowest scope that reads all files.
- **Demo.**
  1. Open Files. Browse to a folder in My Drive. Show its files.
  2. Search for a word that is inside a document. Show the result.
  3. Open a Google Doc in the Albatross editor.

## drive.file (non-sensitive)

- **Feature.** The user makes a new Google Doc, Sheet, or Slides file from an
  Albatross document. Albatross writes the content into that new file.
- **Code.**
  - `publishDocumentToGoogle` (`lib/documents/google.ts:557-631`) makes the
    file with `createGoogleFile` (`:531-555`). Then it writes the content with
    the Docs, Sheets, or Slides writer (`:123`, `:292`, `:502`).
  - The create methods and the `batchUpdate` methods of Docs, Sheets, and
    Slides accept `drive.file`
    (<https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/create>,
    <https://developers.google.com/workspace/slides/api/reference/rest/v1/presentations/create>).
  - It reads the Drive metadata of the new file (`lib/documents/google.ts:233-246`).
  - Route `POST /api/documents/[id]/google`, called from
    `components/files/DocumentEditor.tsx:440`.
  - The Office working-copy save replaces a Google file with a Drive v2 upload
    (`lib/documents/google-working-copy.ts:223-234`). With `drive.file`, this
    works only for a file that Albatross made. For another file, Google
    refuses the upload. Albatross then shows a clear message
    (`GOOGLE_WORKING_COPY_NOT_APP_FILE`, `:48`), and the edited copy stays in
    Albatross.
- **Narrower scope.** `drive.file` is the narrowest Drive scope that lets an
  app make files and change the files that it made.
- **Demo.** In an Albatross document, use the control that saves the document
  to Google. Show the new file in Google Drive.

## documents (sensitive)

- **Feature.** Import a Google Doc into the Albatross editor. Save edits back
  to the same Google Doc, also when Albatross did not make that Doc.
- **Code.**
  - Read: `lib/documents/google-import.ts:287`.
  - Write back to an existing Doc: `updateGoogleNativeFile`
    (`lib/documents/google.ts:633-675`) calls `syncGoogleDoc`, which sends
    `documents.batchUpdate` (`:220`). Only a Doc can go back to its Google
    original (`lib/documents/google.ts:644`,
    `lib/documents/google-write-policy.ts:53-62`).
  - After the save, Albatross renames the Doc when the user changed the
    title (`renameGoogleFile`, `lib/documents/google.ts:684-702`, Drive v3
    `PATCH`). The Drive API renames a file only with `drive`, or with
    `drive.file` for a file that the app made. For a Doc that the user made in
    Google, Google refuses the rename (403). Albatross then keeps the Google
    name and tells the user. The content save does not depend on the rename.
  - Route `PATCH /api/files/google/editor`, called from
    `components/files/DocumentEditor.tsx:997` and `:1073`.
  - The assistant tool `google_document_edit` only proposes a change. The user
    reviews it in the editor. The tool never writes to Google
    (`lib/tools/google-documents.ts:45`).
- **Narrower scope.** `documents.readonly` cannot save edits. `drive.file`
  cannot write to a Doc that Albatross did not make.
- **Demo.** Open a Google Doc from Files. Change one sentence. Save. Show the
  change in Google Docs.

## Notes for the owner

These notes are not for the reviewer. Each note has the decision of the owner.

1. **`spreadsheets` and `presentations`: removed (decision of 2026-09-29).**
   The code reads existing Sheets and Slides and writes only to files that
   Albatross made. The Sheets and Slides APIs accept `drive.readonly` for reads
   and `drive.file` for files that the app made. The Drive OAuth request
   (`lib/files/providers.ts:46-52`) no longer has the two scopes, and no code
   checks for them.
   - A Drive connection from before the change still holds the two scopes. It
     keeps them until the user connects Google Drive again or removes the
     access at <https://myaccount.google.com/permissions>. Such a connection
     works as before, and a new connection works without the two scopes.
   - In Google Auth Platform > Data Access, remove the two scopes before you
     submit.
2. **Writes to Drive files that Albatross did not make: no `drive` scope
   (decision of 2026-09-29).** Two calls change a user's original file through
   the Drive API. For a file that the app did not make, these calls need the
   full `drive` scope, and Albatross does not ask for it. Both calls fail soft:
   - The rename after a Doc write back (`lib/documents/google.ts:684-702`,
     Drive v3 `PATCH`). A 403 skips the rename. The content is saved, the file
     keeps its Google name, and the editor tells the user.
   - The Office working-copy save (`lib/documents/google-working-copy.ts:223-234`,
     Drive v2 upload). A 403 gives the message "Google did not save your
     edits: Albatross can change only the Google files that it made." The
     edited copy stays in Albatross. A 403 for a rate limit keeps the old
     error.
   - Do not show these two actions on a file that Albatross did not make in the
     demo video.
3. **`scripts/nylas-provision.ts`: done (2026-09-29).** The script now sends
   the eight scopes of the production connector (`GOOGLE_MAIL_SCOPES` in
   `lib/google/oauth.ts`), and its `status` mode reports a missing scope.
4. **`userinfo.profile`.** Albatross does not keep profile data from the grant.
   Nylas adds the scope. In the direct flow, the scope has no code use unless
   the Gmail workstream reads the name (for example, as the sender name).
