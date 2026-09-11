# Chat and document dogfood — September 11, 2026

## Observed problems and product research

The supplied transcript shows repeated presentation-generation configuration failures, an invalid null block edit, a saved placeholder being described as a finished deck, and September 11 notification timestamps attributed to September 10. The screenshot shows result-card shadow clipping. Additional requests cover wider chat, high-depth dark mode, attachments, styled presentations, and editing Google originals through a hosted document server.

The Mobbin skill was read, but this session exposed no Mobbin search tools. No Mobbin results are claimed. Browser research used Dia's public site and its presentation description: https://www.diabrowser.com/. Its public example emphasizes turning gathered context into slide headlines, layout and flow. This supports a narrative/content planning pass followed by consistent design; it does not reveal Dia's private implementation. The Albatross implementation uses that observable pattern: bounded slide briefs, coherent palettes, alternating cover/statement and evidence layouts, concise typography, and notes for sources. It retains the existing editable slide model and PPTX exporter.

The surrounding real AppShell, chat, work logs, file editor and composer were inspected and exercised with the browser preview. Existing density, theme tokens and native ownership boundaries were preserved. Full chat width increases from 920 to 1440px; the active work-log step no longer clips its card shadows. Dark elevation is compressed above depth 1 and muted text lifted. A Chromium check across 216 combinations of depth, tint, hue and surface found a minimum muted-text contrast of 4.92:1.

## Technical references

- Google documents conversion on update replaces content: https://developers.google.com/workspace/drive/api/guides/manage-uploads
- Conditional file metadata/media updates: https://developers.google.com/workspace/drive/api/reference/rest/v2/files/update
- Collabora SDK, WOPI and postMessage Save/ExtendedData: https://sdk.collaboraonline.com/CO-SDK-manual.pdf
- Collabora upstream configuration and isolation: https://github.com/CollaboraOnline/online.mirror/blob/main/coolwsd.xml.in
- OpenAI model reasoning requirements: https://developers.openai.com/api/docs/models/gpt-5-nano

Structured generation no longer disables reasoning by default on endpoints which require it. The existing explicit fast-classifier setting is retained. An unchanged generated model cannot be saved as a purported content edit. Agent instructions require exact-date evidence, correct operation types and inspecting actual saved content before claiming completion.

Chat attachments are uploaded once and represented by owned storage references. The server hydrates images/PDFs for the model, extracts text from supported text/Office formats, resolves spreadsheet shared strings, and refuses arbitrary remote URLs. Picker, paste and drop share explicit count/type/size validation. Sent files remain visible and downloadable. A failed upload keeps the draft and attachments.

## Verification evidence

- Full suite: 3,833 tests passed, including save receipts, no-op protection, conversion races, explicit slide counts, and legacy attachment compatibility.
- Typecheck and production build passed.
- Actual workspace browser suite passed: attachments, corner/split/full layouts, streaming continuity through navigation/resizing, file review cards, editable canvas and no save on opening.
- Live Google Docs, Sheets and Slides: export → edit → conditional same-ID update → reopen verified, and old version rejected. Only newly created synthetic files were used and moved to Trash.
- Live AI presentation generation: six populated designed slides exported to PPTX without the reasoning error.
- The first embedded save exposed early editor acknowledgement before upload completion. The implementation now waits for an atomic WOPI receipt before synchronizing Google.

See [deployment notes](../deployment/documents.md) for the pinned service, environment configuration, live harness and recovery behavior. Healthcheck success alone is not editor acceptance.

Live embedded DOCX, XLSX and PPTX editing all passed against the deployed document server: browser edits → explicit Save → persisted receipt → stored archive verification. The CODE first-run dialog is dismissed in the browser harness; product code does not hide or misrepresent the free edition.

Production verification passed for all three formats at `https://mail.lab86.io`: each browser edit created revision 2 with the expected stored content. Both production and development synthetic Office owners were cleaned up. The production test caught and resolved a Convex target mismatch before acceptance; the deployment guide records the actual Railway backend.
