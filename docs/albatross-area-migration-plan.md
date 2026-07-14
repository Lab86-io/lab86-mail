# Albatross Area Migration Plan

Last updated: 2026-07-09

## Scope

This increment moves pre-Albatross mail into the post-Albatross area model without deleting or rewriting the original corpus. It also makes Personal a guaranteed system area, adds area branding for images and favicons, routes new intent capture into an area, and gives users a manual area-brief refresh.

Claude Opus sub-agent note: the project contract normally requires an Opus UI sub-agent for Albatross UI work. The user explicitly asked to skip only that requirement and do the UI directly, while still doing the rest of the contract: Mobbin research, Browserbase/browser research, screenshots/browser verification, user stories, tests, and screen fit.

## Product Grounding

Mobbin references used:

- Plane project/workspace sidebar/home: project spaces are first-class destinations, not a separate planning island.
- Jira project sidebar/home: project summary, shortcuts, and work queues live together inside the project context.
- Obvious sidebar/activity: the left rail can carry small brand marks without becoming noisy.
- Cloudflare and Arcade refresh/dashboard/report screens: refresh controls are quiet commands in context, close to the report they update.
- Pinterest image cards: image support matters most when it identifies the object or area, not as decoration.

Browser-based references used:

- Linear Projects and project updates: project work is organized around the project surface, with updates as a native part of that surface.
- Notion connected project management: tasks, docs, and meeting notes belong together in the project context.
- Asana project status updates: status/brief content should be triggerable and readable where the project work already lives.

## User Stories

- As a returning user with old mail, I want my historical corpus categorized into areas so the new area briefs are immediately useful.
- As a user with mixed personal and work mail, I want a Personal area to always exist, but I want to rename it to match my own language.
- As a user capturing an intent, I want Albatross to place it into the right area when obvious and ask me when it is not obvious.
- As a user reading an area brief, I want a manual refresh so I can pull in recent corpus or area-fact changes without waiting for the cron.
- As a user scanning the sidebar, I want recognizable favicons or images for areas so I can navigate by shape and brand, not just text.

## Data Model

Additive fields on `areas`:

- `primaryDomain`: the canonical domain associated with the area, normalized from a URL, email address, `@domain`, or plain domain.
- `faviconUrl`: an optional icon URL. When omitted, the UI derives one from `primaryDomain`.
- `imageUrl`: an optional larger image used in area reports and area management surfaces.

System area:

- Personal has stable `externalId = "system:personal"`.
- Personal is created or revived by user-facing area reads/writes and intent creation.
- Personal cannot be archived. Its name is editable, so the user can rename it without losing the system fallback.

## Migration and Backfill

The migration is intentionally additive:

1. Ensure Personal exists for the user.
2. Load all active areas and all candidate/verified area facts.
3. Build deterministic match keys from facts of kind `domain`, `website`, `url`, `email`, `sender`, and area `primaryDomain`.
4. Page through all `mailCorpusThreads` for the user.
5. For each thread, match sender email/domain to an area fact first.
6. Insert a supporting `mailThread` area link for deterministic matches.
7. If no match exists and no active area has already claimed the thread, insert a low-confidence candidate link to Personal.
8. Do not delete, downgrade, or churn existing non-rejected links.
9. Continue in scheduled pages until the full corpus is scanned.

Verified links are only created when the source fact already has a valid `userConfirmation` ref. Otherwise the backfill creates candidate links, even from verified-looking evidence.

## Reindex Triggers

The full historical reindex is queued by:

- creating, updating, or archiving an area;
- adding, verifying, rejecting, or superseding an area fact;
- manual "Refresh brief" from an area;
- manual "Reindex" from area settings;
- mail corpus incremental upserts;
- the final ready state of mailbox backfill.

Backfill pages before `corpusReady` do not each queue a full historical sweep. That avoids many duplicate full-corpus jobs while the mailbox import is still walking backward. The ready transition queues the complete sweep.

## UI Fit

- Area rail rows show a favicon/image mark when available and fall back to the existing categorical dot.
- Area brief headers and report rows support image/favicons without adding decorative cards.
- Intent capture keeps the primary text dump flow, then shows area chips and a compact overflow picker. If Albatross cannot infer an area and multiple areas exist, save is blocked until the user chooses one.
- The manual brief refresh is a small in-context button in the area header. It queues a reindex rather than pretending the report is immediately complete.
- Area settings supports rename, primary domain, image URL, archive, and full reindex in the same management list.

## Rollout Checks

- Run Convex codegen so the new public and internal functions are available to the client bundle.
- Run focused pure tests for domain parsing, favicon derivation, branding precedence, and intent area suggestion.
- Run `bun run lint`, `bun run typecheck`, and the relevant Albatross tests.
- Use browser preview screenshots for desktop and mobile area surfaces. If auth blocks local data inspection, record that limitation and rely on code/test verification plus protected-route load checks.
- Push `staging`; Railway/staging should deploy from the branch as usual.

## Verification Notes

2026-07-09 local/browser pass:

- T3 preview tools were present, but `preview_status` and `preview_open` returned `PreviewAutomationNoAvailableHostError`.
- Browserbase created a session and navigated to the local dev server successfully.
- With basic auth enabled, the app returned the expected staging basic-auth challenge.
- With the safe local basic-auth bypass enabled, `/settings?tab=areas` reached the app and redirected to Clerk sign-in for a signed-out browser.
- Local screenshot capture was unavailable because the installed `chromium` and `google-chrome-stable` commands are wrappers pointing at a missing `/home/jjalangtry/repos/cardhunt/scripts/vhs-browser.sh`.
- Authenticated area UI screenshots could not be captured from this environment; coverage comes from code review, data-fit tests, lint, typecheck, full test suite, Browserbase reachability, and protected-route auth behavior.
