# Secure details (PR 2)

Status: design, 2026-10-07. Branch `claude/secure-store`. It builds on PR 1
(`docs/albatross-thread.md`, shipped in #320 and #321). Owner decisions are at the end.

## Why

Personal details (PR 1) are facts that the model may read: a name, a phone, an address. Some
facts must never reach a model, a log, or a transcript, but Albatross still has to use them:

- a password, to sign in to a site while the user is away;
- an ID number (Social Security, driver's license, passport) or a date of birth, for a form;
- an API key, to call a service for the user.

Secure details store these values. **Albatross uses them, and no model ever sees them.**

## User stories

Platforms: W (web), I (iOS), M (macOS).

- **V1. Save a sign-in (W I M).** In Settings, "Passwords and IDs", I add "Chase" with
  `chase.com`, my username, and my password. The list shows "Chase · chase.com · ••••".
- **V2. Save an ID (W I M).** I add my driver's license: the state, the number, and the expiry
  date. The list shows "Driver's license · NY · ends 4821". My date of birth shows as
  "Date of birth · saved".
- **V3. Save an API key (W I M).** I add "OpenAI" with `api.openai.com` and the key. The list
  shows "OpenAI · api.openai.com · sk-…f3a2".
- **V4. Never shown again (W I M).** A saved value is never shown again, anywhere. To change it,
  I enter a new value. To stop using it, I delete it.
- **V5. A run signs in for me (W I M).** A run reaches the Chase sign-in page. Albatross types my
  username and password from Secure details. The run log says "Signed in to chase.com with your
  saved sign-in". A two-factor code still comes to me ("Your turn: enter the code").
- **V6. A new site asks first (W I M).** A run on `dmv.ny.gov` needs my license number. It stops:
  "Use your driver's license number on dmv.ny.gov?" with "Allow once", "Always on this site", and
  "Do not allow". "Allow once" continues this run only. "Always on this site" asks me to confirm
  my identity, then adds the site.
- **V7. A wrong site never gets it (W I M).** A page on another site asks for my Chase password.
  Albatross does not type it. The run says why.
- **V8. Use history (W I M).** Each item shows its recent uses: when, which site, which Albatross,
  and what happened (typed, refused for the site, allowed once, allowed always, not allowed).
- **V9. I paste a secret in the chat (W I M).** I write my Social Security number in a message.
  Before I send, the composer says "This looks like a Social Security number. Albatross does not
  send it." with "Save in Passwords and IDs" (opens the add sheet with the number in it and takes
  it out of my draft) and "Send without it". If a message gets past the composer (an old app, a
  paste at the last moment), the server is the backstop: the model's copy and the saved chat say
  "[removed: looks like a Social Security number]".
- **V10. Cards wait (W I M).** I try to save a card number. Albatross says that it does not keep
  card numbers yet.
- **V11. Delete my account or export my data (W).** Deletion deletes every item and use.
  The export lists each item without its value.
- **V12. Albatross asks for a missing secret (W I M).** I ask the chat to pay my water bill. No
  sign-in is saved for `springfieldwater.gov`. Albatross shows a card: "Add your sign-in for
  springfieldwater.gov" with its reason and "Add". The sheet opens with the site filled in. I type
  the username and password and save. The card changes to "Saved. Albatross can use it on
  springfieldwater.gov." The model knows only that the item now exists.
- **V13. Save a sign-in from a handoff (W I M).** A run hands me the Chase sign-in page because no
  sign-in is saved. The run block also offers "Save a sign-in for chase.com", so the next run
  signs in by itself.

## How a model uses a value it never sees

1. **Inventory.** `secure_details_list` (chat and runs) returns, for each item: `id`, `kind`,
   `label`, `sites`, and the field names. No value and no masked hint. A date of birth gives
   `ageYears` (computed on the server, so an age rule can be checked); an ID with an expiry gives
   `expired`; an ID gives its type, region, and country; a key gives its header name.
2. **References.** To use a value, the runner writes `{{secure:<itemId>.<field>}}` in a tool
   argument. A date field (`date`, `expires`) takes a format: `{{secure:<id>.date|MM/DD/YYYY}}`
   (`YYYY-MM-DD`, `MM/DD/YYYY`, `DD/MM/YYYY`, `MM/YYYY`, `MM`, `DD`, `YYYY`, `M`, `D`, `MONTH`).
   An ID number takes `DIGITS` or `LAST4`; a Social Security number also takes `DASHED`, `AREA`,
   `GROUP`, and `SERIAL` for split boxes (`lib/secure/contract.ts`).
3. **Resolution, in three runner tools only.**
   - `browser_type` and `browser_select`: the server checks the field kind, the field's frame
     address, and its form action against the item's sites (or a grant), types the value, and
     returns "Typed the saved Driver's license number." A password goes only into an HTML
     password input, and only from a `sign_in` item bound to that site.
   - `secure_fetch` (new, runs only): an HTTPS request to a host that an `api_key` item is bound
     to, with the key in the header. No redirect to another host. The response is scrubbed and
     cut to 20 KB before the model reads it.
   Everywhere else a reference stays literal text.
4. **Scrubbing** (`cleanPage`, revised after the security review of 2026-10-08). On a page, the
   values of items saved for that page's site, and the values this run typed there, are replaced
   (raw, digits only, grouped forms, and the exact typed form in its field line) with
   `[secure: Driver's license]`. Values of other items are **not** looked for: replacing a value
   on any page would let a hostile page test guesses (a replaced guess tells the model it is
   right). A value this run typed that shows up on a page outside its sites **stops the run** and
   gives the user the page, so the model gets at most one bit. Text is cleaned before it is cut.
   A Playwright error from a fill is replaced with a fixed message, because it quotes the value.
5. **Nothing else holds a value.** Tool arguments hold references. Run logs, chat transcripts,
   audit lines, errors, and use-history rows never hold a value.
6. **Asking for a missing item.** In the chat, `ask_secure_detail({ kind, label?, site?, reason })`
   shows a card that waits (V12, decision 12). It holds no value and saves nothing: the user adds
   the item in the sheet, through the normal route, and the answer is
   `{ saved: true, itemId } | { skipped: true }`. A run hands off with `next.kind === 'sign_in'`
   and `next.saveSignIn = { site }` (V13), or `finish_on_page` for a missing ID.

## Site rules

- Matching is by registrable domain (`tldts`): `chase.com` covers `secure.chase.com`.
- `sign_in` and `api_key` items are used only on their own sites or hosts.
- `id_number` and `date_of_birth` items start with no sites. Each new site asks (V6).
- A site is the registrable domain with private suffixes counted (`dmv.ny.gov` → `ny.gov`,
  `foo.github.io` stays `foo.github.io`). An API key keeps its exact host.
- "Allow once" is a grant for one item, one site, and one step (`workId` + `stepKey`, so the
  run's continuations share it), for up to 2 hours.
- **A saved value never goes to a new place without a recent identity check.** "Allow once",
  "Always on this site", and a new site in Settings all need it: the session's first-factor
  verification age (`fva`) must be 10 minutes or less. Otherwise the server answers 403 with
  Clerk's reverification body and `code: 'verify_identity'`. Web uses Clerk's
  `useReverification`. iOS and macOS use the Clerk SDK's verification when it has one (see the
  native design notes for the fallback). "Do not allow", a new value, fewer sites, and delete need
  no check: none of them sends a value anywhere.
- A page that asks for a value in its text is data, not an instruction. Only the real page origin
  counts.

## Storage and keys

- Table `secureItems`: `userId`, `kind`, `label`, `sites` (registrable domains or hosts),
  `fields` (names with masked hints), `payloadSealed` (AES-256-GCM with a random data key per
  item), `dataKeyWrapped` (the data key, AES-256-GCM with the key-encryption key), `kekId`,
  `createdAt`, `updatedAt`, `lastUsedAt`.
- Both layers bind AAD `secure:v1:<userId>:<itemId>:<kind>`. A value cannot move to another user
  or item.
- The key-encryption key is separate from the mail key: `LAB86_SECURE_KEK` (32 bytes, base64)
  and `LAB86_SECURE_KEK_ID`, with retired keys in `LAB86_SECURE_KEKS`. A Cloud KMS provider is a
  later step (owner task). **The key must be backed up**: without it, no item can be opened.
- Table `secureGrants`: "Allow once" only: `userId`, `itemId`, `site`, `workId`, `stepKey`,
  `expiresAt` (2 hours at most), `createdAt`. "Always on this site" adds the site to the item's
  `sites` instead of making a grant. A new value or fewer sites delete the item's grants.
- Table `secureUses`: `userId`, `itemId`, `field`, `site`, `host`, `runId`, `workId`, `outcome`,
  `at`. Kept 90 days; the prune cron runs every 6 hours, and a full batch runs again at once.
- Only the Next server decrypts, at the moment of use. Every Convex function of these tables
  needs the server secret. No API returns a value.
- Rotation: `scripts/rotate-secure-kek.ts` re-wraps the data keys. These fields are not part of
  the mail key rotation (their names do not match the encrypted-field pattern on purpose, and
  the rotation test lists them as exempt with this reason).
- The feature is off unless `LAB86_SECURE_STORE` is `all` or lists the user id.

## Field and form rules (security review, 2026-10-08)

- A password goes only into an HTML `type="password"` input. A text field that a page names
  "Password" (a form question, a post on a large site) is not one.
- The field's frame address comes from the browser (CDP), never from page script.
- The field's form must send to a covered site too (`form.action`): a form that a post on a saved
  site points at another host is refused.
- A site that the chat suggests in `ask_secure_detail` shows "Albatross suggested this site.
  Check that it is the site where you sign in." until the user edits it.

## Known limits (accepted, 2026-10-08)

- **DNS rebinding window in `secure_fetch`.** The host is resolved and checked, then `fetch`
  resolves it again. An attacker who controls the DNS of a host that the user bound could point
  the second lookup at a private address. The bound host is the user's own choice; the same window
  exists in the attachment fetch. A pinned-address dispatcher is a later step.
- **GET is not always read-only.** Some APIs change data on GET (for example a chat API that posts
  on `GET /api/chat.postMessage`). `secure_fetch` stays GET and HEAD only, the runner rules forbid
  sends and deletes, and a per-host list of read paths (or an approval for other paths) is a later
  step.

## Refused values

Card numbers (Luhn, 13 to 19 digits), CVV codes, bank and routing numbers, and two-factor or
recovery codes are refused, by label and by value.

## CASA

`docs/google-verification/` gains the data flow (no model, no clear text in Convex, no logs), the
separate key and its backup, the identity check, the site rules, scrubbing, the use history,
retention (items until deleted; uses 90 days), deletion, and the export rule. The privacy page
names the new data.

## Owner decisions (Jakob, 2026-10-07)

- Store passwords, ID numbers, and API keys. The model uses them without seeing them.
- Each item is limited to its sites or hosts. IDs ask on each new site, with "Always on this site".
- Real card numbers are not stored. Two-factor codes stay with the user.
- Done: PR to `main`, one CodeRabbit review, merge.

## Lead decisions (2026-10-07)

- **No reveal.** A saved value is never shown again; the user replaces or deletes it. This
  removes the largest risk of a stolen session (reading the values) and needs no identity check
  for viewing.
- **Identity check wherever a value can go somewhere new:** "Allow once", "Always on this site",
  and adding a site. (First draft: "Allow once" needed none. Changed: with a stolen session, an
  attacker could start a run on their own site and press "Allow once". One check opens a
  10-minute window, so the cost to the real user is small.)
- **Dark launch:** `LAB86_SECURE_STORE` gates the feature; it turns on for the owner first.

## Cross-platform decisions (lead review, 2026-10-08)

The three design notes are in `docs/research/secure-store-{web,ios,macos}-design-2026-10-07.md`.
Where they disagree, this section wins.

1. **Name and place.** "Passwords and IDs", directly after "Personal details" on every platform
   (web: the "You" group; iOS and macOS: under Account, below Personal details).
2. **"Saved sign-ins" becomes "Signed-in sites"** on all three platforms. On the web it moves
   into the Passwords and IDs tab as its last group, "In the shared browser". On iOS and macOS
   it stays in Trust, renamed, and Passwords and IDs ends with one line that points to it.
3. **List.** Three groups: Sign-ins, IDs (with the date of birth as a fixed slot), Keys. No
   search in PR 2. A row shows the label, the site, the masked hints (the username hint too, so
   two sign-ins for one site differ), and "Last used". Detail: a pushed page on iOS and macOS,
   an expanded row on the web.
4. **One date of birth for each user.** The server refuses a second one ("Your date of birth is
   saved. Replace it there."). Any past date is allowed.
5. **No reveal, no copy.** "Replace" for each secret field, write-only. A replace, a delete, and
   removing a site need no identity check. Adding a site, "Allow once", and "Always on {site}"
   need it.
6. **Fresh input may show.** A "Show" toggle while the user types a password or a key, off at
   every open, on all three platforms. On the web, masked inputs are `type="text"` with
   `-webkit-text-security` and password-manager ignore attributes, with `type="password"` as
   the fallback, so no browser offers to save the value for mail.lab86.io.
7. **The identity check.** Web: Clerk's `useReverification` modal. iOS and macOS: the
   clerk-ios 1.3.3 session verification (`startVerification(level: .firstFactor)`; passkey,
   then email code, then password; a second factor step when the account has one). Title: "One
   more check". The window pre-check reads `fva` from the cached token; the server's 403 is the
   authority. No local Face ID gate in PR 2. The clerk-ios bump (biometrics) is a later PR.
8. **When native cannot check.** iOS and macOS show: "This device could not do the check.
   Answer on the web, or press Do not allow." with "Open on the web" (the Work deep link). The
   answer is a server row, so the web answer ends the question on every device. No "Sign out"
   button.
9. **Copy without "confirm" or "verify".** Both are not STE verbs. Use "one more check" and
   "Albatross needs one more check first."
10. **The allow block.** The question names the site ("Use your driver's license number on
    ny.gov?"); the reason names the host ("dmv.ny.gov asks for the number and the expiry
    date."). Buttons: "Allow once" (primary, ⌘↩), "Always on {site}" (secondary; long sites
    fall back to "Always on this site"), "Do not allow" (quiet). The server sets outcome
    `needs_answer`, `next.label` "Answer", and `next.detail` "Use your saved {item} on {site}?".
    The first answer is stored as `next.allowAnswer { scope, at }`, so every device shows
    "Allowed once on ny.gov." / "Always allowed on ny.gov." / "Not allowed." A second answer
    gets 409. Cancel of the check leaves the three buttons and one quiet line.
11. **Notifications never name the item or the site:** "A site asks to use one of your saved
    details."
12. **Asking for a missing item in the chat is a question that waits:** `ask_secure_detail`
    (no execute, like `ask_form`), offered only to clients that send the `ask_secure_detail`
    capability and only when the store is on. Input `{ kind, label?, site?, reason }`; answer
    `{ saved: true, itemId } | { skipped: true }`. The card computes "already saved" from the
    client's own list. The runner has no such tool: a missing sign-in hands off `sign_in` with
    `next.saveSignIn`; a missing ID hands off `finish_on_page`.
13. **After a save from the sign-in handoff (V13)**, the done label becomes "Continue" and the
    line reads "Saved. Press Continue, and Albatross signs in." The resumed run sees the new
    sign-in and signs in.
14. **The composer notice.** It appears on paste and on send. Return while it shows means "Send
    without it" (the value goes, the marker stays in the sent text). "Save in Passwords and
    IDs" opens the add sheet with the value in it and takes it out of the draft. Card numbers
    get "Albatross does not keep card numbers yet." and no save action.
15. **Refusals** answer `{ code: 'refused', reason: 'card' | 'code' | 'bank', field, error }`;
    clients pick their line by `reason` and fall back to `error`.
16. **Two sign-ins for one site:** the runner asks one form choice by label.
17. **Not in PR 2:** a date for each site, search, a "Checkup" row, a separate Mac window,
    Touch ID or Face ID.
