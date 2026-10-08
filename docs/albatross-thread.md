# The Albatross thread (PR 1)

Status: design, 2026-10-07. Branch `claude/albatross-chat`. Owner decisions are at the end.
The secure store for passwords, ID numbers, and API keys is PR 2 (`docs/albatross-secure-store.md`).

## Why

On 2026-10-07 a dogfood run of the step runner showed these problems, in order (the example
below is invented):

1. The run chose the date. It opened the form for the first open class (Saturday, October 17).
   It did not ask, and it did not read the calendar. Jakob wanted a Monday or a Wednesday.
2. The run stopped at the wrong boundary. It said that only the user can enter personal details.
   Only the $45 payment belongs to the user. Albatross must type the name, address, phone, and email.
3. Albatross did not know the user. The name and email are on the account. The user had to type
   all four details.
4. Two agents did not connect. The run can act but cannot talk. The chat can talk but cannot act.
   The chat found the correct class (Monday, October 19) and offered to email the provider. The
   page still showed the empty October 17 form.
5. The chat said "Your details are saved". No store for personal details existed.
6. The Work page had three "Continue" buttons and two "Discuss this" buttons. The same sentence
   appeared twice. The chat panel covered the form that the user had to see.

## The idea

An Albatross is one conversation. Albatross does the work in background runs, and each run
reports into the conversation. The user talks to one Albatross, not to a chat and a runner.

- The conversation is the Work page. The Guided work page goes away.
- A run appears in the conversation as it works: what it does now, the page it uses, and the
  one thing that it needs from the user.
- A question is a form in the conversation, with typed fields and real choices.
- A message from the user reaches a run that works now.
- Albatross knows the user's personal details and types them into forms.
- The plan, the files, and the proof move to a side panel.

## User stories

Each story names the platform surfaces that must support it: W (web), I (iOS), M (macOS).

### Open and read

- **S1. Open from anywhere (W I M).** I open an Albatross from the list, the Brief, Today, an
  Area, a notification, or a chat card. The conversation opens at its newest item. When a run
  waits for me, its question or action is the last item, next to the composer.
- **S2. A new Albatross (W I M).** I captured "register for CPR and first aid before Nov 14". The
  conversation opens with what Albatross understood: the outcome and the plan, in one compact
  block. The current step offers "Handle it". While the plan is not ready, the block says that
  Albatross makes the plan, and the composer works.
- **S3. The plan at a glance (W I M).** A short line at the top says where I am: "Step 1 of 2 ·
  Your turn". I open it to see all steps with their states (done, now, next). Each runnable step
  offers "Handle it". A done step shows its proof line.
- **S4. Older chats (W I M).** I discussed this Albatross before this change. The newest of those
  chats becomes the conversation. The older ones stay in chat history.
- **S5. Away and back (W I M).** The morning Brief started a run while I slept. I open the
  Albatross. I see what happened, in order: the run, its summary, the files it made, and its
  handoff at the bottom. The notification took me to the same place.

### Work with a run

- **S6. Start (W I M).** I press "Handle it", or I write "go ahead and register me". A run starts.
  A live block shows "Working on: Register for the course", with its newest lines. I can stop it.
- **S7. Watch the page (W I M).** The run opens a site. On web and Mac, the page opens in a pane
  beside the conversation. On iPhone, a row in the run block opens the page in a sheet. The pane
  says who has the page: "Albatross is on the page" or "Your turn". "Take over" is always there.
- **S8. Talk while it works (W I M).** While the run works, I write "use the Monday class". My
  message reaches the run. The run log shows that it read my note. Albatross answers in one
  short line. No second agent appears.
- **S9. A choice that is mine (W I M).** The run found three classes before November 14. It does
  not choose. It reads my calendar and asks one form: which class? Each option shows the day,
  time, and price, and "Free on your calendar" or "Conflicts with Team sync". The first option
  is the one that matches what I said before ("Monday or Wednesday").
- **S10. Missing details in the same form (W I M).** The same form asks only for what Albatross
  does not know. My name, email, and address are filled in from my details. The phone field is
  empty. "Save to my details" is on. I submit once.
- **S11. Answer in my own words (W I M).** I ignore the form and write "Monday works, my phone is
  607 555 0100". Albatross saves the phone, shows "Saved to your details: Phone" with "Undo", and
  continues the run. The form shows that the chat answered it.
- **S12. Sign in (W I M).** The site asks me to sign in. The run stops and says "Sign in to
  firstaidclass.example.com in the page, then press Continue". The page pane opens. I sign in and press
  "Continue", or I write "done". The run continues. Next time the site still knows me.
- **S13. The final page (W I M).** The run filled the form for Monday, October 19. It stops
  before the payment: "Everything is filled in. Check it and pay the $45." One button opens the
  page. After I pay, I press "I paid". The run checks the page and marks the step done with its
  proof (the confirmation text).
- **S14. Drafts and documents (W I M).** The run wrote a draft to the pool manager. The draft is a
  card in the conversation with "Read and send". A document is a card with "Open".
- **S15. Done (W I M).** The step is done. The conversation shows the proof line. The plan line
  moves to the next step. Albatross says what comes next in one sentence.
- **S16. Failed or stopped (W I M).** The run failed or used its time. The block says why in plain
  words and offers "Try again" or "Continue".

### Talk about the Albatross

- **S17. Ask (W I M).** I ask "when is the orientation?". Albatross answers from the Work, my mail,
  and my calendar, like the chat does today.
- **S18. Change the plan (W I M).** I write "I already registered, skip that". Albatross records
  the progress and moves the plan. The plan line updates.
- **S19. Details (W I M).** I open the side panel to see the plan document, the files Albatross
  made (with Undo), the proof, and the commitments. Split, Put it down, the horizon, and "Mark
  done" are in the header menu.

### Personal details

- **S20. It knows me (W I M).** A form asks for my name, email, phone, and address. Albatross
  types them. It does not ask me.
- **S21. Settings (W I M).** Settings has "Personal details". I see my name, email, phone, home
  address, and emergency contact, each with where it came from ("From your account", "You told
  Albatross on Oct 7"). I add, change, or delete each one. The page says that Albatross types
  these into forms, and that it never saves passwords, card numbers, or ID numbers here.
- **S22. Found in my mail (W I M).** Albatross finds my phone in my email signature. It does not
  use it silently. It fills the form field with it and says "From your email signature". When I
  submit with "Save to my details" on, the phone is saved.
- **S23. My legal name (W I M).** My account says "Sam rivera". In Personal details I correct
  it to "Sam Rivera". Forms use the corrected name. My account name does not change.
- **S24. Something it must not keep (W I M).** I write my Social Security number in the chat.
  Albatross does not save it in Personal details. It says that it cannot keep that number yet.
  (PR 2 adds the secure store and moves this story there.)

## How it works

### One voice, background runs

Every message in the conversation goes to the Albatross chat agent with the Work attached. The
chat agent answers, and it controls runs with one tool:

- `albatross_handle_step({ workId, stepKey?, note?, stop? })`
  - A run is open: the note goes to that run (a steer note). Result `steered`.
  - The newest run of the step waits on a handoff: resume it with the note. Result `resumed`.
  - Otherwise: start a run with the note. Result `started`.
  - The tool result carries `runId`. Its tool shape is `step_run`, so the run block renders
    in place inside the message.
- `albatross_handle_step({ workId, stop: true })` stops the open run and gives the page to the
  user. (Stop is part of the same tool, so the chat stays inside the 128-tool limit.)

The runner reads new steer notes between its model steps (`prepareStep`) and writes a log line
when it uses one. Steer notes are capped (10 for each run, 2,000 characters each).

Runs keep all PR #319 behaviour: triggers, limits, the lease, saved sign-ins, the evidence gate,
and the hard stops.

### The timeline

The conversation is two sources merged by time:

1. The chat messages of the Work's canonical chat session, id `work-<workId>`.
2. The Work's runs, newest 30 (`GET /api/albatross/work/[workId]/runs`, and the live Convex
   query `albatrossStepRuns.runsForWorkHistory` on web and Mac).

Rules:

- Every message carries `metadata.createdAt` (milliseconds). The server sets it on assistant
  messages in the stream start chunk. The client sets it on user messages. A message without it
  (older chats) sorts before every run.
- A run sorts by `createdAt`.
- A run that a message started (an `albatross_handle_step` tool part with that `runId`) renders
  inside that message, not a second time in the merged list.
- A resumed run is a new run (`parentRunId`). It renders as a continuation of the block before
  it ("Continued").

Saving: the server merges a save of a `work-*` session with the stored copy by message id, so
two devices do not delete each other's messages. The client sends `baseUpdatedAt` (the `updatedAt`
of the copy it has). The saved list wins for every id it holds; a stored message that the save
lacks stays only when it is newer than `baseUpdatedAt` (another device wrote it), and an older one
goes (a retry or an edit removed it). The response carries `mergedMessages` (the kept ones); the
client adds them to its list, so its next save does not drop them.

### Questions are forms

One question shape serves the chat and the runner: `FormQuestion` in
`lib/albatross/thread-contract.ts`.

- Field kinds: `choice`, `text`, `number`, `phone`, `email`, `date`, `name`, `address`,
  `contact`.
- A `choice` option has a label, an optional detail ("4:00–8:00 PM · Zoom · $45"), and an
  optional calendar note with `fit: 'free' | 'conflict'`.
- A field can bind to a personal detail (`detailKey`). The client fills an empty bound field
  from the saved details. When a bound value is new or different, the form shows "Save to my
  details", on by default.
- The answer is `FormAnswer { values, save }`.

Chat: the HITL tool `ask_form` (no execute). The answer comes back as the tool output. The agent
route saves bound values when `save` is true, before the model continues.

Runner: `step_handoff` with outcome `needs_answer` carries `question.form`. The server stores
it on the Work question (`albatrossWorkQuestions.form`). The answer route takes
`{ form: FormAnswer }`, saves bound values when `save` is true, and resumes the run with a note
that lists the answers.

Older single-choice questions (the planner's) render as a form with one `choice` field and
"Other".

### Personal details

A per-user store of facts that forms ask for. The model may read them, because it must reason
with them (which state, which time zone). They are encrypted at rest.

| Key | Value | Notes |
|---|---|---|
| `name` | `{ first, middle?, last }` | Default from the account until the user saves one. |
| `email` | string | Default from the account's primary email. |
| `phone` | string (E.164 when possible) | Split into parts for split phone inputs. |
| `home_address` | `{ line1, line2?, city, region, postalCode, country }` | `country` is ISO 3166-1 alpha-2. |
| `emergency_contact` | `{ name, phone, relationship? }` | Common on registration forms. |
| `custom:<slug>` | `{ label, value }` | Plain facts only, for example "Employer". |

- Storage: Convex table `personalDetails`, one row for each key. `valueEncrypted` holds the
  `encryptSecret` output of the JSON value (AES-256-GCM, key id). Convex never holds the clear
  value. Decryption happens only in the Next server.
- Refused: passwords, one-time codes, card numbers, bank and routing numbers, Social Security
  and other ID numbers. The check runs on save (label and value patterns). The user sees "Albatross
  does not keep this number here."
- The model gets a short block in the system prompt: the name, the email, and the names of the
  other saved details (not their values). It reads the values with `personal_details_get` when a
  task needs them. This keeps phone and address out of every chat turn.
- Tools: `personal_details_get({ keys? })`, `personal_details_save({ details, source })`.
  The save tool takes only values that the user wrote or confirmed in this conversation. Its
  `receipt` shape (surface `memory`, `target.personalDetails`) shows "Saved to your details: Phone"
  with "Undo" (action `undo_personal_details`, which posts `{ action: 'undo', key }` to
  `/api/personal-details` for each key). `personal_details_get` has no card, and saved chats drop
  its output, so the values do not stay in chat history.
- API: `GET/PUT/DELETE /api/personal-details` (signed-in user, rate limited).
- Account deletion deletes the rows. "Export my data" includes the decrypted values.

### The runner learns three rules

1. **Personal details.** Before it fills a form, it calls `personal_details_get`. It types every
   detail it has. It asks only for the missing ones, all in one form.
2. **Choices that belong to the user.** When a choice depends on the user's preference (a date,
   a time, a plan, a price tier, one of several matches), it does not choose. It reads the
   calendar for each option and asks one form. It chooses alone only when the user already said
   what they want and exactly one option fits. Then it says why.
3. **What the user said.** The run context includes the last user messages of the conversation,
   so a preference said in the chat ("Monday or Wednesday") reaches the run.

The boundary text changes: personal details are not "only you". Payment, signature, password,
and one-time codes are.

### The page pane

The shared browser keeps PR #319 behaviour. The pane shows the live view, who has the page, and
the actions: "Take over" while Albatross has it; "Continue" and "Check the page" when it is the
user's turn; "Close the page" to end the session.

## Surfaces

Each platform has a design note from its own research (Mobbin and reference products):

- Web: `docs/research/albatross-thread-web-design-2026-10-07.md`
- iOS: `docs/research/albatross-thread-ios-design-2026-10-07.md`
- macOS: `docs/research/albatross-thread-macos-design-2026-10-07.md`

Removed: the Guided work page (`GuidedStep.tsx`), the step-run card stack in `WorkDetail.tsx`, the
floating chat over the Work page, and the "Find my next step" launcher on the Work page.

## Cross-platform decisions (lead review, 2026-10-07)

These settle the open questions of the three design notes. Every platform follows them.

1. **"Handle it" calls the run route directly** (`POST /run { action: 'start' }`). No model turn, no
   synthetic user message. Written requests go through the chat agent and `albatross_handle_step`.
2. **The recommended option.** `FormOption.recommended` is the tag text ("Matches what you said",
   "Earliest free class"). The client shows the tag and selects that option first. Only one option
   in a field has it.
3. **Runner questions have no Skip.** The form has one primary button (`submitLabel`, default
   "Continue"). The run block keeps its quiet "Dismiss". A chat `ask_form` has "Skip" (it answers
   `{ skipped: true }`).
4. **One quiet word: "Dismiss"** (not "Not now"), the same as the Brief.
5. **No "Check the page" in the thread.** On the user's turn the primary button is `next.doneLabel`
   ("I paid", "I signed in"), default "Continue". It resumes the run, and the run checks the page
   with the evidence gate.
6. **Run state copy** (no -ing forms): queued "Starts soon", running "In progress", handed off
   "Your turn" / "Needs your answer" / "Ready for you", done "Done", failed "Did not finish",
   stopped by a limit "Stopped", cancelled "Stopped by you". The Brief's "Working on: {step}"
   changes to "In progress: {step}" on all three platforms.
7. **The log disclosure** is "What Albatross did" with the count as a quiet number, no unit word.
8. **Steer notes.** The user's message shows as a normal bubble. The run log shows
   "Read your note: …" when the run uses it. No extra "sent to the run" line.
9. **Answered in the chat.** `ThreadQuestion.answeredIn === 'chat'` renders the receipt
   "Answered in the chat."
10. **Older chats.** Messages without `metadata.createdAt` sit under one divider, "From an earlier
    chat".
11. **Composer placeholder by state:** waiting on an answer "Answer here, or tell Albatross what to
    change"; a run in progress "Tell Albatross what to change"; otherwise "Tell Albatross what to do".
12. **Jump pill:** "Newest" when the user scrolled up; "Albatross needs an answer" when a pending
    form is off screen.
13. **The page pane opens by itself** only for a run that the user started from this view, or when
    the user presses the page row. A run from the Brief or the conductor never opens it.
14. **One trailing pane** on wide screens: the page or the details, not both. The page displaces the
    details.
15. **No floating chat on the thread.** The corner chat and its launcher hide on the Work page.
    The global shortcut (⌘K) focuses the thread composer.
16. **Details panel:** Plan (steps with proof), Files (with Undo), Proof, Commitments, and the plan
    document collapsed under "Read the plan". Split, Put it down, the horizon, and "Mark it
    complete" go in the header menu.
17. **Personal details in Settings:** web in the "You" group before Account; iOS and macOS in the
    Account section, under Connections.
18. **Live runs:** web and macOS subscribe to Convex `runsForWorkHistory`; iOS polls
    `GET /api/albatross/work/[workId]/runs` every 3 seconds while a run is open.
19. **Invented data only** in fixtures, previews, tests, screenshots, and docs (for example
    "Sam Rivera", "12 Elm Street, Springfield, IL 62704", 555 numbers). Never a real person's details.

## Security (CASA)

- Personal details are encrypted at rest with the registered key-id format and rotate with the
  other encrypted fields (`lib/security/encrypted-fields.ts`).
- Only the Next server decrypts. No Convex query returns a clear value.
- No log line, error, or analytics event contains a detail value.
- Every route checks the signed-in user, limits the rate, and validates input with zod.
- The model gets values only through `personal_details_get`, on the turns that need them.
- Deletion: per item, with account deletion (cascade), and in the export.
- The data-flow, retention, and security-control documents in `docs/google-verification/` and
  the privacy page name the new data.

## Copy rules

- ASD-STE100 Simplified Technical English. Sentence case.
- Never "AI", "assistant", or "agent" in user copy. The agent is "Albatross".
- No icons before text. No sparkle or star icons. No ALL-CAPS labels.
- Concrete verbs: "Handle it", "Continue", "Take over", "Save to my details", "I paid".
- Use registry components (`@ai-elements`, `@tool-ui`, the vendored Odyssey chat parts) before
  custom code.

## Owner decisions (Jakob, 2026-10-07)

- Option A: background runs report into one conversation; user messages reach a working run.
- The Guided work page goes away. The plan, files, and proof move to a side panel.
- Personal details in PR 1. Passwords, ID numbers, and API keys in PR 2, where the model uses
  them without seeing them. This reverses the 2026-08-15 rule "never store credentials".
- Real card numbers are not stored. Payments come later, with virtual cards and an approval for
  each payment.
- Two-factor codes stay with the user.
- Fable subagents design the UI for each platform. Research and user stories come first.
- Done: PR 1 to `main`, one CodeRabbit review, merge. Then PR 2 the same way.
