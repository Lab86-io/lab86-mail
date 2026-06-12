# Web → macOS Parity Gaps

Audit date: 2026-06-12, after the first signed-in build. Format: what the web
app has that the Mac app doesn't, UI and backend combined. Checkboxes get
ticked as they land; items marked **[backend]** need server-side work in the
main repo (new authenticated Convex functions or API routes).

## P0 — Flagship surfaces (the app feels incomplete without these)

- [ ] **Daily Report** — the default web view. Broadsheet masthead (serif),
  sections (Reply Owed / Follow-Up Owed / New People / Time-Sensitive /
  Tracked / FYI / Bulk), per-item "why it matters" + suggested action +
  elapsed-time framing, streaming partial→ready state, manual regenerate with
  kind selector, click-to-focus thread. **[backend]** native needs an
  authenticated read of the `dailyReports` doc (web reads via its server) +
  a generate trigger; today both are internal-secret only.
- [ ] **AI Assistant (⌘K)** — chat side panel, 53 tools, mutation
  confirmation cards, tool-execution animations, chat history sessions,
  prompt suggestions, memories (remember/recall), `ui_*` tools mapped to
  native navigation (focus thread, set query, open compose…). **[backend]**
  reuse the web's agent loop over SSE; needs the streaming chat endpoint
  callable with a Clerk Bearer token.
- [ ] **Command palette (⌘P)** — mailboxes, AI quick actions, recent
  threads, theme toggle.
- [ ] **Onboarding / connect accounts natively** — Nylas OAuth in
  `ASWebAuthenticationSession` against `/api/nylas/connect` + callback;
  provider buttons (Google/Microsoft/iCloud/IMAP); first-run welcome.
  Today: connect/disconnect only via web settings link.
- [ ] **Settings parity** — AI mode (Lab86 vs BYOK, model pickers, key
  management), billing/upgrade status, account alias rename, disconnect,
  delete account, keyboard shortcut reference. Native Settings window now
  covers: undo-send window, theme, account list (read-only), sign out.

## P1 — Mail-core parity

- [ ] Multi-select + bulk actions (`x`, ⌘A; bulk archive/trash/label/triage)
- [ ] Forward (UI; `/api/compose` mode=forward already works)
- [ ] Reply: editable To/Cc/Bcc + subject, from-account selector, attachments
- [ ] Drafts — autosave, recover, Drafts view shows real drafts **[backend:
  userDocs drafts need an authenticated read path or /api/tools draft tools]**
- [ ] Snooze / unsnooze + Snoozed view (`snooze_thread` tool exists)
- [ ] Labels: add/remove provider labels, create label, apply smart labels
- [ ] Category correction ("quick fix": never_main / always_noise / move to X
  → `set_smart_category` + smart rules)
- [ ] Mute thread; restore-from-trash in Trash view
- [ ] Schedule send UI (backend `sendAt` already supported)
- [ ] Undo-send status polling (`/api/compose/status/:id`) + global sent toast
- [ ] Star at thread level from list rows
- [ ] Thread row chips: category pill, account alias, attachment indicator
- [ ] Search: NL → query translation ("ask for mail…") — hosted `nl_search`
  or on-device Foundation Models; typed-operator parity audit (parser port);
  search history + suggestions
- [ ] Deep pagination past 200 threads (HTTP `search` tool path)
- [ ] Contact popover on sender click (`contact_lookup`)
- [ ] Markdown compose with preview tab (web sends markdown + html)
- [ ] Cached thread summaries with hosted fallback (web `summarize_thread`
  persists summary/summaryAt; native on-device summary is ephemeral and has
  no fallback when Apple Intelligence is off)
- [ ] Fullscreen reader (⌘↑), per-message collapse, quoted-text collapse
- [ ] Full keyboard map: o/enter, u/esc, r, /, s, t, g-sequences, ?, x
- [ ] "99+" capped badge display (cap field is already in categoryCounts)

## P2 — Intelligence & theming parity

- [ ] **On-device classification write-back** (the money feature)
  **[backend]** add Clerk-authenticated `liveMail.listMyLlmPending` +
  `liveMail.storeMyLlmVerdicts` mirroring the internal functions; Mac sweeps
  pending threads with Foundation Models and the web app benefits
- [ ] Triage (`t`), bulk triage, extract action items, translate thread,
  pre-send critique — hosted tools, need native entry points
- [ ] Theme parity: rail wash opacity, film-grain overlay, display font
  choice (Editorial/News/Sans — bundle Fraunces/Averia or map to New York)
- [ ] Dark-mode adaptation of light-only HTML emails (web tints backgrounds)

## P3 — Platform-native wins (beyond web parity)

- [ ] Dock badge unread count (trivial off live categoryCounts)
- [ ] Native notifications for new Main/needs-attention mail
- [ ] SwiftData offline mirror: instant cold launch, offline reading (M5)
- [ ] Quick Look attachment previews; drag attachments out of the reader
- [ ] Register as `mailto:` handler; share-sheet compose
- [ ] Menu bar extra with unread peek (optional)

## P4 — Distribution

- [ ] App Store Connect record, provisioned signing (restores
  associated-domains → **passkeys work**), TestFlight, notarized DMG+Sparkle

## Fixed already (this session)

- [x] Auth race: subscriptions opened before Convex token exchange → dead
  publishers, empty rail ("Server Error" alert at sign-in)
- [x] Full-width inbox when no thread selected (reader slides in on select)
- [x] Account switcher (All Mailboxes / per-account scoping)
- [x] Custom smart labels in the rail (from live categoryCounts keys)
- [x] Settings window (undo window, theme, mailbox status, sign out)
- [x] Liquid glass pass: floating reader actions, glass composer/summary/auth
- [x] On-device summaries with "On-device" badge
