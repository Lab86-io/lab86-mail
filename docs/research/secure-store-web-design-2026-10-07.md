# Passwords and IDs, web design note (2026-10-07)

Status: design only. No production code changed. The brief is `docs/albatross-secure-store.md`.
The contract is `lib/secure/contract.ts`. The thread rules are in `docs/albatross-thread.md`,
section "Cross-platform decisions". This note decides how the web surfaces look and behave. The
iOS and macOS notes decide their own surfaces.

> **Lead change, applied in this note (2026-10-07, late).** "Allow once" also needs the recent
> identity check. The rule: *a saved value never goes to a new place without a recent identity
> check.* "Do not allow" needs no check. One check opens a 10-minute window. Section 5 has the
> flow. The reason: with a stolen session, an attacker could start a run on their own site, press
> "Allow once", and get a saved number typed into their form.

Mockup: `/tmp/secure-store-mockup/index.html`. Rendered with Playwright at 1440×900, scale 2:

- Settings, "Passwords and IDs", the driver's license open: `/tmp/secure-store-mockup/settings.png`
  (full page) and `/tmp/secure-store-mockup/settings-dark.png`.
- The thread with an `allow_secure` run block: `/tmp/secure-store-mockup/allow.png` and
  `/tmp/secure-store-mockup/allow-dark.png`.
- The add sheet, a sign-in with the site filled in from a `secure_request` card (V12):
  `/tmp/secure-store-mockup/add.png`.

Render again with `node /tmp/secure-store-mockup/shoot.mjs settings,allow,add,settings-dark,allow-dark`.
The sample data is invented: Sam Rivera, 12 Elm Street, Springfield, IL 62704, 555 numbers,
"ends 4821", "sk-…f3a2", chase.com, dmv.ny.gov, api.openai.com, springfieldwater.gov.

## 0. The one sentence

Albatross uses a value, and no model ever sees it. Every screen in this note serves that
sentence: no reveal, no copy, each item limited to its sites, an identity check before a value
goes somewhere new, and a use history the user can read.

## 1. Research findings and the decision each one drives

### 1.1 Mobbin (web screens, images inspected)

| Screen | Taken | Rejected |
|---|---|---|
| Proton Pass, vault list ([screen](https://mobbin.com/screens/575a2bf8-bfdb-44b8-ae90-c84f3c384d40)) | A row is a title and one quiet line (the username). No value on the row. | The vault and folder rail. A split view with "No items selected". |
| NordVPN, credit cards list ([screen](https://mobbin.com/screens/3fba1b23-d205-41e7-8386-e6e954eb6f30)) | The "•••• 4444" grammar and a "Last used" read-out. | A category rail for a short list. |
| 1Password, item search ([screen](https://mobbin.com/screens/229f946c-def1-463e-8be3-8c67da56e663)) | Search exists only because the list is long. Ours is short: no search in PR 2. | Categories, tags, Watchtower. |
| PlanetScale, passwords table ([screen](https://mobbin.com/screens/b4879ccb-7689-483d-914c-0063ffc5e8ab)) | Nothing. | Usernames in clear text and a "Status" chip. We mask the username too. |
| Cloaked, identity detail ([screen](https://mobbin.com/screens/e37204c4-5508-4fe6-9a56-568c27daaea8)) | Label and value rows with the website at the top. | The eye icons that reveal a value. |
| Link, wallet card detail ([screen](https://mobbin.com/screens/52703ccd-1506-403e-93f4-d8a08531424d)) | "•••• 6008" plus a short verb list ("Update card", "Remove"). Ours is "Replace" and "Delete". | Card art. |
| Modal, secrets list ([screen](https://mobbin.com/screens/e11ade6b-7c86-4534-b83a-471f6f64263a)) | Name, created, last used. No value anywhere. | A full table for two items. |
| 1Password, item history ([screen](https://mobbin.com/screens/b73a0791-59c5-4846-8dfa-d7e46f26fd67)) | A history list with a time and an actor per row. | "Reveal Passwords" and "Restore Item". We keep no versions and never reveal. |
| NordVPN, password history ([screen](https://mobbin.com/screens/3ab1f7cb-3973-40df-aca8-a7ec54550525)) | Nothing. | Old passwords shown in clear text. |
| Proton Pass, item detail ([screen](https://mobbin.com/screens/e1dedc83-7827-4530-b5a2-098bf81663fe)) | "Last autofill", "Last modified", "Created" lines, and a websites list. | The password shown in clear with a copy button. |
| Uber Eats, security page ([screen](https://mobbin.com/screens/66cd171a-923d-4851-b9af-f156c756c918)) | The row grammar "Password · •••••••• · Last changed September 15, 2025". The one sentence that explains "Login activity". | A chevron on every row; we expand in place. |
| GitLab, authentication log ([screen](https://mobbin.com/screens/1c068392-6278-422a-ba0f-e23aef1ce223)) | Events written as sentences, with a relative time. | Nothing. |
| Zoho, "Verify your identity" ([screen](https://mobbin.com/screens/7c16e783-530c-4a82-a578-4dd305f3fa09)) | One sentence names the reason before the password field. Ours is said before Clerk's modal opens. | A full-page takeover. |
| Mistral, confirm this action ([screen](https://mobbin.com/screens/0d4c72d1-4a7f-4976-93f8-df77a57ab5fc)) | The reason sentence. | The full page. |
| Clerk, "Verification required" ([screen](https://mobbin.com/screens/bb56463f-9874-4232-95cb-f1a324da0f22)) | This is the modal we get from `useReverification`. It does not name our action. So our copy names it before the modal. | Nothing. |
| Dropbox Dash, security authentication ([screen](https://mobbin.com/screens/d70af6a6-060f-43d4-adf0-364c18f04a48)) | A visible Cancel. Our cancel path is designed, not an error. | Nothing. |
| Discord, confirm changes ([screen](https://mobbin.com/screens/29f4179b-9c4f-42f7-b858-47c83d814b2a)) | A small dialog with two buttons. | Nothing. |
| Buffer, Instagram consent ([screen](https://mobbin.com/screens/5f8785ac-b9b5-4c5c-97e7-9acacd0dbfaa)) | "X is requesting access to Y" names the requester and the subject. Our block names the host and the item. | Toggles inside a consent. |
| Zoom, "Allow persistent access" ([screen](https://mobbin.com/screens/0ef5b9e1-848d-42aa-a580-964b75d7cae8)) | Nothing. | A checkbox that makes an allow permanent. Ours is a separate, named button. |
| Perplexity, connector tool permissions ([screen](https://mobbin.com/screens/9bcf8755-5cb5-444c-aad1-2c42c3b4cb42)) | A standing permission lives in settings where it can be removed. Our sites list. | A grid of per-tool toggles. |
| Clerk, delete application ([screen](https://mobbin.com/screens/de2ed754-dcb1-4e66-867f-45c5f6c9ed41)) | The consequence sentence: "This will also delete your X". | Type the name to confirm. Our items are cheap to add again. |
| Cloudflare, delete worker ([screen](https://mobbin.com/screens/aa928ac1-4a1d-4b8c-9ccb-be35211cdca8)) | Nothing. | Type-to-confirm. |
| Lindy, delete workspace ([screen](https://mobbin.com/screens/9f1d4d52-a8f7-48b7-89e5-b113b6aa6419)) | Nothing. | The yellow warning box. |
| Tailscale, keys ([screen](https://mobbin.com/screens/c297c1a1-5541-444d-98f2-0df39369d55f)) | A prefix, created, expiry, and "Revoke". The line "Your private device keys are not included here" becomes our "No password is kept here." | Nothing. |
| ElevenLabs, API keys ([screen](https://mobbin.com/screens/6739c2c6-13ee-455c-b1a4-90933c2ffece)) | The "••••••••d8af" grammar. Ours is "sk-…f3a2". | The enable toggle. |
| Cohere, API keys ([screen](https://mobbin.com/screens/57fe2433-aebd-4d9d-bcbd-fe4063272b8d)) | Nothing. | The eye icon. |
| Rows, "visible this one time" ([screen](https://mobbin.com/screens/93cab127-e167-407f-8b9d-aa1aa40fa1e2)) | The show-once idea. For values the user already holds, it becomes "never again after you save". | The blue info box. |
| Proton Pass, empty vault ([screen](https://mobbin.com/screens/652c5aa3-fb65-44a9-87b0-5247bdf9765e)) | Nothing. | Five stacked buttons. We offer one "Add" and a menu. |
| NordVPN, "Let's get started" ([screen](https://mobbin.com/screens/a1977199-6c75-45ff-8698-666e35e5910a)) | Nothing. | An illustration and two buttons. |
| AirOps, secrets empty state ([screen](https://mobbin.com/screens/a9908ffe-7b94-408b-a7dd-dd85ee124425)) | The empty state explains the promise ("without exposing their values in logs or outputs"). Ours says it in plain words. | The boxed paragraph. |
| Gumloop, secrets empty state ([screen](https://mobbin.com/screens/ec30ac53-9843-40db-9197-192236e7da29)) | Nothing. | The plus icon in a circle. |

### 1.2 Reference products (Browserbase fetches)

- **1Password, "Closing the credential risk gap for AI agents using a browser"**
  ([blog, 2025-10-08](https://1password.com/blog/closing-the-credential-risk-gap-for-browser-use-ai-agents)).
  Principles: secrets stay secret, raw credentials never enter the LLM context, transparency on
  what the model can and cannot see, least privilege. Every credential request is approved by a
  person. When two logins match one site, the user is asked which one. Decisions: the allow block
  names the item and the host; the run log says which item it used, never the value; when two
  sign-ins match one site, the runner asks one `ask_form` choice (section 6.5).
- **1Password, "Use 1Password to sign in to websites with Claude"**
  ([support, 2026-09-28](https://support.1password.com/1password-claude/)). "1Password shows you
  exactly which item Claude is requesting, so you can approve, choose a different login to use, or
  deny." "Claude stops reading and tracking the website until 1Password reports back." "Claude only
  knows which login it used." Decisions: the scrub rule (the page text is replaced before the
  model reads it) and the receipt "Albatross can use it on springfieldwater.gov" (the model learns
  only that the item exists).
- **ChatGPT browser extension** ([docs, Markdown](https://learn.chatgpt.com/docs/chrome-extension.md)).
  Permission per website host: "Allow once", "Allow for this site", "Allow for all sites",
  "Decline". The allowlist is managed in settings; "Removing a domain from the allowlist means
  ChatGPT asks again." "Allow for all sites" carries an elevated-risk badge. Browser history "doesn't
  have an always-allow option". Decisions: no "all sites" option, ever. "Always on ny.gov" names the
  site in the button. "Remove" on a site means Albatross asks again next time.
- **ChatGPT Work, sign-in takeover** ([secondary write-up, 2026-08-26](https://anothernews.io/news/chatgpt-agent-login/);
  help.openai.com answered 403). The agent hands the cloud browser to the user at a sign-in wall;
  screenshots stop; cookies persist, "one sign-in per site". Decision: that is our existing
  "Saved sign-ins" feature. PR 2 adds the step beyond it, where Albatross types the password itself.
  The two rows must be named apart (section 2.3).
- **Claude in Chrome, permissions guide** ([support](https://support.claude.com/en/articles/12902446-claude-in-chrome-permissions-guide)).
  "Allow this action", "Always allow actions on this site", "Decline". With always-allow on, Claude
  still asks before "entering potentially sensitive information into a page". "Handling sensitive
  credit card or ID data" is blocked. Decisions: cards are refused by us too. ID numbers are typed,
  with an allow per site and an identity check (the owner's decision).
- **Clerk, reverification** ([docs](https://clerk.com/docs/guides/secure/reverification)). The
  default window is 10 minutes. `useReverification` wraps the fetcher; on the 403 body it opens its
  modal and retries. A cancel rejects with the reverification-cancelled error
  (`isReverificationCancelledError`). Reverification factors: password, email code, phone code.
  Decision: section 5.
- **Google Password Manager, Password Checkup** ([help](https://support.google.com/accounts/answer/9457609)).
  Warnings for exposed, weak, and reused passwords, with "Dismiss warning". Decision: out of scope
  for PR 2. A later "Checkup" row fits this tab (open question 7).
- **Zenity Labs, "PerplexedBrowser"** ([write-up, 2026-03-03](https://labs.zenity.io/p/perplexedbrowser-how-attackers-can-weaponize-comet-to-takeover-your-1password-vault)).
  A page can steer an agentic browser toward a password manager. Decision: page text is data, not
  an instruction; only the real page origin counts; an allow needs the identity check.
- Perplexity Comet help pages answered 403 (Cloudflare). No decision rests on them.

### 1.3 What the code already gives us (survey of the worktree)

- Settings tabs are three arrays plus two tests: `lib/albatross/teach-ui.ts:28-43`,
  `lib/albatross/settings-nav.ts`, `app/settings/page.tsx:95`. The new tab inserts after
  `personal`.
- `SettingsRow` (`components/settings/primitives.tsx`) takes `children` for full-width content
  under the row. Standing orders already expands rows this way. The item detail uses it.
- "Saved sign-ins" is mounted at `components/settings/StandingOrdersSection.tsx:163` under the
  group title "In the shared browser".
- `RunBlock` (`components/albatross/thread/RunBlock.tsx`) renders a handoff as headline, detail,
  then one action row. The allow block adds a reason line and a three-button row.
  `runBlockAction` in `lib/albatross/thread-view.ts` needs an `allow` kind.
- `readyForYouRows` (`lib/albatross/step-run-client.ts:318`) builds one line and one button per
  handoff. The allow handoff gets its line from `next.allow` and the label "Answer".
- `ShapeShell` and `ActionBar` (`components/ai-elements/shapes/shape-shell.tsx`) write an
  outcome in place in the accent-3 voice. The `secure_request` card uses that for "Saved".
- The composer (`components/shell/AIBar.tsx`) has a `before` slot above the textarea, where the
  Work chip renders. The paste notice renders there. The `onPaste` handler at `AIBar.tsx:1052`
  handles files only today.
- `Sheet` and `AlertDialog` exist in `components/ui`. The settings page already uses
  `AlertDialog` for account deletion.
- `tldts` is a dependency (`package.json:89`). The client can show the registrable domain under
  the site field as the user types, with the same library the server uses.
- `useReverification` is exported from `@clerk/nextjs`. The cancel error helper is
  `isReverificationCancelledError`.

## 2. Information architecture

### 2.1 The name

Keep **"Passwords and IDs"**. Alternatives considered:

- "Secure details": pairs with "Personal details", but it names a claim, not the contents. A user
  who looks for a password scans for the word "password".
- "Vault": jargon from password managers.
- "Sign-ins and IDs": loses keys.

Keys are the minority item. The tab description names them. Rail entry:

```
Passwords and IDs
What Albatross uses on sites and never shows.
```

### 2.2 Where it sits

In the "You" group, after "Personal details", before "Account". The two tabs are neighbours on
purpose: Personal details are facts the conversation may read and type; Passwords and IDs are
values nobody sees. The Personal details blurb changes from "It never keeps passwords, card
numbers, or ID numbers here." to "Passwords and ID numbers go in Passwords and IDs." with a link
to the tab.

### 2.3 "Saved sign-ins" becomes "Signed-in sites"

Today "Saved sign-ins" is a browser cookie context, not a password. Next to a "Sign-ins" group of
passwords the old name misleads. Decision:

- Rename the row to **"Signed-in sites"**. Move it from Standing orders into this tab, as the last
  group, under the title "In the shared browser".
- Row copy: label "Signed-in sites"; description "When you sign in to a site in the shared browser,
  the browser stays signed in for the next run. No password is kept here."; hint "Saved. Last
  used today." (the existing `savedSignInsHint`); button "Sign out everywhere" (was "Forget saved
  sign-ins").
- The two rows now read as two different things: what Albatross types, and what the browser
  remembers.

### 2.4 The page

Heading "Passwords and IDs". Blurb: "Albatross uses these on their sites: it signs in, fills a
form, or calls a service for you. A saved value never appears again, not here and not in a
conversation." Aside: "4 saved" (the item count), or "Nothing saved yet".

Three groups in a fixed order, each a `SettingsCard` under a `SettingsGroupTitle`:

1. **Sign-ins** (`sign_in`). Hidden when empty.
2. **IDs** (`id_number` items, then one fixed "Date of birth" slot). Always present, because of
   the slot.
3. **Keys** (`api_key`). Hidden when empty.

Then the add row, the note, and the "In the shared browser" group. Rows sort by label within a
group. No search in PR 2 (open question 6).

### 2.5 The item row

A `SettingsRow` that is also a disclosure button. Hover shows the control-hover fill. Click, Enter,
or Space expands it in place (section 4). One indicator: a 7 px chevron at the far right, the same
glyph the run log disclosure uses, rotated when open. No icon before the text.

| Kind | Label | Description line | Hint line |
|---|---|---|---|
| sign_in | the label ("Chase") | `chase.com · s…@example.com · ••••••••` | "Last used today, 9:12 AM" or "Not used yet" |
| id_number | `ID_NUMBER_LABELS[type]` ("Driver's license") | `New York · ends 4821 · expires June 2029` (facts, then hints) | last use, or "No sites yet. Albatross asks you the first time a site needs it." |
| date_of_birth | "Date of birth" | "Saved" or "Not saved" | same as id_number |
| api_key | the label ("OpenAI") | `api.openai.com · sk-…f3a2 · Authorization: Bearer` | last use |

Masked hints are a server rule; the client only displays `hints`:

- username: for an email, the first character, an ellipsis, and the domain (`s…@example.com`); for
  another username, the first and last characters (`s…a`); three characters or fewer, `•••`.
- password: `••••••••` always (eight dots, not the length).
- number: "ends 4821" (the last four). A number of six digits or fewer: "saved".
- expires: month and year ("June 2029"). The day stays hidden.
- name_on_id: "Saved".
- date: "Saved". `ageYears` is for the model only; the row never shows an age.
- key: the first three characters, an ellipsis, and the last four (`sk-…f3a2`) when the key has 16
  characters or more; otherwise `••••`.

The dots carry `aria-label="password saved"` so a screen reader does not read eight bullets.

### 2.6 Empty state and flag-off state

- **Nothing saved.** The IDs card shows the "Date of birth · Not saved · Add" slot. The add row
  reads "Add" with the hint "A sign-in, an ID, your date of birth, or a key." The aside says
  "Nothing saved yet". This is the Personal details pattern: fixed slots show "Not saved". No
  illustration.
- **Flag off** (`enabled: false` from `GET /api/secure-details`): the tab is absent from the rail,
  `?tab=secure` falls back to Personal details, the Personal details blurb keeps the PR 1 text, the
  composer notice keeps PR 1 behaviour (one action, "Send without it"), and the server does not
  register `secure_details_request`, so no card or allow block can appear.

## 3. Add flows

### 3.1 One add surface: the sheet

"Add" opens a `DropdownMenu` with four plain nouns: "Sign-in", "ID", "Date of birth" (hidden once
saved), "Key". Each opens a right-side `Sheet`, 440 px wide, title "Add a sign-in" / "Add an ID" /
"Add your date of birth" / "Add a key". The thread opens the same sheet from the `secure_request`
card and the sign-in handoff, with the site filled in. One surface, three doors.

The sheet footer: "Save" (primary, small), "Cancel" (ghost), and a right-aligned fine line
"Encrypted on the server. Never shown in a conversation." Escape closes the sheet and clears the
fields. Nothing is saved on close.

### 3.2 Masked inputs

The browser's own password manager must not learn the user's Chase password under
`mail.lab86.io`, and a third-party manager must not offer to fill it. Decision:

- Secret inputs are `type="text"` with `-webkit-text-security: disc`, not `type="password"`.
  Password managers key off `type="password"`; a text input is invisible to them.
- Attributes: `autocomplete="off"`, `autocapitalize="off"`, `autocorrect="off"`,
  `spellcheck="false"`, `data-1p-ignore`, `data-lpignore="true"`, `data-bwignore`,
  `data-protonpass-ignore`. `inputmode="numeric"` for a number and a date part.
- No `<form>` submit. The save is a `fetch`. The field state is cleared on success and on close.
- A "Show" text toggle sits inside the field while the user types (`aria-pressed`). There is no
  reveal after save, so the user must be able to check the typing. "Show" becomes "Hide".
- Help under the field: "Hidden as you type. After you save, you can replace it but not see it."
- Fallback: if `-webkit-text-security` is not available (check Firefox in verification), use
  `type="password"` with `autocomplete="new-password"` and keep the other attributes. Verify in
  Chrome, Safari, and Firefox that no "Save password?" bubble appears after Save (open question 2).
- Screen readers: `aria-describedby` points at the help line. The input is not announced as a
  password; the help line says the characters are hidden.

The username field is a normal text input with `autocomplete="off"` and the same ignore attributes,
because a manager would otherwise pair it with the masked field.

### 3.3 Fields by kind

Order, input, and copy. "Site" always comes first because it sets where the value may go.

**Sign-in**

| Field | Input | Help / validation |
|---|---|---|
| Site | text, `inputmode="url"`, placeholder "chase.com" | Live line under the field, from `tldts`: "Covers chase.com and its pages, such as secure.chase.com." Empty: "Type the site, such as chase.com." Not a domain: "That does not look like a site. Type a domain such as chase.com." |
| Label | text, placeholder "Chase" | "How it appears in your list." Defaults to the site without its suffix, capitalised ("Chase"), when left empty. |
| Username or email | text (section 3.2) | Empty: "Type the username or email." |
| Password | masked (section 3.2) | Empty: "Type the password." |

**ID**

| Field | Input | Help / validation |
|---|---|---|
| Type | `Select`: Driver's license, Passport, State ID, Social Security number, Other | Sets the label. "Other" adds a Label field. |
| State or province | text, shown for Driver's license and State ID; `region` | Optional. "Two letters are enough: NY." |
| Country | `Select`, shown for Passport; `country` (alpha-2) | Default "United States". |
| Number | masked, `inputmode` numeric for SSN, text otherwise | Empty: "Type the number." SSN: "Use nine digits." |
| Expiry date | the shared date field (`FormFieldInput` kind `date`), hidden for SSN | Optional. In the past: a warning, not an error: "This ID expired on June 3, 2024. You can still save it." |
| Name on the ID | text, prefilled from Personal details with the source line "From your details" | Optional. |

Under the fields, one line: "Albatross asks you the first time a site needs this ID." No site
field: IDs start with no sites (the brief).

**Date of birth**

| Field | Input | Help / validation |
|---|---|---|
| Date of birth | the shared date field | In the future or less than 13 years ago: "Check the date." (we do not say why). "Albatross can tell a form your age. It types the date only on sites you allow." |

**Key**

| Field | Input | Help / validation |
|---|---|---|
| Host | text, placeholder "api.openai.com" | The exact host, not the registrable domain: "Albatross calls this host only." A URL is reduced to its host. |
| Label | text, placeholder "OpenAI" | Defaults to the host's second label ("Openai") when empty; the user usually types a better one. |
| Key | masked | Empty: "Type the key." |
| Header | text, optional, placeholder "Authorization: Bearer" | "Leave empty to send the key as `Authorization: Bearer`. Type a header name, such as `x-api-key`, for another scheme." |

### 3.4 Site normalisation

The user types `https://secure.chase.com/login`. The live line says "Covers chase.com and its
pages, such as secure.chase.com." The saved site is `chase.com`. The server does the same with
`tldts` and private suffixes counted, so `dmv.ny.gov` becomes the site `ny.gov`. Where a site and
a host differ, the UI shows both: the site in the sites list, the host that asked in the run
block and in the history ("ny.gov · covers dmv.ny.gov"). A key keeps its exact host.

### 3.5 Refusals (V10)

Checked on the client before Save and on the server. The message sits under the field in the
danger voice. The sheet stays open; nothing is saved.

| Match | Copy |
|---|---|
| A card number (Luhn, 13 to 19 digits), in any field | "This looks like a card number. Albatross does not keep card numbers yet." |
| A label or type that says CVV, CVC, or security code, or a three- or four-digit value under such a label | "Albatross does not keep card security codes." |
| A label that says bank, routing, IBAN, or account, or a nine-digit ABA routing number | "Albatross does not keep bank or routing numbers." |
| A label that says 2FA, two-factor, backup, or recovery, or a value made of six- to eight-digit groups | "Albatross does not keep two-factor or recovery codes. Those stay with you." |

### 3.6 On save

`POST /api/secure-details` with the values. The response is the `SecureItemView` (no value). The
sheet closes, the list gains the row, and a toast says "Chase saved" (the label). The client
discards the typed values at once. No value ever comes back from the server, so the row shows
only hints and facts.

## 4. Item detail (the expanded row)

The row expands in place, on the paper (the card's elevated surface stays; the open row takes the
page colour to read as "open"). Four parts, top to bottom:

1. **Fields.** One line per secret field: label, hint, and "Replace" (text button, accent). Facts
   (type, region, country) are not editable here; they belong to the ID and change with "Replace"
   of the number.
   - "Replace" opens an inline masked input in the row with "Save" and "Cancel". Enter saves,
     Escape cancels. After the save, the hint updates ("ends 9930") and a toast says "Number
     replaced". The old value is gone. No identity check: a replace sends nothing anywhere new.
2. **Sites that may use it.** One line per site: the site, the scope word "Always", the covered
   host when the run gave one ("covers dmv.ny.gov"), and "Remove" (quiet text). Under the list: an
   input "A site, such as travel.state.gov", a small "Add" button, and the faint line "Asks you to
   confirm your sign-in first." A `sign_in` or `api_key` item shows its own site or host with no
   "Remove" when it is the only one.
   - "Remove": no check. Toast "ny.gov removed. Albatross asks again next time."
   - "Add": the identity check (section 5), then the site appears, toast "travel.state.gov added".
   - Empty (IDs): "No sites yet. Albatross asks you the first time a site needs it."
3. **Recent uses.** `GET /api/secure-details/[itemId]/uses`, newest first, ten rows, then "Uses
   are kept for 90 days." Columns: time (tabular), the site (and the host when known), the
   Albatross title (a link to the thread), the outcome. Outcome copy:

   | `outcome` | Copy | Voice |
   |---|---|---|
   | typed | "Typed the number" / "Typed the number and the expiry date" / "Signed in" (sign_in) | accent-3 |
   | sent | "Sent to api.openai.com" | accent-3 |
   | refused_site | "Refused: not one of its sites" | warning |
   | allowed_once | "You allowed it on ny.gov for one run" | muted |
   | allowed_always | "You allowed it on ny.gov from now on" | muted |
   | denied | "You did not allow it on ny.gov" | muted |

   Empty: "No uses yet."
4. **Actions.** "Rename" (quiet text) and "Delete" (danger text). Rename edits the label inline.
   Delete opens an `AlertDialog`:

   | Kind | Title | Body | Buttons |
   |---|---|---|---|
   | sign_in | "Delete Chase?" | "Albatross can no longer sign in to chase.com for you. A run that reaches the Chase sign-in page stops and asks you." | "Delete" (danger), "Cancel" |
   | id_number | "Delete your driver's license?" | "Albatross can no longer type the number on ny.gov. A form that asks for it waits for you." | same |
   | date_of_birth | "Delete your date of birth?" | "A form that asks for it waits for you." | same |
   | api_key | "Delete OpenAI?" | "Albatross can no longer call api.openai.com for you." | same |

   After the delete: the row is gone, toast "Chase deleted". No Undo: the value cannot come back.

Keyboard: the row header is a button with `aria-expanded`. Inside the open detail, Tab moves
through Replace, Remove, the site input, Add, the Albatross links, Rename, Delete. Escape on any
control collapses the row and returns focus to its header.

## 5. The identity check

### 5.1 The rule

A saved value never goes to a new place without a recent identity check. The check is Clerk's
reverification with a 10-minute window (`IDENTITY_CHECK_MINUTES`).

| Action | Check |
|---|---|
| "Allow once" in the run block | yes |
| "Always on {site}" in the run block | yes |
| "Add" a site in the item detail | yes |
| "Do not allow" | no |
| "Remove" a site, "Replace" a value, "Rename", "Delete", add a new item | no |
| A run types a value on a site already in the list | no (the place is not new) |

Why these and not more: a stolen session can already read nothing (no reveal). The remaining risk
is to send a value somewhere the user never chose. Each of the three checked actions does exactly
that; each unchecked action removes, replaces, or adds nothing that goes anywhere.

### 5.2 Before the check

The user must not be surprised by a password prompt. One quiet line, 11 px faint, under the
buttons: "To allow, confirm your sign-in once. The confirmation lasts 10 minutes." In the item
detail, next to "Add": "Asks you to confirm your sign-in first." Nothing else. No dialog of our
own before Clerk's.

### 5.3 During the check

The user presses "Allow once". The button reads "Confirming…" and the other two disable. The
client calls the answer route through `useReverification`. If the session's factor verification is
10 minutes old or less, the server answers 200 and section 5.4 applies at once; the user sees no
modal. Otherwise the server answers 403 with Clerk's body and `code: 'verify_identity'`; Clerk's
modal opens ("Verification required. Enter your current password to continue.", or the code
factor the account has). The block stays as it was behind the overlay.

### 5.4 After the check

Clerk retries the request. The block replaces its three buttons with a receipt line in the
accent-3 voice (section 6.3), the run continues as a "Continued" block, and the use history gains
a row. In the item detail, the site appears in the list with a toast. Focus returns to the control
the user pressed, which is now the receipt (a focusable `aria-live` region).

### 5.5 On cancel

The user closes Clerk's modal. `useReverification` rejects with the cancelled error. The block
stays exactly as it was: three buttons, enabled. Under them, one quiet muted line replaces the
faint line: "Not confirmed. Nothing was allowed." The run stays parked. In the item detail: "Not
confirmed. The site was not added." and the typed site stays in the input.

Any other failure: the danger voice, "Could not confirm. Try again." The buttons stay enabled.

### 5.6 Why one check per working session

Clerk's window is per session, not per action. The first "Allow" in a session opens the window;
further allows and site adds within 10 minutes pass with no modal. So the user sees the modal at
most once in a working session, and the quiet line can say "once".

## 6. The `allow_secure` run block (V6)

### 6.1 Anatomy

The run block in its handed-off state (`RunBlock.tsx`). Header: "Step 2 · Renew the registration
online · Needs your answer · 9:12" (the waiting tone). The collapsed log. The summary. Then the
handoff:

```
Needs your answer                                     (11.5 px, accent-3)
Use your driver's license number on ny.gov?           (14 px, medium)
dmv.ny.gov asks for the number and the expiry date. Albatross types them on the page.
They do not appear in this conversation.              (12.5 px, muted)
[Allow once]  [Always on ny.gov]  Do not allow        (primary, outline, ghost)
To allow, confirm your sign-in once. The confirmation lasts 10 minutes.   (11 px, faint)
```

See `allow.png`. The question names the site (`next.allow.site`); the reason line names the host
(`next.allow.host`) and the fields (`next.allow.fieldLabels`). Both are shown because they differ.

### 6.2 Copy by kind

`sign_in` and `api_key` never produce an allow block: a sign-in types only on its own site and a
key calls only its own host; anywhere else is refused (V7). The block exists for `id_number` and
`date_of_birth`.

| Kind, type | Question | Reason line (fields from `fieldLabels`) |
|---|---|---|
| drivers_license | "Use your driver's license number on ny.gov?" | "dmv.ny.gov asks for the number and the expiry date." |
| passport | "Use your passport number on state.gov?" | "travel.state.gov asks for the number, the expiry date, and the name on the ID." |
| state_id | "Use your state ID number on {site}?" | "{host} asks for the number." |
| ssn | "Use your Social Security number on {site}?" | "{host} asks for the number." |
| other | "Use your {label} on {site}?" | "{host} asks for the number." |
| date_of_birth | "Use your date of birth on {site}?" | "{host} asks for it." |

Every reason line ends with "Albatross types them on the page. They do not appear in this
conversation." ("types it" for one field). When the site and the host are the same
(`chase.com`), the reason line drops the host: "The page asks for the number."

### 6.3 The three buttons

Order and weight: **"Allow once"** (primary, first: the safe default that keeps the run moving),
**"Always on ny.gov"** (outline), **"Do not allow"** (ghost, last, the user's refusal, quiet like
"Dismiss"). The contract label "Always on this site" is the fallback when the site is longer than
24 characters.

After each answer the three buttons become one receipt line (accent-3 voice, `aria-live`):

| Answer | Receipt | Then |
|---|---|---|
| once | "Allowed once on ny.gov." | The run continues as a "Continued" block. The grant lasts for the run chain, 2 hours at most. |
| always | "Always allowed on ny.gov. Change this in Settings." ("Settings" links to the item) | The site appears in the item's sites. The run continues. |
| deny | "Not allowed on ny.gov." | The run resumes with the refusal. It either continues without the value or hands off "Your turn" with "Type the number yourself in the page, then press Continue." |
| cancel | none; section 5.5 | The block stays. |

No auto-focus on the buttons when the block appears: the thread's jump pill ("Albatross needs an
answer") brings the user to it. Enter or Space on a focused button answers.

### 6.4 In the Brief and in a notification

- **Brief, "Ready for you".** A row: the Work title, the step title, and the line "Albatross needs
  your answer: use your driver's license number on ny.gov?" One button, "Answer", opens the thread
  at the block. The three choices live only in the thread, because the identity check and the
  receipt belong there.
- **Push notification.** Lock-screen privacy: no site, no item kind, no field. Title "Albatross
  needs your answer". Body "Renew the car registration: a site asks to use one of your IDs. Open
  to answer." The app opens the thread at the block.

### 6.5 Two sign-ins for one site

Two Chase sign-ins exist. The runner cannot choose. It asks one `ask_form` choice: "Which Chase
sign-in?" with one option per item, each the username hint ("s…@example.com", "j…a"). This is the
1Password rule. No identity check: the site is already the item's own.

## 7. The `secure_request` card (V12) and the sign-in save offer (V13)

### 7.1 `secure_request`

A `ShapeShell` card (accent-2 border like every shape card). Title from the kind, summary from
`reason`, one text action.

| Kind | Title |
|---|---|
| sign_in | "Add your sign-in for springfieldwater.gov" |
| id_number | "Add your driver's license" (or the requested type) |
| date_of_birth | "Add your date of birth" |
| api_key | "Add your key for api.openai.com" |

| State | Card | Action |
|---|---|---|
| pending | title, the reason ("To pay the water bill, Albatross must sign in to your account.") | "Add" (opens the sheet with the site and label filled in), "Dismiss" (quiet) |
| sheet open | same | "Add" disabled |
| saved | the outcome in place, accent-3: "Saved. Albatross can use it on springfieldwater.gov." | none |
| dismissed | outcome "Dismissed." | none |
| already exists (`existingItemId`) | title "Your sign-in for springfieldwater.gov is saved", summary "Albatross can use it." | "Open in Settings" |
| flag off | the card never renders (the tool is not registered) | – |

The model learns only that the item exists. The HITL continuation sends `{ saved: true, itemId }`
or `{ saved: false }`; no value and no hint.

### 7.2 The sign-in handoff with `saveSignIn` (V13)

A `sign_in` handoff block as today ("Your turn", "Sign in to chase.com in the page, then press
Continue.", "Continue", "Dismiss") gains one inset row above the action row:

| State | Row | Action |
|---|---|---|
| pending | "Save a sign-in for chase.com, and the next run signs in by itself." | "Save a sign-in" (text, accent), "Not now" (quiet) |
| sheet open | same | disabled |
| saved | accent-3: "Sign-in for chase.com saved." The detail line changes to "Press Continue. Albatross signs in with the saved sign-in." | none |
| dismissed | the row hides | – |
| already exists | the row never renders | – |

After "Continue", the run checks the page. If the sign-in form is still there, it signs in with
the saved sign-in and logs "Signed in to chase.com with your saved sign-in". If the user already
signed in by hand, it continues.

## 8. The composer paste notice (V9)

### 8.1 Detection

`lib/secure/detect.ts`, shared by the client and the server backstop. Runs on paste (the pasted
text) and on send (the whole draft). Not on every keystroke.

| Kind | Pattern |
|---|---|
| Social Security number | `\d{3}[- ]\d{2}[- ]\d{4}` with a dash or space; or nine bare digits with "ssn", "social", or "security" within 40 characters |
| card number | 13 to 19 digits with spaces or dashes, Luhn valid |
| API key | a known prefix (`sk-`, `pk_`, `ghp_`, `xox`, `AKIA`) followed by 16 or more key characters; or 32 or more characters with upper case, lower case, and digits and no spaces |
| password | "password", "passcode", "pw", or "pin" followed by "is" or ":" and a token |

### 8.2 The notice

Renders in the composer's `before` slot, above the textarea: a bordered row on the elevated
surface, 12 px text, two text actions.

| Kind | Copy | Actions |
|---|---|---|
| ssn | "This looks like a Social Security number. Albatross does not send it." | "Save in Passwords and IDs", "Send without it" |
| card | "This looks like a card number. Albatross does not send it, and it does not keep card numbers yet." | "Send without it" |
| api_key | "This looks like a key. Albatross does not send it." | "Save in Passwords and IDs", "Send without it" |
| password | "This looks like a password. Albatross does not send it." | "Save in Passwords and IDs", "Send without it" |
| flag off | the same line | "Send without it" only |

- "Save in Passwords and IDs": opens the add sheet with the kind set and the value in its masked
  field. The draft loses the value: it is replaced by `[saved: Social Security number]`. After the
  save, the user sends the message; the model reads the token and knows the item exists.
- "Send without it": the value is replaced by `[removed: looks like a Social Security number]`
  and the message sends.
- The notice disappears on its own when the user deletes the match by hand.
- There is no "Send it anyway". The server backstop removes it regardless.

### 8.3 Keyboard

Enter in the textarea with a match present: the send is blocked, the notice appears, and focus
moves to its first action. Escape in the notice returns focus to the textarea with the draft
intact. Tab from the textarea goes to the composer controls as today; Shift+Tab reaches the
notice. The notice is `role="status"`, so a screen reader hears it when it appears.

### 8.4 The server backstop

A message that reaches the server with a match (an old app, a last-moment paste) is rewritten
before any model reads it and before it is saved. Both copies hold
`[removed: looks like a Social Security number]` in place of the value. In the transcript the
token renders inside the user bubble in the muted colour. No extra line, no toast.

## 9. Run log lines ("What Albatross did")

Simple past, no value, the item by its label or kind, the host by name.

| Event | Line |
|---|---|
| sign-in typed and checked | "Signed in to chase.com with your saved sign-in" |
| ID fields typed | "Typed your driver's license number and its expiry date on dmv.ny.gov" |
| date typed | "Typed your date of birth on dmv.ny.gov" |
| key sent | "Called api.openai.com with your OpenAI key" |
| refused for the site (V7) | "Did not type your Chase password: the page is on ny-dmv-renewals.com, not chase.com" |
| asked | "Asked you to allow your driver's license number on ny.gov" |
| allowed once | "You allowed your driver's license number on ny.gov for this run" |
| allowed always | "You allowed your driver's license number on ny.gov from now on" |
| denied | "You did not allow your driver's license number on ny.gov" |
| missing item (V12 from a run) | "No sign-in is saved for springfieldwater.gov. Asked you to add one" |
| two-factor code (V5) | "The site asks for a code. Your turn" |

## 10. The stories as screen states

**V1. Save a sign-in.** Settings, Passwords and IDs, "Add", "Sign-in". The sheet: Site "chase.com"
(live line "Covers chase.com and its pages, such as secure.chase.com."), Label "Chase", Username
"sam.rivera@example.com", Password masked. Save. Toast "Chase saved". Row: "Chase ·
chase.com · s…@example.com · •••••••• · Not used yet".

**V2. Save an ID.** "Add", "ID". Type "Driver's license", State "NY", Number masked, Expiry date
June 3, 2029, Name on the ID prefilled "Sam Rivera · From your details". Save. Row: "Driver's
license · New York · ends 4821 · expires June 2029 · No sites yet. Albatross asks you the first
time a site needs it." Then "Add", "Date of birth": the date field, Save; the slot reads "Date of
birth · Saved".

**V3. Save an API key.** "Add", "Key". Host "api.openai.com", Label "OpenAI", Key masked, Header
empty. Row: "OpenAI · api.openai.com · sk-…f3a2 · Authorization: Bearer".

**V4. Never shown again.** The open row shows "Number · ends 4821 · Replace". There is no
"Show", no "Copy". "Replace" opens an empty masked input. "Delete" opens the dialog of section 4.

**V5. A run signs in for me.** The run block log: "9:12 Opened secure.chase.com", "9:12 Signed in
to chase.com with your saved sign-in". No block, no question. When the site asks for a code:
handoff "Your turn", detail "Enter the code that chase.com sent you, then press Continue.",
buttons "Continue", "Dismiss".

**V6. A new site asks first.** See `allow.png` and section 6. Press "Allow once": "Confirming…",
Clerk's modal, then the receipt "Allowed once on ny.gov." and a "Continued" block whose log reads
"9:13 Typed your driver's license number and its expiry date on dmv.ny.gov".

**V7. A wrong site never gets it.** The run block summary: "The page on ny-dmv-renewals.com asked
for your Chase password. Albatross did not type it: that site is not chase.com." The log line of
section 9. Handoff "Your turn", detail "Check this site before you continue. It is not chase.com."
The item's history gains "Refused: not one of its sites" in the warning voice.

**V8. Use history.** The "Recent uses" list of section 4, as in `settings.png`.

**V9. I paste a secret in the chat.** The composer notice of section 8 above the textarea. "Save
in Passwords and IDs" opens the sheet "Add an ID" with Type "Social Security number" and the
number in the masked field; the draft reads "my number is [saved: Social Security number]".

**V10. Cards wait.** The sheet's Number field with a card number: the danger line "This looks like
a card number. Albatross does not keep card numbers yet." Save does nothing until the field
changes.

**V11. Delete my account or export my data.** The Account tab's delete dialog gains one sentence:
"This also deletes your passwords, IDs, and keys." The export's "Passwords and IDs" section lists
each item's kind, label, sites, created, and last used. No value and no hint.

**V12. Albatross asks for a missing secret.** The chat answers "No sign-in is saved for
springfieldwater.gov." and shows the card "Add your sign-in for springfieldwater.gov · To pay the
water bill, Albatross must sign in to your account. · Add". "Add" opens `add.png`. After Save the
card reads "Saved. Albatross can use it on springfieldwater.gov." and the chat continues: "Saved.
I will sign in and open the bill."

**V13. Save a sign-in from a handoff.** The sign-in handoff block with the inset row "Save a
sign-in for chase.com, and the next run signs in by itself. · Save a sign-in · Not now". After
Save: "Sign-in for chase.com saved." and the detail "Press Continue. Albatross signs in with the
saved sign-in."

### 10.1 State matrix: the item row

| State | Label | Description | Hint | Right |
|---|---|---|---|---|
| closed | label | sites · hints | last use, or the no-sites line | chevron |
| open | same | same | same | chevron rotated; the detail below |
| loading uses | same | same | same | "Loading…" in the Recent uses section |
| busy (replace, remove, add, rename, delete) | same | same | same | the pressed control reads "Saving…", "Removing…", "Confirming…", "Deleting…" |
| error | same | same | the message in the danger voice under the control that failed | – |

### 10.2 State matrix: the item detail

| Part | Idle | Editing | After |
|---|---|---|---|
| a secret field | hint, "Replace" | masked input, "Save", "Cancel" | new hint, toast "Number replaced" |
| a site line | site, scope, "Remove" | – | the line is gone, toast "ny.gov removed. Albatross asks again next time." |
| add a site | input, "Add", the faint line | "Confirming…"; Clerk's modal | the site appears, toast "travel.state.gov added"; or "Not confirmed. The site was not added." |
| the label | "Rename" | inline input, "Save", "Cancel" | the row label updates |
| delete | "Delete" | the dialog | the row is gone, toast "Chase deleted" |

### 10.3 State matrix: the allow block

| State | Question and reason | Buttons | Line under the buttons |
|---|---|---|---|
| pending | shown | "Allow once", "Always on ny.gov", "Do not allow" | "To allow, confirm your sign-in once. The confirmation lasts 10 minutes." |
| confirming | shown | the pressed one reads "Confirming…"; the others disabled | same |
| cancelled | shown | all three, enabled | "Not confirmed. Nothing was allowed." (muted) |
| failed | shown | all three, enabled | "Could not confirm. Try again." (danger) |
| allowed once | shown, muted | receipt "Allowed once on ny.gov." | – |
| allowed always | shown, muted | receipt "Always allowed on ny.gov. Change this in Settings." | – |
| denied | shown, muted | receipt "Not allowed on ny.gov." | – |
| superseded (the run ended another way) | shown, muted | "No longer open" | – |

### 10.4 State matrix: the request card

See section 7.1.

## 11. Accessibility, keyboard, dark mode, motion

- **Never a value aloud.** Hints are the only text. Dots carry `aria-label="password saved"`.
  "ends 4821" reads as written: it is a hint, not the number. Masked inputs have the help line as
  `aria-describedby`; "Show" is a toggle with `aria-pressed`.
- **Focus order.** Settings: group by group, row header (a button with `aria-expanded`), then the
  open row's controls in reading order. The sheet traps focus; the first field gets focus on open;
  Escape closes and returns focus to "Add". The allow block: the three buttons in order; after an
  answer, focus lands on the receipt. Clerk's modal returns focus to the pressed button.
- **Keyboard only.** Every action is a button or an input. The row header opens with Enter or
  Space. The inline Replace saves with Enter and cancels with Escape. The notice is reachable with
  Shift+Tab from the textarea.
- **Screen reader names.** The row header: "Driver's license, New York, ends 4821, expires June
  2029, last used today, collapsed". The allow group: `role="group"` named by the question. The
  receipt and the cancel line: `aria-live="polite"`.
- **Dark mode.** Only tokens. `settings-dark.png` and `allow-dark.png` show the result: the open
  row uses the paper colour, the warning voice stays readable, the primary button uses the dark
  accent with its dark foreground.
- **Reduced motion.** The sheet fades instead of sliding. The row expands with no height
  animation. No shimmer on the allow block (it is not a working state).
- **Contrast.** The faint line under the buttons (11 px, `--color-text-faint`) is decorative help;
  the same fact is in the heading blurb of the settings tab, so the faint contrast is acceptable.

## 12. Mockup

- `/tmp/secure-store-mockup/index.html`, screens `settings`, `add`, `allow`; `&dark=1` for dark.
- `/tmp/secure-store-mockup/settings.png`, `settings-dark.png`: the tab with Chase, the open
  driver's license (fields, sites with the add input, three history rows, Rename and Delete), the
  date of birth slot, the OpenAI key, the add row, and "Signed-in sites".
- `/tmp/secure-store-mockup/allow.png`, `allow-dark.png`: the thread "Renew the car registration
  before October 31", a done Step 1 with its proof line, the Step 2 allow block, the page pane
  paused on the renewal form.
- `/tmp/secure-store-mockup/add.png`: the sheet "Add a sign-in" with the site filled in.
- Iterations: the first render put the mock site's required marks into field boxes (a selector
  bug), wrapped a history site, and claimed a count the browser-context API does not report;
  all fixed. "Name" in the sheet became "Label" because it sat above "Username".

## 13. Open questions for the lead designer

1. **Move "Saved sign-ins" into this tab as "Signed-in sites" (section 2.3).** Recommendation:
   yes. The old name next to a "Sign-ins" group misleads. The move is a copy change and one mount;
   iOS and macOS mirror it.
2. **Masked inputs as text with `-webkit-text-security`.** Recommendation: yes, with the
   `type="password"` fallback, and a three-browser verification that no "Save password?" bubble
   appears. If Firefox lacks the property, the fallback stands for Firefox only.
3. **"Always on ny.gov" in the button label instead of "Always on this site".** Recommendation:
   yes; it names the scope the user grants, which differs from the host that asked. The contract
   label stays as the fallback for long sites.
4. **The date of birth as a fixed slot.** Recommendation: yes, like Personal details. The Social
   Security number is not a slot: it is added on purpose through "Add", "ID".
5. **Identity check on "Replace".** Not needed by the rule (nothing goes anywhere new).
   Recommendation: leave it out; add it later only if a sabotage case appears.
6. **Search or a filter in the list.** Recommendation: none in PR 2; add a filter field when a
   group passes twelve items.
7. **A "Checkup" row later** (expired IDs, a sign-in never used, a key with no use in 90 days).
   Recommendation: later, in this tab, under the groups.
8. **The push notification says "one of your IDs" and no site.** Recommendation: keep it that
   quiet; the thread has the detail.
9. **Export without hints.** Recommendation: kind, label, sites, dates only. A hint is derived from
   the value.
10. **Two sign-ins for one site** (section 6.5). The runner asks one choice. This is runner
    behaviour and belongs to the server design; the web side only renders the `ask_form`.
11. **`SecureItemView.sites` carries no source or date.** The sites list cannot say "Allowed in a
    run on Oct 7". Recommendation: acceptable for PR 2; the history has the date.
