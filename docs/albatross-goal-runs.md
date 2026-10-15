# Albatross goal runs

Status: design, 2026-10-15. Owner decisions are from Jakob on 2026-10-15.
Research: `docs/research/browserbase-auth-files-2026-10-15.md` (Browserbase sign-in, files, and research).

## Why

Jakob tried the StatPearls invoice goal on 2026-10-14. The goal needed an email, an invoice,
a W-9, and a direct deposit form. Albatross failed in five ways:

1. It did not talk. A run is told "The user is not watching". The text that the model writes
   between tool calls is discarded. The user sees fixed log lines and a summary of one to three
   sentences.
2. It made one thing at a time. A run works on one plan step. A handoff has one `next` and one
   `target`. Document mode opens one document. Three runs made three copies of one invoice.
3. It could not get the W-9. `browserbase_fetch` returns page text only. No tool saves a PDF in
   Files. No tool fills a PDF form.
4. The invoice looked unofficial. Each Word file starts empty, and the model types each line.
5. Numbers had no source. The hours 48, 78, and 132 appeared with no mail, file, or page behind
   them.

## Owner decisions (2026-10-15)

- D1. "The smart models don't need to plan anymore." Remove the step plan. A run works on the
  whole goal. No plan is generated first. The model keeps its own short checklist while it works.
  The Work page and the thread show that checklist.
- D2. Browserbase is the only way that Albatross reaches the web: search, page reads, file
  downloads, and work on sites where the user is signed in. Browserbase supports sign-in well, so
  sign-in, research, and file downloads use one Browserbase layer.
- D3. All at once. Talk, the package handoff, document templates, web files, PDF fill, and
  research ship in one round. PRs split only for the CodeRabbit limit of 150 files.

Earlier decisions that stay: one thread for each Work; the secure store (the model never sees a
value); no payment, no e-signature, and no mail send without the user; per-platform builds (web,
iOS, macOS) in the same round; no "AI" in user copy; no icons before text; no ALL-CAPS labels.

## The design in one paragraph

A Work has a goal and an outcome contract. It has no steps. The user presses "Handle it", or an
automatic trigger starts a goal run. The run works on the whole goal with all its tools. It
writes short messages into the thread while it works, and each message carries its sources. It
keeps a checklist that the user can read. It can make many things in one run: drafts, Word files,
sheets, decks, saved web files, and filled PDFs. It ends with one handoff that holds a package of
items. Each item has a state: ready, has blanks, or needs your check. The user opens each item in
a tab in document mode. The email draft carries the other files as attachments.

## G1. Goal runs (no step plan)

### Identity

- A goal run uses the run row that exists. `stepKey` is `goal`. `stepIdentity` is `goal:<workId>`.
  `stepTitle` is the Work title. No schema migration is necessary for these fields.
- The Work keeps a plan row, but the row has zero actions. `planReady` stays true, so the work
  conductor does not plan the Work again (`lib/albatross/execution.ts:70-78`).
- The guard "one open run for each Work" stays.

### Switch

- `LAB86_GOAL_RUNS` is `all` or a comma list of user ids. It is off when empty.
- For a user in the switch:
  - `advanceWork` does not call the plan model. It saves a plan row with zero actions and an
    outcome contract from `proposeContract` (deterministic). The run can change the contract
    with the tool `goal_update`.
  - Every run is a goal run. Old open steps become the first checklist of the first goal run.
    Done steps stay done and show in the history.
- For other users, nothing changes. Native apps show both kinds.

### Start

- "Handle it" starts a goal run. The thread shows "Handle it" when no run is open and no
  handoff waits for the user. It does not need a step.
- Automatic triggers (Brief and conductor, behind `LAB86_STEP_RUNS_AUTO`) start a goal run for a
  Work that has no run yet, or whose last run stopped at its time or cost limit. They do not
  start a run while a handoff waits for the user. Automatic dedupe uses `goal:<workId>:<local date>`.
- A user message in the thread steers an open run, as today. With no open run, the message
  starts a goal run when the user asks for work ("do it", "make the invoice"). The chat reply path
  decides this as today (`handleStepFromThread`).

### Budget

- Default limits for a goal run: 30 minutes, $8, 120 model steps. Environment overrides stay.
- At the limit the run hands off with `continue`, as today. The next run reads the checklist and
  the messages of the earlier runs and goes on from there.

### Done

- `done` means the goal's outcome contract holds now. `proveDone` uses the contract outcome and its
  proofs as the requirement. Proof attaches to the Work with `targetKind: 'work'`. The contract
  closes the Work by its `closeWhen` rule, as today.
- `ready_for_you`, `your_turn`, and `needs_answer` keep their meaning.

### Checklist

- New runner tool `checklist_set`: the model sends the full list each time. Each item has
  `text` (max 120 characters) and `state` (`todo`, `doing`, `done`, `yours`). Max 12 items.
  `yours` marks a part only the user can do.
- The run row stores the newest list. The Work detail shows the newest list of the newest run.
- The checklist is the model's own record. It is not a contract. The user cannot check items
  off. The user tells Albatross in the thread.

## G2. Talk

### Run messages

- The runner keeps the text that the model writes in each model step (`onStepFinish`,
  `stepResult.text`). Each non-empty text becomes a run message. No new tool.
- Run message: `{ id, at, text, sources }`. `text` max 1,500 characters. Max 40 messages on a
  run row. Older messages fold into "Earlier messages" on the client; the row keeps the newest 40.
- The server attaches sources. The sources of a message are the things that the model read in
  the tool calls of the same model step and of the steps since the previous message:
  - `browserbase_fetch`, `web_research`, `web_file_save`: `web` (title, URL).
  - `read_thread`, `get_thread`, `get_message`: `mail` (subject, sender, thread id, account).
  - `jira_read_issue`, `atlassian_search` hits that were read: `jira` (key, title, URL).
  - `document_get`, `word_document_get`, `google_document_get`, `cloud_file_search` opened:
    `file` (title, id or URL).
  - `calendar_event_detail`: `calendar` (title, id).
  - Max 8 sources on one message. Same URL or id only once.
- The run message, the log, and the summary all pass through the secure redaction as today.

### What the model is told

The prompt says:

- The user reads the thread while you work. Write to the user like a capable coworker.
- Before a group of tool calls, say in one sentence what you look for.
- When you find a fact that matters, say it with the number or the name, and where it came from.
- When you decide something, say why in one sentence.
- When you are not sure, say so. Do not invent.
- Do not narrate each tool call. Do not repeat the log.
- Propose values that you can find or compute (the next invoice number from earlier invoices,
  today's date, work summaries from Jira and Bitbucket). Ask only for what you cannot find.

### The end of a run

- The handoff gets `unsure`: max 4 short lines, each one a thing the user must check. Example:
  "I found no mail with the hours for July. I used 78 from the Jira worklog."
- The summary stays. The client shows: messages, then the package, then "Not sure", then the
  main button.

## G3. Many things at once: the package handoff

### Handoff items

- The handoff gets `items`: max 8. Each item:
  - `kind`: `draft`, `document`, `sheet`, `deck`, `file`, `approval`, `event`, `page`.
  - `id`, `url`, `accountId`: as on `target` today.
  - `title`: max 120 characters.
  - `state`: `ready` (nothing left for the user), `blanks` (fields to fill), `check` (the user
    must read it before it goes out).
  - `blanks`: max 6 names, as `next.blanks` today, but for this item.
  - `note`: max 200 characters, optional. One sentence about this item.
- `next` stays the main action. Old native builds read only `next`; they keep working.
- When the model gives no `items`, the server builds them from the run artifacts: each draft,
  document, deck, file, approval, and event. `next.target` comes first.
- `RunArtifact` gets the kinds `deck` and `file`. A deck from `document_create` with kind `deck`
  records as `deck`. A file from `web_file_save` or `pdf_form_fill` records as `file`.

### One document, not three

- The run context lists the artifacts of earlier runs of the same Work, with ids.
- The prompt says: change the existing draft or document with the edit tools. Make a new one only
  when the user asks for a new one.

### Decks in a run

- The runner gets `presentation_plan` and `document_review_slides`.
- The runner passes a presentation session with the choices delegated, so `presentation_plan`
  does not ask for pickers. The deck goes into the package with state `check`.

### Attachments on drafts

- `Draft` gets `attachments`: max 10. Each one: `{ source: 'file', fileId, provider, format, name }`.
  `provider` is `office` (a Word, Excel, or PowerPoint file), `upload` (a saved file such as a
  PDF), or `albatross` (an Albatross document). `format` is `pdf` or the native format.
- `save_draft` and `update_draft` accept `attachments` with file ids from this run or from Files.
- At send time the server reads the bytes from storage. A Word file with `format: pdf` converts
  through the document server first. The send path does not fetch a URL that a model gave.
- The web, iOS, and macOS composers show the attachments as removable rows and keep them when the
  user changes the draft.

## G4. Official documents (templates)

From the review of 2026-10-14 (`/home/jjalangtry/.claude` memory `official-documents-2026-10-14`):

- `word_document_create` gets `template`: `invoice`, `letter`, `memo`, `report`. With a template,
  the model sends typed `data` and the server renders the file. The model sets no font, size, or
  border.
- One renderer for each template in `lib/documents/templates/`. House type: Fraunces Display for
  the title and the total, Geist for body text. Tokens from the prototype: ink 1F1D1A, muted
  6B665D, rule D9D3C7, accent AE4B2B, tint F6E9E3. Letter page, 0.8 inch margins.
- The fonts are embedded in the DOCX, so Word and Pages on other computers show the same type.
- An empty value becomes a Word content control (`w:sdt`) with the tag `blank:<slug>`. The item
  `blanks` names come from the same list. A new `word_document_edit` op `fill_blank` writes a
  value into the control. A new read `blanks` returns the current value of each control. The blank
  rows in the thread and the document then show the same values.
- `document_export` gets `format: 'pdf'` for Word files. The document server makes the PDF
  (Collabora `convert-to`). The PDF is a `file` item when the run attaches it to a draft.
- Page numbers: emit the field runs one by one (begin, instruction, separate, end), each with the
  footer size. The `docx` library joins them in one run, and LibreOffice then uses the body size.

## G5. The web layer (Browserbase only)

Details and probe results: `docs/research/browserbase-auth-files-2026-10-15.md`.

- One module, `lib/web/browserbase.ts`, owns every call to Browserbase: search, fetch, sessions,
  contexts, downloads, and requests inside a session. `lib/tools/web.ts`, `browser-agent.ts`,
  `browser-session.ts`, and `deck-render.ts` use it.
- A model-given or content-given URL never goes to a plain server `fetch`. A test scans `lib/` and
  `app/` and fails when a new direct outside fetch appears outside an allow list of first-party
  APIs (Google, Nylas, Convex, the model gateway, Atlassian, Slack, GitHub, Bitbucket, Clerk,
  Resend, Apple, the document server, Browserbase).
- Moves:
  - `fetchWebFile` (mail attachments from a URL) goes through `web_file_save`, then attaches the
    saved file.
  - The Nominatim reverse geocode goes through Browserbase, or the client sends the city. The
    research report decides.
  - `secure_fetch`: the research report decides if it runs inside a Browserbase session with
    the secret substituted on the server. If a secret must stay off Browserbase, the report says
    why, and this document records the exception.

### New runner and chat tools

- `web_research`: input `{ question, queries (1 to 6), sites? }`. It runs the searches in
  parallel, reads the best pages in parallel (fetch first, a session for pages that need
  JavaScript or a sign-in), and returns numbered sources with short passages. Pages on a
  signed-in site use the user's Browserbase context, read only.
- `web_file_save`: input `{ url, name? }`. It downloads the file in a Browserbase session (the
  user's context when the site is a signed-in site) and saves it in Files (`agentUploads`) with
  the source URL, the time, the size, and a SHA-256. It refuses private hosts. It prefers the
  issuer's own site (irs.gov for IRS forms). Max size 25 MB. Types: PDF, DOCX, XLSX, PPTX, CSV,
  PNG, JPEG.
- `pdf_form_fields`: input `{ fileId }`. It returns the fillable fields of a PDF (name, type,
  options, current value, page) and a short label for each field.
- `pdf_form_fill`: input `{ fileId, values, title? }`. Each value is plain text, a choice, a
  check, a personal detail key, or a secure reference `{{secure:<id>.<field>}}`. It writes a new
  file. It never signs. A signature field becomes a blank for the user.

### Secret values in a PDF

A filled W-9 holds a tax ID. Files are not encrypted with the secure store key. So:

- The saved PDF never holds a secure value. A field with a secure reference stays empty in the
  saved bytes, and the file keeps a sealed fill list: `{ field, ref }`.
- The value goes into the PDF only in memory, when the user downloads the file or when the mail
  sends with the file attached. The secure store rules apply at that moment: the item must be
  allowed for the recipient's domain (send) or the user passes "One more check" (download).
- The item state is `check`, and the item note says which fields fill at send time.

## G6. Fixes from the 2026-10-14 screen

- The raw "Applied N of the plan's actions. N failed: … (Invalid JSON response)" banner shows
  plain copy and keeps the detail in the log (`lib/tools/albatross.ts`).
- The run history shows each run once, in time order. A goal run header is the time and the
  state, not "Step N".
- A stopped run shows no "Handle it" on its own block.
- Production turns on `OFFICE_THEMED_CHROME` after a check on main.

## Contract summary (shared by web, iOS, macOS)

Run view (`stepRunView`, `ThreadRunView`, Swift `StepRun`) gets, all optional:

- `goal: boolean`
- `messages: Array<{ id: string; at: number; text: string; sources: RunSource[] }>`
- `checklist: Array<{ id: string; text: string; state: 'todo' | 'doing' | 'done' | 'yours' }>`
- `items: Array<HandoffItem>` (the package; see G3)
- `unsure: string[]`

`RunSource`: `{ kind: 'web' | 'mail' | 'file' | 'calendar' | 'jira' | 'document'; title: string;
url?: string; id?: string; accountId?: string }`.

Work detail gets `goalRuns: boolean` and `checklist` (from the newest run). Swift decodes the new
fields as optional; unknown enum values decode as `.unknown`.

## Out of scope

- Payment cards and payments.
- E-signature.
- Parallel runs on one Work. The package covers the case of many things at once.

## Tests

- Runner: goal key, checklist tool, message capture with sources, items built from artifacts,
  `unsure`, done against the contract, budget defaults, deck tools in the list, old step runs
  unchanged.
- Start: "Handle it" with no step, automatic dedupe for each day, no automatic run while a
  handoff waits.
- Templates: each template renders, fonts embed, blanks become content controls, `fill_blank`
  round trip, page number runs, PDF export call.
- Web: the egress scan, `web_file_save` (types, size, private hosts, hash), `pdf_form_fields`,
  `pdf_form_fill` (no secure value in saved bytes, sealed fill at send).
- Drafts: attachments save, survive an edit, and send.
- Native: decode the new fields, zero steps is not "planning" for a goal Work, package rows,
  document mode tabs.

## Tool results (shared shapes)

The runner records artifacts and sources from these results, so every builder uses them as written.

- `web_file_save` and `pdf_form_fill` return
  `{ ok: true, fileId, title, openPath, size, contentType, sourceUrl?, sha256, sealedFields? }`.
  `fileId` is the `agentUploads` id. The runner records a `file` artifact and a `web` source
  (`sourceUrl`).
- `pdf_form_fields` returns `{ ok: true, fileId, fields: Array<{ name, label, type, options?, value?, page }> }`.
  `type` is `text`, `check`, `choice`, `radio`, or `signature`.
- `web_research` returns `{ ok: true, sources: Array<{ n, title, url, passage, signedIn? }>, failed: string[] }`.
  The runner records each source that has a passage as a `web` source.
- `word_document_create` with a template returns the result of today plus `blanks: string[]`
  (the names of the content controls, in page order).
- `document_export` with `format: 'pdf'` returns `{ ok: true, fileId, title, openPath, size }`
  for a new saved PDF (`agentUploads`), so the PDF can go into a package and onto a draft.

## Lead decisions during the build (2026-10-15)

These decisions change or add to the sections above. The code follows them.

- Goal handoff buttons: the second button is "Done, continue", never "Mark done". It tells
  Albatross that the user did their part. The server closes the handoff and queues a goal run
  that checks the outcome contract first. The Work closes only when the proofs hold. With no
  items and no `next`, the button is "Continue". Step runs keep "Mark step done".
- Start: a goal Work starts with `POST /api/albatross/work/<id>/run` and `{ "action": "start" }`,
  with no step key. "Done, continue" is `POST /api/albatross/work/<id>/step` with
  `{ "stepKey": "goal", "continue": true }`.
- Closing a goal Work: a goal run settles a contract proof only with evidence that the run
  observed in its own tool results, its own files, or the open page. The words of the model never
  count. The mail watch also watches goal Works against their open proofs. A contract that closes
  `outcome_confirmed` still needs the user's confirmed word.
- Sources: `RunSource.detail` is a short locator that the server computes: the host of a web
  page, the sender and the date of a mail in the user's time zone, the Jira key, or the date of an
  event. Clients show it after the title, with no dot, and hide it when the title already holds it.
- Opening items: drafts, approvals, events, and cards open by kind and id with the existing in-app
  handlers. The server `url` is the fallback for documents, saved files, and pages. A saved file
  opens at `/?view=files&file=<id>`.
- Packages in lists: a package of two or more items opens the thread in document mode, with one
  tab for each item. A lone item opens in place. The Documents page lists each waiting document,
  sheet, deck, or file item as its own row, and the row opens the thread on that item's tab.
- Send permission: a sealed value goes into a mail only with a send grant: "Allow for this send"
  (single use, 30 minutes at most) or "Always for mail to <domain>". Both need the identity check.
  A send grant never lets a run type the value on a website, and a site grant never lets a mail
  carry it.
- Sealed previews: a preview of a sealed file shows the stored bytes, where the sealed field is
  empty, with no check. Its sealed field names come in `x-sealed-fields`. Download and send fill
  the value in memory after the check.
- Documents: the templates are ink on white with one accent (216440, the app accent) on the
  total rule and the blank underline. The sender shows once, in the masthead. "Subtotal" shows only
  with an adjustment line.
- Web: Browserbase sessions keep no logs (`logSession: false`). `secure_fetch` through a
  Browserbase session stays behind `LAB86_SECURE_FETCH_BROWSERBASE`, off at deploy.
- Copy: no new strings joined with middle dots. The current checklist item shows once.
