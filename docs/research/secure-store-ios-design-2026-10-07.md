# Passwords and IDs, iOS design note (2026-10-07)

Status: built on 2026-10-08 in `apps/ios` on branch `claude/secure-store`. The lead decisions in
`docs/albatross-secure-store.md` ("Cross-platform decisions (lead review, 2026-10-08)") override
this note where they differ. The code follows them:

- The sheet title is "One more check" (decision 9). No "confirm" or "verify" in any line.
- The second button reads "Always on {site}", with "Always on this site" for a long site
  (decision 10). The question names the site; the reason names the host.
- "Allow once" needs the identity check too (the lead decision of 2026-10-07, below).
- The ask card is the HITL tool `ask_secure_detail` (decision 12); the capability goes in
  `clientCapabilities`.
- "Show" shows fresh input while the user types a password or a key (decision 6).
- Return while the notice shows sends without the value, with the marker in the text
  (decision 14).
- No age floor on the date of birth; one date of birth for each user (decision 4).
- The username hint shows in the row and the detail (decision 3).
- The fallback when this device cannot do the check is "Open on the web" (decision 8).

The component names of section 11 are the file names in the code. The Mac designer's notes are
in the build report, not here.

This note decides how the secure store (`docs/albatross-secure-store.md`, PR 2) looks and
behaves on iPhone and iPad. The contract is `lib/secure/contract.ts`. The thread it lives in is
PR 1 (`docs/albatross-thread.md`, decisions 1 to 19). The earlier iOS note,
`albatross-thread-ios-design-2026-10-07.md`, stays valid for the thread; this note adds to it.

The macOS designer reads this note too. Section 11 says which views are shared and which stay
on iOS.

One rule governs every screen here: **Albatross uses a value, and no model ever sees it.** The
app shows labels, sites, masked hints, and uses. It never shows a saved value. The user
replaces a value or deletes the item.

> **Lead decision (2026-10-07, after the brief).** "Allow once" also needs the recent identity
> check (10 minutes), the same as "Always on this site" and "Add a site". The rule: **a saved
> value never goes to a new place without a recent identity check.** "Do not allow" needs no
> check. One check opens a 10-minute window. The reason: with a stolen session, an attacker
> could start a run on their own site and press "Allow once". This note follows the new rule;
> where `docs/albatross-secure-store.md` says "Allow once needs none", this note wins.
>
> Two server facts: the server answers 403 `{ code: 'verify_identity' }` with Clerk's
> reverification body when the check is needed; and a site for sign-ins and IDs is the
> registrable domain with private suffixes counted (`dmv.ny.gov` is on the site `ny.gov`), so
> screens show both the site and the host that asks. An API key keeps its exact host.

Every name, number, and site in this note is invented ("Sam Rivera", 555 numbers,
"ends 4821", `chase.com`, `dmv.ny.gov`, `api.openai.com`, `springfieldwater.gov`).

## 1. Research findings

### 1.1 ClerkKit verdict: yes, the SDK supports session reverification

Source: `gh api` on github.com/clerk/clerk-ios (releases, source at HEAD), the Clerk docs
(`clerk.com/docs/ios/reference/native-mobile/auth.md`, `clerk.com/docs/guides/secure/reverification`,
`clerk.com/docs/guides/sessions/session-tokens.md`), and the Frontend API spec
`fapi/2026-05-12.yml` in clerk/openapi-specs.

- The latest release is 1.6.1 (2026-10-07). The app pins `from: 1.3.3`
  (`apps/ios/project.yml`), and `Package.resolved` holds 1.3.3.
- Session verification arrived in 1.1.4 (PRs #433 and #456, 2026-06). **The pinned 1.3.3 has
  the whole first-factor flow.** The methods live in
  `Sources/ClerkKit/Domains/Auth/Session/Session+Verification.swift`:

  ```swift
  @discardableResult @MainActor
  public func startVerification(level: SessionVerification.Level) async throws -> SessionVerification
  public func sendEmailCode(emailAddressId: String) async throws -> SessionVerification
  public func verifyWithEmailCode(code: String) async throws -> SessionVerification
  public func sendPhoneCode(phoneNumberId: String) async throws -> SessionVerification
  public func verifyWithPhoneCode(code: String) async throws -> SessionVerification
  public func verifyWithPassword(_ password: String) async throws -> SessionVerification
  public func verifyWithPasskey(preferImmediatelyAvailableCredentials: Bool = true) async throws -> SessionVerification
  public func verifyWithTOTP(code: String) async throws -> SessionVerification
  public func verifyWithBackupCode(code: String) async throws -> SessionVerification
  ```

  `SessionVerification` carries `status` (`.needsFirstFactor`, `.needsSecondFactor`,
  `.complete`), `level`, `supportedFirstFactors`, and `supportedSecondFactors`. The methods map
  one to one on the Frontend API `POST /v1/client/sessions/{id}/verify`,
  `/verify/prepare_first_factor`, and `/verify/attempt_first_factor`. If the user has no second
  factor, the server downgrades a request to `first_factor`.
- Later versions add the local pre-check and biometrics: 1.5.3 adds
  `Session.factorVerificationAge`, `session.checkAuthorization(reverification:)`, and
  `Clerk.has(reverification: .custom(level: .firstFactor, afterMinutes: 10))`; 1.5.5 adds
  `verifyWithBiometrics(reason:level:)` and reads the JWT `fva` claim
  (`TokenResource.factorVerificationAgeClaim`); 1.5.8 and 1.6.1 contain breaking changes
  (`has()` call shapes; organization, enterprise connection, and session actor decoding).
- **Clerk ships no reverification UI for iOS.** `ClerkKitUI` has no `UserVerificationView`, and
  `AuthView` has no verification mode. The reverification guide shows only React code for the
  client. The app builds its own sheet (section 5).
- The session JWT (v2) carries `fva: [firstFactorAgeMinutes, secondFactorAgeMinutes]`, with
  `-1` for a factor the user has not enrolled. After a verification, the SDK does not refresh the
  cached token by itself (only the biometric path does). The app must call
  `session.getToken(.init(skipCache: true))` once, then retry the request. The app's own token
  path, `ClerkSessionAccess.activeToken` (`Core/Authentication/SessionStore.swift`), uses the
  default options and returns the cached token for up to 60 seconds; the retry needs the fresh
  one.
- One boundary detail: Clerk passes when `afterMinutes > age`; the server rule in the brief is
  "10 minutes or less" (`age <= 10`). The server should mirror Clerk (`age < 10`) so a local
  pre-check and the server agree (open question 9).

Decisions this drives:

1. **iOS offers "Allow once", "Always on this site", and "Add a site" in full.** All three go
   through one native identity sheet (section 5). With the lead's new rule, an iOS user with
   no reverification could never allow a new site on the phone; the SDK removes that risk.
   Section 5.5 designs the fallback for the case where a verification cannot complete.
2. **Stay on 1.3.3 for PR 2.** The verify methods are there. The 403 from the server is the
   signal; a local pre-check (1.5.3+) saves one round trip and nothing else. A bump to 1.6.x
   is a separate change with its own CI run, because no local compiler exists
   (`native-verify-without-mac.md`): breaking changes in 1.5.8 and 1.6.1 can touch sign-out and
   session decoding.
3. **Phase 2, after the bump: Face ID as the identity check.** `verifyWithBiometrics` is a real
   Clerk first factor, so Face ID can satisfy the server rule. It needs an enrolled biometric
   credential (`.biometryCurrentSet`) and native biometric sign-in on the Clerk instance. Open
   question 7.
4. **No local Face ID gate on the section** (section 1.5).

### 1.2 1Password and Browserbase, "Secure Agentic Autofill" (2025-10-08)

Sources: 1password.com/blog/closing-the-credential-risk-gap-for-browser-use-ai-agents,
1password.com/press/2025/oct/browserbase-ai-security-partnership,
browserbase.com/blog/1password-agentic-autofill, support.1password.com/1password-claude-security/.

- The credential travels on an end-to-end encrypted channel (Noise protocol) from the approving
  1Password device to the 1Password extension in the remote browser. The extension fills the
  page. "The AI agent and underlying LLM never need to see nor handle the credentials."
- Every request asks a human. "There are no standing approvals: a new agent session means a
  new prompt." The prompt shows which item the agent asks for; the user approves, picks another
  item, or denies.
- The agent's stated reason is "treated as an untrusted claim" and shown as plain text.
- Site match is strict: an item fills only a page that matches the websites saved on it.
- Every grant goes to the item's usage history, with an audit event category
  "Vault item agentic autofill".
- Caveat: the public Browserbase quickstart for 1Password still resolves the password in code
  and passes it to `stagehand.act("Type in the password: ...")`. That path shows the secret to
  the model. Our `browser_type` reference design (`{{secure:<id>.<field>}}`) is the correct
  shape.

Decisions: the `secure_request` card shows the model's `reason` as quiet secondary text under
our own fixed title, never as the title (section 7). The use history records every grant and
every refusal, not only the uses (section 4). The site rule stays strict and is never a choice
the user makes per item. Our "Allow once" with an identity check is close to 1Password's
per-request human approval; "Always on this site" goes one step further and is a deliberate
owner decision for IDs. Sign-ins and keys have their sites as the standing grant.

### 1.3 Apple: secret text input

Sources: developer.apple.com/documentation/uikit/uitextcontenttype,
.../security/enabling-password-autofill-on-a-text-input-view,
.../security/about-the-password-autofill-workflow, .../swiftui/securefield,
.../uikit/uitextinputtraits/issecuretextentry, .../swiftui/view/privacysensitive(_:),
.../swiftui/protecting-sensitive-content-when-screen-sharing,
developer.apple.com/design/human-interface-guidelines/text-fields and /entering-data.

- `.password` is for a sign-in; `.newPassword` is for a new or changed password and is what
  triggers the Strong Password suggestion. `passwordRules` is read only with `.newPassword`.
  An untagged secure field falls to heuristics. Decision: **the sign-in password field is
  `SecureField` with `.textContentType(.password)`**, next to a `.username` field. iOS then
  offers the Passwords key in the keyboard bar, so a user can fill from Apple Passwords, and
  never offers to invent a password. The API key field has no content type.
- `SecureField` hides the dots in a screenshot and blocks cut and copy. `isSecureTextEntry`
  "in some cases" blocks recording of the text. Decision: passwords and keys are `SecureField`
  with a live length caption ("14 characters"), so a paste can be checked without a reveal.
- `.privacySensitive()` only marks a view for `.redacted(reason: .privacy)`. It blocks nothing
  by itself. Apple's screen-sharing guide says to observe `isSceneCaptured` and swap in redacted
  content; "The Passwords app uses a similar pattern." No public API blocks screenshots.
  Decision in section 12.
- HIG: use a secure field for sensitive data; never prepopulate a password field. Decision: the
  V12 card prefills the site, never a secret.

### 1.4 Apple: hidden notification previews

Sources: developer.apple.com/documentation/usernotifications/unnotificationcategory/hiddenpreviewsbodyplaceholder,
.../unnotificationcategoryoptions, support.apple.com/guide/iphone/change-notification-settings-iph7c3d96bab/26/ios/26.

- The user setting is Show Previews: Always, When Unlocked (default), Never.
- `UNNotificationCategory(identifier:actions:intentIdentifiers:hiddenPreviewsBodyPlaceholder:options:)`
  sets the text the lock screen shows when previews are hidden. `.hiddenPreviewsShowTitle`
  and `.hiddenPreviewsShowSubtitle` show the title or subtitle even then.
- Decision: the `allow_secure` push uses a category `secureAllow` with placeholder
  "Albatross needs an answer." and no `.hiddenPreviewsShowTitle`, because the title carries the
  step title ("Pay the court fine"). No banner actions: a grant from a lock screen has no
  context and no identity (section 6).

### 1.5 Apple: LocalAuthentication, and the Passwords app

Sources: developer.apple.com/documentation/localauthentication/lapolicy/deviceownerauthentication,
.../lacontext/evaluatepolicy(_:localizedreason:reply:), .../bundleresources/information-property-list/nsfaceidusagedescription,
support.apple.com/en-is/104955.

- `.deviceOwnerAuthentication` tries biometry, then the passcode. The reason string must not
  include the app name. `NSFaceIDUsageDescription` is required. The Passwords app unlocks with
  Face ID, Touch ID, or the passcode.
- Decision: **no local Face ID gate in PR 2.** The section shows no value, so a gate protects
  nothing that the "no reveal" decision does not already protect. A local check cannot satisfy
  the server's `fva` rule, so it would look like security and be none. It would add a TCC
  prompt and an Info.plist key. If the owner wants the Passwords-app feel, a "Require Face ID
  to open" switch is a later, separate change (open question 8).

### 1.6 Mobbin screens (iOS)

Each row names the screen, what the screen does, what the design takes, and what it rejects.

| Screen | What it does | Taken | Rejected |
|---|---|---|---|
| [1Password, item detail](https://mobbin.com/screens/2a538f7a-7027-448f-9d77-7d0a38555c0c) | Labelled rows: username, password as dots with a strength ring, website, notes, tags; created and modified dates at the bottom. | Labelled rows in groups. The dates at the bottom. | The "…" menu that reveals. The strength ring (nothing to measure). Notes and tags. |
| [1Password, item menu](https://mobbin.com/screens/cccd2ecc-e204-4182-9da1-481465029ebb) | A long menu with Delete at the end. | Delete last, in red. | A menu. Ours is one row at the bottom of the detail. |
| [1Password, autofill behaviour](https://mobbin.com/screens/f9b30a8c-e24e-4c7c-80ab-8adebf00d466) | "Fill anywhere on this website", "Only on this exact domain", "Never on this website", per website row. | The site is a property of the item, shown as its own row. | The three-way choice. We fix the rule: registrable domain for sites, exact host for keys. |
| [1Password, new login](https://mobbin.com/screens/0c5f33dc-a81d-4f76-a70e-c8e3bf58dbe1) | Username and password in one group; the password in clear while typed; the Passwords key in the keyboard bar. | Username and password in one group. The Passwords key (from `.password`). | The clear password. Ours is a secure field with a length caption. "Create a New Password". |
| [1Password, website suggestions](https://mobbin.com/screens/efd32530-10b9-4d2f-a195-8c534232a9d5) | A list of common sites while the user types a website. | Nothing. | A site catalogue. The V12 card prefills the site instead. |
| [1Password, create a login (flow)](https://mobbin.com/flows/cd57caf7-7cab-4d4b-ae70-d000d973f8a6) | Title, username, password, website, "add another website", notes, tags, in 26 screens. | Cancel and Save in the navigation bar. "Add a site" as a row under the sites. | The vault picker, notes, tags, the icon chooser. |
| [Google, passwords list](https://mobbin.com/screens/3bc66bef-6e21-454e-8e87-a36960092d41) | Rows of site over username, with a favicon; "Add a new password" inside the list. | The add row inside the list. Site over account in one row. | Favicons on a security surface. Search for a list of ten. |
| [Opera, password detail](https://mobbin.com/screens/a225040f-c244-4cd1-94a6-72fa447054bd) | Site, username, and a password field with an eye. | Nothing. | The eye. No reveal, anywhere. |
| [Obsidian, Keychain empty](https://mobbin.com/screens/cfbd9d9b-11c4-47e5-be5b-862efbed06a8) | One sentence: what secrets are, and who uses them. | The empty state is one sentence and the add rows. No illustration. | Nothing. |
| [Obsidian, Keychain row](https://mobbin.com/screens/8137c9be-ffdb-453a-80eb-7157bfaa0b0d) | "secret · Never accessed" with edit and trash icons. | "Not used yet" on a row that no run has used. | Icons on the row. |
| [Obsidian, add secret](https://mobbin.com/screens/07abea26-f358-4d6e-8d96-b3dd9ab41abd) | ID and Secret, two fields, Save and Cancel. | The two-field key sheet. | The eye toggle. |
| [Matter, API token](https://mobbin.com/screens/5540db4f-bc78-46ff-ae97-e7086fcb57e5) | "mat_48b603..." with Show Token and Regenerate. | The prefix-and-ellipsis hint form ("sk-…f3a2"). | Show Token. |
| [Binance, anti-phishing code](https://mobbin.com/screens/d891e95f-5c83-4a26-ab16-4371f08342c9) | "Mo**" with an eye; "Change" as the only action. | A partial hint is enough to recognise an item. "Replace" as the only change. | The eye. |
| [Deel, sensitive info](https://mobbin.com/screens/a0a07d60-37f7-4f64-87bc-331e9311299c) | A global Visible or Hidden switch. | Nothing. | A reveal switch. |
| [CLEAR, passport vault](https://mobbin.com/screens/6d34748e-dba6-4891-8eea-40ec8ff9f446) | Passport number, issuance date, expiry, each blurred with a copy control; a flag for the country. | The facts of an ID as rows: type, country or state, expiry. | Copy controls. A card picture. |
| [CLEAR, ID type menu](https://mobbin.com/screens/d289f323-3716-48ed-a4fa-8f10b7da5771) | A menu of ID kinds. | "Add an ID" is a menu of the five types, so the sheet opens with its title set. | The pill style. |
| [Turo, driver's license](https://mobbin.com/screens/911d851c-9207-45af-aab5-b805efcd538d) | Country, state, three name fields, number, date of birth, expiry; "exactly as it appears on your license". | The field order: state, number, expiry, name. The "as it appears on the license" line. | Scan to fill (later). Date of birth inside the license (ours is its own item). Three name fields. |
| [DoorDash Dasher, background check](https://mobbin.com/screens/b0a0daa4-66a7-4808-90ad-e0196a3c3c55) | License number with an inline error, confirm fields, SSN with "000-00-0000", a "Why do you need this?" line. | The `000-00-0000` prompt. The inline error under the field. | Confirm fields. The user sees the number while typing instead. |
| [State Farm, license info](https://mobbin.com/screens/9e60a5b7-5eea-4e84-b8a5-9c5efe364984) | Number and state, then Save. | The minimum: number and state. | The scan button (later). |
| [CRED, location prompt](https://mobbin.com/screens/08e41e83-2a85-4af5-b89c-829e58b04d2a), [Squarespace](https://mobbin.com/screens/8ce1519b-51b4-44ed-a27c-5645486cf111) | "Allow Once", "Allow While Using App", "Don't Allow", with the app's reason under the title. | The order: once, standing, deny. The reason line under the title. | A system alert. Ours is inline in the run block and names the site. |
| [Cleo, verify identity](https://mobbin.com/screens/d5d656cd-d2d9-430e-847c-e9a75cb0cb4b) | A short sheet: one line, one field, one button. | The shape of the identity sheet. | Date of birth as proof of identity. It is a secret in our store. |
| [Afterpay, confirm Face ID](https://mobbin.com/screens/ec5505af-4d36-417d-9911-692785f66fe6) | One sentence says what the check authorises. | The sentence that says what the check lets Albatross do. | Face ID itself (phase 2). |
| [Brave, delete sync account](https://mobbin.com/screens/1cda0c93-6eff-4e74-96c6-73660aa8c866) | The dialog says what the deletion does and does not do. | The "can no longer" sentence in the delete confirmation. | Three paragraphs. Ours is two sentences. |
| [Bluesky, app passwords](https://mobbin.com/screens/6ac94646-6b16-4e41-9406-4d3fa32d2065) | Name, created date, and one consequence line per row. | One consequence line in the delete dialog. | The trash icon on the row. |
| [Cash App, passkeys](https://mobbin.com/screens/4b03df3b-1aba-4d51-936e-5b22435c46af) | "Added on Jul 19, 2026" with "Remove". | "Remove" for a site row. "Delete" is for the item. | Nothing. |
| [Whatnot, passkey](https://mobbin.com/screens/5681c8b0-3cf1-4011-a7c9-efaff07f6017) | "Last used: Apr 7, 2026" on the row. | "Used Oct 5" as the row caption. | Nothing. |
| [Yahoo Finance, recent activity](https://mobbin.com/screens/58c1de3e-56c9-499e-8a38-bad6ad447257) | One sentence per event with a relative time. | One sentence per use. | Lock icons before text. |
| [Marcus, login history](https://mobbin.com/screens/f13581d0-762d-4167-ad6d-f91eafdd873d) | Absolute date and time per row. | Absolute times in the use history. | The IP address. |
| [Binance, account activity](https://mobbin.com/screens/15c79bf7-aefd-4302-9c03-fa9313bd599b) | Four label and value rows per event. | Nothing. | The card per event. Ours is two lines. |
| [Uber Eats, password rules](https://mobbin.com/screens/acd85f86-1610-4bfd-a8e2-a249545a66b3), [Agoda](https://mobbin.com/screens/b931d51e-525e-497c-9b69-ef69491f2e51) | Rule checks, eye toggles, confirm fields. | Nothing. | Rules (the site owns them), eyes, confirm fields. |

## 2. Navigation

### 2.1 The name

The brief says "Passwords and IDs". I keep it. "Secure details" pairs with "Personal details",
but it is an adjective and a promise. "Passwords and IDs" names what is inside, which is the
plain choice. API keys ride under "Passwords" in the user's mind (a password for a program);
the page intro names them.

One conflict: Settings, Trust already has "Saved sign-ins" (`SavedSignInsView.swift`), which is
the shared browser's cookie session, not a password. The new store calls a username and
password a "sign-in" too (`sign_in`). Two things with one name is a trap. Recommendation: rename
the Trust row to **"Signed-in sites"** and keep its page as it is. The Trust footer becomes:
"Everything Albatross does on its own, with a pause switch for each. Signed-in sites keep the
shared browser signed in. Passwords and IDs, under Account, hold what Albatross types and never
shows." This touches web and Mac copy, so it is open question 4.

### 2.2 Where it lives

Settings, Account section, directly under "Personal details" (PR 1 decision 17 put Personal
details in Account, under Connections):

```
Account
  Albatross            Signed in
  Plan                 Everyday
  Mailboxes                     >
  Connections                   >
  Personal details              >
  Passwords and IDs             >
  Export my data
  Sign out
  Delete account and data
```

### 2.3 The flag-off state

`GET /api/secure-details` answers `enabled: false` when `LAB86_SECURE_STORE` is off for the
user. Then:

- The "Passwords and IDs" row is not in Settings.
- The composer shows no paste notice (section 8). PR 1 behaviour stays (the server refuses).
- The `secure_request` card and the `allow_secure` handoff do not arrive (the server does not
  send them). An older app that meets `allow_secure` must not misread it (section 6).

The row needs `enabled` before Settings draws. A `SecureDetailsStore` (section 11) keeps the
last `enabled` value per owner in `UserDefaults` (a Boolean is not sensitive). Settings draws
the row from that cache at once and refreshes in `.task`. On the first open ever, the row
appears after the read. The row never flashes from shown to hidden.

### 2.4 The list

One `Form`, three groups by kind, each with its add row at the end. The groups make the add
flow kind-specific, so no type picker sheet exists, and the empty state is the three add rows.

```
Passwords and IDs                                  (inline title)

  Albatross uses these to sign in, to fill forms, and to call
  services. It never shows a saved value again. To change one,
  replace it.

Sign-ins
  Chase                                  Used Oct 5
  chase.com · ••••                                >
  Springfield Water                    Not used yet
  springfieldwater.gov · ••••                     >
  Add a sign-in
  A sign-in works only on its site. Albatross types it on the
  sign-in page and never reads it back.

IDs
  Date of birth                               Saved >
  Driver's license                       Used Oct 5
  NY · ends 4821 · 2 sites                        >
  Passport                             Not used yet
  US · ends 7HK2                                  >
  Add an ID                                    (menu)
  An ID works on the sites you allow. Albatross asks you the
  first time a site needs one.

Keys
  OpenAI                                 Used Oct 6
  api.openai.com · sk-…f3a2                       >
  Add a key
  A key works only on its host. Albatross sends it in the request
  and reads only the reply.

  Albatross does not keep card numbers, bank numbers, or
  two-factor codes yet.
```

Rules:

- **Row.** Title is the label. The detail line is the sites joined with " · ", then the main
  hint (`hints.password`, `hints.number`, `hints.key`). An ID puts its facts first
  (`facts.region` or `facts.country`), then the hint, then the site count when it has sites.
  "Date of birth" is a fixed row like the fixed rows of Personal details: "Add" when missing,
  "Saved" when present (V2). The trailing caption is "Used Oct 5" from `lastUsedAt`, else
  "Not used yet".
- **Order.** Within a group, by label, case-insensitive. The fixed "Date of birth" row is first
  in IDs.
- **Add an ID** is a `Menu` with five items: Social Security number, Driver's license,
  Passport, State ID, ID number (`ID_NUMBER_LABELS`). The sheet opens with that type as its
  title. "Add a sign-in" and "Add a key" open their sheets directly.
- **Empty state.** The intro sentence, three groups with only their add rows and footers, and
  the refusal footer. No illustration, no `ContentUnavailableView`. The page is its own
  explanation (Obsidian Keychain).
- **Loading.** `ProgressView("Checking…")` in the first group, as Personal details does.
  **Load error** with no cached items: the error line and "Try again".
- **Pull to refresh** reloads. A sign-out clears the store.
- **No search.** A list of ten needs none.
- **No favicons, no kind icons.** Text only.

### 2.5 The item detail

A pushed screen (`NavigationLink`), not a sheet, because it has a history list and a delete row.
Section 4 specifies it.

## 3. Add flows

Every add flow is a sheet: `NavigationStack` with a `Form`, "Cancel" at the leading edge,
"Save" at the trailing edge, `interactiveDismissDisabled` while a save runs. The pattern is
`PersonalDetailEditorView`. The Mac wraps it in `macFormSheet()`.

Common rules:

- The secret fields never prefill, except from the V9 paste (section 8). The site prefills
  from the V12 card or the V13 offer.
- "Save" opens when the required fields have a value. The format check runs on save.
- The server is the authority for refusals and for site normalization. The client runs the
  same checks first so the user sees the line before a round trip.
- An error from the server shows under the field it names, else under the last field.
- After a save, the sheet closes, the list reloads, and VoiceOver announces "Saved."
- The server answers `{ code: 'refused', reason: 'card' | 'cvv' | 'bank' | 'code', error }`
  on a refusal and `{ code: 'invalid', error }` on a bad value, as Personal details does
  (open question 2 asks the lead to pin `reason`).

Refusal copy (`SecureSaveError.line`):

- card: "This looks like a card number. Albatross does not keep card numbers yet."
- cvv: "This looks like a card security code. Albatross does not keep it."
- bank: "This looks like a bank or routing number. Albatross does not keep it yet."
- code: "This looks like a two-factor or recovery code. Those stay with you."
- limit: "You have as many items as Albatross can keep. Delete one first."

### 3.1 Sign-in

Title: "New sign-in". Fields, in order:

| Field | Control | Keyboard and content type | Notes |
|---|---|---|---|
| Site | `TextField`, prompt `chase.com` | `.URL`, `.textContentType(.URL)`, no capitalization, no correction | Required. Prefilled from V12 and V13 and then read-only with the caption "From the run". Normalization below. |
| Username | `TextField`, prompt `sam.rivera@example.com` | `.emailAddress`, `.textContentType(.username)`, no capitalization, no correction | Required. |
| Password | `SecureField` | `.textContentType(.password)`, no correction | Required. A live caption under it: "14 characters". The Passwords key in the keyboard bar fills from Apple Passwords. |
| Name | `TextField`, prompt from the site ("chase.com") | `.default`, words capitalization | Optional. Empty saves the site as the label. |

Footer: "Albatross types this on the sign-in page of chase.com and nowhere else. It never
reads the password back."

Site normalization: the client lowercases, strips the scheme, userinfo, port, path, query,
fragment, and a leading "www.". `https://secure.chase.com/login` becomes `secure.chase.com`.
When the typed text and the cleaned host differ, a caption shows "Saved as secure.chase.com".
The server reduces it to the registrable domain with `tldts` (`chase.com`), and the list shows
that. The client does not guess the registrable domain, because `dmv.ny.gov` and `bbc.co.uk`
need the public suffix list. The help line says it: "chase.com covers secure.chase.com too."

Validation copy:

- Site empty: "Enter the site."
- Site has no dot or has a space: "Enter a site like chase.com."
- Username empty: "Enter the username."
- Password empty: "Enter the password."

No password rules. The site owns its rules. No confirm field: the length caption and the
Passwords key are the check.

### 3.2 ID number

Title: the type label ("Driver's license"). Fields, in order:

| Field | Control | Keyboard and content type | Shown for |
|---|---|---|---|
| Number | `TextField`, monospaced digits, prompt `000-00-0000` for SSN else `Number` | SSN: `.numbersAndPunctuation`. Others: `.asciiCapable`, no capitalization change (licence numbers mix cases), no correction. No content type. | All |
| State | `TextField`, prompt `NY` | `.asciiCapable`, `.textContentType(.addressState)`, characters capitalization | Driver's license, State ID, ID number |
| Country | `TextField`, prompt from the locale (`US`) | `.asciiCapable`, characters capitalization, limit 2 | Passport, ID number |
| Expiry date | `DatePicker`, compact, date only, optional (a "Set" row that turns into the picker) | — | Driver's license, Passport, State ID, ID number |
| Name on the ID | `TextField`, prompt from Personal details name ("Sam Rivera"), caption "From your details" when prefilled | `.textContentType(.name)`, words capitalization | All except SSN |

The number field is **plain, not secure, while the user types.** The value is never shown
again after the save, so the user must see it once. Every government form does this. A live
caption under the field reads "Ends 4821" once four characters exist, so the hint the list
will show is already known. Section 12 covers screen capture.

Footer: "Type it exactly as it appears on the ID. Albatross asks you before it uses this on a
new site." For SSN: "Type the nine digits. Albatross asks you before it uses this on a new
site."

Validation copy:

- Number empty: "Enter the number."
- SSN not nine digits: "A Social Security number has nine digits."
- Number passes Luhn with 13 to 19 digits: the card refusal line (above).
- Expiry in the past: "That date is in the past. Save it anyway?" as a caption, not a block.
  The server accepts it (an expired ID is still a fact).
- State empty for a driver's license or state ID: "Enter the state."

### 3.3 Date of birth

Title: "Date of birth". One `DatePicker` in wheel style (compact style makes a year 30 years
back slow), date only, range from 120 years ago to today. Default: no date until the user
moves a wheel ("Save" stays closed).

Footer: "Albatross types this into forms. For an age rule, it knows only your age in years.
It asks you before it uses this on a new site."

Validation: a date in the future is impossible with the range. A date under 13 years ago:
"Albatross is for adults." and Save stays closed (open question 13).

### 3.4 API key

Title: "New key". Fields, in order:

| Field | Control | Keyboard and content type | Notes |
|---|---|---|---|
| Name | `TextField`, prompt `OpenAI` | `.default`, words capitalization | Required. |
| Host | `TextField`, prompt `api.openai.com` | `.URL`, `.textContentType(.URL)`, no capitalization, no correction | Required. Cleaned like a site (scheme and path stripped), but the server keeps the exact host. Caption when changed: "Saved as api.openai.com". |
| Key | `SecureField` | No content type, no correction | Required. Live caption: "Ends f3a2 · 51 characters". |
| Header | `TextField`, prompt `Authorization` | `.asciiCapable`, no capitalization, no correction | Optional. Help: "The request header that carries the key. Most services use Authorization." |

Footer: "Albatross calls api.openai.com with this key from a run and reads only the reply. It
never shows the key."

Validation: empty name, host, or key: "Enter the name." / "Enter the host." / "Paste the key."
A key under 8 characters: "That is too short for a key." The server's refusal lines apply (a
pasted card number goes nowhere).

Open question 6 asks whether `header` is a name only or a template ("Bearer {{key}}").

## 4. The item detail

A pushed screen. Title: the label. The Mac shows the same groups in its settings page.

```
< Passwords and IDs       Driver's license

  Type                         Driver's license
  State                                      NY
  Expires                              Mar 2028

  Number                     ends 4821   Replace
  Expiry date                Mar 2028    Replace
  Name on the ID             S… Rivera   Replace
  Albatross never shows a saved value. Replace it to change it.

Sites
  ny.gov                            Added Oct 5
  Every page of ny.gov
  geico.com                         Added Oct 2
  Every page of geico.com
  Add a site
  Albatross uses this ID on these sites without a question. It
  asks you on any other site. Adding a site needs a recent
  sign-in.

Recent uses
  Typed on dmv.ny.gov · Number, Expiry date
  Renew the license · Oct 5, 9:41 AM
  Allowed once on dmv.ny.gov
  Renew the license · Oct 5, 9:40 AM
  Refused on dmv-renewal.example
  Not one of this ID's sites · Renew the license · Oct 3, 2:12 PM
  Show all 7
  Albatross keeps 90 days of uses.

  Delete this ID
```

### 4.1 Facts

`facts` from the server, as `LabeledContent` rows: Type, State or Country, Expires (month
only, as the server sends it). A sign-in has no facts group. A key shows Host and Header. A
date of birth shows nothing but "Saved on Oct 2".

### 4.2 Secret fields and Replace

One row for each name in `SECURE_FIELDS[kind]`: the label from `SECURE_FIELD_LABELS`, the hint
from `hints[field]` ("••••", "ends 4821", "S… Rivera", "sk-…f3a2"), and a "Replace" button
at the trailing edge (bordered, small). A field with no saved value (an optional expiry) shows
"Add" instead. The group footer: "Albatross never shows a saved value. Replace it to change
it."

"Replace" opens a sheet with one field of the kind's control (secure field for a password or a
key, plain monospaced field for a number, `DatePicker` for a date, text field for a name).
Title: "Replace the password". Footer: "The old value goes away when you save." Save sends
`PUT /api/secure-details/[itemId]` with `values: { password }` only. A replace needs no identity
check: a replaced value is the user's own new input, and it cannot leave the item's sites.

There is no "Edit" mode. A plain label change is "Rename" in the navigation bar menu, a one
field alert.

### 4.3 Sites

One row for each site. The title is the site as the server stores it (`ny.gov`, the
registrable domain with private suffixes counted). The second line says what it covers:
"Every page of ny.gov". A key's row is its exact host (`api.openai.com`) with no second
line. The trailing caption is "Added Oct 5" when the server sends a date (the contract has no
per-site date today; without one, the caption is empty; open question 14).

- **Remove:** swipe to delete, or "Remove" in the row's context menu. No identity check. The
  last site of a sign-in or a key cannot be removed; the footer says "A sign-in needs at least
  one site." and the swipe action is absent on that row.
- **Add a site:** a row that opens a one-field sheet, "Add a site", prompt `dmv.ny.gov`,
  footer "Albatross may use this item on the site without a question. This needs a recent
  sign-in." Save sends `PUT` with the full `sites` list. A 403 `verify_identity` opens the
  identity sheet (section 5), then retries. Cancel in the identity sheet returns to the add
  sheet with the line "Adding a site needs a recent sign-in." under the field; the user can
  cancel or try again.
- An ID or a date of birth with no sites shows only the add row and the footer "No sites yet.
  Albatross asks you the first time a site needs this."

### 4.4 Recent uses

`GET /api/secure-details/[itemId]/uses`, read when the detail opens. Rows, newest first, two
lines each:

| `outcome` | Line 1 | Line 2 |
|---|---|---|
| `typed` | "Typed on dmv.ny.gov · Number" | workTitle · absolute date and time |
| `sent` | "Sent to api.openai.com" | workTitle · time |
| `refused_site` | "Refused on dmv-renewal.example" | "Not one of this ID's sites · " workTitle · time |
| `allowed_once` | "Allowed once on dmv.ny.gov" | workTitle · time |
| `allowed_always` | "Always allowed on dmv.ny.gov" | workTitle · time |
| `denied` | "Not allowed on dmv.ny.gov" | workTitle · time |

Rows with the same outcome, site, work, and minute merge: "Typed on chase.com · Username,
Password". The first ten show; "Show all 23" expands inline. Empty: "No uses yet." The footer:
"Albatross keeps 90 days of uses." A refusal is not red; it is Albatross at work. Colours stay
primary and secondary.

### 4.5 Delete

The last row, destructive: "Delete this sign-in" / "Delete this ID" / "Delete your date of
birth" / "Delete this key". A `confirmationDialog` says what stops:

| Kind | Title | Message |
|---|---|---|
| sign_in | "Delete the Chase sign-in?" | "Albatross can no longer sign in to chase.com for you. A run that needs it stops and asks you." |
| id_number | "Delete your driver's license?" | "Albatross can no longer type it on dmv.ny.gov and 1 other site. A form that needs it asks you." (no sites: "A form that needs it asks you.") |
| date_of_birth | "Delete your date of birth?" | "Albatross can no longer type it into forms or check an age rule." |
| api_key | "Delete the OpenAI key?" | "Albatross can no longer call api.openai.com for you." |

The destructive button repeats the verb: "Delete". After the delete, the screen pops, the list
reloads, and VoiceOver announces "Deleted."

## 5. The identity check on iOS

Three actions need it: "Allow once" and "Always on this site" (section 6), and "Add a site"
(section 4.3). "Do not allow", a replace, a delete, and a site removal need none. The server
answers 403 with `code: 'verify_identity'` and Clerk's reverification body when `fva[0]` is
older than 10 minutes. One check opens a 10-minute window for every action on every item.

### 5.1 Flow

1. **The window pre-check.** Before the request, `IdentityWindow.isOpen(token:)` decodes the
   payload of the cached session JWT (base64url JSON, no signature check) and reads `fva[0]`
   and `iat`: the age is `fva[0]` plus the minutes since `iat`. This needs no SDK version. When
   the window is closed, the app opens the sheet first and sends the request after the check.
   When the window is open, the app sends at once. The server's answer is the authority: a 403
   `verify_identity` opens the sheet in every case and the app retries once.
2. The sheet presents with a `reason` line that names the action, and calls
   `Clerk.shared.session?.startVerification(level: .firstFactor)`, then reads
   `supportedFirstFactors`.
3. Strategy, in order of preference: passkey when the list has one (`verifyWithPasskey()`
   shows the system sheet with Face ID; one tap); else email code
   (`sendEmailCode(emailAddressId:)` for the primary address, then `verifyWithEmailCode`);
   else password (`verifyWithPassword`). Phone code is a fallback when the account has no
   email address.
4. On `status == .complete`: `try await session.getToken(.init(skipCache: true))`, then the
   app sends (or retries) the request once with the fresh token. The sheet closes.
5. On `.needsSecondFactor` (the user has MFA): the sheet shows a TOTP or SMS code field in a
   second step (`verifyWithTOTP`, `sendMfaPhoneCode` plus `verifyWithMfaPhoneCode`).

### 5.2 The sheet

```
                 Confirm your identity

  Allow once lets Albatross type your driver's license
  on dmv.ny.gov for this run. Enter the code Albatross
  sent to s•••@example.com.

  [ 0 0 0 0 0 0 ]                          (code field)

  Send the code again

  You will not be asked again for 10 minutes.

                                   Cancel   [ Confirm ]
```

- Title: "Confirm your identity". No "it's you" contractions.
- The reason line is the first sentence, by action:
  - Allow once: "Allow once lets Albatross type your driver's license on dmv.ny.gov for this
    run."
  - Always on this site: "Always on this site adds ny.gov to your driver's license. That
    covers dmv.ny.gov and every page of ny.gov."
  - Add a site: "A new site for your Chase sign-in."
  Then the instruction.
- The footer: "You will not be asked again for 10 minutes." It sets the expectation for the
  window.
- The code field: `.textContentType(.oneTimeCode)`, `.numberPad`, six digits. The Clerk code
  arrives by email, in a mailbox Albatross indexes; the app's own AutoFill extension
  (`Lab86MailAutoFill`) can offer it in the keyboard bar on this very field. No change to the
  extension is needed for that.
- Passkey path: the sheet shows one sentence, "Use your passkey to confirm.", and the system
  sheet appears at once. If it fails or the user cancels it, the sheet falls to the email code
  with "Send a code instead".
- Errors: "That code did not work. Check it and try again." / "The code expired. Send a new
  one." / "Could not confirm. Try again." Three wrong codes: the sheet closes with the cancel
  behaviour.
- "Send the code again" is a quiet text button with a 30-second cool-down caption ("Sent.").
- Medium detent, `interactiveDismissDisabled` while a verify runs.

### 5.3 Cancel

Cancel closes the sheet and the original action does not happen. The caller shows one line in
place:

- In the allow card: "An allow needs a recent sign-in. Do not allow needs none." The three
  buttons stay.
- In the add-site sheet: "Adding a site needs a recent sign-in." under the field.

Nothing is retried on its own. Nothing is granted.

### 5.4 After the bump (phase 2)

With clerk-ios 1.5.5 or later, `verifyWithBiometrics(reason:)` becomes the first strategy
when the user has an enrolled biometric credential, and `Clerk.shared.has(reverification:
.custom(level: .firstFactor, afterMinutes: 10))` replaces the JWT decode of 5.1. The sheet
stays the same for the other strategies. With Face ID as the check, "Allow once" is one tap
and one glance, which is what the new rule needs to feel light.

### 5.5 The fallback when a verification cannot complete

The SDK flow can fail: `startVerification` throws, the factor list holds nothing the phone
can do (an enterprise SSO only account), a code never arrives, or the status comes back
`.unknown`. The lead asked for the best fallback. The options, judged:

| Option | Verdict |
|---|---|
| A fresh sign-in in the app | Rejected as a button. `SignOutCoordinator` clears the product state, pending sends, drafts, and the push registration; the user loses the thread in front of them. It does reset `fva[0]` to 0, so the sheet names it as the last resort in words only. |
| "Continue on the web or Mac" | Taken. The handoff is a server row: the Brief and the thread on every device show the same card, and the web has `useReverification`. The phone offers "Open on the web", which opens the Work page in Safari (`https://mail.lab86.io/?work=<workId>`, the existing deep link format); the user signs in there if needed and confirms with the email code. |
| A direct Frontend API call from the app | Rejected. ClerkKit's `Request` is package-scoped; a hand-made call would need the client token from the SDK's keychain and would break on an SDK change. |
| An email link | Rejected. Reverification supports no `email_link` strategy on the Frontend API. |

The fallback state in the allow card (after the sheet closes on a failure):

```
│ │ Use your driver's license on dmv.ny.gov?         │
│ │ Could not confirm your identity on this phone.   │
│ │ Allow this on the web or the Mac, or press Do    │
│ │ not allow. A new sign-in on this phone works     │
│ │ too.                                             │
│ │ Open on the web                     Do not allow │
```

"Open on the web" is a text button; "Do not allow" keeps its quiet style. The card goes
back to its three buttons on the next open of the thread, so a later try works. In the
add-site sheet the same sentence shows under the field with "Open on the web" and the sheet
stays open.

Recommendation: ship the SDK sheet as the only path on iOS, with 5.5 as the error state, and
measure how often it shows. Do not build a second verification system.

## 6. The `allow_secure` run block (V6)

### 6.1 Contract on the client

`StepRunView.Next.Kind` gains `.allowSecure = "allow_secure"`, and `Next` gains
`allow: SecureAllowRequest?` and `saveSignIn: SecureSaveSignInOffer?`.
`StepRunNextBehaviour` gains `.allowSecure(SecureAllowRequest)`, with
`showsPrimaryButton == false` (the card draws its own buttons).

This matters for the current app: an unknown `next.kind` with `target.url` reads as
`.openURL` today (`StepRunPresentation.swift`, `case .unknown`). An older app would then show an
"Open" button that opens `https://ny.gov`. The server sends `allow_secure` only to clients that
report support, or the app ships the new kind before the flag turns on (open question 10). A
regression test pins it: `allow_secure` never becomes `.openURL`.

The server fills the handoff so the Brief and the push read well: `outcome: 'needs_answer'`,
`next.label: "Answer"`, `next.detail: "Use your driver's license on dmv.ny.gov?"` (open
question 1).

### 6.2 The block

The header reads "Needs your answer" (`RunBlockCopy.headline` for `.needsAnswer`). Under the
step title, in place of the form card, the allow card uses `QuestionShell`:

```
│ Needs your answer · Started by you
│ Renew the license
│
│ ┌──────────────────────────────────────────────────┐
│ │ Use your driver's license on dmv.ny.gov?         │
│ │ Albatross types the number and the expiry date   │
│ │ into the page. It does not read them.            │
│ │ The site is ny.gov. An allow needs a recent      │
│ │ sign-in.                                         │
│ │                                                  │
│ │ [ Allow once ]  [ Always on this site ]          │
│ │ Do not allow                                     │
│ └──────────────────────────────────────────────────┘
│ Albatross is on the page · dmv.ny.gov        Open
│ What Albatross did  6
│ Dismiss
```

Copy by kind (`SecureAllowCopy`):

| Kind | Title | Line |
|---|---|---|
| id_number | "Use your driver's license on dmv.ny.gov?" | "Albatross types the number and the expiry date into the page. It does not read them." (one field: "Albatross types the number into the page. It does not read it.") |
| date_of_birth | "Use your date of birth on aliveat25.com?" | "Albatross types the date into the page. It does not read it." |
| sign_in | "Use your Chase sign-in on secure.chase.com?" | "Albatross signs in with your saved username and password." (rare: a sign-in asks only when a new host of the same registrable domain appears, which the server allows without a question; the copy exists for safety) |
| api_key | "Call api.openai.com with your OpenAI key?" | "Albatross sends the key in the request and reads only the reply." |

The field names come from `fieldLabels`, lower-cased and joined with "and". The title names
the **host** (`dmv.ny.gov`): it is what the user sees in the page. The third line names the
**site** (`ny.gov`): it is what a grant covers. When the host and the site are the same word
(`chase.com`), the line reads "An allow needs a recent sign-in." alone. When the identity
window is open (section 5.1), the second sentence of the third line is absent: a check the
user just passed needs no warning.

Buttons, order and weight:

1. **"Allow once"**, `.borderedProminent`. The grant that gets the job done and ends with the
   run. It needs the identity check. It takes the waiting-action shortcut on the Mac; the
   shortcut opens the sheet, so it grants nothing by itself.
2. **"Always on this site"**, `.bordered`. Needs the identity check. No keyboard shortcut.
3. **"Do not allow"**, `.borderless`, `.subheadline`, on its own line. Quiet, like "Dismiss".
   No check.

`ViewThatFits`: the first two in one row, else all three stacked. Every button has
`minHeight: 44`.

The press order for "Allow once" and "Always on this site": the window pre-check; the sheet
when the window is closed; the request; a 403 opens the sheet in any case; one retry. Inside
the window, the second allow of the day is one tap.

### 6.3 States

| State | The card shows |
|---|---|
| Pending, window closed | Title, line, "The site is ny.gov. An allow needs a recent sign-in.", three buttons. |
| Pending, window open | The same without the second sentence. |
| Identity sheet open (once or always) | The sheet over the thread. The card is unchanged under it. |
| Identity cancelled | The three buttons, plus the caption "An allow needs a recent sign-in. Do not allow needs none." |
| Identity failed (5.5) | "Could not confirm your identity on this phone. Allow this on the web or the Mac, or press Do not allow." with "Open on the web" and "Do not allow". |
| Sending | Buttons disabled; the pressed one reads "Allowing…" or "Sending…". |
| Allowed once | Receipt "Allowed once on dmv.ny.gov." The run continues; a "Continued · 9:42" block follows. |
| Always | Receipt "Always allowed on ny.gov. Every page of ny.gov is on your driver's license." |
| Not allowed | Receipt "Not allowed on dmv.ny.gov." The run continues and asks the user to enter it on the page, or stops; its own block says which. |
| Error | The buttons again, with "Could not send your answer. Try again." in red under them. |
| Answered elsewhere (the run has a continuation, no local answer) | Receipt "Answered." |
| Dismissed | The run block's "Dismissed" line, as today. |

The receipt comes from a local memory in `WorkThreadModel` (`allowAnswers[runId]`) in this
session, else from `hasContinuation`. Open question 11 asks the server to store the answer on
the run so every device shows the same receipt.

Only the buttons answer. A chat message "allow it" does not; Albatross replies "Press Allow
once or Always on this site in the run block." (open question 12).

### 6.4 The thread state and the pill

`ThreadState.resolve` already maps a `needs_answer` handoff to `.needsAnswer`, so the plan line
reads "Step 2 of 3 · Needs your answer" and the composer placeholder reads "Answer here, or
tell Albatross what to change". The jump pill "Albatross needs an answer" fires on
`pendingQuestion`; it must also fire on a pending allow (`WorkThreadStore.pendingAllow`).

### 6.5 The Brief row

"Ready for you" (`ReadyForYouSection`) shows the row as it shows every handoff: the Work title,
the step title, `next.detail` ("Use your driver's license on dmv.ny.gov?"), and one button,
`next.label` ("Answer"). `StepRunActions.open` returns false for `.allowSecure`, so the button
opens the thread at the block. The three choices are not in the Brief row: the thread is the
place, one tap away.

### 6.6 The push notification

The server already sends `title: "{next.label}: {stepTitle}"` and `body: next.detail`
(`notifyHandoff` in `lib/albatross/step-runner.ts`), so the banner reads:

```
Albatross
Answer: Renew the license
Use your driver's license on dmv.ny.gov?
```

The app registers a category `secureAllow` with
`hiddenPreviewsBodyPlaceholder: "Albatross needs an answer."` and no
`.hiddenPreviewsShowTitle`. With previews hidden on the lock screen the banner reads
"Albatross · Albatross needs an answer." No banner actions. The tap opens the thread at the
block (the existing deep link). The server sets the category on `allow_secure` handoffs
(open question 1).

## 7. The `secure_request` card (V12) and the sign-in save offer (V13)

### 7.1 `secure_request` in the chat

`ToolShape.content` gains `.secureRequest(SecureRequestShape)`. The card renders inside
`AssistantShapeCardView`:

```
┌──────────────────────────────────────────────────┐
│ Add your sign-in for springfieldwater.gov        │
│ To pay the water bill, Albatross needs to sign   │
│ in to the account.                               │
│ Albatross uses it on springfieldwater.gov and    │
│ never shows it.                                  │
│                                      Skip   [Add]│
└──────────────────────────────────────────────────┘
```

- **Title** by kind: "Add your sign-in for {site}", "Add your {label} key" (or "Add a key
  for {site}"), "Add your {ID label}", "Add your date of birth". With `existingItemId`:
  "Replace your sign-in for {site}".
- **Reason**: `shape.reason`, as secondary text, never as the title (1Password rule). The
  server trims it to 200 characters.
- **Note**: "Albatross uses it on {site} and never shows it." For an ID or a date of birth:
  "Albatross asks you before it uses it on a new site."
- **Buttons**: "Add" (the shape action style, trailing) and "Skip" (quiet). The chat form's
  quiet word is "Skip" (PR 1 decision 3). With `existingItemId`, "Add" reads "Replace" and
  opens the replace sheet of that item's main secret field.

States:

| State | The card shows |
|---|---|
| Pending | Title, reason, note, "Skip", "Add". |
| Sheet open | Unchanged under the sheet. |
| Saved | "Saved. Albatross can use it on springfieldwater.gov." in place of the buttons. |
| Replaced | "Replaced. Albatross tries again." |
| Skipped | "Skipped." |
| Flag off or older app | The existing fallback: "This result is available in the web app." |

The tool is a HITL tool like `ask_form`: the card's answer is the tool output,
`{ saved: true, itemId }` or `{ skipped: true }`, so the model continues at once and the state
survives in the saved chat (open question 3). The model learns only that the item exists.

### 7.2 The sign-in handoff with `saveSignIn` (V13)

A `sign_in` handoff today shows the summary, the detail ("Sign in to chase.com in the page,
then press Continue"), the page row, "Sign in" (opens the page), the done label ("I signed
in"), and "Dismiss". With `next.saveSignIn = { site: 'chase.com' }`, one quiet row joins
under the detail, above the page row:

```
│ Sign in to chase.com in the page, then press Continue.
│ Save a sign-in for chase.com, and the next run signs in
│ by itself.                                Save a sign-in
│ Albatross is on the page · chase.com               Open
│ [ Sign in ]  [ I signed in ]
│ Dismiss
```

"Save a sign-in" opens the sign-in sheet with the site prefilled and read-only. After the
save the row reads "Saved. Press Continue, and Albatross signs in." and the done button reads
"Continue" instead of "I signed in", because the user did not sign in. The server, on resume,
finds the item and signs in (open question 5). The row is not a third button in the button
row; the two-button grammar stays.

## 8. The composer paste notice (V9)

### 8.1 When it appears

`AssistantComposer` scans the draft on every change with `SecretDraftScan` (pure, tested):

- Social Security number: `\b\d{3}[- ]\d{2}[- ]\d{4}\b`, or nine digits within 40 characters
  of "ssn", "social", or "security".
- Card number: 13 to 19 digits with optional spaces or dashes that pass Luhn.
- API key: known prefixes (`sk-`, `sk-ant-`, `ghp_`, `gho_`, `xox[abprs]-`, `AKIA`), 20 or
  more characters after the prefix.

No scan for one-time codes: six digits are prices and ZIP codes, and a code the user types for
a run is the user's choice. No scan for passport or licence numbers: no pattern is reliable.
The scan runs for both routes (Ask and Hold). It runs only when the store is enabled.

### 8.2 What it looks like

One row inside the glass composer, above the field row, where the context chip sits:

```
┌────────────────────────────────────────────────────────┐
│ This looks like a Social Security number. Albatross    │
│ does not send it.                                      │
│ Save in Passwords and IDs        Send without it       │
│ ─────────────────────────────────────────────────────  │
│ [clip]  my ssn is 123-45-6789, use it on the…   [Ask] [↑]│
└────────────────────────────────────────────────────────┘
```

- The sentence is `.footnote.weight(.medium)`, primary colour. The two actions are
  borderless text buttons, accent colour. No icon, no fill.
- Copy: SSN "This looks like a Social Security number. Albatross does not send it." Key "This
  looks like an API key. Albatross does not send it." Card "This looks like a card number.
  Albatross does not send it, and it does not keep card numbers yet." The card notice has only
  "Send without it".
- While the notice shows, `canSend` is false: the send control is dimmed, `onSubmit` does
  nothing, and the Hold route does not fire. The user edits the draft, or chooses an action.
- "Send without it": removes the matched span, then submits what remains. If nothing remains,
  the draft is empty and nothing is sent.
- "Save in Passwords and IDs": removes the span from the draft, then opens the add sheet of
  the matched kind (SSN: ID number with type SSN; key: API key) with the value in the secret
  field. After the save, the composer shows "Saved to Passwords and IDs." for two seconds in
  the same row, then the row goes. The draft keeps its remaining words. If the sheet is
  cancelled, the span goes back into the draft and the notice returns.
- Keyboard: the notice never takes focus. The sheet dismisses the keyboard; on close, focus
  returns to the composer.
- The server backstop stays: a message that gets through reads
  "[removed: looks like a Social Security number]" in the saved chat.

## 9. Run log copy

The server writes these lines (web owns the server). The iOS log view shows them as it shows
every line. Proposed, for one voice on all platforms:

| Event | Line |
|---|---|
| Signed in | "Signed in to chase.com with your saved sign-in." (V5) |
| Typed an ID field | "Typed your driver's license number on dmv.ny.gov." |
| Typed a date of birth | "Typed your date of birth on aliveat25.com." |
| Called a host | "Called api.openai.com with your OpenAI key." |
| Refused for a site | "Did not type your Chase password. The page is on chase-login.example, not chase.com." (V7) |
| Asked | "Asked you: use your driver's license on dmv.ny.gov?" |
| Allowed once | "Allowed once: driver's license on dmv.ny.gov." |
| Always | "Always allowed: driver's license on dmv.ny.gov." |
| Not allowed | "Not allowed: driver's license on dmv.ny.gov. Albatross asks you to enter it on the page." |
| Missing | "No sign-in is saved for chase.com." |
| Two-factor | "Your turn: enter the code on the page." (V5, exists today) |

No line ever holds a value. The log view marks nothing special; these are ordinary lines.

## 10. User stories as iPhone screen states

**V1. Save a sign-in.** Settings → Account → Passwords and IDs → "Add a sign-in". The sheet:
Site `chase.com`, Username, Password (dots, "14 characters"), Name "Chase". Save. The list:
"Chase / chase.com · •••• / Not used yet".

**V2. Save an ID.** "Add an ID" → "Driver's license". The sheet titled "Driver's license":
Number (plain, "Ends 4821"), State `NY`, Expiry date, Name on the ID "Sam Rivera · From your
details". Save. The list: "Driver's license / NY · ends 4821 / Not used yet". Then "Date of
birth · Add" → the wheel → Save → "Date of birth · Saved".

**V3. Save an API key.** "Add a key": Name `OpenAI`, Host `api.openai.com`, Key (dots,
"Ends f3a2 · 51 characters"), Header empty. Save. The list: "OpenAI / api.openai.com ·
sk-…f3a2".

**V4. Never shown again.** The detail shows "Password · •••• · Replace". No eye, no copy, no
long press. Replace opens a one-field sheet. Delete is the last row with its dialog.

**V5. A run signs in for me.** The thread: the run block "In progress · Pay the bill", log
lines "Opened chase.com", "Signed in to chase.com with your saved sign-in". A two-factor
page: the block turns "Your turn" with "Enter the code on the page, then press Continue",
the page row, and "I entered the code". The item detail later shows "Typed on chase.com ·
Username, Password".

**V6. A new site asks first.** The block "Needs your answer · Renew the license" with the
allow card (section 6.2): "Use your driver's license on dmv.ny.gov?", "The site is ny.gov. An
allow needs a recent sign-in." "Allow once" → the identity sheet ("Allow once lets Albatross
type your driver's license on dmv.ny.gov for this run.") → the code → receipt "Allowed once on
dmv.ny.gov." → "Continued · 9:42" → "Typed your driver's license number on dmv.ny.gov." Nine
minutes later, another run asks for the passport on `travel.state.gov`: "Allow once" is one
tap, no sheet. "Always on this site" → the sheet when the window is closed → receipt "Always
allowed on ny.gov. Every page of ny.gov is on your driver's license." → the detail's Sites
group gains "ny.gov". "Do not allow" → no sheet → receipt "Not allowed on dmv.ny.gov."

**V7. A wrong site never gets it.** The log: "Did not type your Chase password. The page is on
chase-login.example, not chase.com." The block hands off "Your turn" with "This page is not
chase.com. Check the page." The item's uses gain "Refused on chase-login.example".

**V8. Use history.** The detail's "Recent uses" group (section 4.4), ten rows, "Show all".

**V9. I paste a secret in the chat.** The composer row (section 8.2). "Save in Passwords and
IDs" → the ID sheet titled "Social Security number" with the number in the field and the
draft without it → Save → "Saved to Passwords and IDs." for two seconds. "Send without it" →
the message goes without the number.

**V10. Cards wait.** The ID sheet with a 16-digit Luhn number: under the field, "This looks
like a card number. Albatross does not keep card numbers yet." Save stays closed. The composer
with a card number: the notice with only "Send without it".

**V11. Delete my account or export my data.** Web only. On iOS, "Delete account and data"
already names "settings"; its sentence gains "passwords and IDs":
"This permanently removes your Albatross account, connected-provider grants, indexed mail,
calendars, tasks, Areas, Work, passwords and IDs, and settings."

**V12. Albatross asks for a missing secret.** The chat: "Pay my water bill." → the card "Add
your sign-in for springfieldwater.gov" (section 7.1) → "Add" → the sign-in sheet with the site
read-only → Save → "Saved. Albatross can use it on springfieldwater.gov." → the model
continues: "I start the payment now." and a run block.

**V13. Save a sign-in from a handoff.** The block "Your turn · Pay the bill" with "Sign in to
chase.com in the page, then press Continue", the save row (section 7.2), "Save a sign-in" →
the sheet → Save → "Saved. Press Continue, and Albatross signs in." → "Continue" → the next
block logs "Signed in to chase.com with your saved sign-in."

### 10.1 State matrices

**Row (list):**

| Condition | Title | Detail | Caption |
|---|---|---|---|
| Sign-in, never used | Chase | chase.com · •••• | Not used yet |
| Sign-in, used | Chase | chase.com · •••• | Used Oct 5 |
| ID, no sites | Driver's license | NY · ends 4821 | Not used yet |
| ID, two sites | Driver's license | NY · ends 4821 · 2 sites | Used Oct 5 |
| Date of birth missing | Date of birth | Add | — |
| Date of birth saved | Date of birth | Saved | Used Oct 1 |
| Key | OpenAI | api.openai.com · sk-…f3a2 | Used Oct 6 |
| Loading, nothing cached | ProgressView "Checking…" | | |
| Load failed, nothing cached | "Could not read your passwords and IDs." + Try again | | |
| Flag off | The row is absent from Settings | | |

**Detail:**

| Kind | Facts | Secret rows | Sites group | Uses | Delete row |
|---|---|---|---|---|---|
| sign_in | none | Username, Password | Sites (at least one) | yes | Delete this sign-in |
| id_number | Type, State or Country, Expires | Number, Expiry date, Name on the ID | Sites (may be empty) | yes | Delete this ID |
| date_of_birth | Saved on Oct 2 | Date of birth | Sites (may be empty) | yes | Delete your date of birth |
| api_key | Host, Header | Key | Hosts (at least one) | yes | Delete this key |

**Allow block:** section 6.3. **Request card:** section 7.1.

## 11. Component inventory

### 11.1 New files

| File | What it holds |
|---|---|
| `Core/Models/SecureDetailsModels.swift` | `SecureItemKind`, `IdNumberType`, `SecureItemView`, `SecureUseView`, `SecureUseOutcome`, `SecureDetailsResponse`, `SecureItemCreate`, `SecureItemUpdate`, `SecureAllowRequest`, `SecureSaveSignInOffer`, `SecureAllowAnswer`, `SecureRequestShape`, `SecureSaveError`, the row and use-row copy functions. JSON decoding with the same tolerance as `ThreadModels.swift`. No type here can hold a value. |
| `Core/Models/SecureSite.swift` | `SecureSite.clean(_:)`: the client-side host cleaning of section 3.1. |
| `Core/Models/SecureDraftScan.swift` | The V9 patterns, Luhn, and `SecretDraftHit { kind, range, value }`. |
| `Core/Models/SecureDetailsStore.swift` | `@Observable`: `enabled: Bool?` (cached per owner), `items`, `loaded`, `loadError`; `load`, `create`, `update`, `delete`, `uses(id:)`, `allow(_:)`, `clear()`. Throws `SecureStoreError.verifyIdentity` on 403 `verify_identity`. |
| `Core/Authentication/IdentityCheck.swift` | `IdentityWindow.isOpen(token:now:)` (the JWT payload decode of section 5.1, `fva[0]` plus minutes since `iat`, under 10), the `IdentityChecking` protocol (`confirm(reason:) async -> IdentityCheckResult` with `.confirmed`, `.cancelled`, `.failed`), and `withIdentityCheck { }` (the pre-check, one retry after a 403). `ClerkIdentityCheck` drives ClerkKit; tests use a scripted one. |
| `Features/Settings/IdentityCheckSheet.swift` | The sheet of section 5.2. |
| `Features/Settings/SecureDetailsCopy.swift` | Every word of the section, in one enum for the views and the copy tests. |
| `Features/Settings/SecureDetailsSettingsView.swift` | The list of section 2.4. |
| `Features/Settings/SecureItemDetailView.swift` | The detail of section 4, with the sites and uses groups. |
| `Features/Settings/SecureItemEditorView.swift` | The add sheets (section 3), the replace sheet, the add-site sheet. One view, one `Target` enum: `.newSignIn(site:)`, `.newID(type:)`, `.newDateOfBirth`, `.newKey`, `.replace(item:field:)`, `.addSite(item:)`. |
| `Features/Work/SecureAllowCard.swift` | The allow card of section 6.2, with `SecureAllowCopy` and `SecureAllowState`. |
| `Features/Assistant/SecureRequestCard.swift` | The card of section 7.1. |
| `Features/Assistant/ComposerSecretNotice.swift` | The row of section 8.2. |
| `Lab86MailTests/SecureDetailsModelsTests.swift` | Decoding fixtures; an item with a `values` key decodes with no value anywhere; outcomes and unknown words. |
| `Lab86MailTests/SecureSiteTests.swift` | The cleaning table (`https://secure.chase.com/login` → `secure.chase.com`, `www.`, ports, `api.openai.com/v1` → `api.openai.com`). |
| `Lab86MailTests/SecureDraftScanTests.swift` | Hits for SSN, card, key; no hits for phone numbers, dates, ZIP codes, prices, order numbers. |
| `Lab86MailTests/SecureDetailsCopyTests.swift` | Every string: no "AI", "assistant", "agent"; sentence case; no icon names. |
| `Lab86MailTests/SecureAllowPresentationTests.swift` | Copy by kind and field count; the host and site lines; the state table; `allow_secure` never reads as `.openURL`. |
| `Lab86MailTests/IdentityWindowTests.swift` | Invented unsigned JWTs: `fva: [0, -1]` at `iat` now is open; `fva: [9, -1]` two minutes old is closed; a missing claim is closed; a malformed token is closed. |
| `Lab86MailTests/SecureUseRowsTests.swift` | The merge rule and the two lines. |
| `Lab86MailTests/Tour/NativeTourFixtures.json` (entries) | The list, the detail, the allow block, the request card, the composer notice, in the screenshot tour. |

### 11.2 Changed files

| File | Change |
|---|---|
| `App/AppEnvironment.swift` | `let secureDetails = SecureDetailsStore()`; `identityCheck`. |
| `Features/Settings/SettingsView.swift` | The row under Personal details when `enabled == true`; the `.task` read; `clear()` on sign-out and account deletion; the Trust footer and the "Signed-in sites" rename (open question 4); the deletion sentence (V11). |
| `Core/Models/StepRunModels.swift` | `Next.Kind.allowSecure`, `Next.allow`, `Next.saveSignIn`. |
| `Features/Work/StepRunPresentation.swift` | `StepRunNextBehaviour.allowSecure`; `StepRunActions.open` returns false for it. |
| `Features/Work/RunBlockView.swift` | The allow card in the handoff body; the save-offer row; the done label override after a save. |
| `Features/Work/RunBlockPresentation.swift` | The save-offer copy. |
| `Features/Work/WorkThreadModel.swift`, `Core/Models/WorkThreadStore.swift` | `allow(view, scope)`, `allowAnswers`, `pendingAllow`, the identity retry. |
| `Features/Work/WorkThreadView.swift` | The actions wiring; the editor sheet presentation from a card or an offer; the pill on `pendingAllow`. |
| `Features/Assistant/AssistantComposer.swift` | The notice row; `canSend` false while a hit exists; `onSaveSecret`. |
| `Features/Assistant/AssistantView.swift` | The editor sheet presentation for the Chat tab's composer. |
| `Features/Assistant/ToolShape.swift`, `AssistantShapeCards.swift` | `.secureRequest`; the card. |
| `Features/Assistant/AssistantChatModel.swift` | The HITL answer for `secure_request` (as `ask_form` answers today). |
| `Core/Notifications/NotificationCoordinator.swift` | The `secureAllow` category with the hidden-preview placeholder. |
| `Features/Today/ReadyForYouSection.swift` | No change if `next.label` and `next.detail` arrive as section 6.5 says. |

### 11.3 Shared with the Mac, and iOS-only

Shared (compiled into `Lab86MailMac`): every model, the store, `SecureSite`, `SecureDraftScan`,
every copy enum, the editor `Form` bodies, the allow card, the request card, the composer
notice, the identity check logic, and the tests.

iOS-only: the sheet presentation (`presentationDetents`), the swipe-to-remove on site rows,
the keyboard "Done" accessory, the wheel date picker.

The Mac designer decides: `macFormSheet` sizes for the editor and the identity sheet;
"Replace…" and "Remove…" as bordered buttons at the trailing edge of rows (as Personal details
does); the context menu on site rows; the identity sheet's Return key (Return confirms the
code); no keyboard shortcut on "Always on this site"; the compact date picker.

## 12. Accessibility, iPad, dark mode, motion, screen capture

- **Masked hints.** A hint never reads as punctuation. "••••" has the label "Password saved".
  "ends 4821" reads "ends in 4, 8, 2, 1" with `.speechSpellsOutCharacters()`. "sk-…f3a2" reads
  "key, ends in f, 3, a, 2". "S… Rivera" reads "name on the ID, saved".
- **Rows.** `accessibilityElement(children: .combine)`: "Chase, sign-in for chase.com,
  password saved, used October 5. Opens the details." The use rows: "Typed on dmv.ny.gov,
  Number, Renew the license, October 5 at 9:41 AM."
- **Never speak a value.** The secure fields are system secure fields. The plain number field
  speaks what is typed while the user types; that is the user's own input and unavoidable.
  The live caption speaks "Ends in 4, 8, 2, 1".
- **The allow card.** One container: "Needs your answer. Use your driver's license on
  dmv.ny.gov? Albatross types the number and the expiry date into the page." Then three
  buttons by name. The receipt is announced: "Allowed once on dmv.ny.gov."
- **The composer notice.** Announced once when it appears: "This looks like a Social Security
  number. Albatross does not send it." The two actions are buttons by name.
- **Dynamic Type to AX5.** Row captions move under the detail line (the `StepRunLogView`
  pattern). The three allow buttons stack. The notice wraps. No fixed widths except the 44
  point minimum height. The wheel date picker is replaced by the compact picker at
  accessibility sizes, where the wheel is unreadable.
- **iPad.** Settings is a sheet with its own stack; the detail pushes inside it; the editor is
  a form sheet. The thread blocks keep the iPhone layout at the thread's width.
- **Dark mode.** Surface cards from `Surface.swift`; the notice has no fill; no colour carries
  meaning alone. Red only for errors, never for a refusal.
- **Reduced motion.** The notice and the receipts cross-fade (`.opacity`), no slide. The
  sheet uses the system transition.
- **Screen capture.** Decision: the add sheet does not fight screenshots. `SecureField` hides
  its dots in a screenshot by itself (passwords, keys). The plain number field is the user's
  own typed input; iOS offers no API to block a screenshot of it, and a tricked secure layer
  is not worth its fragility. One addition, cheap and real: the editor and the detail read
  `isSceneCaptured` and, while the screen is recorded or mirrored, apply
  `.redacted(reason: .privacy)` to the number field and the hints, with the caption "Hidden
  while the screen is shared." (Apple's own pattern for the Passwords app.) Hints in the list
  carry `.privacySensitive()` so the same redaction covers them. No app-switcher blur: the
  list shows nothing worth a blur.

## 13. ASCII wireframes

### 13.1 The list

```
┌──────────────────────────────────────────┐
│ ‹ Settings      Passwords and IDs        │
├──────────────────────────────────────────┤
│ Albatross uses these to sign in, to fill │
│ forms, and to call services. It never    │
│ shows a saved value again. To change     │
│ one, replace it.                         │
│                                          │
│ SIGN-INS                                 │
│ ┌──────────────────────────────────────┐ │
│ │ Chase                     Used Oct 5 │ │
│ │ chase.com · ••••                   › │ │
│ ├──────────────────────────────────────┤ │
│ │ Springfield Water       Not used yet │ │
│ │ springfieldwater.gov · ••••        › │ │
│ ├──────────────────────────────────────┤ │
│ │ Add a sign-in                        │ │
│ └──────────────────────────────────────┘ │
│ A sign-in works only on its site.        │
│                                          │
│ IDS                                      │
│ ┌──────────────────────────────────────┐ │
│ │ Date of birth                Saved › │ │
│ ├──────────────────────────────────────┤ │
│ │ Driver's license          Used Oct 5 │ │
│ │ NY · ends 4821 · 2 sites           › │ │
│ ├──────────────────────────────────────┤ │
│ │ Add an ID                          ▾ │ │
│ └──────────────────────────────────────┘ │
│ An ID works on the sites you allow.      │
│                                          │
│ KEYS                                     │
│ ┌──────────────────────────────────────┐ │
│ │ OpenAI                    Used Oct 6 │ │
│ │ api.openai.com · sk-…f3a2          › │ │
│ ├──────────────────────────────────────┤ │
│ │ Add a key                            │ │
│ └──────────────────────────────────────┘ │
│ A key works only on its host.            │
│                                          │
│ Albatross does not keep card numbers,    │
│ bank numbers, or two-factor codes yet.   │
└──────────────────────────────────────────┘
```

(Section headers render in the system's grouped-form style; the words are sentence case:
"Sign-ins", "IDs", "Keys".)

### 13.2 A driver's license detail

```
┌──────────────────────────────────────────┐
│ ‹ Passwords and IDs   Driver's license  ⋯│
├──────────────────────────────────────────┤
│ ┌──────────────────────────────────────┐ │
│ │ Type                Driver's license │ │
│ │ State                             NY │ │
│ │ Expires                     Mar 2028 │ │
│ └──────────────────────────────────────┘ │
│ ┌──────────────────────────────────────┐ │
│ │ Number          ends 4821  [Replace] │ │
│ │ Expiry date      Mar 2028  [Replace] │ │
│ │ Name on the ID  S… Rivera  [Replace] │ │
│ └──────────────────────────────────────┘ │
│ Albatross never shows a saved value.     │
│ Replace it to change it.                 │
│                                          │
│ SITES                                    │
│ ┌──────────────────────────────────────┐ │
│ │ ny.gov                   Added Oct 5 │ │
│ │ Every page of ny.gov                 │ │
│ │ geico.com                Added Oct 2 │ │
│ │ Every page of geico.com              │ │
│ │ Add a site                           │ │
│ └──────────────────────────────────────┘ │
│ Albatross uses this ID on these sites    │
│ without a question. Adding a site needs  │
│ a recent sign-in.                        │
│                                          │
│ RECENT USES                              │
│ ┌──────────────────────────────────────┐ │
│ │ Typed on dmv.ny.gov · Number,        │ │
│ │ Expiry date                          │ │
│ │ Renew the license · Oct 5, 9:41 AM   │ │
│ ├──────────────────────────────────────┤ │
│ │ Allowed once on dmv.ny.gov           │ │
│ │ Renew the license · Oct 5, 9:40 AM   │ │
│ ├──────────────────────────────────────┤ │
│ │ Refused on dmv-renewal.example       │ │
│ │ Not one of this ID's sites ·         │ │
│ │ Renew the license · Oct 3, 2:12 PM   │ │
│ ├──────────────────────────────────────┤ │
│ │ Show all 7                           │ │
│ └──────────────────────────────────────┘ │
│ Albatross keeps 90 days of uses.         │
│                                          │
│ ┌──────────────────────────────────────┐ │
│ │ Delete this ID                       │ │
│ └──────────────────────────────────────┘ │
└──────────────────────────────────────────┘
```

### 13.3 The add sign-in sheet

```
┌──────────────────────────────────────────┐
│ Cancel          New sign-in         Save │
├──────────────────────────────────────────┤
│ ┌──────────────────────────────────────┐ │
│ │ Site                                 │ │
│ │ https://secure.chase.com/login       │ │
│ │ Saved as secure.chase.com            │ │
│ ├──────────────────────────────────────┤ │
│ │ Username                             │ │
│ │ sam.rivera@example.com               │ │
│ ├──────────────────────────────────────┤ │
│ │ Password                             │ │
│ │ ••••••••••••••                       │ │
│ │ 14 characters                        │ │
│ ├──────────────────────────────────────┤ │
│ │ Name                                 │ │
│ │ Chase                                │ │
│ └──────────────────────────────────────┘ │
│ Albatross types this on the sign-in page │
│ of chase.com and nowhere else. It never  │
│ reads the password back. chase.com       │
│ covers secure.chase.com too.             │
│                                          │
│ ┌──────────────────────────────────────┐ │
│ │ 🔑 Passwords          (keyboard bar) │ │
│ │ q w e r t y u i o p                  │ │
│ └──────────────────────────────────────┘ │
└──────────────────────────────────────────┘
```

### 13.4 The allow block in the thread

```
│ ● Needs your answer · Started by you
│ Renew the license
│
│ ┌────────────────────────────────────────┐
│ │ Use your driver's license on           │
│ │ dmv.ny.gov?                            │
│ │ Albatross types the number and the     │
│ │ expiry date into the page. It does not │
│ │ read them.                             │
│ │                                        │
│ │ [ Allow once ] [ Always on this site ] │
│ │ Do not allow                           │
│ └────────────────────────────────────────┘
│ Albatross is on the page · dmv.ny.gov  Open
│ What Albatross did  6
│ Dismiss
                                                ┌──────────────────────────────┐
                                                │ Answer here, or tell         │
                                                │ Albatross what to change   ↑ │
                                                └──────────────────────────────┘
```

After "Allow once":

```
│ │ Use your driver's license on dmv.ny.gov? │
│ │ Allowed once on dmv.ny.gov.              │
│ └──────────────────────────────────────────┘
│
│ Continued · 9:42
│ ● In progress · Continued
│ Renew the license
│ 9:42  Typed your driver's license number on dmv.ny.gov.
```

### 13.5 The request card in the chat

```
   Albatross
   No sign-in is saved for springfieldwater.gov.
   ┌────────────────────────────────────────┐
   │ Add your sign-in for                   │
   │ springfieldwater.gov                   │
   │ To pay the water bill, Albatross needs │
   │ to sign in to the account.             │
   │ Albatross uses it on                   │
   │ springfieldwater.gov and never shows   │
   │ it.                                    │
   │                          Skip     Add  │
   └────────────────────────────────────────┘
```

After the save:

```
   │ Add your sign-in for springfieldwater.gov │
   │ Saved. Albatross can use it on            │
   │ springfieldwater.gov.                     │
   └───────────────────────────────────────────┘
   I start the payment now.
```

## 14. Open questions for the lead designer

1. **The `allow_secure` handoff fields.** Recommendation: `outcome: 'needs_answer'`,
   `next.label: "Answer"`, `next.detail: "Use your driver's license on dmv.ny.gov?"`, and a
   push category `secureAllow`. Then the Brief row, the push, and the thread read as one.
2. **The refusal error shape.** Recommendation: `{ code: 'refused', reason: 'card' | 'cvv' |
   'bank' | 'code', error }` and `{ code: 'invalid', error }`, as Personal details does, so the
   client picks its line by `reason` and falls back to `error`.
3. **`secure_request` in the chat is a HITL tool.** Recommendation: like `ask_form`, no
   execute; the answer `{ saved: true, itemId } | { skipped: true }` is the tool output, so the
   model continues at once and the card's state survives in the saved chat.
4. **Rename "Saved sign-ins" to "Signed-in sites".** Recommendation: yes, on all three
   platforms, with the Trust footer of section 2.1. Two things named "sign-in" is a trap.
5. **After a V13 save, resume signs in.** Recommendation: the runner, on resume, finds the new
   item and signs in itself; the client swaps the done label to "Continue" after a save.
6. **`header` on an API key.** Recommendation: a header name only, with "Authorization" and a
   "Bearer " prefix as the server default; a template comes later if a service needs one.
7. **The ClerkKit bump and Face ID.** Recommendation: PR 2 stays on 1.3.3 (the verify flow
   is there); a separate PR bumps to 1.6.x with its own Native acceptance run, then adds
   `verifyWithBiometrics` as the first strategy and `has(reverification:)` as the pre-check.
8. **A local Face ID gate on the section.** Recommendation: no (section 1.5). Revisit as an
   opt-in switch if the owner wants the Passwords-app feel.
9. **The `fva` boundary.** Recommendation: the server passes when `fva[0] < 10`, the same rule
   as Clerk's `afterMinutes > age`, so a future local pre-check cannot disagree with the server.
10. **Older apps and `allow_secure`.** Recommendation: the server sends `allow_secure` only
    when the app build reports support (a header or the device record), or the flag turns on
    for a user only after the app with the new kind ships. Today an unknown kind with a URL
    becomes an "Open" button.
11. **Store the allow answer on the run.** Recommendation: yes, `next.answer: { scope, at }`,
    so every device shows "Allowed once on dmv.ny.gov." and not "Answered."
12. **Buttons only for an allow.** Recommendation: no tool lets the model answer an allow from
    a chat message; the allow route is the only path.
13. **A date of birth under 13 years.** Recommendation: the client refuses with "Albatross is
    for adults." and the server refuses too.
14. **A date per site.** Recommendation: the contract adds `siteAddedAt: Record<string,
    number>` so the Sites group can show "Added Oct 5"; without it the caption is empty.
15. **The username hint.** V1 shows "••••" only. Recommendation: the server returns a
    username hint ("s…ra@example.com") that the detail shows and the row does not, so two
    sign-ins for one site can be told apart without a reveal.
