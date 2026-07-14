# Claude Code Opus prompt — Albatross Work v2 UI

You are the required Claude Code Opus UI implementation agent working inside
`/home/jjalangtry/repos/lab86-mail` on branch `staging`.

Issue number: N/A — user-requested Albatross Work v2 implementation on 2026-07-10.
Record this limitation in the research summary. Do not commit or push.

## Product direction

Albatross is the verified intent layer across mail, calendar, tasks, Projects/Epics,
and future files. Artifacts are evidence, not intent. The user tells Albatross what
they are trying to get out of their head; Albatross asks one material question at
a time, researches in the background, and turns that declared intent into Work,
Projects/Epics, tasks, calendar events, drafts, briefs, and completion history.

Locked decisions:

- Daily Brief remains the default app home.
- A multi-goal brain dump splits automatically; the untouched capture is preserved.
- User-facing items are called Work. Plans remain versioned internal strategies and
  MUST NOT remain a standalone navigation destination.
- Work has one primary Area, optional related Areas, and can remain unassigned.
- Projects/Epics remain a distinct first-class primitive. Multi-week/multi-task Work
  may automatically become a Project/Epic grouping tasks and sprints.
- Area home is a living brief plus operational Work.
- Project/Epic rows are distinct from smaller Work and show progress/current sprint.
- Opening Work replaces the Area pane, with a clear Back to Area path.
- One Albatross voice has global, Area, and Work-scoped histories.
- One highest-value question follows the user in-app. Standard browser PiP is optional,
  never automatic.
- Safe private changes are created automatically and shown with undo. Human-facing or
  destructive changes remain approval-gated.
- Full editorial HTML briefs appear only for complex Work.
- Completion inference is evidence, not truth. Albatross asks what actually got done.
- End-of-day check-in defaults to 7:00 PM local, appears in an in-app notification
  center and opt-in Web Push, then sends fallback email after 90 minutes if unanswered.
- Check-in UI is an open reply plus selectable inferred Work/Project/task suggestions.
- If unanswered, yesterday's check-in appears in the next morning Daily Brief.
- Do not hardcode CardHunt, StatPearls, passport, tax, any profession, any company, or
  any personal workflow. Those may exist only in test fixtures.

## Existing backend contracts — inspect before editing

- `convex/schema.ts`: new `albatrossCaptures`, `albatrossWorkQuestions`,
  `albatrossAreaBriefs`, `albatrossNotifications`, preferences, subscriptions,
  deliveries, daily check-ins; Work v2 fields on `albatrossIntents`.
- `convex/albatrossWorkV2.ts`: `areaWork`, `workDetail`, `livePendingQuestions`,
  `answerQuestion`, Capture mutations.
- `convex/albatross.ts`: `areaHome` now returns `livingBrief` alongside live operational
  sections; use the cached lede/summary when ready without hiding live changes.
- `convex/albatrossNotifications.ts`: `liveCenter`, `currentCheckin`, `answerCheckin`,
  `getPreferences`, `savePreferences`, push subscription mutations.
- `app/api/albatross/capture/route.ts`: Capture -> Work splitting.
- `app/api/albatross/work/[workId]/advance/route.ts`: research/plan/auto-apply.
- `app/api/albatross/work/questions/[questionId]/answer/route.ts`.
- `app/api/albatross/checkin/route.ts`: manual check-in trigger.
- `app/api/albatross/checkin/[checkinId]/answer/route.ts`: free-text plus selected
  candidate reconciliation. DailyCheckin should submit here rather than writing
  completion state directly.
- `app/api/notifications/push/route.ts` and `/public/albatross-sw.js`.
- `lib/albatross/work-v2.ts`: pure Work/project/check-in helpers.

## Required UI work

You may edit/create:

- `components/albatross/AreaHome.tsx`
- `components/albatross/IntentCapture.tsx`
- `components/albatross/IntentPip.tsx`
- `components/albatross/TeachAreas.tsx`
- `components/albatross/WorkDetail.tsx` (new)
- `components/albatross/AlbatrossCompanion.tsx` (new)
- `components/albatross/DailyCheckin.tsx` (new)
- `components/shell/NotificationCenter.tsx` (new)
- `components/shell/AppShell.tsx`
- `components/shell/Rail.tsx`
- `components/report/DailyReport.tsx`
- `app/settings/page.tsx`
- `lib/client-state.ts`
- `lib/shared/types.ts`
- focused tests under `tests/`
- `docs/albatross-work-v2-ui-research.md` (required summary)

Avoid editing the backend contracts above unless a small type/interface correction is
strictly required for the UI to compile; document any such correction.

Implement these states and workflows:

1. Remove the visible Plans rail item. Persisted `primaryView: intents` migrates to
   Areas. Keep compatibility parsing only.
2. Add persisted `selectedWorkId` and transient open-work handoff. Selecting Work keeps
   `primaryView: areas` and replaces the Area body with `WorkDetail`.
3. Global capture uses `/api/albatross/capture`; it never blocks on Area selection and
   never navigates to Plans. After split, call each Work advance endpoint in the
   background and show a concise confirmation of how many Work items were created.
4. Area capture uses the same endpoint/advance flow and passes the current Area as
   `areaId` in the JSON body. Open the created Work and let backend inference continue.
   Do not restore a modal picker.
5. Area home ordering: living brief; Needs you; Projects/Epics; other active Work;
   waiting/blocked Work; recently done; then supporting calendar/tasks/mail/context.
   Reuse real Area read data. Do not fabricate progress.
6. Project/Epic rows remain visually and semantically distinct, show actual linked
   progress/current sprint where returned, and open honest existing deeper surfaces.
7. WorkDetail: back to Area, desired outcome/state, Project/Epic when linked, one active
   question, plan/complex artifact, created actions/live state, sources/assumptions, and
   scoped conversation entry. Reuse the existing plan artifact sandbox/runtime where
   practical; no standalone Plans route.
8. AlbatrossCompanion: highest-ranked pending Work question, compact and persistent.
   Answer through the answer API, then background advance. Offer optional browser PiP
   via an explicit control; no auto-open.
9. NotificationCenter: unified in-app center for check-ins, Work questions, approvals,
   suggestions, and updates. Live unread badge; read/dismiss/deep link. Preserve mail
   suggestions rather than deleting them.
10. DailyCheckin: free-text "What did you actually get done today?" plus selectable
    candidate items. Submit through `/api/albatross/checkin/[checkinId]/answer` so
    explicit natural-language completions reconcile safely. Morning carryover says yesterday.
11. Daily Report includes live Needs you/check-in/change state outside or alongside the
    cached editorial artifact so answers update instantly.
12. Settings adds notification preferences: enabled, timezone, 7:00 PM default time,
    in-app, Web Push opt-in/permission state, fallback email, delay. Register
    `/albatross-sw.js` only after explicit enable action.
13. Teach Areas becomes the same Albatross voice/scoped conversation concept, not a
    separate persona. Deterministic Area management remains available.
14. Mobile, light/dark, reduced motion, keyboard focus, screen-reader labels, loading,
    empty, error, retry, unsupported push/PiP, permission denied, stale/deleted Work,
    no Area, no Project, simple Work, complex Work, and unanswered check-in states.

## Design constraints

- Follow `docs/albatross-development-contract.md` exactly.
- Before implementation, inspect 3–8 current Mobbin examples for notification centers,
  daily review/check-in, project overview/progress, and AI contextual sidecars.
- Also perform browser-based research using current product/docs references.
- Preserve the existing dense editorial design, OKLCH tokens, Fraunces/Geist grammar,
  app density, rails, and responsive patterns.
- Avoid AI/vibe-code tells: generic gradients, card grids for everything, meaningless
  icons before labels, decorative copy, fake statistics, oversized marketing headings,
  excessive pills, nested cards, and one-note purple/blue.
- Use icons only when they communicate a known action/state. Visible copy is sentence
  case, concrete, short, and grounded in real data.
- Playfulness belongs in capture and subtle progress transitions; operational Work,
  questions, Projects, and notifications stay calm and inspectable.

## Verification

- Add/update focused tests for every state, data, routing, and migration contract.
- Run focused tests, `bun run typecheck`, and targeted `bun run lint`/Biome checks.
- Use T3 preview first for browser verification. If unavailable, try its open flow, then
  use the available browser research/verification route and record exact constraints.
- Capture desktop/mobile and light/dark evidence where tooling allows.
- Do not commit or push.

Finish with a concise report: research references/findings, UX decisions, files changed,
tests run, browser verification, and remaining constraints. Let the full Opus run finish.
