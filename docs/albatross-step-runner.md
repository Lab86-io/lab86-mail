# Albatross step runner

Status: shipped in PR #319 (v0.16.24, 2026-10-07). The thread round (`docs/albatross-thread.md`)
adds the fields in "Thread round additions". Owner decisions are at the end.

## The idea

An Albatross plan has steps. Before this change, the agent never did a step. It only described
the step, and the user did the work.

The step runner changes this. The agent takes one step as far as it can. Then it stops and gives
the user one next action. For example: "I wrote the proposal and attached it to a draft. Read and
send." Or: "I opened the bank site. Sign in, then press Continue."

The handoff is the product. Each run ends with a short record:

- what the agent did,
- the files it made (documents, drafts, events, approvals),
- the one next action for the user.

## Run results

A run ends with one of five outcomes.

| Outcome | Meaning | The user sees |
|---|---|---|
| `done` | The agent did the step, and the proof check passed. | The step is checked, with its proof. |
| `ready_for_you` | The agent made a draft, document, or event that needs approval. | One button, for example "Read and send". |
| `your_turn` | Only the user can do the next part: sign in, 2FA, payment, a signature, a physical task. | One button, for example "Sign in". |
| `needs_answer` | The agent needs a fact to continue. | One question, with choices. |
| `stopped` | The run used its time or cost limit, or a lost process stopped it. | What it did, and "Continue". |

## Where the agent always stops

The agent never does these actions. It prepares them and hands them to the user:

- Send mail to a person (it saves a draft).
- Pay, buy, transfer money, or accept terms.
- Submit a form that has a legal or money effect.
- Invite or notify other people (it queues an approval).
- Type a password or a one-time code.

The code enforces these rules in three places: the tool list (no send tools), the approval
gate (gated calls become approvals or refusals), and a check on browser clicks.

## Limits

- One run: 15 minutes and $5 of model cost (`LAB86_STEP_RUN_TIME_BUDGET_MS`,
  `LAB86_STEP_RUN_COST_BUDGET_USD`). The meter counts every model call inside the run, including
  calls inside tools such as document generation.
- One open run for each Work. At most three open runs for each user.
- An automatic run (the Brief or the conductor) starts at most once for each step. After that,
  only the user starts the step again.
- At most one automatic run for each user at a time.

## Triggers

1. **The user.** "Handle it" on a step (web, iOS, macOS).
2. **The Brief.** After the morning edition publishes, the server starts runs on the current
   steps of the Work items the edition features, when an agent can carry the step.
3. **The conductor.** Every 15 minutes, the server starts runs on the current step of Work the
   user touched in the last 24 hours (the conductor quiet rule), when an agent can carry it.
4. **Resume.** The user did their part (signed in, answered) and pressed "Continue". An answer to
   the run's question resumes the run without a button.

Automatic triggers (2 and 3) run only when all of these are true:

- `LAB86_STEP_RUNS_AUTO` is `all` or lists the user id (comma-separated).
- The "Work on steps by itself" standing order is not paused.
- The step mode is `agent_does` or `agent_drafts`.

Manual runs work for every digital step except `you_do_offline`. `LAB86_STEP_RUNS=off` turns off
the whole feature.

## Data contract

### `StepRunView`

Every client reads this shape. The server never sends the lease token or the cost.

```ts
type StepRunView = {
  id: string;
  workId: string;
  stepKey: string;
  stepIdentity: string;
  stepTitle: string;
  state: 'queued' | 'running' | 'handed_off' | 'done' | 'failed' | 'cancelled' | 'closed';
  trigger: 'user' | 'brief' | 'conductor' | 'resume';
  outcome: 'done' | 'ready_for_you' | 'your_turn' | 'needs_answer' | 'stopped' | null;
  summary: string | null; // what the agent did, one to three sentences
  log: Array<{ at: number; text: string }>; // live lines, oldest first, at most 30
  next: {
    kind:
      | 'review_draft' // open the draft in the composer
      | 'review_document' // open the document
      | 'approve' // open the approval (calendar invite, RSVP)
      | 'sign_in' // the shared browser waits at a sign-in page
      | 'finish_on_page' // the shared browser waits at a final page (submit, pay)
      | 'answer' // a Work question waits
      | 'do_offline' // a call, a visit, a signature
      | 'review' // look at the result (a target url or the artifacts)
      | 'continue'; // the run stopped; Continue resumes it
    label: string; // the button text, at most 48 characters, written by the agent
    detail: string; // one or two sentences
    target: {
      kind: 'draft' | 'document' | 'approval' | 'session' | 'question' | 'url' | 'card' | 'event';
      id?: string;
      url?: string; // for a document: its openPath
      accountId?: string; // for a draft or an event
    } | null;
  } | null;
  artifacts: Array<{
    kind: 'document' | 'draft' | 'event' | 'card' | 'approval' | 'page';
    id?: string;
    title: string;
    url?: string;
    accountId?: string;
  }>;
  browserSessionId: string | null; // the shared browser this run uses
  stoppedBy: 'time' | 'cost' | null;
  error: string | null; // a short reason for a failed run, safe to show
  createdAt: number;
  updatedAt: number;
  finishedAt: number | null;
};
```

`state` and `outcome` together:

- `queued`, `running`: the run is open. Show progress and "Stop".
- `handed_off`: the run ended with a handoff (`ready_for_you`, `your_turn`, `needs_answer`,
  `stopped`). Show the handoff card.
- `done`: the step is done. The step row already shows its check.
- `failed`: show `error` and "Try again".
- `cancelled`, `closed`: nothing is open. The step is eligible again.

### Where it appears

- `workDetail` (web Convex query, and the iOS/macOS `work_home` tool result):
  - `execution.guideSteps[i].run`: the newest `StepRunView` of that step, or `null`.
  - `execution.activeRun`: the open run of the Work (`queued` or `running`), or `null`.
  - `execution.runner`: `{ enabled: boolean }`. `false` hides every run control.
  - `execution.guideSteps[i].runnable`: `true` when the user may press "Handle it" on the step.
- Convex live query `albatrossStepRuns.runsForWork({ workId })`: the newest run of each step.
  The web Work page subscribes to it, as it does to `albatrossBrowserSessions.activeSessionForWork`.
- Convex live query `albatrossStepRuns.openHandoffs({ limit? })` and `GET /api/albatross/handoffs`:
  `Array<{ workId, workTitle, run: StepRunView }>`, newest first, one row for each Work. It holds
  open runs and handoffs from the last 14 days. The Brief's "Ready for you" list reads it.

### Actions

`POST /api/albatross/work/[workId]/run`, JSON body:

| Body | Result | Errors |
|---|---|---|
| `{ action: 'start', stepKey }` | `{ ok, runId }` | 409 when a run is open for this Work, 403 when the feature is off or the step is not runnable, 404 when the step does not exist |
| `{ action: 'resume', runId, note? }` | `{ ok, runId }` (a new run) | 409 when a run is open, 404 when the run does not exist |
| `{ action: 'cancel', runId }` | `{ ok }` | 404 |
| `{ action: 'dismiss', runId }` | `{ ok }` (closes a handoff) | 404 |

`cancel` also gives the shared browser to the user (session status `user`).

`GET /api/albatross/browser-context` returns `{ saved: boolean, createdAt?, lastUsedAt? }`.
`DELETE /api/albatross/browser-context` forgets the saved sign-ins (it deletes the Browserbase
context too).

### What each next action does on a client

| `next.kind` | Primary button (`next.label`) | Behaviour |
|---|---|---|
| `review_draft` | "Read and send" | Open the draft (`target.id`, `target.accountId`) in the composer. |
| `review_document` | "Open the document" | Open `target.url` (the document `openPath`) or the document by `target.id`. |
| `approve` | "Approve the invite" | Open the approval (`target.id`) in the approval surface. |
| `sign_in`, `finish_on_page` | "Sign in", "Check and submit" | Show the shared browser live view (the session row is `user`). A second button, "Continue", sends `resume`. |
| `answer` | none | Show the Work question (`target.id`) with its choices. The answer resumes the run on the server. |
| `do_offline` | "Mark this step done" | The usual step check. |
| `review` | "Open" | Open `target.url` when present, otherwise show the artifacts. |
| `continue` | "Continue" | Send `resume`. |

Every handoff card also offers "Dismiss" (`dismiss`) and "Discuss this" (the Work chat).

## The shared browser

- The runner creates the session with the user's saved sign-in context, so a site the user signed
  in to before is still signed in.
- While the runner controls the page, the session status is `agent` and `statusDetail` says what
  it does ("Opening the dispute form").
- At a handoff the status is `user` and `statusDetail` is the handoff detail.
- The live view stays interactive. While the status is `agent`, a client shows that the agent
  has the page and offers "Take over". "Take over" sends `cancel`.
- The user's own "Open the shared browser" and "Check the page" controls stay as they are.

## The Brief

The newest daily edition mounts a "Ready for you" list at the top, before the editorial body, on
web, iOS, and macOS. The list is live (it loads when the Brief opens, from `openHandoffs`). It is
not part of the edition document, so a handoff that finishes after 7:00 still appears. It shows:

- handoffs: the Work title, the step title, the summary line, and the primary button;
- open runs: "Working on: {step title}" and the newest log line.

The list hides when it is empty.

## Notifications

A handoff from an automatic run, or from a user run that took more than one minute, queues a
`work_question` notification with the deep link `/?view=albatrosses&work=<workId>`. Native push
delivery is the usual path.

## Settings

- Standing orders gains "Work on steps by itself" (id `runs`, group `schedule`). Pausing it stops
  the Brief and conductor triggers. "Handle it" still works.
- "Saved sign-ins" (a row near the standing orders): it says whether a context exists and offers
  "Forget saved sign-ins". The copy says that Albatross never sees a password.

## Copy and taste rules

- Write all copy in ASD-STE100 Simplified Technical English.
- Never say "AI" in user copy. The agent is "Albatross".
- No icons before text, no sparkle or star icons, no ALL-CAPS labels.
- Use concrete verbs: "Handle it", "Read and send", "Sign in", "Continue", "Stop", "Take over".
- Use registry components (`@ai-elements`, `@tool-ui`) for the live log and the progress state
  before you write custom code.

## Thread round additions (docs/albatross-thread.md)

- `StepRunView.parentRunId`: the run this run continues, or `null`.
- `next.doneLabel`: for `sign_in` and `finish_on_page`, the button the user presses after doing
  their part on the page ("I signed in", "I paid"). `null` means "Continue". The thread has no
  "Check the page" button; the resumed run checks the page itself.
- `next.blanks`: the names of the fields the run left empty for the user, in page order (at
  most six, 40 characters each). The view always sends an array. Every surface draws them as
  blanks: "Fill in ___, ___, and ___." (docs/albatross-blank-design.md). The list activity
  carries them as `nextBlanks`, and `ThreadRow.blanks` holds them for an open handoff only.
- Run questions are forms: `step_handoff.question.form` (`FormQuestion`). The server stores it on
  the Work question (`albatrossWorkQuestions.form`, dedupe salted with the run id). The answer
  route takes `{ form: { values, save } }`.
- Steer notes: `POST /run { action: 'steer', runId, note }` and the chat tool
  `albatross_handle_step` add a note to a run in progress. The runner reads new notes between
  model steps and logs "Read your note: …".
- `albatrossStepRuns.runsForWorkHistory` and `GET /api/albatross/work/[workId]/runs`: every run of
  a Work, oldest first, each with its question (`ThreadRunView`).
- The runner context adds "About the user" (names of saved personal details) and the user's newest
  messages in the Work thread. It reads values with `personal_details_get`.
- Shared browser sessions are no longer recorded (`recordSession: false`).

## Owner decisions (Jakob, 2026-10-07)

- Saved sign-ins: yes (Browserbase contexts).
- Triggers: the user, the Brief, and the conductor.
- Limits: 15 minutes and $5 per run.
- Fix the found defects first (the paused standing order, and the step mode check).
- Browser control: the plan named Stagehand. The build uses Playwright's AI snapshot (`ariaSnapshot({ mode: 'ai' })`)
  and `aria-ref` locators over the existing Browserbase CDP connection instead. The agent model
  picks each action itself, so there is no second model per click, the run meter counts all the
  cost, and there is no new dependency. A live probe on 2026-10-07 confirmed fill, click, and
  reconnect on a Browserbase session with a persisted context.
