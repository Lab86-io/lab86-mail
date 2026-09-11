# Notifications workspace: research and acceptance

## Direction

Notifications becomes a first-class destination, separate from Activity history and Mail. The footer remains Settings · Notifications · Profile. Questions, approvals, and due check-ins remain outstanding until the owning workflow actually handles them. Merely opening their notification is **read**, never **acted**.

## Research checkpoint

Mobbin discovery was attempted on 2026-09-10; no Mobbin screen/flow tools were available. Intended web queries: “notification inbox with pending approvals and updates,” “notification detail pane beside a keyboard navigable list,” and “mobile notification detail with back navigation.” No Mobbin research is claimed.

Browser research inspected [Linear's Inbox documentation and embedded product screenshot](https://linear.app/docs/inbox). Its priority-versus-update hierarchy, understated row selection, visible timestamps, keyboard movement, and context detail are useful precedents. Albatross keeps pending actions distinct from unread messages: reading cannot resolve a question or approval.

[WAI-ARIA listbox guidance](https://www.w3.org/WAI/ARIA/apg/patterns/listbox/) explains why options cannot contain interactive descendants. This surface uses a semantic list of native buttons, section headings, and separate detail actions—not a faux listbox with nested buttons. Arrow keys move focus, Enter opens, Escape returns to the list.

Claude Fable 5.1 supplied a scoped text-only design review through the authenticated CLI. Adopted: two sections, monochrome source glyphs without circular fills, restrained separators instead of card shadows, source/time metadata, neutral selection, a desktop detail pane and explicit phone Back, and one deduplicated badge. Deferred suggestions that would introduce duplicate approval transports, new snoozing semantics, or speculative keyboard shortcuts: actions route to existing owning workflows.

## Data and state rules

- Use the existing live center, pending questions, approvals, current check-in, and execution snapshot queries. No second notification feed.
- The footer and page use one projection of those sources. A live question/check-in/approval and its delivery notification count once.
- Keep different questions on the same work distinct. Do not deduplicate by title or broad work identity across unrelated event types.
- Routine question deliveries merge only through their exact routine-and-date run identity; separate days and consent questions remain separate.
- A late read must never downgrade acted/dismissed status. Repeated reads preserve the original read timestamp.
- A question attached to put-down work stays reachable without demanding attention from the badge.
- Keep filters, selected item, and list scroll across destination visits, scoped to the signed-in user. Store only view state, not notification contents.
- Render failed read/dismiss operations inline; do not infer resolution or hide outstanding work.
- Known Area, Work, and view links use direct shell state actions. Routine task notifications retain their Area context even though their delivery type is `brief_ready`.
- Restoration waits for actual query results, survives a stale selected item, and observes the list becoming visible after phone-detail or breakpoint changes. A delayed dismissal cannot close a newer selection.

## Verified implementation

Focused run: 41 passing tests across `notifications-workspace`, `notifications-mark-runtime`, notification schema compatibility, daily-report notification delivery, mobile notification response routing, and Albatross Wave A surfaces. Biome passes for all nine Notifications implementation, fixture, and test files.

Synthetic browser run uses the real `NotificationsView`, current application CSS, and local-only fixture data. It passes at 390, 768, and 1440 pixels in light/dark appearance with no horizontal overflow or browser errors. Verified arrow/Enter/Escape behavior, phone Back and focus return, read-versus-resolution counts, read/dismiss failure and retry, delayed-dismiss selection safety, retained filter/selection/scroll, async data restoration, stale selections, and phone-to-desktop restoration. Screenshot artifact directory for this run: `/tmp/albatross-notifications-ui-WeSTjS`.

The existing query bounds remain explicit: 100 recent deliveries, up to 100 pending questions, and up to 200 pending approvals. The page and footer use the same projection and bounds. Activity remains the history destination; this round does not introduce an independently paginated historical feed. No real-account notifications were read, resolved, dismissed, or sent during synthetic verification.

## Verification targets

Deterministic projection tests for duplicate deliveries, multiple questions, closed work, check-in resolution, unread counts, and terminal statuses; Convex mutation tests for ownership and stale reads; browser checks using synthetic data for arrow/Enter/Escape, mobile Back, retained list position/filter, error retry, section counts, and narrow/dark layouts. Signed-in staging smoke must only observe unless separately authorized to mutate real notifications.
