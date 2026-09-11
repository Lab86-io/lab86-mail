# Chat revamp recovery

Scope: the `chat-agentic-pass` worktree. This change covers web, iOS, macOS, and AI model selection.

## Recovered session

Claude session `d6e23d2a-a6d8-46cb-bed0-dcac10781664` stopped at its session limit.
Five survey agents completed: tool inventory, web UI, native UI, latency, and output fields.
Three implementation agents stopped: web chat, shared native chat, and model selection.
The planned separate macOS agent had not started.

Three commits already contained live server output, tool shapes, and shape tests.
Uncommitted changes contained tool groups, prompt changes, partial UI components, and a partial model catalog.
The web and native result components had not been connected to their chat views.

Codex recovered these files and completed the integration. A native specialist continued the shared SwiftUI work.
The previous Claude specialist output was adapted. Claude remained unavailable due to its session limit.

## Product research

The original session used Mobbin before implementation. This recovery retained its screenshots and query results.
The following references informed the retained design:

- [Manus, web](https://mobbin.com/screens/728a9190-886a-4843-8b2e-a9ea8c180d18): a vertical rule groups task steps. Results sit beneath each step.
- [Manus, iOS](https://mobbin.com/screens/59294d00-2e82-406d-a422-a8efa4cd10ab): compact step summaries preserve space for the reply.
- [Langdock](https://mobbin.com/screens/4f26e4c9-7c5c-45b6-9eab-52d2ef6c9bc1): provider groups and model counts reduce the search area.
- [Cofounder](https://mobbin.com/screens/37801342-be92-4580-a24e-81e6c9f35b3a): model names and capability labels share a compact selector.

The web implementation retains the installed AI Elements primitives and the existing application tokens.
[Chain of Thought](https://elements.ai-sdk.dev/components/chain-of-thought) supplies collapsible steps and status indicators.
[Model Selector](https://elements.ai-sdk.dev/components/model-selector) supplies the cmdk pattern for provider groups, search, and keyboard access.

Mobbin tools were unavailable in this Codex session. The saved reference images were inspected locally.
Browserbase Fetch failed because its local configuration file was missing. The official component pages were read through web access.
The OpenRouter models API was read on 2026-09-11 to verify current IDs and metadata.

## Implementation decisions

- Consecutive tool calls form a work log. Completed groups with at least three steps collapse. Failed groups remain open.
- Eighteen server result shapes drive actionable cards. Existing display tools retain their designed cards.
- A word cursor meters transport chunks. A fixed deadline bounds catch-up and completion. Reduced motion bypasses the cursor.
- Card mutations display an inline result. They do not replace the chat with another surface.
- Normal and Fast model choices use provider groups, search, capability labels, and explicit retirement information.
- The runtime uses the same live catalog to resolve retired choices. Replacement models stay within the original vendor.
- Native conversation history retains tool rows, errors, reasoning, questions, and result shapes.

## Validation handoff

Before the user changed the validation instruction, focused tests and desktop/phone browser checks passed.
The browser checks covered live rows, failure visibility, card actions, overflow, model search, and keyboard selection.
Those checks used deterministic transport and API fixtures. They did not prove a live provider or authenticated native flow.

The user then requested a direct push to staging and CI validation. Local checks stopped.
CI is authoritative for the final changes, including the native build and tests.

The repeatable web harness is `/dev/chat-preview`. The model harness is `/dev/model-picker`.
Both return 404 outside development. `scripts/verify-chat-revamp-ui.mjs` records desktop and phone screenshots.
