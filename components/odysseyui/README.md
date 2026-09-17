# Odyssey UI AI chat components

Vendored and adapted from [Odyssey UI](https://github.com/shr3kx/odysseyUI/tree/b83eb73b43a446be293cac9ae5af313aa45201e6/apps/www/registry/components), revision `b83eb73b43a446be293cac9ae5af313aa45201e6`.

Sources: `ai/thought-chain`, `ai/steps`, `ai/chat-container`, `ai/message-bubble`, `ai/prompt-input`, and `texts/text-shimmer`. These are copy-in components, not a runtime package.

Local adaptations:

- Albatross semantic colors, compact typography, existing Radix wrappers and Lucide icons.
- Thought Chain adds an explicit failed state; disclosure preserves mounted result controls and makes closed content inert. The final connector ends at the final row.
- Steps shimmers only while work is active and accepts React content without coercing it to a string.
- Prompt Input retains Odyssey's layered card/textarea/action-bar composition with controlled value, submission, attachments, voice, and Ask/Hold slots. Enter honors IME and caller keyboard handling.
- Chat Container observes content size for streamed text and tool results, follows only while at the bottom, and provides a labeled scroll-to-bottom control.
- Message Bubble uses `from` instead of `role` for the sender to avoid confusing it with ARIA roles. Unused avatars/dividers were omitted.
- Motion respects reduced-motion preferences; shimmer text remains readable before hydration.
