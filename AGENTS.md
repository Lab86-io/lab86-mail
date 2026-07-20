# Agent Instructions

## Albatross UI Work

Codex owns Albatross UI research, design, implementation, integration, and final review directly. Do not delegate UI authorship to Claude or require an Opus implementation pass.

Before materially changing an Albatross UI, use current Apple guidance and Mobbin to research the complete journey and relevant states. Record the queries, screens or flows examined, links, adopted patterns, rejected patterns, state matrix, and rendered-review findings in `docs/mobile/research/<slice>.md`.

Keep native Apple navigation and controls, synthesize Mobbin patterns rather than copying screens, preserve Albatross product semantics, and validate material UI changes with rendered iPhone evidence.

Tests must not regress. Add or update focused tests for every behavioral, state, data, routing, or contract change.
