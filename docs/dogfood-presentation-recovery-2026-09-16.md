# Presentation recovery and indexed mail counts

## Confirmed failure sequence

Read-only staging inspection matched the reported PubMed deck and saved chat. The first complete 13-slide brief omitted `items` on its chart slide and exceeded the closing body limit. The presentation union exposed only `presentation — Invalid input`, hiding both actual fields. Three validator probe files were subsequently saved.

After trimming copy, seven-slide attempts repeatedly failed because the fourth list detail box overlapped the page number. List body boxes were also too small for accepted supporting copy. A seven-slide deck eventually saved. Revision 2 then appended six slides using `slide_insert` with `elements: []` and brief fields (`body`, `items`, `kicker`, `chart`). Nested object validation silently stripped those fields. The saved slides 8–13 had titles and notes but no elements. Subsequent user revisions retained those empty slides. There was no renderer cutoff at slide 7.

The stored creation reason also records a failed server render check: the shared slide renderer was marked as a client entry point. Production server rendering could not execute it. Its implementation has no browser hooks; the editor and preview already provide their client boundaries.

The zero-mail claim was also unsupported. Staging sync states report all three accounts ready with messages synced. Replaying `countCorpusMessages` failed for every account. Convex logs show each exceeded the 16,777,216-byte read limit while loading full message rows. The tool caught those errors and returned exact zero counts.

## Changes

- Nested union validation reports up to five concrete field errors from the closest schema branch. Optional slide callouts default to an empty list.
- Four list rows fit above the footer, and supporting copy has sufficient horizontal room. Four-column comparison headings use a size suitable for their narrower columns. Text measurement counts wrapped words wider than their box; this catches clipped comparison headings found during browser verification.
- Slide insertion and metadata patches reject unsupported fields. Chat checks inserted slides after applying the whole batch and refuses to save or propose empty slides. A batch may insert a slide and populate it with element operations atomically.
- Agent guidance explains rendered elements versus brief content and requires complete deck verification. It directs recovery toward correcting the actual brief rather than creating probe files or placeholder slides.
- The pure slide renderer is shared with the server render check without a client entry directive.
- Mail counts stream indexed rows within a 4 MB budget and a 1,000-row cap. A bounded scan returns an explicit lower bound, and its count card says "or more indexed messages." Read failures stay failures; an unknown account cannot become an empty count. Agent guidance requires account sync evidence before explaining indexing limitations.

## Product research

The Mobbin research skill was loaded, but no Mobbin tool is available in this session. Existing editor, filmstrip, tool activity, and saved revision flows were inspected. This is a repair within existing layouts and components.

Browser research of [Gamma's scale-to-fit update](https://ideas.gamma.app/changelog/scale-your-content-to-fit) confirms the relevant fixed-slide behavior: content should fit the authored canvas automatically. This repair preserves content and adjusts layout/type within existing design rules.

## Verification

Focused regressions cover nested field errors, omitted chart callouts, a 13-slide composition and PPTX export, four-item lists, wrapped long words, rejected misplaced brief fields, rejection of empty inserts in apply/review modes, atomic insert-plus-populate, count failures, account scoping, and byte-bounded counts with text/date filters.

The saved private payloads were replayed locally without committing source material. The corrected complete brief passes layout checks. Recovery uses the recorded slide content and existing document revision; it restores six missing element sets and repairs an overflowing comparison label. Titles, source references, existing content and user notes are preserved. Omitted supporting facts from a statement composition are retained in speaker notes. Browser verification checks all 13 rendered frames and text bounds before any recovery write.

The full suite passed with 3,972 tests, one skip, and zero failures. Typecheck, lint, and the production build passed. After the final comparison-heading adjustment, all 52 focused presentation/render tests passed again. The recovery rendered with 13 frames, zero blank slides, and zero clipped text elements in Chromium. It was saved to the same staging document as revision 11 and read back to verify the full model.

Deployment uses the staging workflow, which deploys Convex before the web service. The count change is compatible with the existing response shape. Existing blank slides require an explicit revision-bound repair; this change does not rewrite arbitrary stored documents.
