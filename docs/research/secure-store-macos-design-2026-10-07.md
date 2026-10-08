# Passwords and IDs on the Mac, design note (2026-10-07)

Status: design, no code. The product brief is `docs/albatross-secure-store.md` (user stories V1
to V13). The contract is `lib/secure/contract.ts`; the server rules are `lib/secure/policy.ts`.
PR 1 is `docs/albatross-thread.md`, and its Mac note is
`albatross-thread-macos-design-2026-10-07.md`. The iOS note for this feature owns the shared
SwiftUI views and their copy. This note decides only what the Mac adds: the Settings sheet, the
pointer, the keyboard, the sheets, the identity check, and the thread blocks. Where this note and
the iOS note name the same view, the iOS note wins; section 3 lists the hooks the Mac asks for.

**Lead decisions override this note.** Two arrived while it was in progress, and the sections
below follow them:

1. "Allow once" needs the recent identity check (10 minutes), the same as "Always on this site"
   and "Add a site". The rule: a saved value never goes to a new place without a recent identity
   check. "Do not allow" needs no check. One check opens a 10-minute window.
2. A site for sign-ins and IDs is the registrable domain, with private suffixes counted.
   `dmv.ny.gov` becomes the site `ny.gov`, so the Mac shows both: the site and the host that asks.
   An API key keeps its exact host.

Sample data in this note is invented: "Sam Rivera", `sam.rivera@example.com`, `(555) 010-0100`,
a driver's license that "ends 4821" with the state NY, sites `chase.com`, `dmv.ny.gov`,
`springfieldwater.gov`, and the host `api.openai.com` with a key hint `sk-…f3a2`. No full number
appears anywhere in this note, and none may appear in a fixture, a test, or a screenshot.

The user-facing name is "Passwords and IDs". "Secure details" is the internal name of the store.
In this note, "the user" is Sam.

## What the Mac must do differently

- The Mac has the Settings sheet (`MacShellView`, 620 by 620 points, grouped form). "Passwords
  and IDs" is one row in it, with pages that push. No new window.
- The Mac has a pointer. Rows show a hover fill and a context menu. The one trailing control of a
  row is always visible; nothing important hides behind a hover.
- The Mac has a keyboard. Return saves a sheet. Escape cancels it. Command-Return answers the
  block that waits. No new shortcut takes a standard one.
- A Mac sheet takes the size of its content. The editor and the identity sheet each name a size.
- A Mac form puts the field title at the leading edge of its row. Example text goes in `prompt:`,
  never in the title (`mac-offscreen-render-probe`).
- A Mac has a camera for screen shares and recordings. No saved value is ever on screen, so there
  is nothing to hide; the one clear-text moment is the user's own fresh input, under a checkbox.

## 1. Research

Mobbin has no macOS filter. The desktop screens below are web screens at a desktop width. Each
line says what the Mac takes and rejects, and which decision (section 2.1) it drives.

### 1.1 Mobbin screens (desktop)

Vault list and detail:

- 1Password, item detail ([screen](https://mobbin.com/screens/20dbadd4-daa7-46c2-bca5-d9459287477f)).
  Three columns: categories, the item list with a one-line subtitle, and the detail. The
  password row shows "••••••••" with a strength word. Two "website" rows follow, then "This item
  has custom Autofill behavior", then a "Last edited" disclosure. Taken: the masked row with the
  field name at the leading edge; one row per site; the last-edited line. Rejected: three columns
  (the Mac uses the Settings sheet; D1 and D2), favourites, tags, Watchtower.
- 1Password, password row hover menu ([screen](https://mobbin.com/screens/cc1236cf-5df1-4856-89aa-ec66503166b5)).
  Hover shows "Copy" and a menu with "Reveal" and "Show in Large Type". Rejected in full: the
  brief's V4 says a saved value is never shown again. The Mac row has no Copy, no Reveal, and no
  hover control. Drives D4.
- 1Password, new item ([screen](https://mobbin.com/screens/fd2dbd9b-35dc-483f-b447-fcb5af2bfccd))
  and the "Creating an item" flow ([flow](https://mobbin.com/flows/8988d87f-a6ec-4067-9726-4685f97711e5)).
  A modal: title row, username and password as one group, website rows with "add another
  website", an "add more" disclosure, notes, tags, and "Save" at the trailing edge of the bottom
  bar. Taken: the order (name, credentials, sites) and Save at the trailing edge. Rejected: the
  vault picker, notes, tags, custom fields. Drives D6.
- 1Password, item history ([screen](https://mobbin.com/screens/b73a0791-59c5-4846-8dfa-d7e46f26fd67)).
  A time-ordered list of versions with "Reveal Passwords" and "Restore Item". Taken: a
  time-ordered list for the use history, newest first. Rejected: versions, reveal, restore.
  Drives D8.
- 1Password, activity log ([screen](https://mobbin.com/screens/d015635b-1d0a-4357-9281-2c863bf010de)).
  Date, event, actor, description, IP address, in a table. Taken: the four facts a use row
  needs (when, where, which Albatross, what happened). Rejected: the table; a grouped form row
  holds the same facts in two lines. Drives D8.
- Proton Pass, login detail ([screen](https://mobbin.com/screens/c3b89562-7598-425f-904d-c11bddb49bc4))
  and create login ([screen](https://mobbin.com/screens/aeb129e2-7fe0-47ea-8bac-312fe3e204ba)).
  The detail shows the password in clear text with a strength word, then "Last autofill: Never",
  "Last modified", "Created". The create panel has a "2FA secret key (TOTP)" field. Taken: "Last
  used" with a "Never" state. Rejected: the clear password; the 2FA secret (the brief refuses
  codes, V10). Drives D5 and D8.
- NordPass, new item ([screen](https://mobbin.com/screens/28c7e51a-87df-4500-90c1-a906a5290155)).
  Title, "Login details", a password field with an eye, "Websites" with "Add Website", "Custom
  fields". Taken: the eye on the password field while the user types (D7). Rejected: custom
  fields.
- AirOps, add connector ([screen](https://mobbin.com/screens/e89de038-a8e6-4890-a1f9-786163c144fa)).
  An access-token field with the line "Sent as Bearer <token> in the Authorization header" and
  "Your credentials will be securely encrypted and stored using AES 256-bit." Taken: the
  one-line header explanation under the key field; a quiet footer that says who uses the value.
  Rejected: the cipher name in user copy. Drives D6.
- n8n, credential sharing ([screen](https://mobbin.com/screens/02598fe2-aa9e-4ff3-8717-02339169e312)).
  "Sharing a credential allows people to use it in their workflows. They cannot access
  credential details." Taken: the idea, in our words: "Albatross uses it. It never shows it
  again, and no model reads it." Drives the page intro and the sheet footers.

API keys:

- Sentry, organization tokens ([screen](https://mobbin.com/screens/0b0bbea0-add6-4943-bd17-40802a22a9ad)).
  "sntrys_…xvuE", created, "Last access: 2 days ago in project javascript-nextjs", Revoke. Taken:
  the prefix-and-suffix hint (the server's `secureHints` gives "sk-…f3a2"), and "last used" with
  the place. Rejected: Revoke as a word; the Mac says "Delete".
- ElevenLabs ([screen](https://mobbin.com/screens/6739c2c6-13ee-455c-b1a4-90933c2ffece)),
  Railway ([screen](https://mobbin.com/screens/7c1acf9b-0dc3-44d2-9443-d084d61359e0)),
  Cloudflare ([screen](https://mobbin.com/screens/a8243a58-000c-461a-8821-1716c52d04b7)).
  "••••d8af", "We will only show this token once", "Last used", "Expires". Taken: the
  shown-once idea, one step further: a key is never shown again after Save. Rejected: the
  enable switch, the tags.

Identity checks:

- Sentry, "Confirm Password to Continue" ([screen](https://mobbin.com/screens/62d6f0ba-8a9a-4afa-a657-51c5bbf3e26d)),
  Dropbox Dash, "Security authentication required" ([screen](https://mobbin.com/screens/497016ca-e25e-44b3-a72b-cd1a45cc1944)),
  Otter, "Verification" ([screen](https://mobbin.com/screens/bfe5bacb-31da-43ec-8f11-bc50dd59347e)),
  X, "Enter your password" ([screen](https://mobbin.com/screens/64f23bfc-b9d4-4ae5-9826-6e761088531a)),
  Canva ([screen](https://mobbin.com/screens/78266485-7595-4f15-8b75-ffe2999067ea)),
  Mixpanel ([screen](https://mobbin.com/screens/5e53bd91-5bb6-4eae-8895-b70494b416c1)).
  Every one is a small modal: one line of reason, one secure field, Cancel and Continue. Dropbox
  names the step ("Confirm identity"). Taken: the small sheet, one reason line that names the
  action, one field, two buttons. Rejected: "Forgot password?" inside the sheet (Clerk's own
  flow owns recovery), the lock glyph. Drives D10.

Permission prompts:

- Dropbox and Savee, "would like access to its own folder" ([screen](https://mobbin.com/screens/b8c64601-9e7a-4458-9a32-a2e43b503afc)),
  Jobber, grouped scopes ([screen](https://mobbin.com/screens/1116f281-71cb-4766-b453-dc9e3acd06c3)),
  Google consent ([screen](https://mobbin.com/screens/09582f39-ef22-451c-9fe3-254b55c9d349)).
  One sentence names what is used and where; the buttons are Cancel and Allow. Taken: the one
  sentence with the fields and the host, and the site under it (lead decision 2). Rejected: a
  modal; the Mac asks inside the run block, where the page sits beside it. Drives D11.

Site lists:

- Neon, trusted domains ([screen](https://mobbin.com/screens/853011f4-9303-4fa0-8f4b-247f366e7312)),
  Stripe, payment method domains ([screen](https://mobbin.com/screens/9cc54c45-682a-42a9-9742-5ccb2e54f625)),
  Whereby, allowed domains ([screen](https://mobbin.com/screens/d19c74ac-c26c-43e8-9d29-f95a8ba95fca)).
  Neon: one row per domain with a delete control, and an "Add new domain" field with an
  example. Whereby: a text area of domains. Taken: one row per site with "Remove", and an "Add a
  site…" row with an example in the prompt. Rejected: the text area. Drives D9.

ID numbers:

- Klarna, account info ([screen](https://mobbin.com/screens/ad3f6d10-27a2-447e-a679-88f112cdaa46)).
  "Legal name", "Date of birth", "SSN/ITIN" as rows with blurred values. Taken: a row per ID
  with a label and a masked hint, never the value. Drives D3.
- Oyster, profile ([screen](https://mobbin.com/screens/e18135b3-233d-4649-9771-2bd4e21a4b16)).
  Empty rows ("Date of birth", "Citizenships") and "Add" at the trailing edge. Taken: the
  "Add your date of birth…" row while none is saved. Drives D3.
- Revolut Business, proof of identity ([screen](https://mobbin.com/screens/8e3cd29c-94aa-4572-83dc-0dfc9d7ffa58)).
  "Passport · Issued in Malaysia" and "Identity card · Issued in Malaysia". Taken: the region
  as the second fact of an ID row ("Driver's license · NY · ends 4821"). Rejected: the
  verification flow.
- Cloaked, identities ([screen](https://mobbin.com/screens/e151ce00-a72d-4ccd-920e-5c2e1d16abd7)).
  A detail with "Password ••••••••" and "One-time passcode · Add". Rejected: one-time codes
  (V10). Taken: the field name at the leading edge, the mask at the trailing edge.

Use history:

- GitLab, authentication log ([screen](https://mobbin.com/screens/1c068392-6278-422a-ba0f-e23aef1ce223)),
  Grammarly, recent activity ([screen](https://mobbin.com/screens/2cc12238-e328-495e-8a28-80481ea2e78a)),
  Mercury, company security ([screen](https://mobbin.com/screens/f1e6ca40-6513-44fa-99bb-b27b56f41371)).
  One verb per row, a relative time, newest first, a retention note ("last 60 days"). Taken:
  all four. Drives D8.

### 1.2 Product behaviour (Browserbase fetches)

- 1Password, "Closing the credential risk gap for AI agents using a browser" (2025-10-08,
  [1password.com/blog](https://1password.com/blog/closing-the-credential-risk-gap-for-browser-use-ai-agents)).
  Four principles: secrets stay secret; raw credentials never enter the LLM context;
  transparency on what the AI can and cannot see; least privilege by default. Every credential
  request is approved by a person. When two credentials match one site, the person picks one.
  Taken: the four principles are the brief; the Mac copy says, at each place, that Albatross
  types and no model reads. The "which one?" prompt is open question 9.
- Browserbase, 1Password integration ([docs.browserbase.com](https://docs.browserbase.com/integrations/1password/introduction.md)).
  A service account and the SDK read the credential into the agent's code. Rejected: the agent
  code holds the value. Our runner resolves a reference inside `browser_type` only.
- Apple, Passwords user guide for Mac ([support.apple.com](https://support.apple.com/guide/passwords/welcome/mac)),
  "See your website or app passwords" ([support.apple.com](https://support.apple.com/guide/passwords/see-a-password-mchl37e45d7c/mac)),
  "Change Passwords settings" ([support.apple.com](https://support.apple.com/guide/passwords/change-passwords-settings-sfri40599/mac)).
  The Mac app is a sidebar, a list, and a detail. "Hold the pointer over the series of dots next
  to Password to show the password." Its settings are five options, one of them "Show accounts
  as" company titles or URLs. Taken: few settings; the row shows the name and the site. Rejected:
  hover to reveal (V4). Drives D4.
- Apple HIG, Settings ([developer.apple.com](https://developer.apple.com/design/human-interface-guidelines/settings)).
  "Minimize the number of settings you offer." Command-Comma opens settings. A macOS settings
  window has panes, and the title reflects the pane. Taken: one row in the existing Settings
  sheet (PR 1 precedent), pages that push, titles that name the page. No new window. Drives D1.
- Apple HIG, Text fields ([developer.apple.com](https://developer.apple.com/design/human-interface-guidelines/text-fields)).
  "Always use a secure text field when your app asks for sensitive data, such as a password."
  Validate "when it makes sense": a password before focus leaves; an email when it leaves. Show
  a separate label and a placeholder. Taken: `SecureField` for a password and a key; the label
  is the row title and the example is the prompt; the site line validates on focus loss, the
  password on Save. Drives D6 and D7.
- SwiftUI `SecureField` ([developer.apple.com](https://developer.apple.com/documentation/swiftui/securefield)).
  In a macOS form the label sits at the leading edge and the prompt is the placeholder. The
  field "Prevents anyone from cutting or copying the field's contents" and "Displays an
  indicator when Caps Lock is enabled". It hides the dots in a screenshot on iOS only. Taken:
  the Caps Lock indicator is free; the dots are not secret, so a Mac screenshot needs no extra
  guard. Drives D13.
- SwiftUI `privacySensitive(_:)` ([developer.apple.com](https://developer.apple.com/documentation/swiftui/view/privacysensitive(_:))).
  "SwiftUI redacts views marked with this modifier when you apply the privacy redaction reason."
  Taken: on the ID number field and the date of birth picker while the user types. Drives D7.
- AppKit `NSWindow.SharingType.none` ([developer.apple.com](https://developer.apple.com/documentation/appkit/nswindow/sharingtype-swift.enum/none)).
  "A legacy constant that macOS no longer uses." "Don't use this value to hide or omit content
  from being captured." Taken as a hard fact: the Mac does not touch `sharingType`. Drives D13.
- LocalAuthentication, "Logging a user into your app with Face ID or Touch ID"
  ([developer.apple.com](https://developer.apple.com/documentation/localauthentication/logging-a-user-into-your-app-with-face-id-or-touch-id)).
  `LAContext.evaluatePolicy(.deviceOwnerAuthentication, localizedReason:)`; Touch ID needs no
  usage string; a fallback is always needed. Taken as a fact: Touch ID is local. It cannot
  refresh the session's factor age, so it cannot be the identity check. Drives D10 and D12.
- Apple HIG, Privacy ([developer.apple.com](https://developer.apple.com/design/human-interface-guidelines/privacy)).
  Purpose strings in sentence case, active voice, one sentence. A custom screen before a system
  alert has one button, "Continue", never "Allow". Taken: the identity sheet's button is
  "Continue". The allow block's "Allow once" is the real decision, not a pre-alert, so the word
  stands (locked in the brief).
- Clerk, "Add reverification for sensitive actions", iOS variant
  ([clerk.com](https://clerk.com/docs/guides/secure/reverification.md?sdk=ios)).
  The server checks `has({ reverification: 'strict' })` (10 minutes) and answers a 403
  `reverificationErrorResponse`; the client must then verify and retry. Factors: password, email
  code, phone code; second factors: phone code, authenticator app, backup code. The `fva` claim
  carries the factor age. Taken: the contract's 403 `verify_identity`, and the factor list the
  sheet must handle. Drives D10.
- ClerkKit 1.3.3, the version `apps/ios/project.yml` pins, source at the tag
  ([Session+Verification.swift](https://raw.githubusercontent.com/clerk/clerk-ios/1.3.3/Sources/ClerkKit/Domains/Auth/Session/Session+Verification.swift),
  [SessionVerification.swift](https://raw.githubusercontent.com/clerk/clerk-ios/1.3.3/Sources/ClerkKit/Domains/Auth/Session/SessionVerification.swift)).
  `Session.startVerification(level:)` returns a `SessionVerification` with `status`
  (`needsFirstFactor`, `needsSecondFactor`, `complete`), `supportedFirstFactors`, and
  `supportedSecondFactors`. Then `verifyWithPassword(_:)`, `sendEmailCode(emailAddressId:)` and
  `verifyWithEmailCode(code:)`, `sendPhoneCode` and `verifyWithPhoneCode`, `verifyWithPasskey()`,
  and `verifyWithTOTP(code:)`. The doc comment: after completion, "refresh the session token
  (for example with `getToken(_:)` using `GetTokenOptions/skipCache`) so subsequent API calls
  carry an updated first-factor age claim". The `main` branch adds `verifyWithBiometrics` (needs
  an enrolled biometric credential) and `checkAuthorization(reverification:)`; neither is at
  1.3.3. Taken: the identity sheet runs on the pinned SDK with no bump. Drives D10.
- Clerk iOS, authentication flows ([clerk.com](https://clerk.com/docs/ios/reference/native-mobile/auth.md)).
  `clerk.auth.getToken()` gives the Bearer token the app already sends to `/api/*`. Taken: after
  a check the client fetches a fresh token and retries the one request that failed.

## 2. Decisions and where it lives

### 2.1 Decisions

- **D1. One row in the Settings sheet.** `SettingsView`, Account section, "Passwords and IDs"
  directly under "Personal details". The row hides while `enabled` is false (dark launch). No
  new window, no new menu item: Command-Comma opens Settings, as today.
- **D2. Pages push; no list-and-detail split.** The list is a page; a row pushes the item page;
  the editor and the identity check are sheets. The Settings sheet is 620 wide by default and a
  split needs 900 or more. Nobody resizes a settings sheet, and no one reads a value here, so
  nothing needs the vault beside the work. Open question 3 keeps a split as phase 2.
- **D3. Rows by kind.** Three sections: "Sign-ins", "IDs" (ID numbers and the date of birth),
  "API keys". A row is the label with one secondary line: `chase.com · ••••`, `NY · ends 4821`,
  `saved`, `api.openai.com · sk-…f3a2`. The secondary line comes from `hints` and `facts`; the
  client never composes a hint of its own.
- **D4. No reveal, no copy, no hover control on a value.** Not in the row, not in the detail,
  not in the context menu. A masked hint is text, selectable, and that is all.
- **D5. "Replace…" and "Delete…" are the only verbs on a value.** Replace opens the editor
  with every secret field empty; the hints sit under the fields as captions. Delete asks once.
- **D6. One editor view for add and replace.** A grouped form in a sheet (`.macFormSheet(.editor)`,
  480 by 440, taller for an ID). Field titles are row labels; examples go in `prompt:`; Return
  is Save; Escape is Cancel. The footer names who uses the value and that no model reads it.
- **D7. Fresh input may be seen; a saved value may not.** A password or key field is a
  `SecureField` with a "Show while I type" checkbox (Mac only). An ID number is a plain field
  with monospaced digits and `.privacySensitive()`. A date is a `DatePicker`. The checkbox is
  off at every open, and the clear text ends with the sheet.
- **D8. Use history is a section of the item page.** Newest first, ten rows, "Show all N".
  Each row: the outcome verb and the field, the host and the Albatross, the relative time. A
  use row with a `workId` opens that Albatross. The footer says uses stay for 90 days.
- **D9. Sites are rows.** One row per site or host with a borderless "Remove" at the trailing
  edge, always visible. "Add a site…" is the last row and asks for the identity check. The
  footer differs by kind. A new ID item lists no sites and says why.
- **D10. The identity check is a native sheet on ClerkKit 1.3.3.** "Allow once", "Always on
  this site", and "Add a site" try the request first. On a 403 `verify_identity`, the sheet
  "One more check" opens, runs `startVerification(level: .firstFactor)`, completes the factor
  the session supports, refreshes the token, and retries the one request. One success opens a
  10-minute window; the client keeps nothing but the time of the last success, for one caption.
- **D11. The allow question lives in the run block.** Headline "Needs your answer". One
  sentence names the fields and the host; one line names the site. Buttons: "Allow once"
  (prominent, Command-Return), "Always on this site" (bordered), "Do not allow" (quiet). No
  separate "Dismiss"; "Do not allow" is the quiet word of this block.
- **D12. No Touch ID gate.** Touch ID cannot refresh the server's factor age, and there is no
  value to reveal, so a local gate adds a prompt and protects nothing. Open question 10.
- **D13. No `sharingType` change.** Apple calls `.none` legacy and says not to use it to hide
  content. No saved value is ever drawn, so there is nothing to hide; the one clear-text moment
  is under the user's own checkbox.
- **D14. The composer notice is inside the glass.** Above the field, one sentence and two text
  buttons. Return sends without the secret while the notice is up, because the sentence says
  Albatross does not send it. The removed text never reaches the draft store.
- **D15. The thread opens the editor as its own sheet.** V12 "Add" and V13 "Save a sign-in"
  present `SecureItemEditorView` from `MacWorkThreadView` with the site filled in. V9 "Save in
  Passwords and IDs" opens the Settings sheet on the add editor through a pending route, because
  the number must travel in memory and the Settings sheet is where the user looks for it next.
- **D16. Nothing in the client persists a value.** No draft store, no `@AppStorage`, no
  restoration state, no log line. The editor's `@State` goes away with the sheet. The V9 prefill
  is taken once (`takeSecurePrefill()`) and cleared.

### 2.2 Where it lives

`SettingsView.swift`, the Account section (shared, both platforms):

```
Account
  Albatross                     Signed in
  Plan …
  Mailboxes                                                >
  Connections                                              >
  Personal details              Sam Rivera, 3 more         >
  Passwords and IDs             4 saved                    >
```

- The row value is "{n} saved", or "None saved" with no items. It comes from the store after
  its first load; before that the value is empty.
- The row is absent while `SecureDetailsResponse.enabled` is false.
- The Trust footer gains one sentence: "Passwords and IDs, under Account, are what Albatross
  types without a look." Open question 1 recommends a rename of the Trust row "Saved sign-ins"
  (browser sessions) to "Signed-in sites", so the two rows read apart.

The page pushes inside the Settings `NavigationStack`, as "Personal details" does. The item page
pushes from the list. The editor and the identity check are sheets over the Settings sheet, as
PR 1 ships `PersonalDetailEditorView` (`.sheet(item:)` with `.macFormSheet()`); AppKit attaches a
sheet to a sheet, and the shipped pattern stays.

### 2.3 The list page

Title "Passwords and IDs". A `Form` with `.formStyle(.grouped)` from the Settings sheet.

```
Passwords and IDs
Albatross types these where you let it. It never shows a saved value again, and no model
reads one.

Sign-ins
  Chase                     chase.com · ••••                             >
  Springfield Water         springfieldwater.gov · ••••                  >
  Add a sign-in…
IDs
  Driver's license          NY · ends 4821                               >
  Date of birth             saved                                        >
  Add an ID number…
API keys
  OpenAI                    api.openai.com · sk-…f3a2                    >
  Add an API key…
Cards, bank numbers, and sign-in codes are not kept. Delete an item at any time.
```

- A row is a `NavigationLink` with the label at the leading edge and the secondary line at the
  trailing edge, as the "Mailboxes" and "Connections" rows are. Below 560 points the secondary
  line wraps under the label.
- "Add your date of birth…" sits in the IDs section while no date of birth exists; one date of
  birth at most, so the row hides after a save.
- Sort: by label, case-folded, inside each section. No search field in PR 2; the sections and
  the sort carry up to the 100-item cap (open question 7).
- Empty: one section with the intro and the four "Add…" rows, and the footer.
- Load error: "Could not read your Passwords and IDs." with "Try again". Loaded items stay on
  screen during a refresh, as the Saved sign-ins row does.

### 2.4 The item page

Title: the item label. A grouped form with four sections.

Driver's license:

```
Driver's license

  Name              [Driver's license                                    ]
  Type              Driver's license
  State             NY
  Number            ends 4821
  Expiry date       March 2029
  Name on the ID    saved
  Change the values                                        [Replace…]
Albatross never shows a saved value again. Replace the values to change them.

Sites
  ny.gov                                                   Remove
  Add a site…
Albatross asks you the first time a new site needs this item. A site here never asks again.

Recent uses
  Typed the number                                         Today, 9:41
  dmv.ny.gov · Renew the car registration
  Allowed once                                             Today, 9:41
  dmv.ny.gov · Renew the car registration
Uses stay for 90 days.

  Delete this item                                         [Delete…]
Deletes the saved values, the sites, and the uses.
```

- "Name" is an inline `TextField` row. Return or focus loss saves it (`PUT label`); the row
  shows the server's copy after the response. A refused label ("Visa card") shows the server's
  line in red under the row and keeps the text.
- The fact rows come from `facts` and `hints`. `facts.expires` is `YYYY-MM`; the Mac shows
  "March 2029". `hints.number` is "ends 4821" or "saved". A sign-in shows "Username
  s•••@example.com" and "Password ••••••••". An API key shows "Host api.openai.com", "Key
  sk-…f3a2", and "Header Authorization" (the fact, or "Authorization" when none).
- Sites: `sites` from the item. A sign-in's footer: "Albatross signs in only on these sites."
  An API key's section is "Hosts", and its footer: "Albatross sends the key only to these
  hosts." An ID or date of birth with no sites: "No sites yet. Albatross asks you the first time
  a site needs it." "Remove" needs no check: it narrows use (open question 8). "Add a site…"
  opens a small sheet (section 4.6) and needs the check.
- Recent uses: `GET /api/secure-details/[itemId]/uses`. Ten rows, then "Show all N". A row's
  first line is the outcome and the field; its second line is the host and the Albatross title;
  the time is at the trailing edge, with the full date and time in a tooltip. Outcome words:

  | `outcome` | First line |
  |---|---|
  | `typed` | "Typed the {field}" ("Typed the password", "Typed the number", "Typed the date") |
  | `sent` | "Sent the key" |
  | `refused_site` | "Refused: wrong site" |
  | `allowed_once` | "Allowed once" |
  | `allowed_always` | "Always allowed" |
  | `denied` | "Not allowed" |

  A row with a `workId` is a button; its context menu has "Open the Albatross". Empty: "No uses
  yet."
- Delete: the Mac row pattern from PR 1 (`LabeledContent` with a bordered "Delete…"). The
  dialog: "Delete Driver's license?" / "Albatross stops its use at once. The values and the
  uses go away." / "Delete" (destructive; Return is Cancel).

### 2.5 Toolbar, menus, shortcuts, pointer, focus

The Settings sheet keeps its toolbar ("Done"; a pushed page has the back control). The page adds
no toolbar item: every action is a row, where the pointer and Full Keyboard Access find it.

| Key | Where | Action |
|---|---|---|
| Command-Comma | Anywhere | Opens Settings (exists). |
| Return | A sheet (editor, identity check, add a site) | Save or Continue, the default button. |
| Escape | A sheet | Cancel. Escape on a pushed page does nothing; the back control pops. |
| Return | The inline Name field | Saves the label and keeps focus in the field. |
| Return | A focused row (Full Keyboard Access) | Opens the row. |
| Command-Return | The thread, a waiting allow block | "Allow once" (section 6.1). |
| Delete | Anywhere | Nothing. Delete is a row with a dialog; there is no selection to delete. |
| Command-N | Anywhere | Stays "New Message". No "new item" shortcut; the add rows are one click. |
| Command-F | Anywhere | Stays "Search Mail". No search field in PR 2. |

Pointer:

- Every row takes `.hoverHighlight()`. The trailing control of a row ("Remove", "Replace…",
  "Delete…") is always visible; hover changes nothing but the fill.
- Context menu on an item row: "Open", "Replace the values…", divider, "Delete…". On a site
  row: "Remove". On a use row: "Open the Albatross" when it has a `workId`.
- The Name field shows the system focus ring. Rows show the Full Keyboard Access ring.
- Tooltips: the relative time of a use shows the full date and time; a hint shows nothing.

Narrow window: the Settings sheet's minimum is 620 wide; AppKit does not go below it. Row content
wraps under its label below 560, which happens only inside a sheet the user made short and wide.

## 3. Shared and Mac-only code

### 3.1 Shared (the iOS note owns these; the Mac compiles them)

- `Core/Models/SecureDetailsModels.swift`: `SecureItemView`, `SecureUseView`, `SecureItemKind`,
  `IdNumberType`, `SecureAllowRequest`, `SecureSaveSignInOffer`, `SecureRequestShape`, the
  field and ID labels from the contract, and `SecureDetailsError` with `.verifyIdentity`
  (decoded from the 403 body), `.refused(field:line:)`, `.invalid(field:line:)`, `.site(line:)`,
  `.limit(line:)`.
- `Core/Stores/SecureDetailsStore.swift`: `enabled`, `items`, `load`, `create`, `update`,
  `delete`, `uses(for:)`, `allow(answer:)`. Every write returns the server's item; the list
  changes only on the response. `clear()` on sign-out, as `personalDetails.clear()`.
- `Core/Authentication/IdentityCheck.swift`: the pure state machine over `SessionVerification`
  (`idle`, `needsFirstFactor(factors)`, `codeSent(to:)`, `needsSecondFactor(factors)`,
  `complete`, `failed(line)`, `unavailable(reason)`), `lastSuccess: Date?`, and `windowOpen(at:)`
  for the 10-minute caption. Testable without Clerk.
- `Features/Settings/SecureDetailsSettingsView.swift` (the list),
  `SecureItemDetailView.swift` (the item page), `SecureItemEditorView.swift` (add and replace,
  `Target.new(kind:site:prefill:)` and `.replace(item)`), `SecureSiteSheet.swift` ("Add a site"),
  `SecureUsesSection.swift`, `SecureCopy.swift` (every line in one place, as `PersonalDetailsCopy`).
- `Features/Settings/IdentityCheckSheet.swift`: the sheet over `IdentityCheck`.
- `Features/Assistant/SecureDraftScan.swift`: the pure composer detector (SSN, card by Luhn,
  key prefixes), mirrored from the server's patterns with the same fixtures.
- `Features/Work/RunBlockView.swift`: the allow body for `StepRunNextBehaviour.allowSecure`,
  the V13 offer row under a `sign_in` handoff.
- `Features/Assistant/ToolShape.swift` and `AssistantShapeCards.swift`: `Content.secureRequest`
  and its card.
- `Features/Shell/NavigationModel.swift`: `SettingsRoute` with `.secureDetails(.list)`,
  `.item(id)`, `.add(kind:site:)`; `pendingSettingsRoute`; the in-memory `securePrefill` with
  `takeSecurePrefill()`.

Assumption: the iOS designer keeps the kind sections, the row lines, the editor fields, and the
copy table of section 7, because the brief fixes them. If the iOS note changes a line, the Mac
takes the iOS line.

### 3.2 Mac-only branches and files

| Place | `#if os(macOS)` branch or Mac file |
|---|---|
| `SettingsView.swift` | None. The row and its value are shared. |
| `SecureDetailsSettingsView.swift` | `.pointerMenu` on item rows (no-op on iOS). The "Add…" rows are plain buttons on both. |
| `SecureItemDetailView.swift` | `LabeledContent("Change the values") { Button("Replace…").buttonStyle(.bordered) }` and the same for "Delete this item", as PR 1 does; iOS keeps a destructive row and a "Replace values…" row. Site rows: a borderless "Remove" at the trailing edge; iOS uses `onDelete` (swipe). Use rows: `.help` with the full time; `.pointerMenu` with "Open the Albatross". |
| `SecureItemEditorView.swift` | `.macFormSheet(.editor)` when presented; `TextField(_:text:prompt:)` with `.labelsHidden()` through `FormFieldView`'s existing pattern; `Toggle("Show while I type").toggleStyle(.checkbox)` under a password or key field; the DatePicker in `.field` style; Save as `.confirmationAction` (Return) and Cancel as `.cancellationAction` (Escape). |
| `IdentityCheckSheet.swift` | `.macFormSheet(.editor)`; the code field takes Return; "Send a new code" is borderless. |
| `RunBlockView.swift` | "Allow once" takes `.waitingActionShortcut(ownsWaitingShortcut)`; `.pointerMenu` adds the three verbs; `ViewThatFits` lays the three buttons in a row, then a column. |
| `AssistantComposer.swift` | The notice sits inside the glass above the field; `onSubmit` reads the scan state and sends without the secret while the notice shows (D14). iOS decides its own placement. |
| `MacWorkThreadView.swift` | `.sheet(item: $secureEditor)` with `.macFormSheet(.editor)` for V12 and V13; the V9 route sets `navigation.sheet = .settings` and `pendingSettingsRoute`. |
| `MacSheetChrome.swift` | A new size `editorTall` (480 by 560) for the ID editor; everything else uses `.editor`. |
| `ShortcutReferenceView.swift` | No new row. "⌘↩ Do the action that waits" covers "Allow once". |
| `NativeTourMacTests.swift` | New screens: `mac-settings-secure` (the list), `mac-settings-secure-detail` (the driver's license), `mac-settings-secure-add` (the add sign-in sheet, "Show while I type" off), `mac-settings-identity-check` (the password variant), `mac-work-thread-allow` (section 9.4), `mac-chat-secure-request`, `mac-work-thread-sign-in-offer`. Fixtures hold hints only. |

What the Mac asks of the shared views:

- `SecureItemEditorView`: a `presentation: .sheet | .push` parameter is not needed; the Mac
  always presents it as a sheet (D6), and iOS decides for itself.
- `RunBlockView`: the allow body hides `dismissRow` (D11) and passes `ownsWaitingShortcut` to
  "Allow once" only.
- `AssistantComposer`: a `notice: SecureDraftNotice?` input and an `onNoticeAction` closure,
  so the host (the thread or the chat) routes "Save in Passwords and IDs".
- `WorkThreadModel.actions`: `allowSecure(view, scope)` and `saveSignIn(site)`.
- `FormFieldView`: nothing new; the editor uses plain `TextField`, `SecureField`, `DatePicker`,
  and `Picker` rows, with the `prompt:` and `.labelsHidden()` pattern from `FormFieldViews.swift`.

## 4. The sheets

### 4.1 Add a sign-in

```
Add a sign-in
  Name              [Chase                                   ]
  Site              [chase.com                               ]
                    Saved as chase.com. Covers secure.chase.com and every chase.com page.
  Username          [sam.rivera@example.com                  ]
  Password          [••••••••••••                            ]
                    [ ] Show while I type
Albatross signs in on chase.com with this. It never shows the password again, and no model
reads it.
                                                         Cancel    [Save]
```

- Name prompt "Chase". Site prompt "chase.com". Username prompt "sam.rivera@example.com"; the
  literal renders with `Text(verbatim:)` so it does not autolink. Password prompt "Required".
- The site caption appears when the field loses focus and the text parses. The client shows a
  preview with the same rule as the server (`normalizeSite`: strip scheme, path, `www.`;
  registrable domain for a sign-in or ID; the exact host for a key). The server's answer wins:
  the item page shows `sites` from the response. A private host, an IP address, or an empty
  entry shows the server's line in red: "Use a public web address, for example chase.com." or
  "Enter a web address, for example chase.com."
- Save is enabled when Name, Site, Username, and Password are non-empty. Validation lines come
  from the server (`SecurePolicyError`): "Check Username.", "Check Password.", "Use a shorter
  name." The field keeps its text; the line sits under the field in red.
- A refused label ("Visa", "backup codes") shows the server's refusal under Name (section 4.7).
- Saving: the Save button reads "Saving…" and both buttons disable; `interactiveDismissDisabled`.

### 4.2 Add an ID number

```
Add an ID number
  Type              [Driver's license                      ⌄]
  State             [NY                                      ]
  Number            [                                        ]
  Expiry date       [ ] Has an expiry date
  Name on the ID    [Sam Rivera                              ]   Optional
Albatross asks you before it types this on a new site. It never shows the number again, and
no model reads it.
                                                         Cancel    [Save]
```

- Type: a `Picker` with "Social Security number", "Driver's license", "Passport", "State ID",
  "Other". "Other" adds a "Name" row (prompt "Library card"). The other types take their label
  from the type; "Name" is hidden.
- Rows by type: Social Security number shows Number only (prompt "9 digits"). Driver's license
  and State ID show State (prompt "NY"), Number (prompt "Required"), Expiry date, Name on the ID.
  Passport shows Country (prompt "US", two letters), Number, Expiry date, Name on the ID. Other
  shows Name, Number, Expiry date.
- Number: a plain `TextField` with `.monospacedDigit()` and `.privacySensitive()` (D7). The
  field accepts spaces and dashes; the server keeps the digits of a Social Security number.
- Expiry date: a checkbox "Has an expiry date". On, a `DatePicker` row "Expires" appears below
  it, `.field` style, date only.
- Server lines: "A Social Security number has 9 digits.", "Check the Social Security number.",
  "Check Expiry date.", "Use a two-letter country code.", and the card refusal under Number
  when the digits pass Luhn (section 4.7).

### 4.3 Add your date of birth

One row, "Date of birth", a `DatePicker` in `.field` style, date only, with `.privacySensitive()`.
Footer: "Albatross asks you before it types this on a new site. Forms get the date in the format
they ask for." A future date shows "Check Date of birth."

### 4.4 Add an API key

```
Add an API key
  Name              [OpenAI                                  ]
  Host              [api.openai.com                          ]
                    Saved as api.openai.com. The key goes only to this host.
  Key               [••••••••••••••••••••••••••••            ]
                    [ ] Show while I type
  Header            [Authorization                           ]   Optional
                    The header that carries the key. Authorization when empty.
Albatross sends the key to api.openai.com for you. It never shows the key again, and no model
reads it.
                                                         Cancel    [Save]
```

- Host keeps the exact host (lead decision 2). A pasted URL shows the host in the caption.
- Server lines: "A key has no spaces.", "Use a header name such as Authorization.", and the
  card refusal under Key when the key is 13 to 19 digits that pass Luhn.

### 4.5 Replace the values

Title "Replace the Chase values" (sign-in), "Replace the Driver's license values", "Replace
the date of birth", "Replace the OpenAI key". The same rows as the add sheet, every secret field
empty, and the current hint as a caption under each: "Saved: s•••@example.com", "Saved:
••••••••", "Saved: ends 4821". Name, Site, and Type are not in this sheet; the item page owns
them. Save replaces all secret values of the item at once (`PUT values`), so a sign-in asks for
both the username and the password.

### 4.6 Add a site

A small sheet from the item page's "Add a site…" row (`.macFormSheet(.editor)` is too tall; this
one is 480 by 220):

```
Add a site
  Site              [dmv.ny.gov                              ]
                    Saved as ny.gov. Covers dmv.ny.gov and every ny.gov page.
A site here never asks again. Adding one needs one more check of your sign-in.
                                                         Cancel    [Add]
```

"Add" posts `PUT sites` with the new list. A 403 `verify_identity` opens the identity sheet over
this one (section 5), then retries. The row appears when the server answers.

### 4.7 Refusal copy

The server's lines, verbatim, in red under the field named by `SecurePolicyError.field`:

| When | Line |
|---|---|
| A label or an "Other" type names a card | "Albatross does not keep card numbers yet." |
| A label names a sign-in code, a recovery code, or a backup code | "Albatross does not keep sign-in codes or recovery codes. They stay with you." |
| A label names a bank or routing number | "Albatross does not keep bank account or routing numbers." |
| A number or key is 13 to 19 digits that pass Luhn | "Albatross does not keep card numbers yet." |
| The 101st item | "Albatross keeps 100 items at most." (the server's limit line) |
| The 21st site | "An item works on 20 sites at most." |

The field keeps its text, so the user can fix it. No line names the value.

## 5. The identity check on the Mac

### 5.1 When

Lead decision 1: "Allow once", "Always on this site", and "Add a site" need the check. "Do not
allow", "Remove" (a site), "Replace…", "Delete…", and a new item need none. The client always
tries the request first; the server reads `fva` and answers 403 `{ code: 'verify_identity' }`
with Clerk's reverification body when the age is over 10 minutes. The client never decides on
its own (ClerkKit 1.3.3 has no `checkAuthorization(reverification:)`; `main` does, and it stays
a later convenience).

### 5.2 The sheet

```
One more check
To let Albatross use your driver's license number on dmv.ny.gov, type your password.
A check lasts 10 minutes.
  Password          [••••••••••••                            ]
                                                         Cancel    [Continue]
```

Variants by the factors `SessionVerification.supportedFirstFactors` lists:

| Factor | Rows | Lines |
|---|---|---|
| Password | one `SecureField` | as above |
| Email code | a six-digit code field | "We sent a code to s•••@example.com. Type it here." and a borderless "Send a new code" |
| Phone code | the same | "We sent a code to (555) ···-0100." |
| Passkey | no field | "Use your passkey to continue." and the Continue button starts `verifyWithPasskey()` |
| Second factor (`needsSecondFactor`) | a code field | "Now the code from your authenticator app." |

- The reason line names the action: "To let Albatross use your driver's license number on
  dmv.ny.gov every time, …" (Always), "… on dmv.ny.gov, …" (once), "To add ny.gov to your
  driver's license, …" (Add a site).
- The sheet picks the strongest factor the session lists, password first, then passkey, then
  email code, then phone code. A "Use another way" borderless button shows when two or more
  exist; it opens a menu of the others.
- Continue is the default button. While the SDK works, Continue reads "Checking…" and both
  buttons disable. On `complete`, the sheet fetches a fresh token (`getToken` with `skipCache`),
  retries the one request, and closes. The caller shows its result (the allow receipt, the new
  site row).
- Errors: "That password did not work." / "That code did not work." under the field, text kept
  for a password, cleared for a code. "The code expired. Send a new one." after Clerk's expiry
  error. Three failures: the sheet stays; Clerk's own limits apply.
- Cancel: the caller's state goes back to what it was. An allow block reads "Not checked. Allow
  once still waits." under its buttons, and the buttons stay.

### 5.3 The 10-minute window

The sheet records `lastSuccess`. For the next 10 minutes the server passes these requests, so
no sheet appears. The allow block shows one caption while the window is open: "Checked 3
minutes ago. Allow once and Always on this site work without another check." The caption is the
only place the client uses the time; the server stays the judge.

### 5.4 Fallback when the Mac cannot reverify

Lead decision 8 (2026-10-08) settles this: the native fallback is the iOS one. Cases:
`supportedFirstFactors` is empty (an account with OAuth only), the SDK throws before a factor
starts, or the status is `unknown`. The allow block then reads:

```
This device could not do the check. Answer on the web, or press Do not allow.
[Open on the web]                                              Do not allow
```

- "Open on the web" opens the Work page on the web (`?work=<id>`). The allow answer is a server
  row, so an answer on the web ends the question on every device, this Mac included. No
  "Sign out" button.
- "Do not allow" and "Take over" stay available; the user types the number on the page in the
  pane.
- In Settings, "Add a site" shows "This device could not do the check. Add the site on the web."
  "Remove" still works.

### 5.5 Touch ID

Not in PR 2 (D12). Touch ID cannot refresh `fva`, and there is no reveal to gate. ClerkKit
`main` has `verifyWithBiometrics`, which needs an enrolled biometric credential and the
instance's biometric sign-in setting; if the SDK is bumped later, the sheet gains a "Use Touch
ID" first factor with no other change. Open question 10.

## 6. The thread surfaces on the Mac

### 6.1 The `allow_secure` block (V6)

`next.kind === 'allow_secure'` maps to `StepRunNextBehaviour.allowSecure(SecureAllowRequest)`
in `StepRunPresentation.swift`. The block:

```
┃ Needs your answer · Started by you · 9:41
┃ Renew the car registration
┃ Use your driver's license number and expiry date on dmv.ny.gov?
┃ This site is ny.gov. Albatross types the values on the page. It does not read them, and no
┃ model sees them.
┃ ● Albatross is on the page · dmv.ny.gov                        Hide the page
┃ ▸ What Albatross did  6
┃ [Allow once]   [Always on this site]      Do not allow
┃ Always on this site covers every ny.gov page. Both need one more check of your sign-in,
┃ once in 10 minutes.
```

- The sentence: "Use your {item label, lowercased} {field labels joined with "and"} on {host}?"
  from `SecureAllowRequest.itemLabel`, `fieldLabels`, and `host`. For a date of birth: "Use your
  date of birth on dmv.ny.gov?"
- The site line: "This site is {site}." When `site == host`, the line is "Albatross types the
  values on the page. It does not read them, and no model sees them." alone.
- Buttons: "Allow once" is `.borderedProminent` with `waitingActionShortcut()` (Command-Return;
  help "⌘↩"). "Always on this site" is `.bordered`. "Do not allow" is borderless, in the quiet
  colour, at the trailing edge of the row. `ViewThatFits` folds them into a column below 480.
- The context menu: "Allow once", "Always on this site", "Do not allow", divider, "Copy the
  summary", "Copy the log". No "Dismiss".
- Both allow buttons post `SecureAllowAnswer`. A 403 opens the identity sheet; success retries;
  the block then shows the receipt below. Command-Return for "Always" is never offered: the
  wider grant takes a click.
- The composer placeholder is "Answer here, or tell Albatross what to change"; "not this one"
  in the composer is a steer note, and the block stays until a button answers it.

State matrix:

| State | Headline | Body | Buttons |
|---|---|---|---|
| Pending | "Needs your answer" | the sentence, the site line, the caption | all three |
| Window open (checked in the last 10 min) | same | caption "Checked 3 minutes ago. Allow once and Always on this site work without another check." | all three |
| Sending | same | same | "Allow once" reads "Allowing…"; all disabled |
| Check sheet open | same | same | all disabled behind the sheet |
| Check cancelled | same | line "Not checked. Allow once still waits." | all three |
| Allowed once | "Ready for you" | receipt "Allowed once on dmv.ny.gov." | none; the run continues as a continuation block |
| Allowed always | "Ready for you" | receipt "Always allowed on ny.gov. Change it in Settings, Passwords and IDs." | none |
| Denied | "Your turn" | receipt "Not allowed. Type it on the page yourself, then press Continue." | "Take over", "Continue" |
| Expired (the run ended, the chain closed) | "Dismissed" | "No longer needed." | none |
| Server error | "Needs your answer" | the error in red: "Albatross could not record your answer. Try again." | all three |
| Cannot reverify | same | "This device could not do the check. Answer on the web, or press Do not allow." | "Open on the web", "Do not allow", plus "Take over" in the pane |

VoiceOver: the block's label is "Needs your answer. Use your driver's license number and expiry
date on dmv.ny.gov?" The announcement is "Albatross asks: use your driver's license on
dmv.ny.gov?" once.

### 6.2 The `secure_request` card (V12)

`ToolShape.Content.secureRequest(SecureRequestShape)` renders through `AssistantShapeCardView`:

```
┌──────────────────────────────────────────────────────────────┐
│ Add your sign-in for springfieldwater.gov                     │
│ The water bill is paid on springfieldwater.gov, and no sign-in│
│ is saved for it.                                      [Add…]  │
└──────────────────────────────────────────────────────────────┘
```

- Title by kind: sign-in "Add your sign-in for {site}"; ID number "Add your {label}" ("Add your
  driver's license"); date of birth "Add your date of birth"; API key "Add your {label} key"
  or "Add an API key for {site}" when no label.
- The body is `reason`, verbatim from the server.
- "Add…" is `.bordered` at the trailing edge; it presents `SecureItemEditorView` as a sheet with
  the kind and the site filled in (D15). After Save the card reads "Saved. Albatross can use it
  on springfieldwater.gov." and the button goes; the chat model learns only that the item
  exists (the brief).
- With `existingItemId`: title "Albatross has a sign-in for springfieldwater.gov", body "It
  uses the saved one on the next run.", button "Open" (Settings, the item page).
- While the feature is off (`enabled` false), the card shows "Passwords and IDs is not on for
  your account yet." and no button; this is only possible if the server sends the card by
  mistake.

### 6.3 The `sign_in` handoff save offer (V13)

Under the handoff detail, when `next.saveSignIn` is set:

```
┃ Your turn · Started by you · 9:41
┃ Sign in to chase.com in the page, then press I signed in.
┃ No sign-in is saved for chase.com.           Save a sign-in for chase.com…
┃ ● Albatross is on the page · chase.com                         Hide the page
┃ [Sign in]   [I signed in]      Dismiss
```

- The offer is one quiet row: the fact at the leading edge, a borderless button at the trailing
  edge. It opens the editor sheet with the site filled in (D15).
- After Save the row reads "Saved. Press Continue, and Albatross signs in." and the second
  button reads "Continue" (the done label gives way, because the run can now sign in itself).
- The row never appears twice in a chain; a continuation that still carries `saveSignIn` after
  a save shows nothing.

### 6.4 The composer notice (V9)

```
┌────────────────────────────────────────────────────────────────┐
│ This looks like a Social Security number. Albatross does not    │
│ send it.          Save in Passwords and IDs    Send without it  │
│ (clip)  my ssn is ···-··-····, use it on the form     Ask  (up) │
└────────────────────────────────────────────────────────────────┘
```

- `SecureDraftScan` runs on each draft change, debounced 300 ms, on the Mac and on iOS. The
  notice shows inside the glass above the field (D14). It hides when the draft no longer
  matches.
- Lines by kind: Social Security number as above; "This looks like a card number. Albatross
  does not send it, and it does not keep card numbers yet." (only "Send without it"); "This
  looks like an API key. Albatross does not send it." (both buttons).
- "Save in Passwords and IDs" (bordered, small) removes the match from the draft, puts
  "[removed: looks like a Social Security number]" in its place, and opens the Settings sheet
  on the add editor with the number in the Number field (`pendingSettingsRoute`,
  `securePrefill`, taken once). The draft store never sees the number: the removal happens
  before `model.updateDraft`.
- "Send without it" (borderless) removes the match the same way and sends.
- Return while the notice shows is "Send without it" (D14). The send control does the same. The
  notice is announced once: "Albatross does not send this number. Save it in Passwords and IDs,
  or send without it."
- The server backstop stays: a message that gets past the client shows "[removed: looks like
  a Social Security number]" in the saved chat.

## 7. User stories on the Mac

Copy is exact. Sentence case. No icon before text.

**V1. Save a sign-in.** Settings, Account, "Passwords and IDs", "Add a sign-in…". The sheet of
4.1 opens. Sam types "Chase", "chase.com", the username, the password, presses Return. The sheet
closes. The list reads "Chase · chase.com · ••••". The announcement: "Saved Chase."

**V2. Save an ID.** "Add an ID number…". Type "Driver's license", State "NY", the number, "Has an
expiry date" on, "Expires" March 2029, Name on the ID "Sam Rivera". Save. The list reads
"Driver's license · NY · ends 4821". Then "Add your date of birth…", the date, Save: "Date of
birth · saved". The add row for the date of birth goes away.

**V3. Save an API key.** "Add an API key…". "OpenAI", "api.openai.com", the key, Header empty.
Save. The list reads "OpenAI · api.openai.com · sk-…f3a2".

**V4. Never shown again.** The item page shows "Password ••••••••", "Number ends 4821", "Key
sk-…f3a2". No row, menu, hover, or tooltip shows more. "Replace…" opens the sheet of 4.5 with
empty fields and the hints as captions. "Delete…" asks once and deletes.

**V5. A run signs in for me.** The run block's log reads "9:41 Signed in to chase.com with your
saved sign-in." Then a `sign_in` handoff: "Your turn" / "Chase sent you a code. Type it on the
page, then press Continue." The pane bar reads "Your turn: enter the code" with "Continue" at
the trailing edge. The item page's uses gain "Typed the username" and "Typed the password ·
chase.com · Pay the credit card · Today, 9:41".

**V6. A new site asks first.** The run reaches `dmv.ny.gov`. The block of 6.1 appears; the plan
line reads "Step 1 of 2 · Needs your answer"; the jump pill reads "Albatross needs an answer"
when the block is off screen. Sam presses Command-Return ("Allow once"). The server answers 403.
The sheet "One more check" opens with the password row. Sam types the password, Return. The
sheet closes, the answer posts, the block reads "Allowed once on dmv.ny.gov." and a continuation
block starts: "9:42 Typed the driver's license number." Two minutes later, on `tax.ny.gov`, the
block appears again; the caption reads "Checked 2 minutes ago…"; "Always on this site" posts at
once; the receipt reads "Always allowed on ny.gov. Change it in Settings, Passwords and IDs."
The item page's Sites gains "ny.gov".

**V7. A wrong site never gets it.** A page on `example-mail.com` asks for the Chase password.
The log reads "9:44 Did not type the Chase password: this page is example-mail.com, not
chase.com." The run hands off: "Your turn" / "This page asks for your Chase password, but it is
not chase.com. Albatross typed nothing. Check the page before you do anything." with "Take
over" and "Continue". The Chase item's uses gain "Refused: wrong site · example-mail.com".

**V8. Use history.** The item page's "Recent uses" section of 2.4. Ten rows, "Show all 23".
A row with an Albatross opens it from the context menu.

**V9. I paste a secret in the chat.** Sam pastes a sentence with a Social Security number. The
notice of 6.4 appears. Sam clicks "Save in Passwords and IDs". The draft changes to "my ssn is
[removed: looks like a Social Security number], use it on the form". The Settings sheet opens on
"Add an ID number" with Type "Social Security number" and the Number filled. Save. The sheet
closes; the thread is behind it, the draft still there. Sam presses Return; the message goes
without the number. The server's copy would show the same bracket if the client had missed it.

**V10. Cards wait.** "Add an ID number…", Type "Other", Name "Visa card": the line "Albatross
does not keep card numbers yet." under Name, in red. A 16-digit Luhn number under any Number or
Key field: the same line under that field.

**V11. Delete my account or export my data.** Web only. The Mac's "Delete account and data" sheet
(PR 1) keeps its copy; the server deletes the items and the uses. "Export" (the Mac save panel)
lists each item without its value, as the server builds it.

**V12. Albatross asks for a missing secret.** Sam writes "pay the water bill". The reply shows
the card of 6.2. "Add…" opens the editor sheet with Site "springfieldwater.gov" filled. Sam types
the username and password, Return. The card reads "Saved. Albatross can use it on
springfieldwater.gov." The run starts from the reply and the log reads "Signed in to
springfieldwater.gov with your saved sign-in."

**V13. Save a sign-in from a handoff.** The block of 6.3. Sam clicks "Save a sign-in for
chase.com…", fills the sheet, Return. The row reads "Saved. Press Continue, and Albatross signs
in." Sam presses Command-Return ("Continue"). The continuation signs in by itself.

### 7.1 State matrix: the list row

| Item state | Label | Secondary line | Trailing |
|---|---|---|---|
| Sign-in | label | "{site} · ••••"; "{site}, +2" with three or more sites | chevron |
| ID number | label | "{region} · ends 4821"; "ends 4821" without a region; "saved" when the hint is "saved" | chevron |
| Date of birth | "Date of birth" | "saved" | chevron |
| API key | label | "{host} · sk-…f3a2" | chevron |
| Never used | same | same | same; "Last used" is on the item page |
| Load in progress, nothing cached | "Checking…" row with a small spinner | | |
| Load failed, nothing cached | "Could not read your Passwords and IDs." | "Try again" | |
| Feature off | the row in Settings is absent | | |

### 7.2 State matrix: the item page

| Section | Empty | Loaded | Busy or error |
|---|---|---|---|
| Saved | never empty | the fact rows and hints | a label save shows "Saving…" in the field's caption; a refusal in red |
| Sites | "No sites yet. Albatross asks you the first time a site needs it." (ID, date) | one row per site, "Remove" | "Add a site…" disabled while a request runs; the error line under the row |
| Recent uses | "No uses yet." | ten rows, "Show all N" | "Could not read the uses." with "Try again" |
| Delete | never empty | "Delete…" | "Deleting…" disabled; the error line under the row |

### 7.3 State matrix: the request card

| State | Title | Body | Button |
|---|---|---|---|
| Pending | "Add your sign-in for {site}" | `reason` | "Add…" |
| Editor open | same | same | disabled |
| Saved | same | "Saved. Albatross can use it on {site}." | none |
| Existing item | "Albatross has a sign-in for {site}" | "It uses the saved one on the next run." | "Open" |
| Feature off | "Passwords and IDs is not on for your account yet." | none | none |

The allow block's matrix is in 6.1.

## 8. Accessibility, dark mode, vibrancy, screenshots

VoiceOver:

- An item row: "Chase, sign-in, chase.com, password saved, button". An ID row: "Driver's
  license, ID number, NY, ends 4821". A date row: "Date of birth, saved". A key row: "OpenAI,
  API key, api.openai.com, key saved". The hint words are the only value-like text, and the
  server chose them to be safe.
- A `SecureField` is "secure text field"; the system never reads its characters. The ID number
  field is a text field; VoiceOver echoes typed characters by the user's own typing-echo
  setting, which is the user's input, not a saved value. After Save, nothing holds the value.
- Announcements (`PlatformAccessibility.announce`): "Saved Chase.", "Replaced the Chase
  values.", "Deleted.", "Added ny.gov.", "Removed ny.gov.", "Allowed once on dmv.ny.gov.",
  "Always allowed on ny.gov.", "Not allowed.", "Albatross asks: use your driver's license on
  dmv.ny.gov?", the composer notice once.
- The identity sheet's field has the label "Password" or "Code"; the reason line is a header.
- A use row: "Typed the number, dmv.ny.gov, Renew the car registration, today at 9:41".

Full Keyboard Access:

- Every row, the inline Name field, the checkboxes, the pickers, the sheet buttons, the three
  allow buttons, and the two notice buttons are in the tab order. The allow block's order is
  "Allow once", "Always on this site", "Do not allow".
- The dialogs have Cancel as the default; the destructive button needs a click or Tab.

Dark mode: the grouped form and the sheets use the system backgrounds. Error lines are red; hints
and captions are secondary; the allow block's headline uses the accent (the handoff colour of
`RunBlockView`). No colour carries a meaning alone: every state has a word.

Vibrancy: none. The Settings sheet, the editor, and the identity sheet are opaque forms, as every
settings surface in the shell (`MacSheetChrome`). The tour's `cacheDisplay` draws them faithfully.

Screenshots and screen shares (D13): `sharingType` stays as it is. The only clear text a
screenshot can hold is the user's own input while "Show while I type" is on or while an ID number
is typed; both end with the sheet, and the checkbox starts off at every open. The tour fixtures
hold hints only, and the add-sheet screen renders with the checkbox off and the fields empty.

Reduce Motion: the editor and the notice appear with a crossfade; nothing slides.

## 9. Wireframes

Invented data. The Settings sheet is 640 wide in the tour (`mac-settings-personal-details` uses
640 by 640); the thread window is 1440 by 900.

### 9.1 Settings, the list, and the driver's license page

```
┌───────────────────────────────────────────────────────────────┐
│ ‹ Settings                      Passwords and IDs        Done │
├───────────────────────────────────────────────────────────────┤
│ Albatross types these where you let it. It never shows a      │
│ saved value again, and no model reads one.                    │
│ Sign-ins                                                      │
│ ┌───────────────────────────────────────────────────────────┐ │
│ │ Chase                 chase.com · ••••                  › │ │
│ │ Springfield Water     springfieldwater.gov · ••••       › │ │
│ │ Add a sign-in…                                            │ │
│ └───────────────────────────────────────────────────────────┘ │
│ IDs                                                           │
│ ┌───────────────────────────────────────────────────────────┐ │
│ │ Driver's license      NY · ends 4821                    › │ │
│ │ Date of birth         saved                             › │ │
│ │ Add an ID number…                                         │ │
│ └───────────────────────────────────────────────────────────┘ │
│ API keys                                                      │
│ ┌───────────────────────────────────────────────────────────┐ │
│ │ OpenAI                api.openai.com · sk-…f3a2         › │ │
│ │ Add an API key…                                           │ │
│ └───────────────────────────────────────────────────────────┘ │
│ Cards, bank numbers, and sign-in codes are not kept. Delete   │
│ an item at any time.                                          │
└───────────────────────────────────────────────────────────────┘
```

```
┌───────────────────────────────────────────────────────────────┐
│ ‹ Passwords and IDs             Driver's license         Done │
├───────────────────────────────────────────────────────────────┤
│ ┌───────────────────────────────────────────────────────────┐ │
│ │ Name              [Driver's license                     ] │ │
│ │ Type              Driver's license                        │ │
│ │ State             NY                                      │ │
│ │ Number            ends 4821                               │ │
│ │ Expiry date       March 2029                              │ │
│ │ Name on the ID    saved                                   │ │
│ │ Change the values                              [Replace…] │ │
│ └───────────────────────────────────────────────────────────┘ │
│ Albatross never shows a saved value again. Replace the values │
│ to change them.                                               │
│ Sites                                                         │
│ ┌───────────────────────────────────────────────────────────┐ │
│ │ ny.gov                                             Remove │ │
│ │ Add a site…                                               │ │
│ └───────────────────────────────────────────────────────────┘ │
│ Albatross asks you the first time a new site needs this item. │
│ A site here never asks again.                                 │
│ Recent uses                                                   │
│ ┌───────────────────────────────────────────────────────────┐ │
│ │ Typed the number                              Today, 9:42 │ │
│ │ dmv.ny.gov · Renew the car registration                   │ │
│ │ Allowed once                                  Today, 9:41 │ │
│ │ dmv.ny.gov · Renew the car registration                   │ │
│ └───────────────────────────────────────────────────────────┘ │
│ Uses stay for 90 days.                                        │
│ ┌───────────────────────────────────────────────────────────┐ │
│ │ Delete this item                                [Delete…] │ │
│ └───────────────────────────────────────────────────────────┘ │
│ Deletes the saved values, the sites, and the uses.            │
└───────────────────────────────────────────────────────────────┘
```

### 9.2 The add sign-in sheet (over the Settings sheet, 480 by 440)

```
┌───────────────────────────────────────────────────────┐
│                    Add a sign-in                      │
├───────────────────────────────────────────────────────┤
│ ┌───────────────────────────────────────────────────┐ │
│ │ Name          [Chase                            ] │ │
│ │ Site          [chase.com                        ] │ │
│ │               Saved as chase.com. Covers          │ │
│ │               secure.chase.com and every          │ │
│ │               chase.com page.                     │ │
│ │ Username      [sam.rivera@example.com           ] │ │
│ │ Password      [••••••••••••                     ] │ │
│ │               [ ] Show while I type               │ │
│ └───────────────────────────────────────────────────┘ │
│ Albatross signs in on chase.com with this. It never   │
│ shows the password again, and no model reads it.      │
│                                                       │
│                                    Cancel     [Save]  │
└───────────────────────────────────────────────────────┘
```

### 9.3 The identity sheet (480 by 260)

```
┌───────────────────────────────────────────────────────┐
│                    One more check                     │
├───────────────────────────────────────────────────────┤
│ To let Albatross use your driver's license number on  │
│ dmv.ny.gov, type your password. A check lasts 10      │
│ minutes.                                              │
│ ┌───────────────────────────────────────────────────┐ │
│ │ Password      [••••••••••••                     ] │ │
│ └───────────────────────────────────────────────────┘ │
│ Use another way                     Cancel [Continue] │
└───────────────────────────────────────────────────────┘
```

### 9.4 The thread with the allow block (1440 by 900, sidebar 260, pane 616)

```
┌──────────────────────┬──────────────────────────────────────────────┬─────────────────────────────────┐
│ Albatross        [+] │ Renew the car registration                   │                   [◎] [▣] [⋯]   │
│                      │ Step 1 of 2 · Needs your answer ⌄            │                                 │
├──────────────────────┼──────────────────────────────────────────────┼─────────────────────────────────┤
│ Search mail      ⌘F  │ Renew the car registration before Oct 31     │ ● Albatross is on the page      │
│                      │ 1 Renew online · Albatross needs your answer │   On the license form           │
│ Today                │ 2 Put the sticker on the car · You           │          [Take over]  Larger ⌄  │
│ Albatrosses  4 need  │                                              ├─────────────────────────────────┤
│ Chat                 │ ┃ Needs your answer · Started by you · 9:41  │ ┌─────────────────────────────┐ │
│ Mail                 │ ┃ Renew online                               │ │ dmv.ny.gov                  │ │
│ Calendar             │ ┃ Use your driver's license number and       │ │                             │ │
│                      │ ┃ expiry date on dmv.ny.gov?                 │ │  Renew a registration       │ │
│ Your areas           │ ┃ This site is ny.gov. Albatross types the   │ │  Plate        [ABC 1234   ] │ │
│ ● Personal           │ ┃ values on the page. It does not read them, │ │  License no.  [           ] │ │
│ ● Harbor Clinic      │ ┃ and no model sees them.                    │ │  Expires      [  /  /     ] │ │
│                      │ ┃ ● Albatross is on the page · dmv.ny.gov    │ │  Name         Sam Rivera    │ │
│                      │ ┃                            Hide the page   │ │                             │ │
│                      │ ┃ ▸ What Albatross did  6                    │ │  [Continue]                 │ │
│                      │ ┃ [Allow once] [Always on this site]         │ │                             │ │
│                      │ ┃                             Do not allow   │ │                             │ │
│                      │ ┃ Always on this site covers every ny.gov    │ │                             │ │
│                      │ ┃ page. Both need one more check of your     │ │                             │ │
│                      │ ┃ sign-in, once in 10 minutes.               │ │                             │ │
│                      │                                              │ └─────────────────────────────┘ │
│                      │ ┌──────────────────────────────────────────┐ │                                 │
│ Settings             │ │ (clip) Answer here, or tell Alb… Ask (up)│ │                                 │
└──────────────────────┴─┴──────────────────────────────────────────┴─┴─────────────────────────────────┘
```

`[◎]` is the Page toggle, `[▣]` the Details toggle, `[⋯]` the menu, "(clip)" the attach control,
"(up)" the send control. "Allow once" carries Command-Return; its help reads "⌘↩".

## 10. Open questions for the lead designer

1. **Rename the Trust row "Saved sign-ins".** It holds browser sessions, and "Passwords and IDs"
   now holds sign-ins. Recommendation: "Signed-in sites", with the footer "The shared browser
   stays signed in to these sites after you sign in yourself." One rename, both platforms and
   web, in PR 2.
2. **Where the row sits.** Recommendation: Account, directly under "Personal details". It is
   identity data, and the two pages point at each other. The Trust footer names it in one
   sentence.
3. **Push or a list-and-detail split.** Recommendation: push (D2). A split needs a 900-point
   sheet or its own window, and no one reads a value here. If dogfood shows users go back and
   forth between items, phase 2 adds a "Passwords and IDs" window with the Passwords app's
   three columns.
4. **"Show while I type" on a password or key.** Recommendation: yes, Mac only, off at every
   open (D7). It is the user's fresh input, not a saved value, and a wrong password costs a run.
   The ID number field stays plain with `.privacySensitive()`; people type it from a card.
5. **Return in the composer while the notice shows.** Recommendation: "Send without it" (D14).
   The sentence says Albatross does not send it, and the server backstop stands behind it. The
   alternative, Return does nothing, leaves a user who did not see the notice with a dead key.
6. **Command-Return on "Allow once".** Recommendation: yes, and never on "Always on this site".
   With lead decision 1, the key triggers the check when it is due, so a stolen session gains
   nothing from the shortcut.
7. **Search in the list.** Recommendation: none in PR 2. Three sections, sorted, carry the cap
   of 100 items. Command-F stays "Search mail". Revisit at 30 items in dogfood.
8. **"Remove" a site without the check.** Recommendation: no check. It narrows use. The server
   contract needs to say so (the brief names only adding).
9. **Two sign-ins for one site.** 1Password asks which one. Recommendation: phase 2, as an
   `ask_form` choice from the runner ("Which Chase sign-in?") with the username hints as the
   option labels. PR 2 lets the runner refuse with a `secure_request` card that names both.
10. **Touch ID.** Recommendation: not in PR 2 (D12). When the Clerk SDK is bumped past 1.3.3,
    `verifyWithBiometrics` can be the first factor in the identity sheet, after the owner turns
    on native biometric sign-in in the Clerk dashboard. No other UI changes.
11. **The identity sheet's title.** Recommendation: "One more check". "Confirm" and "verify" are
    not STE words; "check" is, as a noun. The reason line carries the meaning.
12. **The Mac fallback when the SDK cannot reverify.** Settled by lead decision 8: "Open on the
    web" and "Do not allow" (5.4). The factor age is per session, but the allow answer is a
    server row, so an answer on the web ends the question on this Mac too. No "Sign out".
13. **The V13 button after a save.** Recommendation: the done label gives way to "Continue",
    and the row says "Saved. Press Continue, and Albatross signs in." The user then does
    nothing on the page.
14. **One date of birth.** Recommendation: the add row hides after a save; the item page's
    "Replace…" changes it. Two dates of birth is a data error, not a feature.

## Copy table (Mac additions)

Shared lines are in the iOS note's copy table. These are Mac only, or they are the lines this
note asks the iOS note to adopt.

| Where | Line |
|---|---|
| Settings row | "Passwords and IDs"; value "4 saved", "None saved" |
| Trust footer sentence | "Passwords and IDs, under Account, are what Albatross types without a look." |
| List intro | "Albatross types these where you let it. It never shows a saved value again, and no model reads one." |
| List sections | "Sign-ins", "IDs", "API keys" |
| Add rows | "Add a sign-in…", "Add an ID number…", "Add your date of birth…", "Add an API key…" |
| List footer | "Cards, bank numbers, and sign-in codes are not kept. Delete an item at any time." |
| Item page rows | "Name", "Type", "State", "Country", "Number", "Expiry date", "Name on the ID", "Username", "Password", "Host", "Key", "Header", "Change the values", "Replace…", "Delete this item", "Delete…" |
| Item page footers | "Albatross never shows a saved value again. Replace the values to change them."; "Albatross signs in only on these sites."; "Albatross sends the key only to these hosts."; "Albatross asks you the first time a new site needs this item. A site here never asks again."; "No sites yet. Albatross asks you the first time a site needs it."; "Uses stay for 90 days."; "Deletes the saved values, the sites, and the uses." |
| Sites rows | "Remove", "Add a site…", "Hosts" (API key section title) |
| Use rows | "Typed the {field}", "Sent the key", "Refused: wrong site", "Allowed once", "Always allowed", "Not allowed", "No uses yet.", "Show all N", "Open the Albatross" |
| Delete dialog | "Delete {label}?", "Albatross stops its use at once. The values and the uses go away.", "Delete" |
| Editor titles | "Add a sign-in", "Add an ID number", "Add your date of birth", "Add an API key", "Replace the {label} values", "Replace the date of birth", "Replace the {label} key" |
| Editor rows | "Show while I type", "Has an expiry date", "Expires", "Optional" |
| Editor captions | "Saved as chase.com. Covers secure.chase.com and every chase.com page."; "Saved as api.openai.com. The key goes only to this host."; "The header that carries the key. Authorization when empty."; "Saved: s•••@example.com" |
| Editor footers | "Albatross signs in on {site} with this. It never shows the password again, and no model reads it."; "Albatross asks you before it types this on a new site. It never shows the number again, and no model reads it."; "Albatross asks you before it types this on a new site. Forms get the date in the format they ask for."; "Albatross sends the key to {host} for you. It never shows the key again, and no model reads it." |
| Editor buttons | "Cancel", "Save", "Saving…", "Add" |
| Add a site sheet | "Add a site", "A site here never asks again. Adding one needs one more check of your sign-in." |
| Identity sheet | "One more check"; "To let Albatross use your {item} on {host}, type your password. A check lasts 10 minutes."; "… on {host} every time, …"; "To add {site} to your {item}, …"; "We sent a code to {hint}. Type it here."; "Send a new code"; "Use your passkey to continue."; "Now the code from your authenticator app."; "Use another way"; "Continue"; "Checking…"; "That password did not work."; "That code did not work."; "The code expired. Send a new one." |
| Identity fallback | "This device could not do the check. Answer on the web, or press Do not allow."; "This device could not do the check. Add the site on the web."; "Open on the web" |
| Allow block | "Needs your answer"; "Use your {item} {fields} on {host}?"; "This site is {site}."; "Albatross types the values on the page. It does not read them, and no model sees them."; "Allow once"; "Allowing…"; "Always on this site"; "Do not allow"; "Always on this site covers every {site} page. Both need one more check of your sign-in, once in 10 minutes."; "Checked {n} minutes ago. Allow once and Always on this site work without another check."; "Not checked. Allow once still waits."; "Allowed once on {host}."; "Always allowed on {site}. Change it in Settings, Passwords and IDs."; "Not allowed. Type it on the page yourself, then press Continue."; "Albatross could not record your answer. Try again." |
| Request card | "Add your sign-in for {site}"; "Add your {label}"; "Add your date of birth"; "Add an API key for {site}"; "Add…"; "Saved. Albatross can use it on {site}."; "Albatross has a sign-in for {site}"; "It uses the saved one on the next run."; "Open"; "Passwords and IDs is not on for your account yet." |
| Sign-in offer | "No sign-in is saved for {site}."; "Save a sign-in for {site}…"; "Saved. Press Continue, and Albatross signs in." |
| Composer notice | "This looks like a Social Security number. Albatross does not send it."; "This looks like a card number. Albatross does not send it, and it does not keep card numbers yet."; "This looks like an API key. Albatross does not send it."; "Save in Passwords and IDs"; "Send without it"; "[removed: looks like a Social Security number]" |
| Run log | "Signed in to {site} with your saved sign-in."; "Typed the {item} {field}."; "Did not type the {item} password: this page is {host}, not {site}."; "You typed the number on the page." |
| Announcements | "Saved {label}.", "Replaced the {label} values.", "Deleted.", "Added {site}.", "Removed {site}.", "Allowed once on {host}.", "Always allowed on {site}.", "Not allowed.", "Albatross asks: use your {item} on {host}?", "Albatross does not send this number. Save it in Passwords and IDs, or send without it." |
