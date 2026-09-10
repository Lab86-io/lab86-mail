# Control-system review and Files next steps

Date: 2026-09-09. Scope: web Albatross. Native is a handoff, not an implemented fix.

## Research and observed problems

Inspected signed-in production in the shared browser (read-only), including Mail,
Calendar, and the rail/profile. The preceding Files review covers Files, search,
editors, and mobile browser layouts. No messages were sent or account settings changed.

Mobbin discovery returned no callable tools in this session. No Mobbin findings are
claimed. Fallback: actual product screenshots, the Radix button documentation opened
and captured in the shared browser, and primary product/library documentation.
Carry these notes into the eventual PR; the Mobbin portion remains unavailable.

- Clerk's rail trigger and avatar resolved to 28px, despite a nested 24px class.
  The avatar box carried an inset ring and several shadows, while its image had
  square corners. Competing geometry and lighting produced a mismatched halo.
- Buttons, selects, and fields used unrelated fills: transparent, dark-only
  alpha fills, elevated backgrounds, and custom gray controls. Ordinary controls
  used multi-layer shadows that competed with dialogs.
- Rail selection used a traveling ShineBorder; collapsed tiles suppressed the
  selected fill and added a second hover glow. The assistant launcher added a
  BorderBeam, ambient accent shadow, and hover scaling.
- Mail search and assistant input had independent lifted surface treatments.
- Web `show_message_draft` wired the Tool UI Send callback to opening the composer.
  The card therefore claimed Sent without a send. It now offers Edit draft and
  stays in review. It does not send an email.

The [Radix button family](https://www.radix-ui.com/themes/docs/components/button)
is a useful reference for separating action emphasis from surface treatment.
[Linear's navigation redesign](https://linear.app/changelog/2024-03-20-new-linear-ui)
is a reference for restrained hierarchy. These inform the implementation; neither
is copied as a replacement visual identity.

## Implemented control contract

| Role | Surface | Depth |
| --- | --- | --- |
| Primary action | Existing theme accent and foreground | Contact shadow |
| Neutral button | `--color-control`, matching control border | Contact shadow |
| Secondary / ghost | Muted / transparent, common hover | None |
| Input, textarea, select | `--color-field`, matching control border | None |
| Selected rail row | Static accent wash, accent text | None |
| Floating launcher | Neutral control | Existing soft elevation |
| Popover / dialog | Existing elevated surface | `--shadow-pop` |

Controls use `--radius-control` (9px); panels keep existing larger radii. Light
neutral controls are brighter. Dark controls retain their contrast. Theme hue,
tint, and depth preferences remain supported. Focus is a visible 2px accent
outline; errors and disabled states remain explicit. Grouped inputs put focus
on the container, not on both the container and its inner field.

Capture and Search now share alignment and surfaces, with Capture as the one
filled primary action. Ask Assistant has a simple chat glyph and platform-aware
shortcut. Neither has a traveling outline. Collapsed navigation retains its
existing magnification and labels but not the glow, and selection stays visible.
The rail profile has one 24px circular clipping box inside a 32px focus target.

Shared primitives propagate this to consumers across the product; explicit
migrations cover Files search/filter fields, Mail search, chat input, and mobile
browser search. This is not a claim that every bespoke surface is migrated.
Document pages/slides intentionally retain their document colors; they are
content, not app chrome. Native controls are unchanged.

## Files: recommended sequence

The product should own useful artifacts, not try to reimplement three office
suites. Separate **Albatross-authored documents** from **connected originals**.
Connected originals must retain their provider identity, version, permissions,
and an Open original escape hatch. Never flatten an unsupported original just
to make it appear editable.

1. **One artifact reference everywhere.** Add an owner-scoped reference carrying
   provider, connection, file/document ID, revision, MIME type, title and
   capabilities. Use it in Files, chat attachments, generated results, work items,
   and narrative citations. Resolve access on the server at use time; don't use
   an expiring download URL as identity. A file picker should offer upload and
   existing Files, show reading/ready/unsupported/error states, and distinguish
   attached metadata from content actually available to the model.
2. **A proper document editor.** The current `DocEditor` is a custom block form,
   not a mature rich-text editing engine. Evaluate Tiptap for authored documents:
   tables, marks, selections, undo, keyboard commands, and explicit autosave states.
   This needs a versioned model migration, not just a React component swap.
   [Tiptap's conversion documentation](https://tiptap.dev/docs/conversion/getting-started/overview)
   describes a separate conversion pipeline;
   [its feature matrix](https://tiptap.dev/docs/conversion/getting-started/feature-support-matrix)
   makes clear why import fidelity must be tested. Evaluate paid conversion and
   data handling before choosing it for connected originals.
3. **Make generated workbooks trustworthy.** `lib/documents/export.ts` already
   uses [ExcelJS](https://github.com/exceljs/exceljs). The sparse-cell model and
   basic grid are the limiting pieces. Add a real selection/copy/paste model,
   formula evaluation, validation, formatting, charts where supported, and
   versioned changes. Evaluate Univer with representative workbooks;
   [its XLSX import/export](https://docs.univer.ai/guides/sheets/features/import-export)
   uses exchange plugins and server infrastructure, not simply the core grid.
   Check licensing, deployment, and unsupported-feature behavior before adoption.
4. **Presentations need a layout pipeline.** The existing generator returns
   free-positioned slide elements and exports with
   [PptxGenJS](https://gitbrent.github.io/PptxGenJS/docs/quick-start/). Keep that
   export investment. Add curated templates, theme tokens, slide outline review,
   source references, thumbnails, overflow/overlap detection, notes, and
   slide-scoped regeneration with undo. A generated deck should be checked
   visually before it is presented as ready, not merely pass its JSON schema.
5. **Choose the fidelity boundary deliberately.** For full editing of imported
   DOCX/XLSX/PPTX, run a small bake-off against an embedded office suite such as
   [ONLYOFFICE Developer](https://www.onlyoffice.com/developer-edition).
   That is a hosting/licensing/security decision. It should not be silently
   installed as another frontend dependency or receive user files by default.

Chat uploads already exist: web `AIBar` stages up to five files through
`/api/agent/uploads` (25MB combined); native chat has an attachment importer.
The web picker currently advertises images, PDF, text, and CSV, not Office.
`getStagedAgentUpload` resolves owned uploaded files for downstream tools.
So the next change is existing-file selection, Office extraction/preview, and
reusable artifact references—not adding a second upload store. Simply widening
the picker is insufficient unless the assistant can reliably read those formats.

Acceptance gates: owner isolation, expired/revoked links, unsupported fidelity,
conflict recovery, autosave/undo, keyboard navigation, realistic large files,
reopen exported artifacts in their native apps, formula results, and slide
render comparisons. Do not advertise first-class Office editing before these pass.

## iPhone inline email composer: native owner handoff

Ownership: Claude (`AGENTS.md`). No native source or mobile v1 contract changed.
An explicit override is required for Codex to implement this portion.

Evidence: `AssistantToolCards.swift` parses a `DraftCard` with only to/subject/body
and displays truncated static text. It has no editable draft, sender selection,
send state, or failure recovery. `NavigationModel.open(mailto:)` switches the
global sheet to Compose. These paths are vulnerable to losing the chat's
presentation context; the exact reported iPhone failure has not been reproduced
on a device here and should not be claimed as conclusively diagnosed.

Implement an `InlineEmailDraftCard` in the transcript with a model keyed by
conversation ID + stable tool-call ID. Keep draft edits separate from streamed
tool output, and persist/recover them across chat restoration. Required fields:
sender account, To, expandable Cc/Bcc, subject, multiline body, attachments;
reply/thread/message identity must survive when applicable. Never overwrite
user edits when a tool result re-renders.

The card stays inline. Editing may expand within the transcript; it must not
mutate `navigation.sheet` or launch a `mailto:` URL. Use native fields and
TextEditor, explicit labels, 44pt targets, Dynamic Type and VoiceOver. Show a
summary when collapsed. Keep the main chat composer independent.

States: draft → validating → submitting → pending undo / scheduled / sent, or
recoverable error. Use the existing `ProductStore.sendCompose` transport and
draft persistence as the starting point, extracting a shared submission model
from `ComposeView` rather than duplicating it. Preserve undo/scheduled semantics.
The current transport returns `.sent` even if the `sent` object is absent;
require positive server evidence instead. Audit an idempotency contract before
adding retries; do not assume the current send method has one. A timeout must
not automatically trigger a second send.

Only an explicit user's Send tap may submit. Disable duplicate taps, preserve
draft text on failure, keep uncertain delivery distinct from failed delivery,
and never let model text or a display tool declare delivery success. When
sender account is ambiguous, require selection. No silent account fallback.

Tests: edit/re-render, history restore, two independent draft cards, changing
accounts, invalid recipients, double tap, timeout, queued/undo/scheduled/sent,
attachments, keyboard avoidance, long body, Dynamic Type, VoiceOver, background
and resume. Verify on iPhone and Mac separately; this Linux workspace is not
native acceptance evidence.

## Verification

Use `scripts/preview-narrative-tools.mjs --controls` and
`scripts/verify-controls-ui.mjs` for real shared components against synthetic
context. `--files` and `scripts/verify-files-ui.mjs` cover the existing Files
changes. Shared-browser production screenshots are before-state evidence,
not proof of deployment. Final test results and artifact paths are recorded
after the acceptance runs below.

### Acceptance results

- Full Bun suite: 3,388 passed, zero failed (337 files).
- Production build and its TypeScript check passed; standalone typecheck and
  repository lint also passed.
- Controls and Files browser acceptance passed at 390, 768 and 1440px, in light
  and dark themes. Covered field surface parity, visible focus, selects/tabs,
  callbacks, disabled controls, draft Edit staying in review, avatar bounds,
  collapsed selection and centered glyphs, Files paging/search/filter behavior,
  provider failure, read-only fidelity, and save conflict recovery.
- Preview server includes production CSS/font chunks and the layout font
  variables; browser checks wait for fonts, rather than accepting fallback text.
- Actual Next dev server is running on loopback port 18841 (18838 was occupied
  and left untouched). Local entry reaches `/sign-in` but returns 401; Clerk logs
  a session refresh redirect loop. This is a local authentication blocker, not
  evidence that authenticated app testing passed or a confirmed key diagnosis.
- Shared-browser automation became unavailable while trying to open the dev
  server. Local Playwright provides the changed-code screenshot evidence.
- Nothing deployed; no native source changed, no messages sent.
