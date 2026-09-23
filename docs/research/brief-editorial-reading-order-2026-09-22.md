# Editorial output verification follow-up

The second production regeneration completed on its first attempt with a generated document, twelve regions, six Tool UI components, and no artifact errors. Rendering its saved document with Next.js passed at 1280px and 390px with no overflow or JavaScript errors. A choice saved and survived reload through the local test store. Those mechanical checks did not establish editorial quality.

Reading the actual page exposed three issues:

- The editor created supporting regions before repairing its opening. `place_regions` preserves existing positions, and the writer had no explicit final ordering parameter. The opening therefore appeared halfway down the page. Finalization now requires a complete, unique reading order; the author still chooses the page composition.
- The editor promoted the next-day intention into the edition's date. Its input now spells out the local date and time alongside the timezone and labels the intention as `tomorrowIntent`. Both writers are told to preserve the edition's local date across UTC midnight.
- Completed connected items can score below the visible-story threshold. Giving the writer only ranked modules withheld evidence that could retire a stale Area claim. Both writers now also receive the already collected connected-source packet (up to 25 records in the active pipeline), including completed items, as reconciliation context. This does not require displaying every record. Secondary summaries without current primary confirmation are explicitly treated as unverified.

This preserves the web design system and existing component catalogue; it changes the editor's context and authoring contract, not a new UI surface. The earlier product research and renderer checks are recorded in [the preceding verification notes](brief-production-followup-2026-09-22.md). Private production screenshots and source content remain local. Final validation uses the Next.js renderer, not the Bun-only client preview that cannot bundle these CSS modules correctly.

The runtime investigation also reproduced an older Area ingestion defect: the deterministic classifier included an extra account identity inside each link, while the Convex validator accepts it only on the enclosing verdict and source references. That field originated in the July 16 classifier change. Removing the redundant nested field keeps account-scoped routing intact. An integration test now runs the real classifier payload through the actual Convex mutation rather than a permissive mock.

Prompt guidance improves evidence handling but cannot guarantee every future model statement. Reading-order completeness and the classifier payload contract are enforced and tested directly.
