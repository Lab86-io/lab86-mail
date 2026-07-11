# Albatross Work v2 UI research

Date: 2026-07-10

The implementation was written directly in Codex at the user's explicit request. The repository's earlier
Claude/Opus handoff was stopped. This is a user-directed exception to the original UI-generation clause;
the remaining research, design-system, test, and verification requirements were retained.

## Existing product baseline

The current Albatross UI already records Mobbin grounding in its source and prior research notes:

- Linear project overview: plan-as-document hierarchy, quiet metadata, progress rather than dashboard cards.
- ClickUp Home and Asana Home: dense, meaning-first work groups with inline capture.
- Notion Home: one calm capture/ask entry rather than separate chatbot chrome.
- Intercom/Pipedrive review queues: compact rows with one clear next action.

Mobbin's public search did not return inspectable screens in this environment during this pass, so no new
screen IDs are claimed beyond the existing repository research. The implementation keeps those established
patterns instead of inventing unsupported references.

## Browser references

- [Linear Inbox](https://linear.app/docs/inbox): one notification center for work needing attention, with
  direct deep links and read/dismiss actions. This informed the unified bell surface and compact row actions.
- [Linear notification settings](https://linear.app/docs/notifications): channels are configured separately;
  email is delayed and suppressed when the in-app item is read. This supports Albatross's in-app-first,
  opt-in Web Push, delayed-email model.
- [Linear project updates](https://linear.app/docs/initiative-and-project-updates): project progress and current
  update belong on the project overview; reminders use the user's local schedule. This informed distinct
  Project/Epic rows and local-time check-in settings.
- [Notion Inbox and notifications](https://www.notion.com/help/updates-and-notifications): the inbox gathers
  changes across the workspace, deep-links to the relevant object, and supports read/archive actions. This
  reinforced keeping questions, approvals, check-ins, and updates together.

## Decisions applied

- Plans has no navigation destination. Legacy `intents` navigation normalizes to Areas.
- Area is a living brief followed by Needs you, Projects/Epics, active Work, waiting/blocked Work, recently
  done Work, then supporting calendar/tasks/mail/context.
- Opening Work replaces the Area body. The Work page shows desired outcome, one question, Project/Epic
  progress, created actions, undo, complex brief, assumptions, and sources.
- The same Albatross chat surface switches among global, Area, and Work scopes and persists histories with
  the scope fields already supported by `/api/chats`.
- The highest-value pending question follows the user in a compact companion. Document Picture-in-Picture
  is explicit and never opens automatically.
- Completion stays user-verified through an evening check-in. Inferred items are selectable suggestions,
  and unanswered prior-day state remains live above the Daily Brief artifact.
- Notification permission is requested only from Settings after an explicit Web Push enable action.

## Design-system fit

The work reuses the existing Geist/Fraunces hierarchy, OKLCH tokens, thin dividers, dense rows, responsive
shell, Radix primitives, focus styles, reduced-motion behavior, and existing artifact sandbox runtime. It
avoids a new card-grid visual language, decorative gradients, fake metrics, and profession/company-specific
examples.
