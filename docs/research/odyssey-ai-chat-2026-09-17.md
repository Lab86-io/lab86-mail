# Odyssey AI chat replacement

## Scope and surrounding flow

Reviewed the floating AssistantChat panel, message history, file attachments, streaming tools, rich result cards, approvals/questions, Ask/Hold composer, and Teach Areas conversation before editing. Shared application actions and tool-result renderers remain the owners of their behavior.

## Browser research

Reviewed the live [Thought Chain](https://www.odysseyui.com/docs/components/ai/thought-chain) and [Steps](https://www.odysseyui.com/docs/components/ai/steps) documentation/previews with Browserbase, and inspected the upstream source for [Chat Container](https://www.odysseyui.com/docs/components/ai/chat-container), [Message Bubble](https://www.odysseyui.com/docs/components/ai/message-bubble), and [Prompt Input](https://www.odysseyui.com/docs/components/ai/prompt-input).

Thought Chain supplies the status glyph, connected vertical timeline, per-row disclosure and active badge. Steps supplies the compact group disclosure. The prompt input has a layered outer shell and inner field, with a separate action row. Message bubbles distinguish senders through alignment and corners.

## Mobbin research

The live Mobbin MCP search tools were unavailable in this session. Reused the repository's previously captured web research from `docs/refinement-round-2026-09-03/macos.md`, Wave E:

- [Tana composer](https://mobbin.com/screens/572a2ee5-025a-4fcc-89a4-3b6fb354df19): one field combines asking and capturing, with route controls near the field.
- [Higgsfield composer](https://mobbin.com/screens/b3d37b95-b6a7-4d0b-a069-4239a27452f1): keep the mode control alongside submission.
- [Mistral Le Chat composer](https://mobbin.com/screens/edacf670-c966-421c-85ec-ad218e18a549): a small labeled mode control preserves input space.

These are existing research observations, not a new live Mobbin search. They support retaining Ask/Hold and attachment/voice actions inside the Odyssey prompt layout.

## Decisions

- Replace the old custom chat container, bubbles, prompt primitives, reasoning disclosure, and chain-of-thought UI with the vendored Odyssey components.
- Use Steps to disclose each work group and Thought Chain for actual tool activity. Do not fabricate pending steps or reasoning.
- Keep Albatross density and semantic theme tokens. Avoid a second icon library.
- Keep failed/interrupted work visible; collapse only successful completed groups according to existing policy. Preserve tool card state on disclosure.
- Follow streaming size changes only while the user is at the bottom. Support reduced motion and keyboard disclosure.

## Validation

- Full Bun suite: 3,992 passed, one pre-existing skipped test, no failures.
- TypeScript and repository lint pass (existing lint warnings remain).
- Focused component tests cover per-row disclosure state retention/inertness, keyboard submission/IME, interrupted work, successful group auto-collapse, and user disclosure preference.
- Playwright fixture checks at 1280×800 and 390×844 verify live/completed/failed tools, archive action feedback, no horizontal overflow, following streamed content, preserving scrollback, return-to-bottom, dark mode and reduced motion; no browser page errors.
- Screenshots reviewed in light and dark themes. The last timeline connector is omitted to avoid extra spacing after a collapsed reasoning row.
