# Verified Guided Work

This document is the contract for the verified-work build. The principle: one
Albatross holds one outcome, and every verification works at that grain. A step
is not "done" because someone clicked a button. A step is done at a named trust
level, with evidence bound to the step identity.

## Layers

### 1. Check-in split

The nightly "tomorrow" answer no longer becomes one Work. The route splits the
answer into independent outcomes with the same rules as capture, plus one new
rule: a shared person, day, or theme is not one outcome.

- `lib/albatross/tomorrow-split.ts` proposes items and matches them against
  the works a previous save created.
- External ids use the form `checkin:<checkinId>:tomorrow:<slug>`. The
  legacy id `checkin:<checkinId>:tomorrow` stays valid. A prefix scan on
  `by_user_external` finds every sibling for reconciliation.
- A superseded sibling is released only when it has no step progress and no
  evidence. Started work is never removed.
- The route plans works inside a time budget. The work conductor advances any
  work the budget did not reach.

### 2. Mail-class gate for proof offers

Marketing mail never asks to be filed as proof. The proof-offer path reads the
thread classification (`noise` and `codes` block the offer). Both clients use
`/api/albatross/proof-matches`, which now also runs the model gate below.

### 3. Split an existing Work

`/api/albatross/work/<workId>/split` proposes child outcomes from the parent
raw text and plan, then commits reviewed children. The parent is released with
a provenance evidence entry. The affordance is permanent UI in the Work
detail, and it also promotes an oversized step into its own Work.

### 4. The evidence gate

`lib/albatross/evidence-gate.ts` exports one question asked everywhere:
does this evidence satisfy this requirement? One structured model call,
`feature: albatross_evidence_gate`. The lexical ranker stays as a cheap
pre-filter. No proof claim ships on lexical overlap alone.

### 5. Step schema and per-step evidence

Plan actions gain three optional fields, written at plan time:

- `stepMode`: `agent_does` | `agent_drafts` | `you_do_observed` |
  `you_do_offline`. The honest taxonomy: the pane must never claim a step is
  "only you" when the agent can carry it.
- `doneWhen`: one sentence that names the observable completion state.
- `evidence`: `{ kind: mail_confirmation | artifact | observation |
  attestation, hint? }` — what proof of this step looks like.

`albatrossEvidence` rows gain `stepIdentity`, using the stable identity scheme
from `lib/albatross/step-progress.ts`. The `workDetail` projection maps that
evidence onto `guideSteps`, so every step carries a verification level:
`reported` | `artifact` | `observed` | `confirmed`. Completion of an offline
step can carry an outcome note; the note becomes step-bound evidence and feeds
the next replan.

### 6. Mail watchers

A work whose applied plan holds an unfinished `mail_confirmation` step is a
watch candidate. A conductor tick (house pattern: candidates, lease, fan-out,
complete or release) reads recent confirmable threads, pre-filters lexically,
asks the evidence gate, and completes the step with `source: evidence` and the
thread bound as step evidence. The receipt email closes the step, not the
user's memory.

### 7. Agent execution in a real browser

Browserbase sessions carry the digital steps the agent can do alone. Stagehand
attaches by session id, acts, extracts, and files what it produced as step
evidence with the session replay URL. Credentials are never requested or
stored. The agent stops at every identity wall.

### 8. The relay pane

The guided pane's right panel becomes a ladder: live session view when a
session exists (interactive iframe from the session debug URL), the plain
iframe when a site allows it, and the open-in-tab fallback last. One step is a
relay: the agent drives to the identity wall, the pane flips to "Your turn",
the user acts in the same browser, and the agent verifies `doneWhen` before
the step checks itself. iOS renders the same session URL in a web view, so
both clients share one browser and one truth.

## Invariants

- The UI never shows a verified mark for a self-reported step.
- No credential is ever requested, stored, or observed on purpose.
- Marketing mail never triggers a proof offer.
- A split never merges and never deletes: children are created, the parent is
  released, started work is untouched.
- Every automatic completion names its evidence and its trust level.
