# Albatross document editor controls

Date: 2026-09-15. Applies to the embedded Collabora editor (CODE 26.04.3.2) with the
`OFFICE_THEMED_CHROME` flag on. With the flag off, the editor opens as before: the
Collabora menubar, the notebookbar and the sidebar are all visible.

Source of the facts: `docs/research/collabora-26.04-host-contract.md` and the live spike
in `docs/albatross-editor-milestone-a-2026-09-15.md`, section 5. Code:
`lib/documents/collabora-chrome.ts`, `components/files/CollaboraFrame.tsx`,
`components/files/OfficeEditor.tsx`.

## How the chrome is built

1. The server sets `chrome.enabled` on the session object (`startCollaboraSession`).
2. The client adds two parameters to the editor URL: `ui_defaults` and `css_variables`.
   The editor page reads them once at load. A theme change needs a new session.
3. After `App_LoadingStatus` with `Status: Document_Loaded`, the frame posts, in order:
   `Hide_Menubar`; `Hide_Command {id: '.uno:Save'}`; `Hide_Command {id: '.uno:Print'}`;
   `Insert_Button {id: 'albatross', insertBefore: 'undo'}`. Under a dark theme it then posts
   `Send_UNO_Command {Command: '.uno:ChangeTheme', Args: {NewTheme: 'Light'}}`.
4. **All tools** posts `Action_ChangeUIMode {Mode: 'notebookbar'}`. The button changes its
   label to **Compact tools** only after `Action_ChangeUIMode_Resp` arrives. Compact tools
   posts `Action_ChangeUIMode {Mode: 'classic'}`.

## The title row

One row above the editor: Back, the editable title, the save status, Save, Download,
History, All tools, Albatross. The row belongs to Albatross. Collabora owns formatting.

| Control | What it does | Behind it |
| --- | --- | --- |
| Back | Returns to Files. Warns when a save is in progress. | `onClose` |
| Title | Renames the working copy on blur or Enter. | `PATCH /api/office/{id}` |
| Save status | Saved, unsaved, saving, applying, or needs attention. | `Doc_ModifiedStatus`, the save flow |
| Save | Saves through the acknowledged flow, then waits for the WOPI receipt. | `Action_Save` with `Notify` and `ExtendedData`; `Action_Save_Resp`; receipt poll |
| Download | Downloads the saved copy. | `GET /api/office/{id}/content` |
| History | Opens the list of revisions with a download for each. | `versions` in the metadata |
| All tools | Shows the full notebookbar. Disabled until the document loads. | `Action_ChangeUIMode` |
| Albatross | Opens the assistant beside the document. | `setAssistantPresentation('split')` |

## Feature map

Every control that was visible before, where it lives now, and how it is reached.

| Previous control | Now | How to reach it | Parameter or message |
| --- | --- | --- | --- |
| Menubar (File, Edit, View, Insert, Format, ...) | Hidden | All tools shows the same commands as tabs. The assistant can run any command. | `Hide_Menubar`; `Action_ChangeUIMode` |
| Notebookbar tabs | Hidden by default | All tools | `UIMode=classic`; `Action_ChangeUIMode` |
| Collabora Save button | Menubar and notebookbar entries hidden | Albatross Save in the title row | `Hide_Command .uno:Save` |
| Collabora Print button | Menubar and notebookbar entries hidden | All tools, File tab, or the assistant | `Hide_Command .uno:Print` |
| Undo, Redo | Classic toolbar | Toolbar or keyboard | `UIMode=classic` |
| Paragraph style, font, size, bold, italic, underline, color, highlight | Classic toolbar | Toolbar | `UIMode=classic` |
| Alignment, lists, indent, line spacing | Classic toolbar | Toolbar | `UIMode=classic` |
| Insert table, image, link, comment, special character | Classic toolbar | Toolbar; more under All tools, Insert tab | `UIMode=classic` |
| Sidebar (properties, styles, navigator, page) | Closed by default | View menu under All tools, or a selection that opens a contextual pane | `TextSidebar=false`, `SpreadsheetSidebar=false`, `PresentationSidebar=false` |
| Ruler (Writer) | Closed by default | View tab under All tools | `TextRuler=false` |
| Status bar (page, words, language, zoom) | Visible | Bottom of the editor | `TextStatusbar=true`, `SpreadsheetStatusbar=true`, `PresentationStatusbar=true` |
| Comments, track changes, compare | All tools, Review tab | All tools | `Action_ChangeUIMode` |
| Find and replace | Keyboard or All tools, Home tab | Ctrl+H | none |
| Headers, footers, page setup | All tools, Layout tab | All tools | `Action_ChangeUIMode` |
| Export as PDF and other formats | All tools, File tab | All tools; Albatross Download gives the saved Office copy | `Action_ChangeUIMode` |
| Spelling, language | All tools, Review tab | All tools | `Action_ChangeUIMode` |
| Sheet tabs, formula bar (Calc) | Visible | Bottom and top of the sheet | none |
| Slide sorter, slide layouts (Impress) | Visible; layouts under All tools | Left pane; All tools, Layout tab | none |
| Welcome dialog | Removed | none | Server `welcome.enable=false` |
| Ask Albatross | Added, before Undo | Toolbar button in the editor, or Albatross in the title row | `Insert_Button`; `Clicked_Button {Id: 'albatross'}` |

## Theme

`css_variables` carries the Albatross tokens for the variables the build defines:
`--color-primary`, `--color-primary-dark`, `--color-primary-darker`, `--color-primary-lighter`,
`--color-primary-text`, `--color-main-text`, `--color-main-background`,
`--color-background-lighter`, `--color-border`, `--color-toolbar-border`, `--cool-font`,
`--border-radius`, `--color-error`, `--color-warning`, `--color-success`.

Values are hex colors resolved from `app/globals.css` at the default accent (hue 156,
chroma 0.09) with `oklchToHex`. The font stack is unquoted. A value with a quote, an
angle bracket, a brace, an ampersand, a pipe, a backslash, a caret, a backtick, a dollar
sign or a square bracket is dropped before the URL is built. The server would reject it.

The editor page cannot follow the theme panel live. A custom accent hue in the app does
not change the editor chrome. This is a known limit.

The notebookbar tab row under All tools keeps its own document-type color. It did not
follow `--color-primary` in the spike or in the live run. The compact classic toolbar
follows the variables.

## Dark mode rule

Under a dark application theme the frame loads with `UITheme=dark` and the dark variable
map. Light values under a dark chrome broke input contrast in the spike, so the dark map
uses the dark tokens. Collabora dark mode also darkens the page render. After
`Document_Loaded` the frame posts `.uno:ChangeTheme Light`, which returns the page to
white while the chrome stays dark. The stored file never changes.

The theme is read once when the frame mounts, from the `dark` class on the root element.
A theme change while the editor is open takes effect on the next open.

## Unsupported on this build

- `Hide_Button {id: 'save'}` and `Hide_Button {id: 'print'}` do not hide the classic toolbar
  buttons. The classic Save and Print buttons stay visible in compact mode. Only the menubar
  and notebookbar entries are hidden by `Hide_Command`.
- `Hide_NotebookTab` does not hide a tab after a live mode switch. The File and Help tabs
  stay visible under All tools.
- `Hide_Menubar` is a no-op in notebookbar mode. Under All tools the `.main-nav` container
  shows again as the tab row. Compact tools hides it again.
- No message reports formatting state (bold, style, font, undo). The title row has no
  formatting buttons because it could not show their state.
- `Send_UNO_Command` never replies. The assistant can run a command but cannot read its
  result from the editor.
- There is no message to change the theme at runtime. `UITheme` and `css_variables` are
  read only when the page is served.

## Verification

- Unit: `bun test tests/collabora-chrome.test.ts tests/office-editor-chrome.test.tsx tests/collabora.test.ts`.
- Live: `bun scripts/prepare-collabora-verification.ts`, then
  `OFFICE_THEMED_CHROME=true bun scripts/verify-collabora-live.ts`. The run asserts the css
  variable inside the frame, the hidden menubar, the hidden save and print commands in the
  notebookbar, the Albatross button and its click, the mode switch and its reply, and the
  white page under `UITheme=dark`. Screenshots land in `/tmp/collabora-chrome/`.
