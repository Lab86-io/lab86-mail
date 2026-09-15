# Albatross editor: milestone A record

Date: 2026-09-15. Branch `claude/editor-milestone-a` off `origin/staging`. This record
answers milestone A of `docs/albatross-editor-design-plan-2026-09-14.md`: the reference
deck, the editor prototypes, and the proof of what the installed Collabora build permits.
Facts from upstream source are in `docs/research/collabora-26.04-host-contract.md`.

## 1. Decisions

1. **Presentation direction: Editorial.** Fraunces display on warm paper with ink
   navy and a rust accent. Signal (Geist, electric blue, solid blocks) is the second
   direction and stays available as a theme. Rationale is in section 3.
2. **Deck model version 2 ships behind the reader first.** Web, iOS and macOS read
   version 2 today. A deck stored as version 1 stays version 1 until it uses a
   version 2 element. Nothing is rewritten on open.
3. **Fonts are pairs.** Each theme font names a web family for the canvas and an
   export face for PowerPoint. Fraunces exports as Georgia, Geist as Aptos, Geist Mono
   as Consolas. Substitution is designed, not accidental.
4. **Document editor: theme Collabora, do not replace its toolbar.** The 26.04 build
   sends no formatting state to the host and `Send_UNO_Command` has no reply. A host
   toolbar could execute commands but could not show state. Albatross owns the title
   row, save status, history and the assistant. Collabora owns formatting.
5. **No fork.** Every behavior the plan asked for is reachable through supported
   URL parameters and host messages. See section 5.
6. **Dark application theme keeps the page white.** Collabora dark mode also darkens
   the page render. The host must send `.uno:ChangeTheme Light` after a dark load, or
   keep the editor chrome light. Section 5 records the measurement.

## 2. What was built

| Area | Files |
| --- | --- |
| Version 2 deck schema, text helpers | `lib/documents/model.ts` |
| Lift, downgrade, save policy, equality, font registry | `lib/documents/deck-versions.ts` |
| Owned asset loading for export | `lib/documents/deck-assets.ts` |
| PPTX export for every version 2 element | `lib/documents/export.ts` |
| Google Slides mapping for version 2 elements | `lib/documents/google.ts` |
| Slide and element edits on version 2 | `lib/documents/edits.ts` |
| Reference decks, two directions | `lib/documents/deck-fixtures.ts` |
| Shared slide renderer: canvas, thumbnails, player, preview | `components/files/editors/SlideRenderer.tsx` |
| Deck helpers on version 2 | `components/files/editors/deck-model.ts` |
| Editor accepts either version, saves by policy | `components/files/editors/PresentationEditor.tsx` |
| Dev preview page | `app/dev/deck-preview/page.tsx` |
| Native passthrough for version 2 decks | `apps/ios/Lab86Mail/Core/Documents/RichDeckSnapshot.swift`, `DocumentModels.swift`, `Features/Files/NativeRichDeckPreview.swift` |
| Collabora spike harness | `scripts/spike-collabora-customization.ts`, `scripts/fixtures/collabora-spike-preview.ts` |
| Tests | `tests/deck-versions.test.ts`, `tests/document-editor-models.test.ts`, `apps/ios/Lab86MailTests/NativeFileCompatibilityTests.swift` |

## 3. Reference deck and design system

Preview: `/dev/deck-preview?deck=lakeshore&direction=editorial`. Add `&sheet=1` for the
contact sheet, `&slide=N` for one slide, `&editor=1` for the editor shell, and
`&deck=hiring` for the second deck. The published gallery lists the same images.

### Slides

1. Cover: image on the right half, display title at 68 pt, kicker in accent, footer caption.
2. Statement: ink ground, one sentence at 56 pt, support line in soft paper, mono page number.
3. Image composition: image on the left 46 percent, kicker, title, body, three small facts on a hairline.
4. Metrics: three display numbers stacked on the left, native column chart on the right, source line.
5. Process: four steps on a hairline with circles, mono step numbers, date and detail under each.
6. Close: title, three numbered asks, closing hairline, contact line.

The hiring deck reuses the system for different content: a numeral cover, a two-panel
comparison, and a doughnut chart.

### Why Editorial

- It continues the brief and letter voice the app already has: Fraunces mastheads,
  paper grounds, hairlines. A deck made in Albatross looks like it came from Albatross.
- Fraunces at display sizes carries a slide on its own. The statement slide needs no art.
- Rust on paper reads at small sizes for kickers and numbers without a second accent.
- Signal is stronger for dense data and dark rooms. It stays as the second theme.

### Typography

| Role | Slot | Size (pt at 960 wide) | Weight | Line height |
| --- | --- | --- | --- | --- |
| Title | display | 32 to 68 | 500 | 0.96 to 1.06 |
| Statement | display | 56 | 500 | 1.02 |
| Number | display | 24 to 56 (cover numeral 220) | 500 | 1.0 |
| Subtitle | body | 16 to 24 | 400 | 1.35 |
| Body | body | 13.5 to 15 | 400 | 1.4 to 1.5 |
| Kicker | body | 12 | 500 | 1.3, tracking 0.04 em |
| Caption | body | 10.5 to 12 | 400 | 1.3 |
| Page number, step number | mono | 11 | 400 | 1.3 |

### Spacing

- Margins: 6 percent left and right, 10 to 14 percent top for the first line.
- Column gutter: 3 percent. Four-step rows use a 22.4 percent pitch.
- Hairlines: 1 to 1.5 pt. Circles: 14 pt. Chart bars: 60 percent of the slot.
- Images bleed to the slide edge on one side; text never touches an image.

### Color

| Token | Editorial | Signal |
| --- | --- | --- |
| background | #F4F1EA | #F7F7F4 |
| surface | #E7E1D3 | #E4E6E9 |
| ink | #1E2A38 | #0B0F14 |
| muted | #5E5A51 | #5B6470 |
| accent | #AE4B2B | #2F5BFF |
| accentInk | #FFFFFF | #FFFFFF |

The slide theme is independent from the application theme. Dark application mode does
not change a slide.

## 4. Deck model version 2

Elements: `text`, `shape` (rect, roundRect, ellipse), `line`, `image`, `chart`. Shared
fields: geometry in percent, rotation, opacity, locked, groupId, name. Text carries font
slot, size, weight, italic, align, valign, line height, letter spacing, color and fill.
Lines may be flat: width or height may be zero. Images reference an owned asset id with
alt text, fit, focal point and aspect. Charts carry categories, series, colors, unit and
source. The deck carries a theme with six colors and up to three font pairs.

Compatibility:

- `upgradeDeckModel` lifts version 1 without loss. The legacy theme reproduces the old
  look: app sans, ink on white, slate shapes with a 0.75 pt border.
- `downgradeDeckModel` returns version 1 when nothing would be lost, else null.
- `deckModelForSave` writes version 1 for a deck stored as version 1 while it can, and
  version 2 once it needs it. Version 2 never goes back.
- `deckModelsEqual` compares across versions, so a lifted deck equals its stored form.
- iOS and macOS decode version 2 into `AlbatrossRichDeckSnapshot`, keep the raw JSON,
  show a read-only text projection, and save the JSON unchanged. Unknown fields survive.

## 5. Collabora on the installed build (CODE 26.04.3.2)

Source facts (upstream tag `cp-26.04.3-2`):

- `ui_defaults` and `css_variables` are URL parameters read only when the editor page is
  served. Changes need a new iframe load. `SavedUIState=false` makes our defaults win
  over the user's saved state.
- `css_variables` values may not contain quotes or angle brackets. Font stacks must be
  unquoted. The 26.04 stylesheet defines `--color-primary`, `--color-main-text`,
  `--color-main-background`, `--color-border`, `--cool-font` and related names. There are
  no `--co-*` variables.
- `Action_ChangeUIMode` switches classic and notebookbar live and replies. Hidden
  buttons, hidden commands and inserted buttons survive the switch.
- `Insert_Button` adds a host button; a click without `unoCommand` sends
  `Clicked_Button`. `Hide_Menubar`, `Hide_Button`, `Hide_Command`, `Hide_NotebookTab`,
  `Collapse_Notebookbar`, `Show_Sidebar`, `Hide_Ruler` and `Hide_StatusBar` exist.
- `Send_UNO_Command` executes any `.uno:` command with JSON arguments and never replies.
  No message reports bold, style, font or undo state. `statechanged:` stays inside the
  browser. The only state the host receives is `Doc_ModifiedStatus`.
- `Action_Save` with `Notify: true` replies `Action_Save_Resp`. This is the flow the
  frame already uses.
- Dark mode: `UITheme=dark` or the `darkTheme` parameter sets `data-theme="dark"` and
  sends `.uno:ChangeTheme Dark`, which darkens the page render.

Spike results, live against the staging document server:

Run 2026-09-15 with `scripts/spike-collabora-customization.ts` against
`documents-staging-development.up.railway.app` on a synthetic DOCX. Screenshots are in the
published gallery.

| Proof | Result |
| --- | --- |
| Theme the interface with Albatross tokens | Works. `css_variables` set `--color-primary`, `--color-main-text`, `--cool-font` and the rest at load. Values with quotes are dropped. |
| Compact chrome by default | Works. `ui_defaults=UIMode=classic;SavedUIState=false;TextRuler=false;TextSidebar=false;TextStatusbar=true` gave a menubar, one toolbar row, no sidebar, no ruler, a status bar. |
| Hide duplicate controls | `Hide_Menubar` works. `Hide_Command .uno:Save` and `.uno:Print` hide the buttons in the notebookbar. `Hide_Button save` did not hide the classic save button on this build. `Hide_NotebookTab File` and `Help` did not hide those tabs when sent after a live mode switch. |
| Expose everything again | Works. `Action_ChangeUIMode notebookbar` switches live, replies, and keeps hidden commands and the inserted button. `Collapse_Notebookbar` and `Extend_Notebookbar` work. |
| Albatross button inside the editor | Works. `Insert_Button` placed a button before Undo; a click sent `Clicked_Button {Id:"albatross"}`. |
| Execute bold and a paragraph style from the host | Works on the editor's own selection. `.uno:StyleApply Heading 1` applied. `.uno:Bold` applied after `.uno:SelectAll`; a keyboard selection made from the host page did not carry. |
| Read formatting state | Not possible. Only `Doc_ModifiedStatus` arrived. The editor's internal state showed `bold:true`, `style:Heading 1`, `undo:enabled`, and none of it reaches the host. |
| Save through the acknowledged flow and reopen | Works. `Action_Save_Resp {success:true}`, revision 2 stored, the marker, the bold run and the Heading 1 style are in `word/document.xml`. |
| Dark application theme | `UITheme=dark` darkened the page render to rgb(28,28,28). `.uno:ChangeTheme Light` sent by the host restored a white page while the chrome stayed dark. The stored file never changed. Light-theme `css_variables` under dark chrome broke input contrast, so dark chrome needs its own values. |
| Session changes | Theme and defaults need a new iframe load. Mode switches, hides and inserted buttons do not. |

Keep, move, remove inventory for the document editor:

| Control | Decision | How |
| --- | --- | --- |
| Editable title, save status, version history, Albatross | Keep in the Albatross title row | Existing `OfficeEditor` header |
| Collabora menubar (File, Edit, View, ...) | Remove from view | `Hide_Menubar`; commands stay reachable in the notebookbar tabs and through the assistant |
| Collabora save and print buttons | Remove | `Hide_Command .uno:Save`, `Hide_Command .uno:Print`; Albatross Save and Export stay in our row |
| Formatting toolbar (style, font, size, emphasis, color, alignment, lists, link, undo, redo, insert) | Keep, themed | `UIMode=classic` compact toolbar with `css_variables`; the notebookbar stays one click away through `Action_ChangeUIMode` as **All tools** |
| Sidebar | Closed by default | `TextSidebar=false`; contextual panes still open on selection |
| Ruler | Closed by default | `TextRuler=false`; toggle stays in View |
| Status bar (page, words, zoom) | Keep | `TextStatusbar=true` |
| Welcome dialog and extension notices | Remove | Server `welcome.enable=false` already set; 404 on `extensions/index.json` is harmless |
| Comments, review, find and replace, headers and footers, page setup, export | Keep reachable | Notebookbar tabs through **All tools**; assistant commands through `Send_UNO_Command` |
| Ask Albatross | Add | `Insert_Button` with `Clicked_Button` handled by the host |

## 6. Export fidelity

The reference deck exports to PPTX with text as text, shapes as shapes, lines as lines,
images as pictures and charts as native charts. LibreOffice rendered all six slides at
the same layout, colors and chart values as the web canvas. Local fonts were substituted
because Georgia and Aptos are not installed on the build host. A PowerPoint check on a
Mac or Windows machine is still open. Known loss: a focal-point crop exports as a
centered cover crop.

## 7. Open items

- Editor chrome for milestone C: contextual inspectors for images, lines and charts,
  alignment guides and layer controls. The renderer and model are ready.
- Asset upload for images through owned storage. Fixtures use the app's art files.
- Generation on the version 2 model with an art-direction brief (milestone D).
- PowerPoint visual check of the exported file.
- Collabora integration in `startCollaboraSession` and `CollaboraFrame`: pass
  `ui_defaults` and `css_variables`, post the hide and insert messages after
  `Document_Loaded`, and send `.uno:ChangeTheme Light` under a dark application theme.
- The native preview shows slide text only. A native canvas for version 2 is later work.
