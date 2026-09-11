# PR #246 review follow-up

CodeRabbit posted 22 findings on September 11. Each was checked against staging. Twenty-one were addressed; the origin-normalization finding was already handled by `configuredOrigin`, which returns `URL.origin` and rejects paths. A regression now covers uppercase hosts, default port 443, trailing slash and provider whitespace/case.

## Correctness and integrity

- Google Office identity no longer includes etag. Existing legacy identities are reused; clean copies import provider changes atomically, retain version history and invalidate stale editors. Dirty or locked copies refuse replacement.
- Google save reconciliation uses expected-session checks and monotonic provider versions. A completed provider write is recorded privately on a session conflict, even if all bounded retries race. Opening/saving resumes reconciliation without repeating the provider write or replacing newer provider state.
- WOPI locks are document-scoped across authenticated sessions of the same owner. Expected revision still guards concurrent transfers. PutFile conflicts include the current lock header.
- Slide requests distinguish exact counts, ranges, minimums and maximums.
- Attachments propagate request cancellation through metadata/storage reads and extraction boundaries; XLSX inline rich-text runs retain their contents.
- Composer file refs track committed state and event updates. Editor cleanup sends Close_Session, preserving save rejection and timer cleanup.

## Configuration and verification

- Office responses share one redaction helper, including private pending Google save metadata. Successful save results require updatedAt.
- Unknown editor providers return a configuration error. Environment documentation states the signing-secret minimum and includes the Collabora test command.
- Verification session files are recreated exclusively with mode 0600 and explicitly chmodded. Storage downloads have timeouts; diagnostic failures cannot mask the original error.
- Google fixtures use one writer per format and report cleanup success only after a successful Trash operation.
- Workspace assertions target the assistant message and exact expected streaming text. Reasoning tests cover classify requests and explicit effort forwarding.
- CI uses HTTPS Ubuntu mirrors with bounded retries/timeouts for its LCOV report dependencies, preserving the existing coverage gate.

## Evidence

Focused tests cover two-session saves, owner/lock conflicts, stable Google identity, concurrent provider/session changes, durable reconciliation, redaction, cancellation, rich inline strings, and slide constraints. Full tests, typecheck, lint, workspace browser checks and a production build were run during the review. Live staging DOCX/XLSX/PPTX tests verified saved bytes and lock release after the editor closed.

Collabora close-message reference: https://sdk.collaboraonline.com/CO-SDK-manual.pdf. No UI redesign was introduced. Original Dia/browser research and the unavailable Mobbin tooling are recorded in [dogfood notes](chat-dogfood-2026-09-11.md).

The template's Claude delegation checklist predates the supplied ownership instruction allowing Codex to implement web UI directly; it is not marked as performed. CodeRabbit's generic docstring-percentage recommendation was not used to add boilerplate to unrelated functions; comments document the security and concurrency boundaries changed here.

## Follow-up review (fe65a1d)

Four valid follow-up issues are fixed: the rate-limit gate now completes before
context reads and attachment downloads; every attachment reference counts toward
the 25 MB hydrated payload limit even when storage retrieval is cached; and initial
PutFile conflicts return an empty lock header when the stored lock has expired.
Focused regressions cover those three, and the browser assertion now accepts
both observed streaming render states before asserting the full final sentence.

One suggestion was not applied; the streaming assertion was made tolerant of either rendering state:

- The workspace browser check intentionally observes an unfinished text stream.
  Streamdown buffers the last word, so `The draft stays` is the rendered text at
  that point. The assertion now accepts either exact rendered form within the assistant
  message. The full `The draft stays here.` sentence is required after the
  fixture finishes the stream.
- Reconciliation must not replace an unrecognized provider version with an
  arbitrarily chosen pending token. `linkGoogle` only persists numeric pending
  provider versions, and reconciliation compares those monotonic versions. If
  canonical state is malformed or unrecognized, preserving the pending save and
  failing closed protects edits; clearing it without establishing version order
  would lose the recovery record or overwrite newer state. Existing regressions
  explicitly verify this boundary and successful recovery for valid versions.
