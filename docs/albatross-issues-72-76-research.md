# Albatross Issues 72-76 Research And Implementation Note

Date: 2026-06-30
Branch: `albatross/issues-72-76`
Base: `staging`

This note records the required research and workflow evidence for the batched implementation of issues
#72, #73, #74, #75, and #76. The standing rules remain in `docs/albatross-development-contract.md`.

## UI Implementation Contract Followed

- UI work was delegated to Claude Code with model `claude-opus-4-8`.
- The sub-agent prompt included the issue range, target files, full UI scope, existing design-system constraints,
  Mobbin research requirement, Browserbase research requirement, and tests/no-regression requirement.
- The Opus run was tool-enabled and long-running. It implemented the UI, audited imports, and ran focused
  checks before the final manual interruption after the last bug fix had landed.
- The implementation uses existing local primitives such as `Dialog`, `Textarea`, `Tooltip`, and `Button`.

## User Stories

- As a user, I can set up an area by adding responsibility context, people, domains, repos, tools, calendars,
  and accounts without answering demographic questions.
- As a user, I can triage an unassigned item and see exactly what context will be learned before committing.
- As a user, I can trust area assignment because verified signals, candidate signals, noise demotion, and
  unassigned routing are explicit.
- As a user, I can inspect an area through practical lenses: replies, open loops, tasks, events, files/links,
  people, and noise.
- As a user, I can dump a thought quickly from anywhere in Albatross, by text or voice, and decide whether
  one raw dump should split into multiple intents.

## UX Shape

- Setup is resumable and skippable by area. It starts with the responsibility question, then captures concrete
  context types. People remain candidates until the user confirms them.
- Review is an inbox-style triage workflow. The queue is separate from the decision preview, and every action
  describes immediate effect plus future classification behavior.
- Classification is deterministic in this increment. It returns one primary area, rare secondaries, or
  Unassigned when confidence is low.
- Area lenses reuse the same artifacts instead of inventing page-specific widgets. Each item carries status and
  correction affordances only where correction is meaningful.
- Capture is a floating bottom-left action to avoid the existing bottom-right AI bar. The dialog preserves raw
  text first, offers voice when supported, and asks before splitting multi-intent dumps.

## UI Grounding

Mobbin flows used by the batch or the Opus sub-agent:

- Motion onboarding/personalization: https://mobbin.com/flows/c5800506-3655-4982-ab3c-dd9d233bcebe
- Sana AI setup: https://mobbin.com/flows/b01ccb8a-7fdb-47a8-8169-70cbf0c9f60a
- Amie workspace creation: https://mobbin.com/flows/313ec1b8-3d78-43fb-86ba-b57a2d8ef672
- Fibery onboarding: https://mobbin.com/flows/29fb7c78-a121-4e97-8f6d-ea12fa4a340b
- Productboard onboarding: https://mobbin.com/flows/54bce0a9-613c-4770-85e0-92c09b001e90
- Gamma onboarding: https://mobbin.com/flows/8e0065e3-76f8-476d-8da5-c8a4017a7093
- Graphite inbox: https://mobbin.com/flows/dece24f9-9579-4c71-a5ef-24c6b74ec39b
- Lemni inbox: https://mobbin.com/flows/4489285d-8089-488b-bd8d-cc2cd3fa8b63
- Graphite section reordering: https://mobbin.com/flows/0318e5e9-660f-4913-a69b-eae79889fae2

Additional Mobbin references cited during the Opus run:

- Lemni inbox/triage: https://mobbin.com/flows/aa0237cc-055c-45ef-8355-3ca33a1529b2
- Apollo setup/domain chips: https://mobbin.com/flows/e5dc880b-7a7e-4a66-8cfb-f04bfb6ae814
- Hootsuite onboarding: https://mobbin.com/flows/9becd38a-0d58-4db3-9e8f-1da0607e9f9e
- Gorgias support triage: https://mobbin.com/flows/58eb8552-710e-47b3-9a5c-9e43f178a6f3
- Front triage: https://mobbin.com/flows/b665d037-901c-4022-a859-c94cb8b0962b
- Jira lens/tabs: https://mobbin.com/flows/102db23b-400f-4039-b62f-76b64fbf72e2
- Slite lens/tabs: https://mobbin.com/flows/26a2131c-1b0f-4d51-9069-5fa5fe11cbcf

Browserbase article research:

- NN/g dashboard design: https://www.nngroup.com/articles/dashboard-design/
- NN/g AI paradigm: https://www.nngroup.com/articles/ai-paradigm/
- UX best practices for AI/ML dashboards: https://thefinch.design/ux-best-practices-ai-ml-data-visualization-dashboards/
- AI dashboard design for SaaS teams: https://www.eleken.co/blog-posts/ai-dashboard-design
- AI dashboard design for real-world users: https://launchpad-design.co.uk/ai-dashboard-design/
- Designing AI dashboards users trust: https://www.letsgroto.com/blog/ai-dashboard-design

Browserbase YouTube search grounding:

- Still Designing Dashboards Like This? UX Tips for 2026: https://www.youtube.com/watch?v=6DpVGHXn88Q
- Uncovering the Secrets of Dashboard Design: https://www.youtube.com/watch?v=vqCwwC_nRjU
- 12 Dashboard design tips for better data visualization: https://www.youtube.com/watch?v=t3cAUt7sOQg
- UX/UI and BI: Turning Design Into Value: https://www.youtube.com/watch?v=Kcmkm4Jh3bY
- Embedded Analytics Done Right: https://www.youtube.com/watch?v=-EuPiGUeDXc

## Slop Avoidance Constraints Applied

- No marketing hero layout. The first screen stays an operational surface.
- No icon before every line of text. Icons are reserved for controls, lens identity, or compact artifact type cues.
- No uppercase letter-spaced labels as a decorative default.
- No fake AI magic copy. Context status, confidence, and future effects are explicit.
- No silent learning. Candidate people and relationship facts require confirmation.
- No overlapping floating actions. Intent capture sits bottom-left; the existing AI bar remains bottom-right.
- No isolated one-off primitives when existing shadcn-style app primitives exist.

## Verification Expectations

Before this branch is review-ready:

- `bun test tests/albatross-surfaces.test.ts tests/albatross-seed.test.ts`
- `bun run lint`
- `bun run typecheck`
- Local browser check of Areas, Intents, Unassigned, setup dialog, review decisions, lenses, and capture dialog.

The PR must target `staging`, reference `Resolves #72`, `Resolves #73`, `Resolves #74`, `Resolves #75`,
and `Resolves #76`, move all five project items to In review, request CodeRabbit, and keep tests green while
addressing review comments.
