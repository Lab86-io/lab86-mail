# Document handoff, iOS design note (2026-10-08)

The contract is `docs/albatross-document-handoff.md` (D2 to D5). The web is the source of the
rules and the copy. This note decides how document mode looks on iPhone and iPad.

## Mobbin screens (iOS)

- Medium, the story editor ([screen](https://mobbin.com/screens/37fba6a4-e08a-46f5-b2e3-b7b1d2293f39)).
  The editor fills the screen. "Close" sits top left; the one primary word sits top right.
  Taken: the editor keeps its own bar with "Close"; the thread adds nothing to it.
- Craft, the block actions ([screen](https://mobbin.com/screens/b766d679-22f2-413b-a5ee-c1dfec96ab29)).
  A bar at the bottom holds a short row of actions with text labels under each glyph.
  Taken: a bottom bar with text buttons, no icons before the text.
- Fabric, the assistant sheet ([screen](https://mobbin.com/screens/c20e5e8c-945e-4317-9308-0e8f32fd04e6)).
  The assistant opens as a sheet over the item. The composer names the item it works on.
  Taken: "Chat" opens the thread as a sheet; the placeholder names the document.
- Gemini, a file in the composer ([screen](https://mobbin.com/screens/793f47cc-ae07-4cfa-b36a-831db8d6d397)).
  The open file shows as a chip over the field. Taken: the thread sends the document as a
  context attachment; the chip is not drawn, the placeholder says it.

## Decisions

- iPhone: the document is a full-screen cover. A bottom bar shows "Your part" and the handoff's
  detail, then "Done, continue" and "Chat". With no open handoff the bar shows "Chat" only.
- iPad (regular width): the document fills the left; the thread sits in a 400 pt column on the
  right with the "Your part" card on top ("Done, continue", "Back to thread").
- The chat is the same `WorkThreadModel`: one conversation, the document attached while it is
  open. A turn that ran a `document_*` or `word_document_*` tool reloads the editor.
