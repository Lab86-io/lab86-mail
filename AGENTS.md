# Agent Instructions

## Albatross UI Work

Any change that designs or materially changes UI for the Albatross feature must follow the Albatross development contract in `docs/albatross-development-contract.md`.

Albatross UI components may be implemented directly by 5.6-sol or by a Claude Code sub-agent with a full-context Opus prompt, e.g. `claude -p "{prompt}" --model opus`. The 5.6-sol path does not require a Claude sub-agent. Do not use tiny prompts, no-tool prompts, or lightweight model fallbacks for Albatross UI. Both implementation paths must name the UI to design, the files to edit, and the product constraints, and must perform Mobbin plus browser-based research before implementation. Keep the resulting research notes and implementation-path summary in the PR.

Tests must not regress. Add or update focused tests for every behavioral, state, data, routing, or contract change.
