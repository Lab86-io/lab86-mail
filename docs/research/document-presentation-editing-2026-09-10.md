# Documents and presentations — implementation and acceptance

## Product boundary and research

Odoo's standalone `o-spreadsheet` package supplies the spreadsheet engine. These are Albatross's document and presentation editors, not a claim that Odoo embeds a complete Word/PowerPoint suite. Arbitrary Office import fidelity and any hosted Office engine remain separate activation/acceptance gates.

Mobbin was unavailable after tool discovery. The actual existing Files UI was rendered before implementation (`/tmp/albatross-editors-before-rnj9zm`), and the [official Tiptap React guide](https://tiptap.dev/docs/editor/getting-started/install/react) was reviewed. That informed a client-initialized ProseMirror editor with proper schema, selection and history instead of manual contentEditable/execCommand behavior. Tiptap React/PM/StarterKit are pinned at 3.31.3; no paid Tiptap functionality is used.

Claude Fable 5.1 was actually used, via the authenticated CLI, for the initial editor design, canonical rich-text adapter, deck model/history helpers and scoped stylesheet. Its job hit the account session quota (API 429) after saving those changes. Codex completed the React components, integration fixes and acceptance instead of presenting the interrupted job as finished. Durable Fable log: `/tmp/albatross-doc-deck-ui.jsonl`.

## Implemented

- Rich documents: paragraph/headings, bold/italic/underline/strike/code, semantic flat bullet/numbered lists and quotes, keyboard shortcuts, block movement, undo/redo, heading outline, word count and an intrinsically growing continuous document canvas. The old approximate pagination helper is removed; this does not claim print-layout pagination.
- Stable block IDs live in editor transactions. Paragraph-to-list changes preserve IDs; splitting introduces one new identity, and undo/redo restores it. Optional rich runs must concatenate exactly to the required canonical plain text, keeping native/tool compatibility.
- Parent adoption of a genuinely different model creates a new undo boundary. Readonly changes do not emit document edits; opening an untouched file never autosaves it. Restore/AI application makes the entire working canvas inert and disables editing.
- Direct Google editing explicitly stays within the existing paragraph-level provider subset. Rich marks are not available there; rich paste becomes plain text with an explanation. Root's provider guards also prevent silently lossy publishing and applying unsupported AI proposals.
- Presentations: actual scaled thumbnails, slide insertion/duplicate/reorder/delete, text and rectangle selection/insertion/deletion, editable text, bounded x/y/width/height, font size, text/fill/border/background colors, notes and undo/redo. Selected objects support arrow-key nudging, Shift for larger movement, Enter to edit and Delete to remove.
- Presentation mode uses a native modal dialog with previous/next/Home/End and Escape, restoring focus on exit. The filmstrip and editor padding adapt to the actual editor container, including desktop split-chat layouts, not the whole browser width.
- Supported DOCX rich runs and PPTX layout/notes survive real exports. Download flushes the current draft before generating bytes; a failed save does not download an outdated version.

## Evidence

`scripts/preview-document-editors.mjs` serves the actual `DocumentEditor` owners and actual DOCX/PPTX export functions against isolated in-memory synthetic records on loopback port 18848. No account, provider, live AI or real file is touched.

`bun scripts/verify-document-editors-ui.mjs` passed with **zero browser page errors**. Final log: `/tmp/albatross-doc-browser-complete.log`. Final screenshots: `/tmp/albatross-document-editors-OX9aiP` (earlier equivalent settled screenshots in `/tmp/albatross-document-editors-EvrASd` were visually inspected).

The browser suite verifies formatting, real lists, keyboard operations, stable IDs, block reorder, undo/redo, saved reopen, immediate-download save flushing, and unzip/inspection of the resulting DOCX. It checks long paragraphs and long unbroken text grow and wrap without horizontal clipping at 390 and 1440 pixels, in light/dark, and verifies the empty writing prompt.

For presentations it verifies object text/font/geometry editing, keyboard nudging, duplicate/reorder identities, notes, modal navigation and Escape focus restoration, save/reopen, and actual generated PPTX text and notes. It also confirms Google-safe editing cannot introduce unsupported bold marks, including rich paste, and unsupported Office table paste preserves its text with an explicit limitation notice. Settled `doc-editor-*` / `deck-editor-*` screenshots were visually inspected separately from stress-test captures.

Focused model/runtime tests cover all supported block conversions, stale-run rejection, long text, fresh pasted identities, exact real-Tiptap split undo/redo IDs, no readonly/lifecycle update, slide duplicates/selection, fractional bounds, coalescing history and supported color normalization. Export tests inspect generated OOXML text/mark/list and slide/style/note contents. The existing full Files workflow additionally passed after extraction (`/tmp/albatross-files-ui-YJfa6U`), recorded by root.

Final focused command: `bun test tests/document-editor-models.test.ts tests/document-editor-runtime.test.ts tests/document-rich-export.test.ts tests/files-editor-contract.test.ts tests/documents.test.ts tests/document-edits.test.ts` — **42 pass, 0 fail, 202 assertions**, `/tmp/albatross-doc-final-tests.log`. Scoped Biome passed. Full-app TypeScript is also checked independently by root during release verification.

## Deliberate limits

This is a structured editor, not arbitrary Office round-trip fidelity. Documents do not yet model tables, images or nested lists; unsupported rich paste is disclosed as text-only. Presentations model text and rectangles, not masters, charts, animations or arbitrary PowerPoint objects. No full hosted Office engine, physical-iPhone validation or production deployment is inferred from these web results. The final PR should include root's independent native, spreadsheet and release evidence.
