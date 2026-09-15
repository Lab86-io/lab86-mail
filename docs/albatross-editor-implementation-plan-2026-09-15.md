# Albatross editor: implementation plan for milestones B to E

Date: 2026-09-15. Follows `docs/albatross-editor-milestone-a-2026-09-15.md`. Branch
`claude/editor-milestone-a`, worktree `/home/jjalangtry/repos/lab86-mail-editor`.
Delivery: one pull request into `staging`, merged after CI and review pass.

## Assumptions stated up front

1. **Visual checks in production use Browserbase.** The app connects a Playwright client to
   a Browserbase session over CDP. No Chromium ships in the Railway image. Local runs use the
   installed Playwright Chromium. Keys are `BROWSERBASE_API_KEY` and `BROWSERBASE_PROJECT_ID`.
2. **Delivery is a pull request into `staging`.** The branch already sits on `origin/staging`.
   Jakob's uncommitted purge in the main checkout will need a rebase after the merge.
3. **Native apps ship the read-only version 2 preview this round.** iOS and macOS open a
   rich deck as a text projection with **Open full editor**. A native canvas for version 2
   is a later milestone.
4. **Flags.** `OFFICE_THEMED_CHROME` and `DECK_V2_AUTHORING`. Both default on in staging
   and off in production until the staging release is verified.

## Waves

### Wave 1: shared layer (Claude)

- `lib/documents/editor-flags.ts`: the two flags.
- `lib/documents/deck-quality.ts`: pure checks on a version 2 deck. Off-canvas, unintended
  overlap, copy that cannot fit its box, type under 10 pt, contrast under 3:1 for display
  and 4.5:1 for body, missing image sources, more than 90 words on a slide. Decorative
  elements may sit under content. `repairDeck` clamps geometry and steps font sizes down,
  bounded to three passes.
- `lib/documents/deck-render.ts`: static HTML for a deck with packaged fonts, and
  `renderDeckSlides` through Playwright, local or Browserbase. Returns one PNG per slide.
- `public/fonts/`: Fraunces and Geist woff2 files with their licenses.
- Deck assets: Convex table `documentAssets`, `app/api/documents/assets` upload route with
  type and size validation, owner checks, and `{ assetId, src, aspect }` in the response.
- `lib/documents/collabora-chrome.ts`: the URL parameters, the light and dark variable
  maps, and the post-load message list. Pure functions with tests.

### Wave 2: three workstreams in parallel, disjoint files

**B. Document editor** (`lib/documents/collabora.ts`, `components/files/CollaboraFrame.tsx`,
`components/files/OfficeEditor.tsx`, `tests/collabora*.test.ts`, docs)

- Session URL carries `ui_defaults` and `css_variables` from the app theme.
- After `Document_Loaded`: hide the menubar, hide save and print by command, insert the
  Albatross button, and send the light document theme under a dark application theme.
- Title row: back, title, save status, Save, Download, History, All tools, Albatross.
- **All tools** switches to the notebookbar live and back.
- Feature map document: where every previous control remains reachable.
- Live verification script extended for the themed chrome.

**C. Slide editor** (`components/files/editors/PresentationEditor.tsx`, `deck-model.ts`,
`document-editors.css`, `tests/document-editor-models.test.ts`, new inspector files)

- Layout: filmstrip left, canvas center, inspector right, notes under the canvas.
- Canvas: drag to move, handles to resize, snap guides to edges and centers, arrow nudges.
- Inspector by selection: text typography, shape fill and stroke, line stroke, image fit and
  focal point and replace, chart type and data and colors. Layer order and delete.
- Insert: text, shape, line, image through the assets route, chart.
- Deck theme panel: palette and font pairs, applied deck-wide with per-slide edits kept.
- Everything survives save, reopen, undo, redo, duplicate, reorder and export.

**D. Designed generation** (`lib/documents/presentation-design.ts`, `lib/documents/ai.ts`,
`lib/documents/edits.ts` restyle, `lib/tools/documents.ts`, tests)

- Art-direction brief: audience, purpose, tone, palette, font pair, imagery, and one
  visual role per slide from a curated set of eleven compositions.
- Deterministic composer from the brief to version 2 slides, using the reference geometry.
- Restyle: theme, palette, fonts and layout scope change; facts, charts, notes, order and
  locked elements stay. Writes a real revision through the existing conflict protection.
- Quality loop: `checkDeck`, bounded repair, then a render check when a browser is
  available. Failure surfaces as a recoverable error, never a half-saved deck.
- Tool descriptions updated so the assistant applies explicit restyle requests directly.

### Wave 3: acceptance and release (Claude)

- Full typecheck, lint, test run, and the coverage gate.
- Screenshots of the editor, generated decks and the themed document editor.
- Live Collabora verification against staging with the real frame.
- PPTX opened in PowerPoint on the Mac, slides exported to PNG, compared with the web.
- iOS and macOS builds on the Mac; native tests.
- Pull request into `staging`, review findings fixed, merge, staging smoke check.
