# Presentation overflow remediation — September 17, 2026

## Reproduction and cause

The screenshot and staging logs agree: `document_create` rejected an excess item array, two subsequent attempts failed on `slide-1-foot`, and the final run ended with `aborted: true`. The logs do not identify the cause of that abort. Existing stream heartbeats and checkpoint recovery remain in place.

The authoring schema relaxed string limits but retained the compact item-array limit, so excess items never reached review. The cover footer came from the audience rather than an editable slide-copy field; repeating the copy-repair call could not affect it. Chart/table source captions had the same fixed-height risk. A boundary regression also exposed an overlapping metrics title/body box.

## Changes

- Accept up to 12 draft items. Reflow excess items into the composition's visible slots before editorial review, preserving the exact original items in notes and the requested slide count. Review receives the slot budget and synthesizes grouped findings; deterministic grouping remains available when the review service is unavailable. The result reports that reflow occurred. Cover, statement and table supplementary items are retained in notes because those layouts have no item slots.
- Explain compact per-field and per-role budgets in the authoring schema and agent/generation prompts. Larger input limits are recovery allowances. Explicitly instruct the agent to correct the failing field instead of resubmitting an unchanged brief.
- Expand captions into reserved space at their existing readable type size. Normalize caption whitespace, retain the complete audience/source text, and preserve short-caption geometry. Metrics titles reserve space for an optional body.
- Recognize both chart and table source fields during repair. Preserve originals in notes when shortened. Deterministic fallback touches only overflowing fields, preserving unrelated content. Skip model repair when no editable target exists.

## Validation

- Reproduced the five-item rejection and full-length audience footer failure in tests before changing implementation.
- Regression coverage: 5/12 items, per-role capacities, legacy layouts, unavailable editorial review, exact original evidence, unchanged slide count, both palettes, artwork cover captions, chart/table citations, newline normalization, metrics title/body separation, and cancellation/no orphan saves.
- Entire suite: 4,033 passed, one optional artwork rendering test skipped. Changed AI/review/design logic has 100% line coverage; compositor coverage remains above 99%.
- Typecheck and lint passed (existing unrelated lint notices remain).
- Browser rendering: inspected synthetic 1920×1080 slides with a full-length audience footer, an owned image, an editable column chart with a long citation, and a five-item list reflowed into four groups. The composed deck passed quality checks; captions were readable and no longer clipped.
- This changes composition sizing and remediation, not an Albatross UI surface or its design system. No new third-party component or visual library is introduced.

## Limits

Layout checks remain mandatory. Invalid chart/table data or content that cannot be repaired safely must still return an error before saving. These regressions cover the reported failures; they do not guarantee uninterrupted network connections or model availability. Existing recovery requires reading saved results before another write.

## Preservation budget follow-up

Review of #259 found that twelve individually valid, maximum-length items could exceed the persisted 50,000-character notes limit when archived. Authoring now enforces a combined 40,000-character serialized source budget per slide, including JSON escaping, before any editorial call. The same guard protects direct review callers. This is a storage-size constraint, separate from the compact visible-copy budgets.

Preservation tracks the source version of each field internally and stores it once. Grouped items already have their exact original array archived, so shortened group labels/details do not duplicate the same evidence in notes. User-authored note markers cannot suppress preservation. The compact brief's original 4,000-character note budget is not reapplied to enriched review output: that output intentionally includes recovered source detail and must satisfy the persisted document's 50,000-character limit.

Regression tests cover maximum-length arrays, control-character JSON expansion, a large accepted draft through `parseDocumentModel`, repeated repairs, and note-marker collisions.
