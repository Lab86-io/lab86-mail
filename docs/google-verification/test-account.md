# Test accounts for the lab and for Google reviewers

Product: Albatross, from Lab86. Status of this text: 2026-09-28, branch
`claude/casa-verify`.

## Who must have what

| Party | Needs | Why |
|---|---|---|
| TAC Security (CASA lab) | The app URL. An Albatross login (e-mail and password). The Google scopes. A data-flow diagram. A time window for the scan. | TAC runs an authenticated DAST scan from the URL and a login. TAC must also get a flow diagram and the scopes (TAC FAQ, <https://tacsecurity.com/esof-appsec-ada-casa-faqs/>). |
| Google OAuth reviewers | An Albatross login, and steps to reach each feature | Reviewers open the app and check each scope. They can use their own Google test account for the consent. |
| The demo video | The same Albatross login and a seeded Google test mailbox | See `demo-video-script.md`. |

Send the data-flow diagram from `data-flow.md` and the scope list from
`scopes.md`.

## Rules for safe test accounts

1. Use test accounts only. Never connect the mailbox or the Drive of a live user to a
   test account.
2. Put only synthetic data in the Google test mailbox, calendar, contacts, and
   Drive.
3. Make a new, long, random password for each account. Keep it in the Lab86
   password manager. Do not put it in e-mail, chat, Git, or this repository.
4. Send the password to TAC only through the TAC portal. Send it to Google
   only in the verification form or in a reply to the verification e-mail.
5. Do not give the test account the `admin` plan. The `admin` plan unlocks
   operator routes (`app/api/jev/settings/route.ts:66`,
   `app/api/brief/telemetry/route.ts:10`).
6. Delete or disable the test accounts after the letter of validation.
7. Each new Google account that grants the unverified app counts against the
   100-user limit. On 2026-09-28, 21 of 100 were used. Use one or two Google
   test accounts only.

## Accounts to make

The names below are examples.

| Account | Where | Use |
|---|---|---|
| `albatross-review@lab86.io` (a Lab86 Workspace user or alias) | Clerk (production) | The Albatross login for TAC and Google |
| A Google test mailbox (a Lab86 Workspace user, for example `review-mail@lab86.io`) | Google Workspace | The mailbox that the video connects. A Workspace user also shows `directory.readonly`. |
| A second Google test account | Google | Sends test mail and invitations to the test mailbox |

Steps in Clerk:

1. Open the Clerk dashboard for production. Make the user
   `albatross-review@lab86.io` with a password.
2. Do not turn on MFA for this user. The DAST scanner must sign in without a
   second factor. MFA stays on for all admin accounts.
3. A new account gets a 14-day Pro trial (`lib/hosted/plans.ts:47`). The
   review can take longer. Give the user the Pro plan in Clerk Billing for the
   review period.
4. Clerk bot protection can block a scanner. Ask TAC for its scanner IP
   addresses and its time window. If the scanner cannot sign in, turn off bot
   protection for that window only, then turn it on again.

## Data to seed in the Google test mailbox

| Feature | Seed data |
|---|---|
| Mail list and threads | 20 to 30 messages from the second test account. Include a thread with 3 replies, a newsletter with an unsubscribe link, and a receipt. Include a message with a PDF attachment and a message with a `.docx` attachment. |
| Labels | Two custom labels, each on some threads |
| Daily Brief | Mail of the last 2 days that tells the reader to do a task, and events for today and tomorrow |
| Calendar | 5 events in the next 7 days. Give one event a place name and one event a Google Meet link. Send one invitation from the second test account (for RSVP). |
| Saved contacts | 5 saved contacts with synthetic names and addresses |
| Other contacts | 2 people that the test mailbox wrote to but did not save |
| Directory | 2 other users in the same Workspace domain |
| Drive | A folder with one Google Doc, one Google Sheet, one Slides file, and one PDF. Put a unique word in the Doc for the search demo. |

After the seed, connect the mailbox and Drive one time. Wait for the first sync.
Then open Today and let the Daily Brief operate one time.

## Settings for the scan window

- Turn off "Brief by e-mail" for the test user. This is the default
  (`convex/dailyReports.ts:414`).
- Notifications: leave push off. The scanner has no device.
- The DAST scan sends many calls. Some routes call models, and each call has a
  cost. The per-user rate limits apply (`lib/rate-limit.ts`). Watch the model
  cost alarm (`lib/notifications/cost-alarm.ts`) during the scan.
- The scan can send mail from the test mailbox through `/api/compose`. The
  route sends to each address in To, Cc, and Bcc, so synthetic contacts do
  not stop mail to a live person. Stop the sends before the scan:
  - On staging, set `LAB86_DISABLE_OUTBOUND_SEND=1` on service `web` in the
    Railway environment `development` for the scan window. Then each mail
    send (compose, reply, scheduled send, and the outbox) stops with an error
    before it goes to the provider (`sendNylasMessage` calls
    `assertOutboundSendEnabled`, `lib/hosted/controls.ts`). Remove the
    variable after the scan.
  - Do not set this variable on production: it stops the mail of all users.
    For a production scan, put the test account in its own organizational
    unit, and set Google Workspace Gmail > Compliance > Restrict delivery for
    that unit to `lab86.io` only.
  - The variable does not stop calendar invitations. A new event with
    participants can make Google Calendar send an invitation
    (`lib/calendar/mutate.ts`). Ask TAC to keep the calendar write routes out
    of the active scan, or accept this risk.
- Tell TAC that the staging host `mail-staging.lab86.io` has HTTP Basic auth.
  Scan production with the test account and the Workspace restriction above.
  Or scan staging with the variable above, and give TAC the staging Basic
  auth pair through the portal.

## Information for the TAC form

| Field | Value |
|---|---|
| Application name | Albatross |
| Legal entity | Lab86 |
| Application URL | `https://mail.lab86.io` |
| Login URL | `https://mail.lab86.io/sign-in` |
| Google Cloud project | `lab86-mail-production` (452431903621) |
| Scopes | See `scopes.md`, section "Summary" |
| Flow diagram | See `data-flow.md`, section "Diagram" |
| Test login | `albatross-review@lab86.io` (password through the portal) |
