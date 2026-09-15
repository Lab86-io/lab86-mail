# Full Word document editor — 2026-09-11

## Request and decision

The user selected a full Word-style editor with pages, tables, images, headers, footers, comments, and AI editing. New **Document** files now use the existing Collabora/Office integration when Office is configured. **Simple document** remains available. Existing simple documents have a **Word processor** action that first saves and then opens a new DOCX copy, retaining the source.

Reuse the integrated full Office editor instead of expanding the intentionally limited, shared canonical document model. Collabora supplies page layout, its formatting and insertion tools, and document review UI. Albatross receives explicit DOCX creation, reading, and editing tools, preserving unrelated package parts rather than converting the document back to plain blocks.

## Product research

Reviewed the surrounding Files creation menu, canonical editor, Office editor, Collabora frame, Google import flow, version history, save acknowledgements, assistant context, and tool result cards before changing their entry points.

- [Odoo HTML editor documentation](https://www.odoo.com/documentation/18.0/applications/essentials/html_editor.html): an embedded rich-text editing model. This does not establish a standalone paginated Word replacement suitable for this request.
- [Collabora SDK manual](https://sdk.collaboraonline.com/CO-SDK-manual.pdf) and [24.04 SDK manual](https://sdk.collaboraonline.com/24.04/CO-SDK-manual.pdf): host/editor messaging, save actions, session closure and command integration. Use the existing acknowledged WOPI save flow; do not report an unacknowledged toolbar command as a persisted AI edit.
- Mobbin skill loaded and tools searched, but no Mobbin search or screen tools were available in this session. No Mobbin findings are claimed.
- Playwright attempted the Odoo documentation page; it returned HTTP 403. The Collabora product-page fetch also failed. Browser research could not establish a live competitor visual reference. The existing app and a loopback browser fixture informed the compact title, save indicator, version history and Albatross controls. No inaccessible page is presented as a successfully inspected interface.

## Implemented behavior

- Full DOCX creation from Files or Albatross; save-and-copy entry point from an existing simple document.
- Renameable Office title with compact save status, Versions and Albatross controls; removal of the permanent private-copy banner.
- `word_document_get` returns saved revision, indexed paragraphs, structural counts and header/footer/comment text.
- `word_document_edit` supports nine operations: paragraph/heading insertion, text replacement, text formatting, paragraph formatting, tables, images, page setup, headers/footers and comments. Each batch is atomic. Indexes apply sequentially after preceding operations; text formatting selects whole paragraphs; page setup and header/footer changes target the final section.
- DOCX edits preserve unrelated ZIP entries, relationships, images and existing Office-only content. Replacement spans formatted runs while retaining links; unsafe field/tracked-change targets fail explicitly. PNG/JPEG input is decoded before insertion.
- A connected Collabora editor saves typing, pauses and releases its actual WOPI lock before an AI revision is committed, then reopens. The server never forcibly clears a lock. If autosave advances the revision, the tool requires a fresh read before retrying. Failed saves retain the live editor draft. Coordination expires and stale requests cannot authorize writes.
- Authentication, signed document/user/session-bound capabilities, request size limits, rate limits, owner checks and revision compare-and-swap protect the new endpoints and mutations. Saved revisions remain immutable and rejected uploaded candidates are removed by the commit mutation.

## Validation and limits

Focused tests cover package fidelity, unsupported content, atomic failure, revision conflicts, session coordination, ownership, source-copy preservation, HTTP validation, assistant routing and tool cards. The browser acceptance script exercises the real OfficeEditor/CollaboraFrame host code with an explicitly synthetic editor protocol double: successful save/pause/reopen, failed-save draft retention, rename, existing-document copy, and 798/390-pixel layouts. This is not a live Collabora rendering test.

A generated DOCX containing all requested structural features was opened and saved by local LibreOffice. PDF output was visually inspected: landscape page, heading, formatted/highlighted text, table, image, header and footer rendered correctly. Reading the resaved DOCX confirmed the image, table and comment survived. This validates an actual Office engine round trip independently of the protocol fixture.

The rich UI depends on the existing configured Office service. Live hosted Collabora acceptance and deployment are separate from these local checks. The automatic AI session handoff is implemented for Collabora; it is not an OnlyOffice collaboration protocol. AI operations are the explicit supported set above, not a claim that every Word command has a corresponding AI operation. Existing simple document and native contracts remain intact.

Final local checks: TypeScript passed; Biome passed on all 35 changed/new code files; production Next.js build passed; browser acceptance passed. The full coverage suite passed with 3,888 tests and no failures. An earlier concurrent build/test run hit the existing five-second tool-schema test timeout; the isolated full rerun passed without changing its timeout. Bun reported 92.54% line coverage across the suite.
