# Presentation art direction and question cards

## Product intent

Let the model compose beautiful native slides around the approved story, evidence, images and data. Fixed compositions remain a fallback. Keep the user's confirmed theme, fonts, chart choices, sources and pacing. Improve the question cards with actual Tool UI controls and topic-specific previews.

## Research

Reviewed the official [Tool UI OptionList documentation](https://www.tool-ui.com/docs/option-list), [QuestionFlow documentation](https://www.tool-ui.com/docs/question-flow), and [component overview](https://www.tool-ui.com/docs/overview). Inspected the live OptionList page in Browserbase and the repository's vendored OptionList implementation.

The useful patterns are a clear question, short option labels with secondary descriptions, visible single/multiple selection, keyboard selection, explicit confirmation, and a compact receipt after answering. Presentation choices need richer media than a generic radio list: retain real SlideSurface previews of the topic, chosen fonts and verified chart values. Use OptionList as the interaction primitive inside the existing staged flow, with a runtime React media slot; do not put components or invented preview data in the tool schema.

Mobbin research was requested by AGENTS.md and its skill was loaded. No Mobbin tools were exposed in this session, so no Mobbin screens were inspected. Official live browser references and the existing product flow informed this change.

## Implementation decisions

- After evidence/copy review, a separate model call per slide designs native geometry, type scale, color placement and decorations. Unlocked starter coordinates are withheld to avoid anchoring the model to a preset. Content, chart data, asset references and locked elements remain immutable.
- Supply neighboring narrative headlines for coherence. Prompts call for a grounded hook, stakes, turning points, contrasts and an earned close, with a tone appropriate to the subject.
- Retain image-top, image-bottom and automatic image compositions as safe starting/fallback layouts, selected from copy density and image shape.
- Keep all authored images beneath the text/chart layer. Check collisions, text fit and contrast; reserve image-free space for intersecting copy when it still fits at its existing type size. Keep intentional readable overlays possible.
- Rejected art direction receives the attempted design and concrete repair feedback. Provider failure or deadline exhaustion preserves a valid starter slide.
- Final pixel review includes deterministic layout errors. Invalid visual fixes receive their attempted geometry and rejection reason for another bounded repair; a clean model verdict cannot waive measured defects.
- Question cards use Tool UI OptionList for source, detail, theme, font and visual choices, with preview galleries, descriptions, progress, native keyboard behavior and existing explicit submit/delegate/revise controls. No additional layout question is introduced.

## Acceptance

Playwright exercised the real components with synthetic content at 1200px desktop/light and 390px mobile/dark. Checked eight themes, six font pairs, keyboard selection, real chart values, both preview gallery columns, no horizontal overflow, confirmation receipts, reload persistence and malformed storyboard recovery. Inspected screenshots and corrected a decorative separator consuming every second gallery column.

Automated regression coverage includes immutable content/assets, complete geometry, invalid layouts, retries, timeouts, cancellation, locked elements, intentional overlays, images covering text despite decorative flags, collision reflow, fallback layouts, and final pixel review of model-designed slides.
