# Albatross style refresh — PR notes

## Research and direction

Reviewed the annotated production brief, Albatross list, assistant, and mail workspace in the browser before editing. The existing palette already provides three accents, recessed / content / floating surfaces, depth-scaled shadows, and user-controlled corners. This change uses those tokens rather than adding a palette or reducing information density.

Mobbin was accessed through the existing authenticated local MCP connection. Web screen searches:

- Email inbox with compact message rows, sender avatars, search toolbar and selected row highlight.
- Notification inbox with filter tabs and count badges beside the page title.
- Daily reflection dialog with journal text fields, grouped sections and a save button.

Visually inspected references:

- [Notion Mail](https://mobbin.com/screens/bb6aa516-50ce-4b33-90e4-a944bed414fb): compact rows, a narrow tool strip, quiet date rules, and a filled selection highlight instead of a border around each email. Keep Albatross's avatars and editorial sender typography, but separate straight rules from the rounded interactive highlight.
- [ClickUp](https://mobbin.com/screens/f1374e47-4168-46b0-baab-445916244ac6): filters and counts sit in the top navigation strip; purple marks actionable content while neutral surfaces carry the list. Apply the same hierarchy using Albatross's accent chord, not ClickUp's colors.
- [Qatalog](https://mobbin.com/screens/691f6c9a-0a16-4ee7-a52f-1a9b8f8a4f61): a floating standup form separates labelled inputs from its surrounding page. Keep the clear question hierarchy, but distinguish today's reflection and tomorrow's intent with the existing editorial and highlight accents.
- [Linear inbox documentation](https://linear.app/docs/inbox): priority and quick-search controls stay with the notification list; contextual detail preserves the list workflow. Retain the existing filtering, keyboard navigation, and selection model.
- [Proton Mail](https://mobbin.com/screens/a6838f9e-79d2-427c-bb4a-35e7e932d55c): the colored rail contains the visual identity while the message canvas stays neutral and dense.
- [Notion Mail](https://mobbin.com/screens/9500dd6d-2569-425a-ad46-6e99c22f73ad): compact tool groups and quiet row dividers retain space for mail. These additional references informed the frame and toolbar refinement.

A read-only specialist pass was requested with `claude -p`. Claude reported a session limit. A second request for the chat refinement timed out without a review. No specialist changes were applied.

The chat refinement used another Mobbin search: "AI chat conversation with user message bubbles and generated document cards showing file thumbnails beside file titles". Two references were inspected:

- [Dropbox Dash](https://mobbin.com/screens/fc54be30-29ff-430c-9554-7858c47373e8): a distinct user bubble separates the request from the assistant response. Compact file cards stay near the request.
- [Claude](https://mobbin.com/screens/16b71c74-387d-4aa8-83ca-8b542a5c4876): a compact tool disclosure keeps the conversation readable beside the document area. Keep that hierarchy, with Albatross surface tokens.

## Implementation intent

- Rebase the full-page wrapper onto the paper color (`--color-content: var(--color-bg)`). The wrapper's existence must not consume the first elevation step. Cards retain `--color-bg-elevated`, inputs can use `--color-surface-well`, and floating UI uses `--color-surface-float`; the existing depth and tint controls continue to drive those surfaces without changing saved preferences.
- Brief sections use raised surfaces, complete accent borders, and horizontal dividers. The check-in uses the same treatment. Colored left-edge card accents are removed.
- Mail keeps flat, straight dividers and custom-corner selection / focus highlights.
- The assistant header sits directly on the base canvas. Its controls form one connected row. The 30px ambient mark fades softly at its edges.
- The corner chat uses the base color and a feathered color wash. The wash has no backdrop filter, which avoids the rectangular blur boundary.
- The launcher puts its shortcut first. Its hidden measurement uses the same individual letter spans as the visible phrase, so the final letters fit.
- Files gives its header width to search and tools. Notifications puts title and filters in one wrapping row and removes the subtitle.
- Work states, Area controls, and the daily check-in use the existing accent and surface ladder.
- Work lists share an inset divider component. Cards, panels, and overlays use shared corner roles. Replaced radius literals are removed from their callers.
- The outer gutter and rail use the same accent tint and depth. The permanent separator and oversized curve are removed. A thin resize guide appears only on hover or drag.
- The shared shell paints the background wash and grain once, behind both the transparent rail and the page gutter. Separate paint layers no longer change their visible colors. The mobile sidebar also uses the outer background token.
- User messages have a distinct accent-tinted bubble. Tool groups use shared raised surfaces, full accent borders, and horizontal dividers. The shared result shell uses the custom card corners.
- Document creation, editing, reading, and lists use one file layout. The left preview shows real document blocks, slide elements, or spreadsheet cells. The page stack opens slightly on hover or keyboard focus. Reduced motion removes the transform.
- Preview reads use the existing authorized document endpoint and shared editor cache. Offscreen previews wait until near the viewport. Invalidation refreshes previews after edits. No preview operation writes a file.
- Office and external files without a supported preview retain a file-type fallback. The UI does not fabricate their content. Preview failures do not remove the open action.
- Mail date headers use the page background color.
- Incoming mail must refresh Area link recency as well as the underlying thread, without overriding confirmed / rejected filing decisions or running a full-mailbox reindex.

## Verification

- Bun suite: 3,801 tests passed. Focused additions cover mail recency, account isolation, preserved filing decisions, replies to hidden threads, real preview content, safe fallbacks, user bubbles, and tool errors.
- TypeScript: `bun run typecheck` passes. Biome checks pass with one existing `noImgElement` warning in the assistant attachment preview.
- Browser: `node scripts/check-albatross-styles-browser.mjs` passes against real components with synthetic data. Checks cover connected controls, complete letter bounds, matching date headers, the continuous outer canvas, custom corners, and surface depth. Notification selection, check-in states, and 320 / 390 / 768px layouts also pass.
- `node scripts/check-chat-styles-browser.mjs` checks real previews, uniform file rows, cache reuse, live updates, unavailable previews, hover, reduced motion, light/dark themes, and open-file navigation. It also checks 320 / 390 / 768px layouts. `/?review=chat` opens this synthetic conversation in the live app shell.
- `node scripts/check-rail-canvas-browser.mjs` checks the common paint layer with a full-strength background wash. Screenshot pixels confirm no color seam in light/dark themes, with the rail expanded or collapsed. Grain covers the same shared canvas.
- Screenshots are written to `/tmp/albatross-style-*.png` by the browser check, including the mail/chat, Files, brief, work rows, notifications, and check-in. No production mail or work actions were performed.

Run the local preview with `ALBATROSS_PREVIEW_PORT=18859 bun run dev:preview`. It serves only this machine by default. To open it from a different device, set `ALBATROSS_PREVIEW_HOST` to an address of this machine that the device can reach. Set `ALBATROSS_STYLE_PREVIEW_URL` to the same address and port when the browser check targets it. The hosted app does not use the tailnet. `/?review=styles` exposes the Work, Brief, Notifications, and check-in fixtures.

The branch is `codex/albatross-style-refresh`, originally based on staging at `82d6f05`. Staging at `10187e8` was merged before release. All newer staging commits remain in the history. The editor, presentation, artwork, and native files from those commits remain unchanged.

The chat preview supports the new version 2 presentation model through the shared slide renderer. It retains the document theme, images, and charts. Focused tests cover that integration and confirm that preview reads do not change the document model.

Web and Convex changes must be released together. The existing staging workflow deploys both. This change requires no database migration or full-mailbox reindex.

## Published visual review

[Open the annotated review](https://files.jjalangtry.com/api/file/albatross-style-review-2026-09-15/review.html) on the tailnet-only files site.

The review includes eight screens and twelve screenshots from the development preview. Mail, chat results, the outer frame, and check-in include light and dark modes. Numbered annotations identify the changes. All data is synthetic. The review is static and does not require the development server.

Browser checks passed for all images, screen selection, annotations, theme selection, and the 390px layout. The shared browser showed the changes during review. After it reported that no automation host was available, local Playwright completed the checks and screenshots. Production remains unchanged.
