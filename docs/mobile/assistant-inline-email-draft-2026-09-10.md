# Native inline email draft in Albatross chat

Date: 2026-09-10. Owner: Claude (apps/ios, iOS + macOS); Codex finish pass
explicitly authorized by the user for this round after Claude's session quota.
Part of the accepted
workspace round (`docs/research/workspace-round-2026-09-10.md`, "Native email").

Final finish status: **424 macOS tests, 452 iPhone simulator tests plus two
rendered XCTest cases, and an unsigned iPhone-device SDK build pass on the
saved source.** The existing signed-out shell UI smoke also passed. Eight
inspected synthetic screenshots are in
[native rendering evidence](evidence/inline-email-2026-09-10/README.md).
No commit, deployment, TestFlight upload or real email was performed by this
native task. Detailed scope and physical-device limitations are below.

## Requirement (frozen)

When chat drafts an email on iPhone it stays an editable artifact inside the
conversation. It never opens the global composer or a `mailto:` sheet on its
own. The artifact shows the sending account, To/Cc/Bcc, editable subject and
body, attachment chips, saving/saved/error status, and an explicit Send. Its
identity is the conversation plus the tool call that produced it and survives
scrolling, reopening the chat, backgrounding, relaunch, and account switches.
Replayed or streamed agent output never overwrites newer typing; a differing
revision waits as an explicit suggestion. Sending reuses the authoritative
`ProductStore.saveDraft` / `ProductStore.sendCompose` transport, honours the
pending-undo and scheduled states, rejects duplicate taps, keeps the draft on
every error, never calls an unconfirmed response "Sent", and never retries an
ambiguous send on its own. The same code builds for macOS. No new bottom tab
bar; existing navigation and density stay.

## State owners and write path

| Fact | Owner | Persistence |
| --- | --- | --- |
| Editable artifact (account, recipients, subject, body, attachment chips, accepted/origin fingerprints, suggestion, delivery state, server draft id) | `AssistantDraftStore` (`Features/Assistant/AssistantDraftStore.swift`), one instance on `AppEnvironment.assistantDrafts` | `UserDefaults` key `albatross.assistant-drafts.v1`, records tagged with `ownerID`; reads filter by the signed-in owner; cleared on sign-out and account deletion |
| Attachment bytes | `MailIntentAttachmentStore` under the record's `attachmentsKey` | Application Support, same as the composer |
| Server draft | `save_draft` / `update_draft` through `ProductStore.saveDraft` (debounced, serialised per artifact; only the returned id lands back in the record, never text) | Server |
| Send | `ProductStore.sendCompose` → `/api/compose` with the person's undo preference | Server; held messages register with `PendingSendCoordinator` |
| Held-message outcome | `PendingSendCoordinator.resolutions` + `confirm(pendingID:)` (`/api/compose/status`, read only) | Process memory; a missing answer leaves the artifact "Not confirmed" |
| Failed `/api/compose` call | `ComposeTransportFailure` (next to `ComposeSubmission`): `rejected` for failures before the request could reach the server (4xx, auth, configuration, no connection), `ambiguous` for anything after (timeout, dropped connection, unreadable answer, 5xx) | Not persisted; the artifact records the resulting delivery state |
| Card identity in the transcript | `AssistantChatPart.card(id:_:source:)` with `AssistantToolCardSource` (tool name, call id, input, output); `transcriptJSON()` writes it as a `dynamic-tool` part with `state: output-available`, the same shape the web writes; `message(from:)` restores it | `/api/chats` history |

Artifact key: `AssistantDraftKey(sessionID:toolCallID:)`. The chat model
ingests each `show_message_draft` output (live stream and history restore) via
`AssistantDraftStore.receive`, which is idempotent: identical content is a
no-op, content matching the origin/accepted fingerprint is a no-op, anything
else becomes `suggestion` for the person to apply or dismiss.

## Behaviour

- `AssistantToolCardView` renders `.draft` as `AssistantDraftArtifactView` when
  it has a tool call id and the conversation id; legacy payloads without ids
  keep the read-only card. The view holds no message copy; bindings write
  through `AssistantDraftStore.update`.
- Send lock (review follow-up, P1): from the Send tap until the outcome is
  known the store refuses every mutation for that artifact (`update`, so
  also the From menu and `applySuggestion`; `dismissSuggestion`;
  `addAttachments`; `removeAttachment`; `resolveAccountIfNeeded`), and
  `canEdit(_:ownerID:)` is what the view mirrors to grey every control. The
  send first flushes the debounced server save and waits for any queued
  attachment operation, then captures `submitted` and transmits exactly that.
  The pending receipt's snapshot, the deleted server draft, and the removed
  attachment file all come from `submitted`, never from a later read. A
  revision streamed mid-flight still lands as a suggestion for later.
- Attachment operations and sends share one queue per artifact, so a send
  never reads files an add or remove is still writing; an operation queued
  before the tap finds the lock and does nothing.
- Delivery states: `editable` (Send available), `pending(id, fireAt)` (countdown
  plus Undo Send through the coordinator), `scheduled(sendAt)`, `sent`,
  `unconfirmed(pendingID:)` ("Keep editing" always; "Check status" only when
  a receipt id is known, because without one there is nothing to look up
  and the honest guidance is to check Sent; nothing automatic).
- A failed send reads through `ComposeTransportFailure`: `rejected` keeps the
  artifact editable with the server's reason; `ambiguous` moves it to
  `unconfirmed(pendingID: nil)` with the check-Sent note. Neither path
  retries, and neither is ever labelled Sent. Reading attachments off disk
  happens before the request, so that failure is a plain editable error
  ("nothing was sent").
- `ComposeSubmission.parse` is the one mapping of the `/api/compose` envelope.
  Only an explicit `sent` object is `.sent`; a 2xx without `pending`,
  `scheduled`, or `sent` is `.unconfirmed`. `ProductStore.sendCompose` uses it
  and refreshes mail only for a confirmed send. `ComposeView` shows the
  unconfirmed message and keeps the draft instead of dismissing.
- `ComposeDraftSnapshot.assistantDraftKey` marks held messages that came from
  an artifact; the shell's Undo Send returns to that conversation
  (`AppEnvironment.revealAssistantChat`) instead of opening the composer.
- Ask/Hold: the route chip and Tab now flip with an empty field, and a route
  the person pinned survives clearing the field (`updateDraft("")` only resets
  an unpinned route). Sending a chat message clears the pin.

Accessibility identifiers on the artifact: `assistant.draft.<toolCallID>`
(container), `assistant.draft.status`, `.account`, `.to`, `.cc`, `.bcc`,
`.subject`, `.body`, `.attach`, `.attachment.<n>`, `.copyFields`, `.send`,
`.undo`, `.sent`, `.check`, `.resume`, `.error`, `.note`, `.suggestion.apply`,
`.suggestion.dismiss`.

## Files

- Added: `apps/ios/Lab86Mail/Features/Assistant/AssistantDraftStore.swift`,
  `apps/ios/Lab86Mail/Features/Assistant/AssistantDraftArtifactView.swift`,
  `apps/ios/Lab86MailTests/AssistantDraftArtifactTests.swift`.
- Changed: `AssistantChatModel.swift`, `AssistantChatView.swift`,
  `AssistantToolCards.swift`, `AppEnvironment.swift`,
  `Core/Models/PendingSendCoordinator.swift`, `Core/Models/ProductStore.swift`,
  `Features/Mail/ComposeView.swift`, `Features/Shell/ShellChrome.swift`,
  `Features/Settings/SettingsView.swift`.

## Write impact check

- Core entities: assistant draft record (new), server draft, pending send
  record (+ `assistantDraftKey`), chat transcript parts.
- Screens: chat transcript (iOS tab, macOS panel), shell pending-send toast,
  full composer (unconfirmed send), Settings sign-out/delete.
- Derived data: card parts restored from history; account resolution from
  `ProductStore.accounts`.
- Notifications/cache/widgets: none.
- Historical snapshots: pending-send snapshot carries the artifact key.
- Invalid references: a record whose owner differs from the session is
  invisible; a receipt missing from the coordinator resolves through
  `/api/compose/status` or stays unconfirmed.
- Time: undo countdown uses the server `fireAt`; no local deadline decisions.
- User-visible errors: save failure ("Couldn’t save · kept here"), send
  failure (inline red text, draft intact), unconfirmed send (note + actions).
- Persisted model: new key; `ComposeDraftSnapshot.assistantDraftKey` is
  optional so older pending records decode unchanged.
- Send lock: while `sendingIDs` holds the artifact, no reader can observe a
  record that differs from what was transmitted; the receipt snapshot names
  the transmitted account, recipients, text, draft id, and attachment key.
- Unconfirmed without a receipt: the artifact says so and offers only "Keep
  editing"; it never claims to have checked an outcome it cannot look up.

## Verification

Environment: Mac over ssh, macOS 27.0 (26A5425a), `/Applications/Xcode-beta.app`
(Xcode 27.0, 27A5209h) selected per command with `DEVELOPER_DIR`; the global
`xcode-select` (CommandLineTools) was left alone. The user's checkout at
`/Users/jjalangtry/Developer/lab86-mail` (with its local scheme edits) was not
touched. The native tree was rsynced to an isolated directory
`/tmp/albatross-native-claude-20260910/apps/ios` (excluding the ignored
`Config/Local.xcconfig`), and the project was regenerated there with a pinned
XcodeGen 2.45.4 binary downloaded into `/tmp/albatross-native-claude-20260910/tools`
(no global install). Linux has no Swift toolchain, so nothing ran locally.

Commands (run from the isolated `apps/ios`, each with
`DEVELOPER_DIR=/Applications/Xcode-beta.app`, `-skipPackagePluginValidation
-skipMacroValidation CODE_SIGNING_ALLOWED=NO CODE_SIGN_IDENTITY=""
ENABLE_DEBUG_DYLIB=NO`):

| Command | Result |
| --- | --- |
| `xcodebuild -project Lab86Mail.xcodeproj -scheme Lab86MailMac -destination 'platform=macOS' -only-testing:Lab86MailMacTests/AssistantDraftArtifactTests test` | `** TEST SUCCEEDED **`, 11 tests in 1 suite passed |
| `xcodebuild -project Lab86Mail.xcodeproj -scheme Lab86MailMac -destination 'platform=macOS' test` | `** TEST SUCCEEDED **`, 403 tests in 28 suites passed |
| `xcodebuild -project Lab86Mail.xcodeproj -scheme Lab86Mail -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -only-testing:Lab86MailTests test` | `** TEST SUCCEEDED **`, 431 tests in 33 suites passed |

Notes: the first macOS attempt failed only in the previews stub-executor link
step (`Ld … Albatross normal`) under `CODE_SIGNING_ALLOWED=NO`; passing
`ENABLE_DEBUG_DYLIB=NO` avoids that Xcode-beta debug-dylib path and is not a
product change. No compiler warnings were emitted for the changed files.
Logs: `/tmp/albatross-native-claude-20260910/{mac-test-2,mac-test-full,ios-test}.log`.

What the new suite (`Lab86MailTests/AssistantDraftArtifactTests.swift`) proves
against real owners: draft parse with call id and cc/bcc/from; a streamed
`show_message_draft` output becomes a store record keyed to
session + tool call, a replay is a no-op, and the transcript round trip
(`transcriptJSON()` → `message(from:)`) restores the same call id; replayed and
revised agent output never overwrites typing (suggestion apply/dismiss, origin
replay ignored after acceptance); persistence across a fresh store over the
same defaults and per-owner isolation plus `clear`; server draft save creates
once then updates the same id, and a failed save keeps the text; a second Send
while one is in flight makes no second transport call, and `.sent` closes the
artifact; a failed send keeps the draft with a visible error and no retry;
`.unconfirmed` is never shown as sent and only `resumeEditing` reopens it; a
`.pending` result registers with `PendingSendCoordinator` carrying the artifact
key, stays pending while the receipt exists, and becomes unconfirmed when the
receipt is gone and the status endpoint is unreachable;
`ComposeSubmission.parse` requires an explicit `sent` object; a pinned route
survives an empty field.

## Initial-pass limitations (historical; finish results below supersede these)

- No physical iPhone or Mac app session exercised the artifact with a live
  agent turn. Simulator and Mac runs above are unit tests plus compilation,
  not iPhone acceptance. Device evidence (screenshots, a real
  `show_message_draft` turn, a real held/undone/sent message) is still owed.
- The Undo Send → `.undone` → editable path and the `.cancelled` / `.failed`
  resolutions are covered only by static reasoning through
  `PendingSendCoordinator.undo`/`reconcile`; the unit tests cannot reach the
  network-backed `/api/compose/undo` and `/api/compose/status` answers.
- Attachment add/remove through the file importer, keyboard behaviour inside
  the lazy transcript, Dynamic Type sizes, and dark mode were not rendered.
- No new UI test: the existing UI test needs an authenticated device and a
  live agent cannot be made to draft deterministically. Identifiers are in
  place for a later device run.
- The web renders the same `dynamic-tool` history parts; that rendering is
  Codex-owned and was not checked here.

## Interruption recovery checkpoint — 2026-09-10, 16:12 EDT

The earlier send-lock follow-up did finish on the isolated Mac before its
connection was interrupted. Recovered logs confirm:

- `mac-test-3.log`: 17 focused tests in one suite passed.
- `mac-test-full-2.log`: 409 tests in 28 suites passed.
- `ios-test-2.log`: 437 tests in 33 suites passed.
- All three end with `** TEST SUCCEEDED **`.

Those results apply to the earlier follow-up, **not** to the additional
attachment-queue changes now saved locally. The resumed Claude Fable 5.1 job
hit its authenticated account session limit before finishing the new changes
or rendering the UI. Its final result names a 6:50pm America/New_York reset;
the queued follow-up also received HTTP 429 and made no changes. Logs are
`/tmp/albatross-native-complete-20260910.jsonl` and
`/tmp/albatross-native-final-review-20260910.jsonl` on the Linux workspace.

New saved work awaiting final verification:

- A protocol seam for attachment storage and a serialized attachment/send
  queue: Send locks new edits immediately, but an attachment operation that
  already began commits its files and chips before the submitted snapshot.
- Owner checks after asynchronous boundaries to avoid resurrecting a draft
  cleared on sign-out or applying results to a replacement owner's record.
- Expanded deterministic attachment/send/owner regression tests, plus a
  shared `Lab86MailTests/Support/StubBackendServer.swift` test helper.
- **Known incomplete test rename:** two new cases still instantiate
  `StubServer`, while the extracted helper is `StubBackendServer`. This is a
  test compilation blocker, not a passing checkpoint.

Still required before native acceptance: finish/test that rename and the
new owner/attachment invariants; implement lossless Odoo v2 read-only
compatibility with an explicit full web-editor link; preserve rich document
`runs` on unchanged native roundtrips and safely clear/update them on plain
text changes; surface bounded attachment-import failures; render and exercise
the real inline email UI on iPhone Simulator with deterministic local data.
The exact queued scope is in
`/tmp/albatross-native-final-review-20260910.md` and
`/tmp/albatross-native-render-acceptance.md`.

No real messages, account settings, native signing configuration, user Mac
checkout, staging, or production were changed during this recovery.

Read-only verification of the saved partial source then ran on the isolated
Mac with the same Xcode/flags above:

`xcodebuild -project Lab86Mail.xcodeproj -scheme Lab86MailMac -destination
'platform=macOS' -derivedDataPath
/tmp/albatross-native-claude-20260910/DerivedData
-only-testing:Lab86MailMacTests/AssistantDraftArtifactTests test`

Result: **TEST FAILED**, exit 65, before running tests. Production source
compiled; the incomplete test file has two root issues: lines 431/475 call
the attachment actor without `await`, and lines 651/687 reference the old
`StubServer` name. The latter causes additional inferred-type diagnostics.
Exact log:
`mac:/tmp/albatross-native-claude-20260910/mac-final-partial-20260910.log`.
No native Swift edits were made by the Codex supervisor to bypass Claude's
ownership boundary.

## Authorized finish checkpoint — 2026-09-10

The user subsequently explicitly approved: “Yes—Codex can finish native this
round.” The earlier compiler issues above are now fixed. Claude Fable 5.1's
implementation and review remain the basis; Codex finished the blocked native
work after reading the applicable iOS implementation/testing/verification
skills. No additional Claude quota attempts were made.

Implemented in this finish pass:

- A new attachment call made during an in-flight send returns immediately
  instead of joining the blocked send queue. Existing attachment writes still
  finish and commit before the exact sent snapshot is taken.
- A From-account change clears the old mailbox's server draft identity.
  In-flight save results check both owner and mailbox before landing; sign-out
  cannot restore old save/error state.
- Selected attachment files are read off the main actor with a 25 MB actual
  byte bound, not just a metadata check. Unreadable/oversized selection reports
  an inline error, with no partial batch silently attached. Send is disabled
  while the selected files are being read.
- Odoo version-2 workbook snapshots are preserved in full, including styles,
  formulas, charts and unknown engine extension fields. Native shows a
  deliberately read-only sheet/cell/formula projection with an explicit
  environment-correct full web-editor link. It does not calculate fake values,
  rewrite the model as legacy v1, or offer unsupported native AI/Google/export
  operations. Failed loads now have an error/retry state instead of a spinner.
- Rich document runs retain optional style flags on unchanged blocks and
  title/type edits. Native renders formatted blocks read-only; replacing
  plaintext clears stale runs rather than associating old formatting text with
  different content.
- The real inline view now takes explicit dependencies beneath its production
  environment wrapper. A deterministic test hosts that exact component in a
  UIKit window with isolated defaults, attachment files and a scripted
  transport, without creating a signed-in application or an auth bypass.

Fresh verified milestone: `mac-native-compat-3-20260910.log` completed
`** TEST SUCCEEDED **`: 25 tests across the inline-draft and native file
compatibility suites. This milestone predates the final mailbox-switch tests
and rendered acceptance fixture; final full-suite results must be recorded
below before acceptance.

In-progress full-suite log paths (isolated Mac):
`mac-native-full-2-20260910.log`, `ios-native-full-2-20260910.log`.
An earlier finish-run failure was a test synchronization mistake: resyncing
the checked-in Xcode project replaced the isolated generated file list. The
project is now regenerated after sync, with the project excluded from
subsequent source-only syncs. No user checkout/project was modified.

Further verified milestones:

- `mac-native-full-final-20260910.log`: **421 tests / 29 suites passed**,
  `** TEST SUCCEEDED **`, including title-save full-snapshot preservation and
  explicit rejection of unsupported native workbook AI mutation.
- `ios-native-full-3-20260910.log`: **448 Swift Testing tests / 34 suites**,
  **two XCTest inline-artifact behavior cases**, and the existing **one shell
  UI smoke test** passed; `** TEST SUCCEEDED **`. The UI smoke reached the
  configuration/authentication boundary, not a signed-in real account.
- Export/inspection caught blank screenshot attachments in the first render
  harness, despite its real-control edit assertions passing. These images are
  **not** visual acceptance evidence. The test-only window is being attached
  to the app's actual UIWindowScene and a nonblank-pixel assertion added;
  revised screenshots must be inspected before declaring visual acceptance.

The scene-attached renderer then passed its nonblank-pixel assertions and
produced eight actual artifact captures (light, dark, inline recipient edit,
attachment error, large Dynamic Type top/actions, pending/Undo, unconfirmed).
These were exported from
`Test-Lab86Mail-2026.09.10_16-48-32--0400.xcresult` and inspected. They verified
the visible inline editing/error/receipt UI, and revealed two visual issues:
the Send label wrapped at accessibility text sizes and its dark-mode contrast
needed improvement. The footer now stacks at accessibility sizes with a
non-wrapping Send label, and the label uses the contrasting paper color.
Final re-capture after those corrections is recorded in the acceptance
section below, not inferred from these earlier images.

An additional send-boundary regression is now fixed and tested: an AI revision
arriving during attachment reads remains a suggestion and cannot silently
cancel an explicit Send. The original submitted text and attachments are
still the only data transmitted. Asynchronous delivery reconciliation also
checks that the person has not resumed editing before applying an outcome.

`ios-native-acceptance-20260910.log`: **450 tests / 34 suites plus two rendered
XCTest cases passed**, `** TEST SUCCEEDED **`. The existing signed-out shell
UI smoke passed in the earlier full-3 run. An unsigned
`generic/platform=iOS` device-SDK build follows in
`ios-device-build-20260910.log`; signing/distribution and real-device use are
not implied by a successful device-SDK compile.

## Final visual and contract acceptance

[Eight inspected native screenshots](evidence/inline-email-2026-09-10/README.md)
are saved in the repository. The final light/dark and accessibility-footer
captures show the corrected contrast and single-line Send label. The real
recipient control updates the persisted draft in place, with no presented
composer. Pending/Undo, unconfirmed guidance, and readable attachment errors
are rendered from the actual owner state with synthetic transport responses.
These are component-level simulator acceptance, not an authenticated live
agent conversation or a physical-device sign-off.

The final contract audit also found a pre-existing native file-save failure:
optional doc `level`, sheet `value`/`formula`/`format`, and deck styling fields
were serialized as JSON null. The strict shared server model schema accepts
omission, not null. Native now omits absent optionals, and Google import/
refresh similarly omit an absent optional `webUrl`. Two focused tests cover
these shapes. Actual Swift-emitted synthetic doc/sheet/deck JSON from the test
log was then piped through the current TypeScript `parseDocumentModel`; all
three passed the real server schema without relaxing its validation.

Current-source verification:

- `mac-native-contract-final-20260910.log`: **424 tests / 29 suites passed**,
  `** TEST SUCCEEDED **`.
- `ios-native-contract-final-20260910.log`: **452 tests / 34 suites plus two
  rendered XCTest cases passed**, `** TEST SUCCEEDED **`. This includes the
  null-omission contract fix and the final artifact UI.
- `ios-device-contract-final-20260910.log`: final unsigned device-SDK rebuild
  ended `** BUILD SUCCEEDED **`, including null-omission changes.

All verification uses the isolated Mac checkout and Xcode 27 beta, with
`CODE_SIGNING_ALLOWED=NO CODE_SIGN_IDENTITY="" ENABLE_DEBUG_DYLIB=NO`, plus the
package/macro validation flags listed earlier. No global Xcode selection,
native signing settings, real email, real account data, release workflow,
TestFlight, staging or production were changed by this native finish task.

Remaining limits are explicit: Odoo's full editor is web-hosted; native v2
workbooks and rich runs are safely inspectable rather than a second native
Office engine. Threaded `ui_open_reply` has not been converted into the new
inline artifact, and replies are not flattened into new messages. Actual
physical-iPhone keyboard/VoiceOver, signed-in Mac visual acceptance and a live
agent-to-send conversation remain separate device/account checks; no claim
of those checks is inferred from simulator rendering or compilation.
