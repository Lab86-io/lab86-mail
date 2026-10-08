# Document handoff, macOS design note (2026-10-08)

The contract is `docs/albatross-document-handoff.md` (D2 to D5). The web is the source of the
rules and the copy. This note decides how document mode looks in the Mac Work thread window.

## Mobbin screens (web, desktop)

- Microsoft Copilot, a page with the conversation ([screen](https://mobbin.com/screens/e359db96-9980-4d1a-9a75-1ccd8037c328)).
  The document fills the center. The conversation is a column on the right. A short card
  ("Your page is ready") sits on top of the column, above the messages and the composer.
  Taken: the same three parts, in the same places. The card is the "Your part" card.
- Gemini Notebook ([screen](https://mobbin.com/screens/f1c92cd7-0fa0-4cff-adcc-d09cce3cee43))
  and Dropbox Dash ([screen](https://mobbin.com/screens/09e3f23a-6afc-46b2-8079-2e20a8b8c879)).
  The chat and the document are two resizable columns with one divider. Taken: `HSplitView`,
  the same divider the Area page uses on the Mac.
- Mintlify ([screen](https://mobbin.com/screens/f0174246-f9a2-4b37-a992-ad981d217afa)).
  The document has its own header row; the one action sits at its trailing edge. Taken: a
  header over the document with the title and a text "Close" button. Escape closes too.

## Decisions

- The document replaces the transcript in the detail column. The thread moves to a column on
  the right (380 to 440 pt, drag up to 560). The trailing pane (page, details) gives way; a
  page opens as a sheet and the details as a popover while the document is open.
- The "Your part" card shows the step ("Step 2 · title"), the handoff detail, "Done, continue"
  and the quiet "Back to thread". No card when no handoff waits on the document.
- The web editor opens in the native workspace, docked: no navigation bar, no sheet frame.
  The workspace keeps its unsaved-changes check before "Close".
- The View menu gets "Close Document", enabled only while a document is open.
- The source list gives way when the window holds the document only without it, as for the pane.
