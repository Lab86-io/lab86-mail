# Undo send countdown and stamped send celebration

## PR description

After Send, show a persistent bottom-right receipt with the subject, a deadline-based countdown ring, and an Undo send button. Undo restores the original compose mode, account, reply anchor, recipients, text, and attachments. Confirmed delivery triggers a large animated “SENT!” stamp and a short fireworks burst. Instant sends use the same celebration; reduced-motion users receive the existing text confirmation.

Fix stale countdown time after an idle session, IndexedDB failures hiding active receipts, startup/focus reconciliation overwriting new sends, repeated cancellation clicks, polling that stopped on unknown status, and the delayed composer reset wiping out a quickly restored draft. Keep memory authoritative for active sends and serialize durable writes. Refresh mail queries when delivery is confirmed. A failed cancellation request no longer incorrectly marks delivery as failed.

## Product and registry research

- [Gmail Help: Send or unsend messages](https://support.google.com/mail/answer/2819488?hl=en): the corner notification puts Undo next to send feedback and restores the draft. Albatross keeps the visible action and adds the exact remaining deadline; it labels the pending state honestly rather than calling it sent.
- [Odyssey UI](https://www.odysseyui.com/docs): reviewed the library and its shadcn/Motion approach. No matching celebration was selected there.
- [Animate UI Fireworks Background](https://animate-ui.com/docs/components/backgrounds/fireworks): inspected the live page using local Playwright/Chromium, plus the [registry source](https://animate-ui.com/r/components-backgrounds-fireworks.json). Reused its particle and rocket physics under MIT + Commons Clause (license retained beside the implementation). Changed the continuous background to three bounded launches, quicker decay, glow, fixed-rate simulation, DPR sizing, and complete timeout/frame/visibility cleanup. Added a bespoke oversized stamp that lands, rebounds slightly, holds, and fades. No new dependencies.
- The user's final visual direction: “playful animated sent stamp. almost like someone is stamping the whole screen with fireworks”.
- Mobbin MCP tools were not exposed in this session, so no Mobbin screens or flows could be inspected. The browser preview service and Browserbase also failed; local Playwright/Chromium supplied browser research and product verification. This is an explicit research gap, not a claimed Mobbin audit.

## Validation

- `bun test tests/pending-send.test.ts tests/sending.test.ts tests/compose-undo-route.test.ts tests/nylas-provider.test.ts`: 38 pass.
- Full `bun test`: 3,976 pass, 1 skipped, 0 failures.
- `bun run typecheck`: passed.
- Biome checks on changed code.
- `ALBATROSS_PREVIEW_PORT=18849 bun scripts/preview-app-workspace.mjs`, then `node scripts/verify-send-ui.mjs`: real InlineComposer + PendingSendProvider with synthetic transport. Covers preference-driven sends, idle timestamps, immediate Undo, all compose modes, recipients/account/attachments, unavailable storage, unknown/offline delivery status, cancellation failures, failed-send recovery, reload persistence, stacked sends, five-minute windows, mobile light/dark layouts, instant sends, reduced motion, celebration timing, and cleanup. Captures desktop/mobile evidence. Latest run passed all checks; screenshots are in `/tmp/albatross-send-cQMY8b`.

No live mail was sent during verification. Provider scheduling/cancellation calls are covered by mocked transport; real-provider latency and delivery were not exercised.
