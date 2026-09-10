# Albatross workspace round — accepted direction

## Scope and design checkpoint

The latest user direction overrides the earlier fixed-header proposal: quiet Search in the rail, one personable floating Ask/Hold entry, and Chat as a first-class destination. Corner chat is a nonmodal translucent spotlight. Expanding keeps the current page on the left and the same conversation on the right; collapsing the page provides chat-only space. On phone, chat fills the screen and returns to the existing page. Presentation changes must not reset drafts, attachments, tool cards, streams, page filters or scroll.

Other accepted work: coherent solid canvas/content/field/floating roles; aligned sender avatar geometry; restrained list and date separators; decoded snippet entities; Settings / Notifications / Profile footer; mailbox scope in Mail; Appearance in Settings; actionable Notifications distinct from Activity; durable native inline email; versioned Files editing and a fidelity-first Office pilot.

## Research and ownership

- The user's Mail screenshot demonstrates the sender-ring offset, weak row separation and entity-escaped previews. The supplied Messages plus-menu reference establishes the local spotlight/transparency direction, not a request to clone the phone layout on desktop.
- Mobbin discovery found no available MCP tools. This is an explicit research limitation, not a completed Mobbin review. Existing product flows, actual browser/component previews and official primary references are the fallback. Further feature-specific research lives alongside this note and belongs in the PR.
- Claude Fable 5.1 is used for the floating control/frame and native implementation. Codex owns web state/routing/integration. Claude owns `apps/ios`, MobileAPI and `lib/mobile/v1` under AGENTS.md.
- ONLYOFFICE's [Developer license FAQ](https://helpcenter.onlyoffice.com/docs/faq/developer.aspx) distinguishes evaluation/development from providing an embedded editor to end users. Its [Automation API](https://api.onlyoffice.com/docs/docs-api/usage-api/automation-api/) is an extra-cost Developer feature. The [React wrapper](https://github.com/ONLYOFFICE/document-editor-react/blob/master/LICENSE) uses Apache 2.0. Hosting, commercial rights and runtime approval remain separate gates; no purchase or paid provisioning is authorized yet.
- The user selected embedding Odoo's standalone spreadsheet (not an ERP account connection). [Odoo's standalone spreadsheet](https://github.com/odoo/o-spreadsheet) supports Excel import/export and is separable from the ERP suite, with an [Owl integration API](https://github.com/odoo/o-spreadsheet/blob/19.0/doc/integrating/integration.md) and LGPLv3 license. This is a spreadsheet engine, not evidence of Word/presentation fidelity. Fable 5.1 is implementing the lifecycle adapter and full-snapshot integration. ONLYOFFICE-specific activation remains paused. Its live pricing calculator displayed $3,500 for development and switched to a quote request with production selected; no production price or purchase is approved.

## Acceptance gates

- Search: existing global shortcuts, left/right categories, page navigation and file/event results preserved; quiet rail affordance and mobile access; keyboard-visible focus.
- Assistant: one launcher, empty-field Ask/Hold switching, reduced motion; corner/split/full keep actual mounted owners; split resize by keyboard and pointer; background remains usable in corner mode, inactive when hidden; close restores focus.
- Foundations: image/initial/failure avatar geometry; row/date separation; no texture over working text; light/dark and narrow/wide screenshots; semantic field/control/floating fills.
- Notifications: opening marks read only; resolved records never downgraded; live questions/approvals remain outstanding; deduped shared counts, error/empty/loading states, details and return path.
- Files: conflict preserves local edits and stops retry loops; version restore is recoverable; AI does not overwrite newer typing; original Office bytes preserved. An unconfigured Office service is not a verified editor. Real editor save/reopen/formula/formatting/conflict evidence is required before claiming fidelity.
- Native email: editable inline artifact, account/recipients/body/attachments, durable identity and edits, explicit send, duplicate protection, visible failures, pending/undo/scheduled/confirmed-sent distinctions. Native builds and device evidence reported separately.
- Release: focused and full regression checks, build/typecheck/lint, synthetic browser checks, exact staging deployment and signed-in smoke checks, PR to main with research/evidence, two completed CodeRabbit review rounds with findings addressed. This request does not authorize merging main.

## Verification record

Implementation and acceptance are in progress. No current-round deployment or completion is claimed by this planning checkpoint.

- The corrected Basic Auth credentials restored staging access in the shared browser; the existing signed-in app session was available. No real mail/notification mutations were performed.
- Mail and Appearance were checked with actual components at 390/768/1440 in light/dark; Appearance meaningful headings/readouts exceed 5.3:1 in the tested custom palettes. Per-surface evidence is recorded in the companion acceptance notes.
- Notifications passed 41 focused tests and synthetic browser acceptance across the same viewport/theme matrix.
- Integration review found and fixed hidden-page navigation from full chat, single-key mail shortcuts leaking from chat controls, and a breakpoint remount of the chat owner. File identity and pre-generation AI revision races are assigned to the Files implementation and require regression acceptance.
- Dormant Office callback handling now captures the base revision before content transfer, preserving a slower concurrent transfer as recovery instead of overwriting the newer commit. This does not prove the document server's callback ordering semantics; real engine force-save/replay testing remains an activation gate.
- The parallel Codex workers stopped at their usage limit after saving work; independent Fable 5.1 CLI jobs continue native, shell and Odoo implementation. No finished native-device, Odoo fidelity or release acceptance is inferred from their partial edits.
- An actual AppShell/AIBar/AskHoldComposer/Search browser fixture (only providers/transport stubbed) passed typed-draft + attachment identity, empty Hold selection, corner/split/full switching, in-place Search navigation, close/reopen and phone/desktop breakpoint retention. Script: `scripts/verify-app-workspace-ui.mjs`; first artifacts: `/tmp/albatross-app-workspace-B0Vjlq`. Final screenshots must wait for theme transitions to settle; the first dark captures were intermediate animation frames, not accepted dark-mode evidence.
- Copied third-party runtime assets under `public/vendor` are excluded from app lint/format so upstream files stay intact. The asset sync/manifest tests, pinned package versions and license notices are the integrity checks for that directory.
- A follow-up actual AppShell browser run passed active `useChat` streaming across presentation, close/reopen, and viewport changes, then rendered the native-shaped `dynamic-tool` email card without navigation or sending. Script: `scripts/verify-app-workspace-ui.mjs`; settled light/dark screenshots: `/tmp/albatross-app-workspace-c1H799`. Web still offers an explicit Edit draft action; inline native editing is verified separately.
- The shared agent prompt now defaults new-email drafting to `show_message_draft`, not automatic `ui_open_compose`, and forbids closing chat after presenting a draft unless requested. Prompt/display tests: 37 pass. Threaded reply workflow remains separate; this change does not claim native threaded-reply parity.
- Original imported workbook bytes are now included in account-deletion cleanup; a two-owner Convex test proves the deleted owner's bytes and metadata are removed without touching the other owner. Office persistence tests: 6 pass; Office security/error tests: 6 pass.
- Broad web regression checkpoint: 3,453 pass; subsequent coverage run reached 3,456 pass with one obsolete source-format assertion caused by the new keyed Google editor. That assertion was updated and its six-test suite passed. All checks must run again after Odoo/native integration finishes.

## Resumed completion pass and budget decision

- A later complete broad checkpoint passed 3,457 tests, zero failures, and the Next production build succeeded. The user was explicitly told these were local checkpoints, not evidence of a staging deployment or finished native/engine acceptance.
- On the resumed pass, three supervised Claude Fable 5.1 jobs worked on native acceptance, Odoo reliability, and document/presentation UI. Their code and evidence were saved incrementally. All three subsequently hit the shared Claude account quota. The web workers are completing saved changes directly under Codex ownership; native implementation is paused pending Claude availability or an explicit user ownership override. Codex continues integration, agent tools, and release gates.
- The user authorized document-server hosting inside the existing Railway lab86-mail staging/production environments, then rejected ONLYOFFICE's commercial pricing and asked for free or less than $100/month. No commercial license purchase, application relicensing, or paid office service provisioning has occurred. Hosting approval is not license acceptance.
- Current official ONLYOFFICE pricing shows $3,500 for the displayed **development** configuration, while production embedding is quoted separately and renews annually. The 30-day Developer evaluation cannot be provided to end users. See [pricing](https://www.onlyoffice.com/developer-edition-prices) and [license FAQ](https://helpcenter.onlyoffice.com/docs/faq/developer.aspx).
- Collabora is the budget pilot candidate, not yet a verified deployment. [CODE](https://www.collaboraonline.com/code/) is free for testing/home/small-team use and not recommended by its vendor for production. [Source/binary terms](https://www.collaboraonline.com/terms/collabora-online-mplv2/) must be distinguished before public activation. [Railway's community OpenCloud template](https://railway.com/deploy/opencloud-drive) includes Collabora; that is feasibility evidence, not acceptance of our own configuration. At [Railway usage rates](https://docs.railway.com/pricing/plans), two instances each averaging 2 GB RAM and 0.25 vCPU illustrate about $50/month before storage/traffic, excluding existing app/AI costs; actual engine usage remains unmeasured.
- Added `document_edit` to the registered and AI-SDK-lifted chat tools: exact block/slide/element/cell operations, expected-revision check, atomic preparation, explicit review/apply outcomes, and engine-backed cell proposals rather than false applied status. Focused tests execute the actual AI SDK tool wrapper under an isolated authenticated context, including conflicts and private ownership. The natural-language generation tools remain available.
- File edit tool cards distinguish pending review from saved revisions; same-shell file links preserve the conversation and composer, revealing Files beside chat. Real AppShell browser acceptance passed all nine navigation/state checks, including streaming/breakpoint state and the new file-result link. Artifacts: `/tmp/albatross-app-workspace-NSjy8K`. That fixture initially lacked the selected file response and displayed a file-loading error; a valid synthetic response and an assertion on the opened file title were added for the next run. The first capture is not evidence of a successfully loaded file body.
- Google publishing is blocked for engine workbooks and marked rich-text documents rather than silently dropping features. Owned files keep engine Excel / rich DOCX export; direct Google editor capabilities must stay honest and bounded.
- Document canvas is inert while applying a suggestion or restoring a revision: a disabled fieldset alone does not disable contenteditable elements. The Files browser acceptance now tests both native controls and focus exclusion.
- Native recovered send-state test results: 437 iOS Simulator tests, 409 Mac tests, and 17 focused inline-draft tests passed. The later attachment-await/account-boundary changes are not accepted: the latest focused test build fails with missing actor `await` calls and stale test-helper references. Native v2 workbook and rich-run preservation and rendered acceptance remain unfinished. This is a release blocker, not a successful native build.
- The user subsequently granted an explicit one-round ownership override: **“Yes—Codex can finish native this round.”** The native worker is resuming the saved Claude changes directly, with separate iOS/Mac build, regression, and rendered-inline-draft acceptance still required. This does not permanently change AGENTS.md ownership.

No current-round staging deployment, main PR, CodeRabbit review, or production change is claimed by this checkpoint.

## Release acceptance checkpoint (supersedes partial results above)

The current implementation uses built-in rich-text documents, structured slide decks,
and the pinned standalone Odoo spreadsheet engine. These editors require no separate
document server or purchased editor license. They are not a full-fidelity arbitrary
DOCX/PPTX import service. The dormant ONLYOFFICE path remains disabled; no document
service was provisioned and no license was purchased. Collabora remains a separately
documented feasibility investigation, not a shipped capability.

- Web: the complete coverage run reached 3,557 passing tests and zero failures before
  the final migration/coverage additions. Full lint and typecheck passed; production
  build passed at the preceding checkpoint. Final release checks run again on the
  complete frozen source.
- Real AppShell acceptance: eleven checks pass, including streaming and attachment
  identity through corner/split/full and phone/desktop transitions, keyboard Search
  navigation, file-tool navigation retaining chat, usable split Files layout, panel
  focus/inert behavior, and no unsolicited save when a document opens. Script:
  `scripts/verify-app-workspace-ui.mjs`; artifacts `/tmp/albatross-app-workspace-mvjmBY`.
- Files: rich document/slide browser save/reopen, immediate download, formatting,
  presentation navigation and light/dark narrow/wide acceptance pass. The document
  workspace uses its actual container width, including when chat occupies the right
  half. Google AI proposals cannot overwrite a locally changed title/body/format or
  act while a save is pending/failed; the actual browser regression is
  `scripts/verify-google-proposal-ui.mjs`.
- Odoo: fifteen browser import/edit/reopen/export checks passed with zero browser or
  HTTP errors. Original XLSX bytes remain recoverable; unsupported fonts/images are
  explicitly reported. Reviewable AI cell edits resolve exact existing sheet IDs
  before names. Unknown sheets are rejected unless explicitly requested as new;
  command failures roll back without partial edits. The real pinned-engine command
  harness verifies ID preservation and no accidental sheet creation.
- Native: the user-authorized Codex finish preserved saved Fable work and fixed the
  remaining draft/account/attachment races. The current Mac suite has 424 passing
  tests across 29 suites; iPhone Simulator has 452 passing tests across 34 suites
  plus two rendered XCTest cases. The final unsigned generic iPhone device-SDK
  build passes. Actual Swift-emitted doc/sheet/deck payloads pass the strict
  server schemas after fixing optional null serialization. Native rich runs remain
  preserved; v2 spreadsheets have a safe read-only native preview and a link to the
  correct environment's web editor, not a native editing-engine parity claim.
- Native visual evidence is checked in at
  [`docs/mobile/evidence/inline-email-2026-09-10/README.md`](../mobile/evidence/inline-email-2026-09-10/README.md).
  Main and native agents inspected the actual SwiftUI light/dark, large-text, pending
  Undo and unconfirmed/error states. Tests use isolated state/transport; no real email
  was sent. Physical iPhone, VoiceOver, signed-in native acceptance and distribution
  remain separate checks. Unsigned CI now uses the same `ENABLE_DEBUG_DYLIB=NO` flag
  as the verified Xcode 27 beta configuration; nine release-workflow tests pass.
- Claude Fable 5.1 contributed UI/native work before its quota was exhausted. The
  user's one-round native ownership override allowed Codex to finish verification;
  AGENTS.md ownership is unchanged. No Mobbin review is fabricated: the unavailable
  integration and actual browser/official-source research fallback are recorded above.

Staging deployment and two completed CodeRabbit full reviews remain release steps,
not inferred from local checks. Production and main are unchanged at this checkpoint.

Final frozen web source: **3,568 tests pass, zero failures, 19,818 assertions across
362 files** (`bun run test:coverage`). Typecheck and full lint (1,150 files) pass.
Legacy grid migration now preserves typed literals, explicit formulas and number
formats; sixteen real-engine cells survive reopen and XLSX export/reimport. Pinned
third-party assets are marked vendored and retain upstream whitespace verbatim;
asset integrity tests remain the check rather than rewriting dependency bytes.

The final `bun run build` exits successfully. Against the last successful main
coverage baseline, changed-library and new-file gates have zero failures; library
line coverage rises from 89.17% to 89.84%. This is the local staging-release gate,
not a claim that the deployment or PR review has completed.
