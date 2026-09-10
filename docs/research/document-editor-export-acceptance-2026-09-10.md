# Document editor baseline and export acceptance

## Scope and research

The standalone Odoo engine is a spreadsheet engine. This track improves Albatross's canonical document and presentation editors without claiming arbitrary imported DOCX/PPTX round-trip fidelity. Root is separately evaluating the hosted Office service and its licensing gate.

Mobbin was unavailable after tool discovery. Following the UI-research fallback, the existing actual Files component was rendered with synthetic data before editing, and the [official Tiptap React integration guide](https://tiptap.dev/docs/editor/getting-started/install/react) was reviewed. The guide recommends the React/ProseMirror/StarterKit integration and client-only initialization for SSR. Fable 5.1 owns the richer editor UI implementation and its separate acceptance note.

Baseline browser: `bun scripts/preview-narrative-tools.mjs --files`, Chromium at 1440 × 900, `owned-doc` and `owned-deck` scenarios. Screenshots inspected: `/tmp/albatross-editors-before-rnj9zm`. No provider or account was contacted. The document canvas preserves useful editorial density but lacks visible formatting tools; the deck's blank thumbnail and passive canvas do not communicate editing affordances. Keep the stable file header/save state and AI rail while adding discoverable editing controls inside the canvas workspace.

The complete existing Files browser suite subsequently passed at 390/768/1440 in light/dark (`/tmp/albatross-files-ui-c6L1Rm`, `/tmp/albatross-files-pre-extraction-verify.log`). It covers browse/search/filter, provider failures, owned/provider save and conflict recovery, version restore, and AI revision locks. The preview now compiles current app/component CSS rather than relying on stale `.next` styles. The restore check now verifies the whole canvas is disabled and inert, and cannot receive focus, which also protects contentEditable rich text. This is the **pre-rich-editor extraction baseline**; the final editor UI must be checked again.

## Export checks

`bun test tests/document-rich-export.test.ts tests/documents.test.ts`: 14 pass, 0 fail, 62 assertions at this checkpoint. Tests unzip the actual generated Office archives; these are not filename-only assertions.

- DOCX preserves bold, italic, underline, strike, code font, explicit line breaks and escaped text.
- Heading, bullet, numbered and quote paragraph styles preserve inline runs; separate ordered-list groups have separate numbering identities.
- If stale rich runs disagree with the authoritative plain text, export keeps the plain text instead of exporting outdated content.
- PPTX preserves slide order, shape geometry/fill/border, text color/font size and speaker notes.

These tests establish canonical-model export behavior. They do not establish arbitrary external Office import fidelity, native UI rendering, actual Microsoft Office rendering, or the separately hosted editor's callback lifecycle. Browser editing/save/reopen verification is recorded separately when complete.
