# Albatross Area Brief fit pass

Date: 2026-07-09

Model/process note: the user explicitly overrode only the Claude Opus sub-agent
requirement for this follow-up and asked Codex to do the UI work directly. The
rest of the Albatross development contract still applies here: fresh Mobbin and
Browserbase research, user stories, focused tests, and browser verification.

## User stories

1. As someone opening Areas, I can tell which area needs attention without
   reading every area name or opening each one.
2. As someone with many active threads/tasks, I can still read the selected
   area brief above the fold because each section fits to a deliberate row cap.
3. As someone acting from an area, every overflow or action takes me to a real
   deeper surface: Plans, Inbox, Calendar, Board, Settings, or an external map.
4. As someone teaching Albatross, I can see suggested context in the side
   dossier without it displacing live work.

## Mobbin research

- [Asana project overview](https://mobbin.com/screens/e0675f3e-421a-440e-91f9-0c02ca427b8e):
  the central column is connected goals/resources/milestones, while a right rail
  carries status updates and membership activity. Takeaway: the selected Area
  Brief should have a main work stream plus a compact side dossier, not two
  equally weighted piles.
- [Linear project overview](https://mobbin.com/screens/e88b6bd7-3d4b-4e1e-8cd7-a9d2a6852795):
  title, description, properties, resources, latest update, progress, and
  activity are arranged as a project document with a right-side details rail.
  Takeaway: put the area headline/properties at the top and keep projects,
  places, and context as a rail.
- [Notion Home](https://mobbin.com/screens/8b381727-1836-4188-ae2f-2be7b6566162):
  the home page leads with recently touched objects and personal tasks rather
  than a generic directory. Takeaway: the Areas chooser should rank and label
  areas by current work, not just show context counts.
- [Basecamp home](https://mobbin.com/screens/6180cb2b-33d4-4a47-a770-4dea29e80697):
  Basecamp treats work as places with pings, schedule, assignments, and recent
  visits. Takeaway: places are useful as launchable area context, but they are
  secondary to blockers, plans, and scheduled work in this product.

## Browserbase research

- Browserbase search + extraction on
  [Linear project overview docs](https://linear.app/docs/project-overview):
  project overview groups summary, editable properties, external resources,
  documents, milestones, updates, graph/progress, and activity. This supports a
  compact area lead plus a dossier rail.
- Browserbase search + extraction on
  [Asana project overview help](https://help.asana.com/s/article/how-to-use-the-project-overview-tab):
  overview acts as a central hub for description, roles, goals, resources,
  milestones, and status updates, with links out to deeper project work.
- Browserbase search + extraction on
  [Notion projects and tasks guide](https://www.notion.com/help/guides/getting-started-with-projects-and-tasks):
  projects and tasks stay linked through properties and multiple views, so a
  single workspace can show status while still offering table/board/timeline
  destinations.

## Implementation choices

- `listAreasOverview` now returns bounded work counts for area cards:
  artifact links, active intents, active/paused projects, and area-board tasks.
  Full row resolution still happens only when opening one area.
- Area cards now sort by a tested priority score and show compact badges for
  blockers, plans, events, tasks, mail, projects, suggestions, and context asks.
- The selected area gets a deterministic daily-brief lead with a headline,
  properties, and pulse before capture.
- The selected area layout changed to a main work stream plus side dossier:
  Plans, Events, Mail, and Tasks stay central; Projects, Places, and Context sit
  in the side rail.
- Sections use tested row caps with explicit overflow rows that point to real
  surfaces instead of stretching the brief into an unbounded dashboard.

## Browser verification

Browser pass on 2026-07-09:

- T3 preview: `preview_status` returned `PreviewAutomationNoAvailableHostError`
  and the exposed T3 tool list did not include `preview_open`, so T3 screenshots
  were unavailable in this session.
- Browserbase: successfully reached the local Next dev server at the network
  URL, but the route rendered `Authentication required.` before the private
  Areas surface mounted. This confirms reachability and the auth gate, but it
  does not provide a live authenticated screenshot of the Area Brief.
- Screenshot tooling: the local `chromium` / `google-chrome` commands are shell
  wrappers pointing at a missing `cardhunt` script, and Browserbase did not
  expose a screenshot artifact tool. No useful screenshot artifact could be
  captured from this environment.

What was verified instead:

- Browserbase extraction found no overlap/clipping on the auth gate.
- `bun test tests/albatross-area-home.test.ts` covers the real data-fit rules:
  chooser priority, chooser badges, selected-brief headline, and row capping.
- `bun run typecheck` and `bun run lint` validate the actual React/Convex wiring.
