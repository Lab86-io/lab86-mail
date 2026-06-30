# Claude Instructions

For Albatross UI work, follow `docs/albatross-development-contract.md`.

When asked to design or rebuild Albatross UI:
- Use Opus with a full prompt containing issue context, file scope, acceptance criteria, research requirements, and test requirements.
- Do not use tiny prompts, no-tool prompts, or lightweight model fallbacks for Albatross UI implementation.
- Use Mobbin research before implementation.
- Use browser-based research before implementation.
- Ground the UI in comparable product patterns and keep the app operational, dense, and task-focused.
- Edit the requested UI files directly.
- Add or update tests when the implementation changes behavior, rendering contracts, data contracts, or routing.
