# Agent Instructions

## Albatross UI Work

Any change that designs or materially changes UI for the Albatross feature must follow the Albatross development contract in `docs/albatross-development-contract.md`.

Do not generate UI components directly from ChatGPT/Codex. For UI component work, spawn a Claude Code sub-agent with a full-context Opus prompt, e.g. `claude -p "{prompt}" --model opus`. Do not use tiny prompts, no-tool prompts, or lightweight model fallbacks for Albatross UI. The prompt must name the UI to design, the files to edit, the product constraints, and require Mobbin plus browser-based research before implementation. Keep the resulting research notes or Claude summary in the PR.

Tests must not regress. Add or update focused tests for every behavioral, state, data, routing, or contract change.
