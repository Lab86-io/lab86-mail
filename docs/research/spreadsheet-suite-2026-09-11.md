# Spreadsheet editing suite and editor cleanup

The user requested the full Odoo spreadsheet editing suite for Albatross's AI
tools and annotated three redundant editor rows for removal. Save status should
be a checkmark with a tooltip beside the editable title.

## Product research

The Mobbin research skill was read and its screen/flow tools were searched for;
this session exposes neither Mobbin tool. No Mobbin findings are claimed.

The [Odoo live demo](https://odoo.github.io/o-spreadsheet/) was opened and visually
inspected in a browser. Its File/Edit/View/Insert/Format/Data menus, compact
formatting toolbar, formula composer, grid and sheet tabs provide the working
hierarchy. The demo includes chart, border, validation, pivot and conditional
format examples. This supports retaining Odoo's complete menus beside Albatross
chat while removing the duplicate product/engine metadata rows.

The [upstream repository](https://github.com/odoo/o-spreadsheet) and the exact
source archive already distributed with our 19.0.50 runtime were inspected.
Source commit: `e4992587245f832c0dbf361b1f23f14b74613d4e`.

- [Command contracts](https://github.com/odoo/o-spreadsheet/blob/e4992587245f832c0dbf361b1f23f14b74613d4e/src/types/commands.ts)
  distinguish persistent workbook commands from local editing/session commands.
  Generated tool contracts cover all 66 core commands plus 45 editing helpers.
- [Demo dependencies](https://github.com/odoo/o-spreadsheet/blob/e4992587245f832c0dbf361b1f23f14b74613d4e/demo/index.html)
  reveal that Chart.js, the geographic and treemap renderers, Luxon, and its date
  adapter must be supplied by the host. These were previously absent: a real
  chart caused `window.Chart is not a constructor` and destroyed the Owl view.
- [Integration contract](https://github.com/odoo/o-spreadsheet/blob/e4992587245f832c0dbf361b1f23f14b74613d4e/doc/integrating/integration.md)
  documents the external image file store. The editor now stores inserted image
  bytes in its private workbook revisions.

## Resulting behavior

`spreadsheet_capabilities` exposes exact nested JSON schemas and the installed
formula names. `document_edit` accepts ordered `spreadsheet_command` operations
alongside existing cell edits. Both generated edits and deterministic edits run
through the actual Odoo engine on a private copy, save its complete export, and
use the existing revision compare-and-swap. An explicitly requested edit applies
directly; review mode still creates a proposal. Failed batches are discarded.
Applying a stored proposal evaluates its stored commands server-side, rather than
accepting an arbitrary client replacement snapshot.

The AI can now create real charts, styled tables, pivots, formatting, conditional
formats, validation, images, and structural changes. `REPT` is absent from this
Odoo release; the AI guidance no longer substitutes text bars for chart objects.

The permanent Google limitation banner, Albatross/private-copy/engine metadata
row, and licensing footer are removed. Save status uses a focusable icon and
hover/focus tooltip beside the title. Busy, dirty, recovered, and error states
remain distinguishable. History moves into the title toolbar. Source/licenses
remain available in File → About spreadsheet. The full Odoo menus remain visible
at the narrow widths used beside chat.

## Validation and scope

- Real engine tests: monthly bar chart, styled/filtered table, pivot,
  conditional format, validation, dimensions, freeze panes, selection cleanup,
  atomic rejection, command order, legacy upgrade, and feature preservation on
  reopen.
- Tool/API tests: direct apply, explicit review, immutable revision checks,
  concurrent save conflicts, stale suggestions and ignored client snapshots.
- Browser acceptance: rendered bar chart values `[1, 13, 7, 4]`, complete menus,
  title/checkmark alignment, tooltip, version history, no redundant rows and no
  page overflow at 1000, 798 and 390 pixels. Existing spreadsheet browser checks
  cover editing, formula evaluation, autosave, recovery, conflicts, import/export,
  suggestion apply and narrow keyboard editing.
- All 14 chart types pass browser engine/runtime creation, including geographic,
  treemap, gauge, and scorecard types. Renderer hashes and dependency versions
  match the pinned upstream lockfile.
- 146 related tests passed; TypeScript and the production build passed.
- The monthly bar chart also survives the editor's Excel download as chart XML.

The existing 900 KB saved-workbook limit remains. Inserted images are limited to
400 KB each to fit that storage contract. Existing Excel import limitations and
Google publishing restrictions remain; the editor no longer repeats them in a
permanent banner. These changes do not add Odoo ERP integrations or collaboration
services beyond the embedded spreadsheet's workbook features.

This note is ready to include in the implementation PR.
