# Embedded spreadsheet: implementation and acceptance

## Product boundary

Albatross embeds Odoo's standalone **o-spreadsheet 19.0.50**, not an Odoo ERP
account or the complete Odoo Documents product. This provides a real spreadsheet
canvas, formula evaluation, formatting, worksheet navigation, Excel import and
export, and undoable cell-command editing. It does **not** provide an embeddable
Word or PowerPoint engine. The separate Albatross document/presentation editors
are documented in their own acceptance notes.

The spreadsheet library is LGPL-3.0-or-later; Owl 2.8.2 is LGPL-3.0-only. No
commercial editor license, Odoo subscription, purchase, or extra document server
was added. Redistribution obligations remain; source and license notices are
supplied rather than treating “free” as “no obligations.” This is implementation
documentation, not a legal opinion.

## Research and design

The user explicitly selected standalone Odoo embedding and requested Claude
Fable 5.1 for UI work. Fable implemented the initial integration and the expanded
browser acceptance flow; Codex completed security, integration, and verification
after the shared Fable account reached its session limit. No substitute was
represented as Fable.

Mobbin access was unavailable. Research used the upstream integration source,
the user-approved Files direction, and browser checks of the actual component:

- https://github.com/odoo/o-spreadsheet/tree/19.0/doc/integrating
- https://github.com/odoo/o-spreadsheet/tree/e4992587245f832c0dbf361b1f23f14b74613d4e
- https://github.com/odoo/owl/tree/54129a5f8dfc1ce16c62ee2f216058c043043a6e

The editor sits inside the existing dense Files workspace, with file identity,
save state, versions, original-file access, and a collapsible AI rail. Its
working canvas remains neutral and readable in both app themes. Vendor
Bootstrap rules are scoped under `.albatross-sheet-frame`, not global.

## Data and editing

- Version 2 stores the **full tagged engine snapshot**, including engine fields
  the simplified version 1 grid cannot represent. Version 1 workbooks upgrade
  on their first engine edit/save. Server safeguards reject silent downgrades.
- Autosave uses revision compare-and-swap. File identity changes retain/flush
  outgoing work under the old identity. Conflicts stop automatic retries and
  offer a downloadable local draft and explicit saved-version reload.
- AI cell changes are reviewable, revision-bound, applied through real engine
  commands, and undoable. Failed command sequences roll back only their own
  changes. Already-satisfied cell updates are harmless no-ops.
- Original imported bytes are stored unchanged. Import warnings persist and
  the original remains downloadable. Race-safe failed-import compensation is
  detailed in `odoo-import-safety-2026-09-10.md`.
- Google publication of a full workbook is disabled with an explicit reason;
  the current Google writer must not silently reduce it to values and formulas.

## Import limits and fidelity

Imports accept plain `.xlsx`, up to 15 MiB, bounded to 4,000 archive entries,
120 MiB declared expanded total and 48 MiB per part. Actual inflation is counted
and stopped at its limit; JSZip's eager whole-archive CRC option is not enabled.
Multipart bodies are bounded before parsing, and snapshots must fit the 900 KB
revision budget before original-byte upload. Macro/ActiveX, encrypted, legacy
OLE, ZIP64, malformed directory/local headers, and unsafe paths are rejected.

This is **not a claim of complete Excel fidelity**. Embedded images are omitted
with a warning because an engine image store is not integrated. Other
unsupported features are described by retained engine import notes. The tested
ExcelJS workbook produced a visible **Calibri-to-Arial** substitution warning.
Its two sheets, formulas and evaluated results, bold text, and numeric format
survived import/export. The untouched original's SHA-256 was verified.

## Replaceable library delivery

The engine and Owl are separately served same-origin ESM, loaded at runtime.
The engine's one bare Owl import is rewritten to the pinned vendor URL; engine
logic is unchanged. They are not imported as runtime package dependencies into
Albatross application chunks. Both complete corresponding source archives,
licenses, hashes, Bootstrap MIT notice, Font Awesome OFL/MIT notices, and
rebuild/replacement instructions are under `public/vendor`. The editor exposes
a source/license link. `scripts/sync-odoo-spreadsheet-assets.mjs` reproduces the
runtime copies and manifest.

## Completed verification checkpoint

**Actual engine + actual Files/DocumentEditor UI**, synthetic authenticated
storage transport only. No provider account, personal file, or real notification
was changed.

`PLAYWRIGHT_CHROMIUM_EXECUTABLE=... bun scripts/verify-spreadsheet-ui.mjs`
passed 15 steps with **zero HTTP, console, or page errors**:

1. Real external-ESM engine renders at 1440, 768, and 390 px, light/dark, no page overflow.
2. Formula typing saves a full version 2 snapshot once.
3. Formula results evaluate correctly and are present in exported Excel.
4. Keyboard bold is preserved in the saved snapshot.
5. Navigation away/reopen restores formulas and formatting.
6. Dirty A → B navigation cannot save A into B.
7. Failed outgoing saves retain recoverable edits.
8. Conflicts stop retries, preserve the local draft, and allow explicit reload.
9. A macro-enabled archive is refused before import.
10. Excel import retains both sheets, formula/style/format data, and exact original SHA-256.
11. Excel export reopens via independent ExcelJS parsing with expected formula results and formats.
12. Import notes and original download are visible.
13. AI application uses engine commands and locks editing while its revision-bound save is pending.
14. The narrow 390 px web editor supports keyboard cell editing and full-snapshot autosave.
15. No browser errors.

Final evidence and rendered screenshots: **`/tmp/albatross-spreadsheet-ui-a4WLBZ`**.
Its `evidence.json`, `export-*.xlsx`, and `exported-forecast.xlsx` retain the
actual results. Imported/light, narrow/dark, and narrow edited screenshots were inspected.
Native iPhone/macOS acceptance is separate; these browser results do not claim
native workbook editing or actual iPhone touch-keyboard validation.

Additional verification:

- Eight real-engine command cases pass in Chromium: no-op with failure,
  no-op-only, partial failure, new-sheet rollback, read-only rejection, and
  successful apply/Undo by name and stable sheet ID, plus unknown-sheet rejection
  with full rollback (`scripts/verify-spreadsheet-commands.mjs`). Stable-ID edits
  preserve the existing sheet count and identity; only an explicit `newSheets`
  plan may create a sheet. Natural-language proposals may still use current names.
- 21 focused tests / 121 assertions pass across the six `tests/odoo-*.test.ts`
  files at this checkpoint: full snapshots/drafts, original upload/cleanup,
  ZIP/request bounds, Google fidelity policy, and vendor/source integrity.
- Typecheck passed; root owns the final whole-app build, coverage, and release.

Release coverage checkpoint: `tests/odoo-spreadsheet-adapter.test.ts` adds 15
behavioral tests / 69 assertions using the existing injected `LoadedEngine`
session boundary. Adapter line coverage is 77.85% after formatting (Bun LCOV;
`/tmp/albatross-odoo-adapter-coverage-final/lcov.info`). It covers mount/dispose
including disposal during asynchronous mounting, mode transitions, committed
content-event batching, snapshot preservation, grid conversion, exact-ID/name
targeting, command rollback, actual ZIP import/export boundaries, warning cleanup,
and browser download cleanup. Combined with document-edit, workbook-state, XLSX
import and asset tests: 36 pass / 192 assertions. This injected-engine coverage
checks Albatross's adapter contract, not Office fidelity; the eight real-engine
browser command cases and the full Files browser flow remain separate evidence.

Legacy grid migration now retains format-only cells and maps text to `@`, number
to `#,##0.00`, currency to `$#,##0.00`, percent to `0.00%`, and date to
`yyyy-mm-dd`. Literal strings get text-preserving formatting instead of becoming
numbers, dates or booleans. Odoo always treats a leading `=` as a formula, even
with text formatting, so those literals are represented as constant-string
expressions, not executable user formulas. Strings with explicit numeric formats
use the same representation to retain both value type and chosen format. Quote,
backslash and newline characters become `CHAR(...)` segments: Odoo does not use
Excel's doubled-quote escaping. Explicit legacy formulas remain formulas.

The real-engine command runner additionally checks 16 typed/formatted cells
through initial migration, exported-snapshot reopening, and Odoo's actual Excel
export/import. Exact values/types, currency/percent/number display and empty-cell
formats pass in all three phases. Evidence:
`/tmp/albatross-odoo-command-migration.log`. This is a bounded legacy-grid
compatibility check, not a claim of arbitrary Excel round-trip fidelity.

The final rerun includes the latest strict ZIP local-header checks and separate
390 px keyboard-edit/autosave step. An intermediate preview restart overlapped
the root production build replacing `.next` font artifacts; the completed final
run above supersedes that infrastructure-only interruption. Inspection of the
successful production app chunk confirms native runtime imports of the vendor
ESM URLs; the Odoo/Owl runtime implementation is not duplicated in app chunks.
