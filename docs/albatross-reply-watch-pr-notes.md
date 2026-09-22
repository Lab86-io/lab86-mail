# Waiting for a reply and reliable progress saves

An Albatross can now be put on hold from its existing chat: “I sent Jolie an email; I can’t move this forward until she replies.” The agent finds the sent thread and passes `waitingForReply` to `albatross_record_progress`. The report, waiting state, expected sender, requirement and cutoff are saved in one transaction. This does not depend on a generated plan containing an email-confirmation step.

Before composing each brief, the server pages through synced mail received after the watched outbound message. It checks read and archived mail as well as inbox mail. New-thread replies from the expected sender are eligible. A relevance check must find the substantive answer the user is waiting for; sent copies, old messages, different accounts, unrelated senders, automatic acknowledgements and mailing lists do not reactivate the work. A failed relevance check leaves the watch intact for retry.

A matching reply atomically records mail evidence, returns the work to active/now, and makes the reply available to the same brief. A stale scan cannot override a pause, completion or replacement watch. Reply receipt resumes the outcome; it never marks the whole outcome completed. The existing scheduled mail watcher also processes these watches between briefs.

## Reliability changes

- User-reported partial progress no longer runs the outcome-proof auto-completion path or loads the entire generated document before saving.
- Optional evidence is validated separately, so a missing mail account does not discard the authoritative report.
- Optional question writes and final UI refresh failures return saved progress with explicit warnings. Failure of the authoritative transaction still returns a failure.
- Question updates are checked against their expected Work, and waiting/paused Work is not automatically replanned after a chat turn.
- An explicit reply watch suppresses planning questions and stored brief action prompts until the reply arrives. Questions remain saved and become available again on resumption.
- Replay deduplication and compare-and-set checks prevent duplicate proof and stale state changes.

## Existing product flow

Reviewed the attached chat, Work context, existing progress receipt, Waiting state, recovery actions, step watcher, Work orchestration and daily brief composition. This change uses those existing surfaces and their design system; it adds no new screen, layout, component or styling. Mobbin MCP is not available in this session. No materially redesigned UI surface was introduced.

## Evidence and limits

The screenshot's request IDs were not present in retained Convex logs. The exact historical exception is therefore unconfirmed; the regression cases demonstrate the specific failure paths addressed here, rather than attributing an unavailable stack trace to one cause.

Matching depends on mail being synced into the corpus and the relevance service being available. The watch survives temporary failures. This implementation requires the Convex schema/functions and web application to be deployed together, with the existing cron authentication configuration present. Local work does not retrofit a watch onto a historical failed chat turn.

## Validation

Integration coverage includes atomic capture, replay deduplication, multi-page mail scans, new-thread and archived replies, same-edition brief context, tenant/account isolation, sent/old/automatic/unrelated message rejection, model failure and retry, pause races, and question ownership. Tool tests cover successful waiting receipts, optional evidence/question/refresh failures, failed authoritative saves, and replanning guards.

Full Bun suite: 4,158 passed, 1 existing skip, 0 failures across 435 files. TypeScript passed. Biome passed on the changed TypeScript files, and `git diff --check` passed. No deployment was performed.
