# Workbook persistence and provider-fidelity review

This is a supplement to the spreadsheet UI acceptance notes, not a claim of full Excel, Word, or PowerPoint compatibility. Checks used synthetic files and isolated storage; no account files or provider data were changed.

## Original-file cleanup

`createImportedDocument` chooses a document ID before creating the record. If the create response is lost, `cancelImport` settles that exact identity atomically:

- An already attached original is retained and the committed document is returned to its owner.
- An unattached original receives a cancellation tombstone before its bytes are deleted.
- A delayed create checks the tombstone and cannot attach already-deleted bytes.
- References owned by another user are retained without exposing that user's document.
- An unconfirmed cleanup response is reported as unconfirmed, not success or a claim that nothing was imported.

Cancellation metadata is included in user deletion. The import route uses this wrapper; bounded-archive and UI acceptance are recorded in `odoo-spreadsheet-2026-09-10.md`.

## No silent Google downgrade

Publishing or syncing an Odoo v2 workbook through the values/formulas-only Google writer is blocked before credential resolution or provider writes. The user is directed to the engine's Excel download. Existing Google originals are untouched. New rich-text document runs are likewise blocked from the current plaintext Google writer, with an actionable DOCX-download instruction.

The Google publish HTTP endpoint returns `422 GOOGLE_FIDELITY_UNSUPPORTED` for these expected limitations. Oversized document-create revisions return an actionable 413 rather than 500.

## Verification

- `bun test tests/odoo-import-service.test.ts tests/odoo-import-cleanup-runtime.test.ts`: 7 passed, 21 assertions at the initial checkpoint.
- `bun test tests/odoo-google-fidelity.test.ts tests/google-document-fidelity.test.ts tests/documents-services.test.ts`: 22 passed, 98 assertions.
- `bun run typecheck`: passed at this checkpoint.
- `PLAYWRIGHT_CHROMIUM_EXECUTABLE=... bun scripts/verify-spreadsheet-commands.mjs`: passed in real Chromium with the actual pinned Odoo engine. No-op, partial failure, new-sheet rollback, read-only rejection, and successful apply/Undo preserve prior human data. The fixture is an isolated engine model, not the Files UI acceptance test.

The no-op rollback suspicion was tested, not assumed: Odoo rejects unchanged UPDATE_CELL commands with `NoChanges`, so those commands are not counted as undoable changes. The adapter now treats this reason as harmless, so a proposal can contain already-satisfied cells without failing. Failed proposal rollback did not undo a preceding human edit.
