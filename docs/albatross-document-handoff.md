# Albatross document handoff and the step check

Status: building, 2026-10-08. Owner report: an Albatross that bills a client for monthly hours.

## What went wrong

1. **"Fill in hours" opened the Files list, not the document.** The handoff target had a
   document id and no link. `openDocumentPath` then pushed `/files/<id>`, and Files reads only
   `?document=` and `?office=`. The document stayed closed.
2. **"I think the step is done, but the proof check did not pass."** The proof check
   (`evidenceSatisfies`) was written for mail watchers: only a confirmation, a receipt, or a
   human reply counts. A research step ("Find the client's billing email") has none of those, so it failed
   every time. The check saw the run's own summary, but not the tool results that the run
   observed.
3. **No way to mark the step done.** A `ready_for_you` handoff with nothing to open showed
   "Check the result" (web: opens Details; native: no button). The copy said "mark the step
   done", but no surface had that button.
4. **"This step is done" in the chat did not check the step.** The chat could only resume the
   run. The run did the step again, and the same check refused it again.

## Decisions

### D1. The proof check reads what the run observed

- `lib/albatross/run-evidence.ts` turns the run's tool results into "Observed" lines (it keeps
  the newest results when over 5,000 characters). Personal and secure tools are left out.
- `evidenceSatisfies({ source: 'run' })` uses its own rules: observed results, made files, and
  page text are facts. The agent's summary is a claim. A research step passes when the facts
  show the information. A step that needs another person to act still needs a fact of that act.
  The mail watchers keep the old strict rules.
- A step with `evidenceKind: 'attestation'` skips the check. It waits for the user's word with
  "This step needs your word. Check it, then mark the step done."
- A refusal names what is missing: "I think the step is done, but I could not prove it: {reason}.
  Check it, then mark the step done."
- A resumed run's note goes in as "User said". The user's word that the step is done passes.

### D2. Every result that waits for the user can be marked done

On a `ready_for_you` handoff:

| The handoff can open | Primary button | Second button |
| --- | --- | --- |
| a draft, a document, an approval, or a web page | the agent's label ("Fill in hours") | **Mark step done** |
| nothing | **Mark step done** | none |

Dismiss stays as the quiet last button on every handoff.

### D3. Mark step done continues the Albatross

`POST /api/albatross/work/{id}/step` with `{ stepKey, continue: true }` checks the step with the
user's word (`source: 'user'`), closes its handoffs, and starts a run on the next step when that
step is one Albatross does alone (`agent_does`, `agent_drafts`). The response adds
`{ nextRunId, nextStepKey, allStepsComplete }`. A step that stays with the user, a closed Work,
or runs that are off end the chain quietly. The plan-panel check (no `continue`) does not start
anything.

### D4. The chat can check a step off

`albatross_handle_step` takes `done: true`. The chat calls it when the user says a step is done.
It runs D3 and answers "Checked the step off. Albatross started on the next step." The chat
never resumes a run to prove what the user already said.

### D5. Document mode in the thread

A `review_document` handoff's primary button (and a click on a document artifact in a run
block) opens **document mode** inside the Work thread. It does not go to Files.

```
┌ header: Back · title ······························ Step 2 of 4 · Ready for you · Details · More ┐
│ ┌ document (center, wide) ─────────────────────────────┐ ┌ thread (right, ~380–440px) ──────┐ │
│ │ document title · saved                       Close   │ │ YOUR PART                         │ │
│ │                                                      │ │ Fill in the months and hours you  │ │
│ │   the editor (Albatross editor or Word editor)       │ │ worked, the rate, the invoice     │ │
│ │                                                      │ │ number and date.                  │ │
│ │                                                      │ │ [Done, continue]  Back to thread  │ │
│ │                                                      │ │ ───────────────────────────────── │ │
│ │                                                      │ │ the same thread: runs + chat      │ │
│ │                                                      │ │ composer: "Tell Albatross what to │ │
│ │                                                      │ │ put in the document"              │ │
│ └──────────────────────────────────────────────────────┘ └───────────────────────────────────┘ │
```

- **Reference:** Microsoft Copilot Pages (document center, conversation right, a short "what to
  do" card on top), Mistral Le Chat canvas, Langdock canvas. Mobbin, 2026-10-08.
- **The "Your part" card** shows the handoff's `next.detail`. Its primary button is
  **Done, continue** (D3 with `continue: true`). The quiet link **Back to thread** closes document
  mode. The card does not show when the document opened from an artifact with no open handoff.
- **The chat edits the document live.** The request carries a context attachment
  `{ kind: 'document', id, provider }`. The server tells the model which document is open, to read
  it first, and to apply edits directly (mode `apply`; every edit is a revision the user can undo).
  When the user says the document is done, the model calls `albatross_handle_step` with
  `done: true`.
- **The editor refreshes** after a chat edit: the web client invalidates the document query after
  a `document_*` tool result, and the Albatross editor checks the saved revision every 5 seconds
  while it has no unsaved edits (the Word editor already does).
- **Done, continue** closes document mode. The thread shows the next run.
- Narrow screens (web < 1024px, iPhone): the document is full screen, the "Your part" card is a
  bar at the bottom with **Done, continue**, and a **Chat** button opens the thread as a sheet.
- **Native:** the document opens in the native workspace (the web editor in a WebKit view) inside
  the same layout: Mac and iPad put the thread on the right; iPhone uses the bottom bar and the
  sheet. Native agent requests send the same `document` context attachment.

## Contract

- `lib/albatross/step-run-client.ts`: `documentTargetOf(url, id)` → `{ provider, id }`;
  `documentTargetPath(target)`.
- `lib/albatross/thread-view.ts`: `runBlockAction` (D2), `runBlockMarksDone`,
  `RUN_STATE_COPY.markDone`, plan rows `waitingLabel` ("Ready for you" / "Needs your answer" /
  "Your turn"), and the header ranks a run at work above a question from another part of the Work.
- `lib/albatross/document-handoff.ts`: `DOCUMENT_HANDOFF_COPY`, `documentHandoffFor(runs, target)`.
- Agent request: `contextAttachments: [{ kind: 'work', id }, { kind: 'document', id, provider }]`.

## Copy

- Mark step done · Done, continue · Back to thread · Your part · Close
- Composer placeholder in document mode: "Tell Albatross what to put in the document"
- No "-ing" verbs, no star icons, no ALL-CAPS labels (the "YOUR PART" in the sketch is a
  sentence-case small label in the build).

## Fixes after the first test (2026-10-09)

- **A Word file named by id opened as a missing document.** A run from before the server
  filled target links named its `.docx` by id only. Clients now take the link of the run's own
  file with that id (`resolveDocumentTarget`, Swift `DocumentTarget.resolve`), so `?office=`
  opens the Word editor.
- **"Needs your answer" pointed at nothing.** The plan's open questions (no run owns them) were
  counted in the header but shown nowhere in the thread. The thread now shows them above the
  composer as "Albatross asks" with the usual form (`openWorkQuestions`, `WorkQuestions.tsx`,
  Swift `WorkQuestionsView`). They also show in document mode.
- The editor's error screen in the thread says "Close the document", not "Back to Files".
