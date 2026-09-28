# Demo video: shot list and narration

Product: Albatross, from Lab86. Status of this text: 2026-09-28, branch
`claude/casa-verify`.

## Before you record

- Record this video only after the direct Google transport is in production
  (casa-prep round, item: "Google accounts talk to Gmail, Calendar, and People
  APIs directly"). Before that, the mailbox consent goes through Nylas, and
  the reviewer sees a different flow from the flow in the submission.
- Record on production: `https://mail.lab86.io`.
- Use the reviewer test account from `test-account.md`. Use a Google test
  mailbox with seeded mail, events, contacts, and Drive files. Never show the
  data of a live user.
- Set the browser language and the Google account language to English. The
  language menu at the bottom-left of the consent screen must show "English".
- Show the full browser window, with the address bar. Keep the address bar in
  the frame on each Google page, so the reviewer can read the `client_id` and
  the `scope` values in the URL.
- Before the video, remove Albatross from the test Google account at
  <https://myaccount.google.com/permissions>. This makes Google show the full
  consent screen again.
- Upload the video to YouTube as "Unlisted". Put the link in the verification
  form.
- Google tells you to show each consent flow, the complete consent screen,
  and each scope in use
  (<https://support.google.com/cloud/answer/13804565>).
- Albatross has two consent flows: the mailbox connect and the Google Drive
  connect. Show the two flows.
- Do not show a step that fails in the live test. See the owner notes in
  `scopes.md`.

## Shot list

Each shot has a narration line. Read each line in English. Keep each shot
short. The full video is about 8 to 12 minutes.

### Part A: introduction

| # | Shot | Narration |
|---|---|---|
| A1 | The Albatross sign-in page at `https://mail.lab86.io/sign-in`. | "This is Albatross, a mail, calendar, and planning app from Lab86." |
| A2 | Sign in with the reviewer test account (see `test-account.md`). | "I sign in to Albatross. Sign-in uses Clerk and does not give Albatross access to Google data." |
| A3 | Open `https://mail.lab86.io/privacy` and scroll to "Google user data". | "Our privacy policy tells how Albatross uses Google user data. It follows the Google API Services User Data Policy, with the Limited Use requirements." |

### Part B: mailbox consent flow

| # | Shot | Narration |
|---|---|---|
| B1 | Settings > Mailboxes. Click "Connect Gmail". | "I connect a Google account. Albatross gets Gmail, Calendar, and contacts access in one step." |
| B2 | The Google account chooser. Pick the test account. Show the address bar. | "The address bar shows the Albatross OAuth client of project lab86-mail-production." |
| B3 | The consent screen. Show the app name "Albatross". Scroll slowly through all scopes. Leave all boxes checked. | "Google shows the app name, Albatross, and each scope: Gmail read, compose, send, and label; Google Calendar; contacts; other contacts; and the directory." |
| B4 | Click "Continue". Albatross opens Settings with the new mailbox. | "Albatross now shows the connected address. We use the e-mail scope only to name and identify this mailbox." |

### Part C: gmail.modify

| # | Shot | Narration |
|---|---|---|
| C1 | Open Mail. Show the inbox list. | "Albatross reads the inbox through the Gmail API. The Gmail modify scope is necessary for this." |
| C2 | Open a thread. Show the message body. | "Albatross shows the full message." |
| C3 | Reply to the thread and send. Then open Gmail in a second tab and show the sent reply. | "Albatross sends the reply from the user's Gmail account." |
| C4 | In Albatross, archive a thread. In Gmail, show that it left the inbox. | "Archive removes the Inbox label in Gmail. The Gmail modify scope is necessary for label changes. The narrower Gmail scopes cannot change labels on received mail." |
| C5 | Mark a thread as unread and add a label. Show the two changes in Gmail. | "Read state and labels also are label changes in Gmail." |
| C6 | Move a thread to Trash. Show it in Gmail Trash. | "Albatross moves mail to Trash. It never deletes mail permanently, so it does not get full mail access." |
| C7 | Open Today. Show the Daily Brief with items from the test mail. | "The Daily Brief reads recent mail and events to show the user the items that are important today." |

### Part D: calendar

| # | Shot | Narration |
|---|---|---|
| D1 | Open Calendar. Show the test events. Show the same events in Google Calendar. | "Albatross shows the events of each calendar of the account." |
| D2 | Make an event with a Google Meet link. Show it in Google Calendar. | "Albatross makes events and Google Meet links in the user's calendar." |
| D3 | Change the time of the event. Then delete it. Show the two results in Google Calendar. | "The user can change and delete events from Albatross." |
| D4 | Answer "Yes" to a test invitation. Show the answer in Google Calendar. | "Albatross sends the user's answer to an invitation." |

### Part E: contacts and directory

| # | Shot | Narration |
|---|---|---|
| E1 | Open a new message. Type the first letters of a saved contact. Show the suggestion. | "Albatross reads saved contacts to suggest recipients. It never changes contacts." |
| E2 | Type the first letters of a person from "Other contacts". Show the suggestion. | "The other-contacts scope gives people that the user wrote to but did not save." |
| E3 | With a Workspace test account, type the first letters of a coworker. Show the suggestion. | "For Google Workspace accounts, the directory scope suggests coworkers from the domain directory." |

### Part F: Google Drive consent flow

| # | Shot | Narration |
|---|---|---|
| F1 | Settings > Advanced > turn on "Show Files". Open Files. Click "Connect" for Google Drive. | "Google Drive is a separate, optional connection." |
| F2 | The consent screen. Show the app name and each Drive scope. Show the address bar. | "Google shows the Drive scopes: read Drive files, files that Albatross makes, and Docs, Sheets, and Slides." |
| F3 | Back in Files, browse a folder. | "Albatross lists the user's Drive files with the Drive read-only scope." |
| F4 | Search for a word that is inside a test document. Show the result. | "Search finds text inside Drive files. Albatross keeps a text index for search, and deletes it when the user disconnects Drive." |
| F5 | Open a Google Doc in the Albatross editor. Change one sentence. Save. Show the change in Google Docs. | "The Docs scope lets Albatross save the user's edits back to the same Google Doc." |
| F6 | Open a Google Sheet and a Slides file in the Albatross editors. | "Albatross imports Sheets and Slides into its editors." |
| F7 | Save an Albatross document to Google as a new file. Show the new file in Google Drive. | "Albatross makes a new Google file from an Albatross document." |

### Part G: user control and Limited Use

| # | Shot | Narration |
|---|---|---|
| G1 | Settings > Account. Show "Export my data" and "Delete account". | "The user can export all data or delete the account at any time." |
| G2 | Settings > Mailboxes > the menu of the mailbox. Show "Remove account & data". Do not click it yet. | "Disconnect deletes the stored mail, calendar events, contacts, attachment copies, and search index of this mailbox. Tasks and Work that the user made from a message, area notes, the activity log, and past briefs stay until the user deletes them or the account." |
| G3 | Files > Google Drive > "Disconnect". Click it. | "Drive disconnect deletes the Drive token and the Drive index. Albatross also asks Google to revoke the token, unless a mailbox uses the same Google sign-in." |
| G4 | Show `https://myaccount.google.com/permissions` with Albatross listed. | "The user can also remove Albatross access from the Google account." |
| G5 | The privacy page, section "Google user data". | "Albatross uses Google user data only for the features shown here. We do not sell it, use it for ads, or use it to train models. Model calls go through OpenRouter with data collection turned off." |

## Limited Use: what to show

- The privacy policy section "Google user data" (`app/privacy/page.tsx:61-76`),
  with the link to the Google API Services User Data Policy.
- That sign-in with Clerk does not give Google data to Albatross (shot A2).
- That each scope maps to a visible user feature (parts C to F).
- That the user can export, delete, disconnect, and revoke (part G).
- Say "OpenRouter with data collection turned off" (shot G5) only after the
  casa-prep item "OpenRouter `data_collection: deny` on all model calls" is in
  production.
- Say that disconnect deletes the index (shot G2) only after the casa-prep item
  "disconnect deletes the content index too" is in production.

## Check after the recording

- [ ] The consent screen of each flow shows all scopes in the submission.
- [ ] The language of each consent screen is English.
- [ ] The address bar is visible on each Google page.
- [ ] No data of a live user is visible.
- [ ] Each scope has at least one shot in parts C to F.
- [ ] The YouTube video is "Unlisted", not "Private".
