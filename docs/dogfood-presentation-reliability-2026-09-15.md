# Presentation creation and research reliability

## Reported behavior

The supplied chat requested a presentation using a project report, Granola notes, and email history. `document_create` timed out after 75 seconds. The assistant checked Files, found an older presentation, and attempted another creation before proposing manual slide edits. A `corpus_search` activity claimed to have searched mail, but its two displayed matches were Granola meetings.

## Confirmed causes

- Chat applied the same 75-second deadline to generated documents and short read operations. Its `Promise.race` rejected without cancelling the underlying generator, so a provider response could still create a file after the assistant had moved on.
- Researched presentation content could only be passed as instructions to a second model or assembled through a blank file plus later edit operations. The deterministic presentation composer was available internally but not exposed to chat creation.
- New document creation did not record the saved document ID in the same transaction as its agent execution checkpoint. Updates and suggestions already did.
- Combined corpus searches defaulted to mail plus connected sources, silently swallowed per-mailbox failures, and always used a mail-only activity label.

The transcript does not establish a title-rendering defect: the cards use the saved document title, while the assistant can also see titles inside its slide content. It also does not establish why the live generator took longer than 75 seconds or whether an underlying mailbox request failed.

## Changes

- `document_create.presentation` accepts validated slide content and uses the existing composer directly. It preserves source references and speaker notes, validates presentation kind and requested slide count, and returns the saved file as before.
- Generated document calls receive 210 seconds; direct creation and reads retain 75 seconds. Timeout and chat cancellation propagate an abort signal to generation. Document creation, suggestions, and generated edits check cancellation before persistence.
- Creation records the file ID and revision in the same Convex transaction as the document and its initial revision. Interrupted or already committed executions cannot create a second file. Recovery can identify a committed file even if its tool response was lost.
- Corpus search returns counts for the displayed mail and connected-source results, explicit per-source failures, and connected-item identifiers and summaries. Activity text reports the actual result sources.
- Agent guidance prefers direct creation after research, requires separate email retrieval and reading for combined meeting/email requests, and describes recovery without repeating the same generation request or repurposing an unrelated file.

These changes use the existing presentation layouts and chat components. There is no visual redesign.

## Verification

Focused regressions cover direct creation → read → PPTX export (including speaker notes), validation, a simulated 90-second generation, timeout/disconnect cancellation, refusal of late saves, atomic recovery records, duplicate/interrupted creation, separate mail research, partial search failures, source identity, and activity labels. The full repository suite passes: 3,807 tests across 398 files, zero failures. TypeScript and changed-file Biome checks also pass.

The tests use synthetic source material and controlled provider responses. They do not replay the user's private email/Granola queries or establish live provider latency. Ship the additive Convex creation argument before the web changes. No deployment was performed as part of this repair.
