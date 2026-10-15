# Goal runs: core build notes

Date: 2026-10-15. Branch: `claude/goal-runs-core`. Design: `docs/albatross-goal-runs.md` (G1, G2, G3, and the server part of G6).

## What the server does now

- The switch is `LAB86_GOAL_RUNS` (`all`, or a comma list of user ids). Set it in Railway and in Convex. Convex reads it for `workDetail.goalRuns`.
- For a user in the switch, `advanceWork` makes no plan model call. It saves one plan row with no actions and with `outcome` set to the Work title. It adds a first contract from `proposeContract` when the Work has no contract. It applies nothing and marks nothing applied.
- A Work that has an applied plan keeps it. Its open steps become the first checklist of the first goal run.
- Every run of a user in the switch is a goal run. A row has `stepKey: 'goal'`, `goal: true`, and the Work title as `stepTitle`.
- A user start has `stepIdentity: goal:<workId>`. An automatic start has `goal:<workId>:<local date>`, so the old dedupe gives one automatic run for each Work each day.

## Start rules

- "Handle it": `POST /api/albatross/work/<workId>/run` with `{ "action": "start" }`. The `stepKey` can be missing or `"goal"`. The answer is `{ "ok": true, "runId": "<id>" }`.
- "Done, continue" on a goal handoff: `POST /api/albatross/work/<workId>/step` with `{ "stepKey": "goal", "continue": true, "note"?: "<text>" }`. The answer is `{ "ok": true, "stepKey": "goal", "allStepsComplete": false, "nextRunId": "<id>", "nextStepKey": "goal" }`.
  - The server queues a goal run first. Then it closes the handoff. The note of the new run starts with "The user did their part: <next.label>.". That run checks the contract first.
  - No goal handoff that is `ready_for_you` or `your_turn`: 409 "Nothing waits for you on this Albatross.".
  - `stepKey: "goal"` without `continue: true`: 400.
- The thread tool (`albatross_handle_step`) in goal mode: a note goes to the open run. A waiting handoff continues as a goal run. `done: true` is "Done, continue". With nothing open or waiting, a goal run starts.
- Automatic triggers (Brief and conductor, behind `LAB86_STEP_RUNS_AUTO`): a goal run starts only when the Work has no run, or when its newest run stopped at its time or cost limit (that run becomes the parent). It never starts while a run works, a handoff waits, or a question is open.
- A plan step that the user marks done in goal mode starts a goal run, not a step run.

## The run

- Limits: 30 minutes, $8, 120 model steps. `LAB86_GOAL_RUN_TIME_BUDGET_MS`, `LAB86_GOAL_RUN_COST_BUDGET_USD`, and `LAB86_GOAL_RUN_MAX_MODEL_STEPS` change them. The step-run variables do not change a goal run.
- The prompt is `GOAL_RUNNER_RULES` (`lib/albatross/goal-run-prompt.ts`). The context has the goal (outcome and proofs), the checklist, the newest six earlier runs (summary, newest messages, package, "Not sure" lines), the things earlier runs made with ids, today's local date, and the limits.
- Talk: each model step's text becomes a run message. The sources are the things that the tool calls of that step, and of the steps since the last message, read. The text goes through the secure redaction first.
- Tools: the step tools plus `checklist_set`, `goal_update`, `presentation_plan`, `document_review_slides`, `web_research`, `web_file_save`, `pdf_form_fields`, and `pdf_form_fill`. A goal run has no `step_note`. A tool that the registry does not have yet is skipped.
- `presentation_plan` gets a delegated presentation session, so it asks no pickers.
- The package: the model's `items`, or, with none, each draft, document, deck, file, approval, and event that the run made, with the main target first. An edit to an earlier draft or document puts that thing in the package.
- Every artifact and every item of a goal run has a `url` from the server:
  - draft: `/?view=mail&account=<account>&draft=<id>`
  - document, sheet, deck: the path of the tool, else `/?view=files&document=<id>`
  - file: `/?view=files&file=<id>`
  - approval: `/?view=notifications&approval=<id>`
  - event: `/?view=calendar&account=<account>&event=<id>`
  - card: `/?view=tasks&card=<id>`
  - page: the page link
- A filled PDF with sealed fields is an item with state `check` and the note "Your saved ID number fills in when the mail sends or when you download the file.".
- Done: the requirement is the contract outcome and its open proofs. The proof attaches to the Work, without a step identity. No plan step is checked. Only proof that the page shows can settle the contract, as for step runs.

## Read paths

- `workDetail` has `goalRuns`, `checklist` (the newest list of the goal runs), and `execution.goalRun` (the newest goal run view).
- The thread list (`albatrossThreads.activity`): for a goal run, `logLine` is the newest message. `nextBlanks` adds the blanks of the items. New fields: `goal` and `itemCount`.
- `readyForYouRows`: a goal handoff whose next action opens nothing opens its first package item.
- `documentsWaitingRows`: one row for each document, sheet, or deck of the package that is not `ready`. Rows have a new `key`.
- `documentHandoffFor` finds a document in a package. `threadStateInput` counts a goal handoff as waiting when an old step is open.
- New behaviour `open_file`: a saved file opens in Files by its path.

## G6

- The banner text "Applied N of the plan's actions. N failed: ..." is now "Albatross made N of the M steps of the plan. K steps did not work. Try again to make the rest.". The step titles and the errors go to the server log only.

## Decisions to check

- No plan row is marked applied in goal mode. A mark would record an `intent_plan` completion event, and the Brief would show it as done work.
- `goal_update` changes only the contract, not `plan.outcome`, because the clients use `plan.outcome` as the Work title.
- The runner adds sources from `atlassian_search` (the first three hits, because each hit carries its summary). It adds no source from `cloud_file_search` or `browserbase_search`, because those give names only.

## For other builders

- Web builder: add `web_research`, `web_file_save`, `pdf_form_fields`, and `pdf_form_fill` to `AGENT_TOOL_NAMES` in `lib/ai/loop.ts`. If a tool is not in that set, `liftToolsForAgent` does not give it to the runner.
- UI builders: in goal mode, hide "Apply plan" for a plan row with no actions. Send `{ "action": "start" }` for "Handle it".
