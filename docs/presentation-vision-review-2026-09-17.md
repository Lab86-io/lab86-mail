# Presentation image review and vision model selection

## Product behavior

The settings picker accepts verified image-input models across providers, including Z.ai GLM-5.3 Flash. Search, provider filters, capability badges, keyboard selection, and compact descriptions build on the existing shadcn Command/Popover controls. Unknown custom IDs and text-only choices are rejected on save. Old unsupported saved choices use the configured runtime default, and saving unrelated preferences migrates those choices without a dead end. Direct vendor keys retain compatible vendor defaults even when staging's hosted default is GLM.

Every newly composed presentation and AI-edited/restyled deck now renders every final slide to a PNG. The selected primary model receives the actual image plus element IDs and source chart data. Browser measurements also detect clipped text. The model can repair geometry, rotation, type size, and colors; it cannot change words, numbers, chart categories/series, notes, theme, or locked elements. Repaired slides are rendered and checked again. At most four model requests run concurrently, with a 120-second total visual-review budget and two repair rounds.

A partial or unavailable check saves an explicitly marked draft instead of throwing away the deck or claiming it passed. `document_review_slides` resumes the same file with revision conflict protection. The creation card discloses unfinished review, and optional Google publication waits for a passed review. The agent is instructed to recheck after manual slide edits. This verifies the shared slide canvas; it does not run desktop Microsoft PowerPoint, whose font substitution may differ on the recipient's machine.

The chart renderer now draws horizontal bars directly with upright labels and a correct zero baseline. Signed values are preserved for horizontal/vertical bars and lines.

## Design research

- Reviewed [Odyssey UI's model selector](https://www.odysseyui.com/docs/components/ai/model-selector) in a browser and read its public registry source. Useful patterns: provider filtering, model descriptions, capability badges, and a compact selected-model trigger. Adapted those patterns to Albatross's existing shadcn primitives and density; no new runtime component dependency or hard-coded demo model list.
- Applied the Mobbin research skill. Mobbin tools were not connected in this session, so no fresh Mobbin results are claimed. Existing picker research already records [Relevance AI](https://mobbin.com/screens/94a61b0c-d8b5-4254-8147-426391e60452), [Langdock](https://mobbin.com/screens/4513a553-1cfa-4f66-949e-a7047ba11af3), and [Vercel](https://mobbin.com/screens/43b56b19-c2f2-4adf-acdc-445c98112c87) model catalog examples. The Odyssey browser review supplements that research.
- Verified [OpenRouter's live model catalog](https://openrouter.ai/api/v1/models) and [GLM-5.3 Flash's provider page](https://openrouter.ai/z-ai/glm-5.3-flash): text/image/video input, text output, tools, and structured outputs. Live metadata overrides curated capability information.
- Consulted [OpenAI image-input documentation](https://developers.openai.com/api/docs/guides/images-vision) and [Browserbase's Playwright guidance](https://docs.browserbase.com/platform/browser/files/uploads) for image transport and remote rendering. Runtime model selection remains provider independent.

## Verification

- Regression tests cover vision filtering/server rejection, saved-model fallback, provider routing, actual image forwarding, visual repair and reinspection, chart data preservation, measured clipping, retry/failure/cancellation, draft recovery, and revision conflicts.
- Live GLM-5.3 Flash caught and repaired an upside-down bar chart and a nearly invisible footer, then passed the new screenshot in about 9 seconds.
- Live clipped-text fixture needed two geometry repairs and passed the third image inspection, preserving the complete paragraph and numbers, in about 9 seconds.
- An eight-slide synthetic presentation completed editorial review and all eight visual checks in about 53 seconds. No real user documents were created by these checks.
- Browser checks at 1200px and 390px verified GLM selection, keyboard selection, provider filtering, text-only exclusion, and no page overflow or browser exceptions.
- The complete Browserbase render → GLM critique → repair → rerender → approval cycle passed under Node in about 24 seconds. Browserbase CDP succeeds under Node (the deployed Next.js runtime). Bun's CDP connection timed out in the local smoke runner; local Chromium and provider image calls worked under Bun.

Staging deployment uses `z-ai/glm-5.3-flash` for the normal and fast defaults. Explicit compatible user selections remain respected. Production defaults are unchanged.

Final feature checks: 4,093 tests passed, one optional test skipped, no failures. Every changed library file meets the staging coverage baseline; the visual-review module has 100% line coverage. Typecheck and lint passed.

## Follow-up review

The automated review identified an actual collision between category labels and negative bar-value labels. The renderer now reserves separate space for negative values, including their unit suffix. Added a direct OpenAI-key regression with both hosted defaults set to GLM.

The 120-second image-review budget remains intentional: creation also needs composition, editorial review, and persistence within its 280-second tool limit. Raising image review to 200 seconds could consume the remaining save window. Slow or large decks stay resumable drafts.

Unsupported saved text-only models intentionally fall back to the configured vision default, including retired text-only models. This prevents legacy settings from breaking the presentation flow. Explicitly selecting a retired model is still rejected.

The Google gate applies to automatic publication during creation. A later explicit publish remains available; this release does not introduce a mandatory review policy for manual publishing or persist a typed review attestation on every document revision. Review results are in the tool result and revision summary, and resuming the review checks the entire current deck. The legacy generator returns its composition promise without awaiting it inside the catch, so asynchronous cancellation is already propagated rather than relabeled.
