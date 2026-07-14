# Albatross living-assistant research

Date: July 14, 2026

This increment was implemented directly in the repository at the user's request. The normal Claude/Opus handoff in the Albatross development contract was explicitly stopped. The design work below is grounded in fresh Mobbin and browser-based product research.

## Product premise

Albatross is an intent and evidence layer over a person's mail, calendar, tasks, connected tools, conversations, and explicit answers. It should not pretend that activity is intent or that an observed event proves completion. It should ask small, timely questions; remember the answer; and use accumulated evidence to make future classification, plans, and briefs more accurate.

Areas are the durable contexts in which that loop happens. Projects and epics are multi-week outcomes inside an Area. Routines are recurring commitments attached to an Area or project. Tasks are concrete actions. Generated briefs are living, scoped HTML artifacts rather than static dashboards.

## Mobbin references

### Project overview and living status

- [Linear project overview](https://mobbin.com/screens/e88b6bd7-3d4b-4e1e-8cd7-a9d2a6852795)
- [Linear project details](https://mobbin.com/screens/21868ab4-8721-4702-a824-ac4844e87dda)
- [Linear project progress](https://mobbin.com/screens/0071bd9c-a406-499a-bc4b-b0f3ea07c631)
- [Linear project activity](https://mobbin.com/screens/649fcb71-a33d-420b-aa0f-aecb25070e13)

The strongest pattern is a restrained document-like center with compact properties, progress, milestones, and updates nearby. Activity supports the outcome instead of becoming the outcome. Albatross should use a compact project pulse rather than a second task dashboard.

### Area-scoped inbox

- [Notion Mail category view](https://mobbin.com/screens/fcbc3ac5-67b3-4732-bb12-999172202799)
- [Notion Mail inbox](https://mobbin.com/screens/cdc3f16d-f403-44ed-ac9b-f83e5a9e7168)
- [Twist thread list](https://mobbin.com/screens/40fc324f-05d7-4fc9-a8c9-bd165aa9d8bf)
- [Twist channel inbox](https://mobbin.com/screens/2961167e-6c44-4495-9deb-303f121c3597)

These examples favor a readable, dense message list and very small view controls. Categories behave as views, not decorative cards. The Area inbox therefore uses only the local distinctions that matter and leaves universal views, such as Codes, at the global mail level.

### Recurring work and reminder consent

- [Todoist natural-language scheduling](https://mobbin.com/flows/830c959f-d3c3-4cc7-9fea-e79be143fb00)
- [Todoist recurring scheduling](https://mobbin.com/flows/74a4971c-4007-40d6-8319-1f9ce028b221)
- [Todoist reminder setup](https://mobbin.com/flows/3775c8ec-f7db-44e3-8459-db33e1abd131)

Recurring behavior should start from a compact, natural-language commitment and reveal scheduling details progressively. Notification channels require explicit consent. A routine may create work before notification consent, but Albatross must ask before starting an ongoing notification cadence.

### Personal logging and goals

- [Yazio daily diary](https://mobbin.com/flows/9359cf60-bd54-4488-912a-c6365b32b76f)
- [Fitbit food detail](https://mobbin.com/flows/5cf2f957-cc5d-456e-849e-1cbd73c7204c)
- [MyFitnessPal Today](https://mobbin.com/flows/c7d3b0bb-5381-4a07-920a-0a0a36e8226e)

Personal goals work best as a today-first log with one obvious entry action, a short weekly trend, and progress language that does not imply unsupported precision. Albatross can estimate calories or progress only after asking and should preserve the user's original answer as provenance.

## Browser-based references

- [Linear initiative and project updates](https://linear.app/docs/initiative-and-project-updates)
- [Linear project milestones](https://linear.app/docs/project-milestones)
- [The next generation of Linear projects](https://linear.app/changelog/2024-05-02-the-next-generation-of-linear-projects)
- [Behind Linear's design refresh](https://linear.app/now/behind-the-latest-design-refresh)
- [Linear project progress reports](https://linear.app/changelog/2023-08-16-project-progress-reports)
- [Todoist recurring dates](https://www.todoist.com/help/articles/introduction-to-recurring-dates-YUYVJJAV)
- [Todoist reminders](https://www.todoist.com/help/articles/introduction-to-reminders-9PezfU)
- [GitHub Projects overview](https://docs.github.com/en/issues/planning-and-tracking-with-projects/learning-about-projects/about-projects)
- [GitHub project items API](https://docs.github.com/en/rest/projects/items?apiVersion=2022-11-28)
- [Apple Reminders smart lists](https://support.apple.com/guide/iphone/use-smart-lists-iphe882772ed/ios)
- [Apple Reminders custom smart lists](https://support.apple.com/guide/reminders/create-custom-smart-lists-remnfec66479/mac)

## Decisions for this increment

1. **Brief and Inbox are sibling views.** The generated Area brief remains the primary whole-canvas artifact. Inbox is a small switch away and is scoped to evidence already filed into the Area.
2. **The brief stays creative but honest.** It may render charts, timelines, evidence meters, and interactive Tool UI controls, but every claim must preserve provenance and confidence.
3. **Questions are a queue, not a form stack.** Show one compact question at a time, reuse shared Tool UI controls, never render two confirmation affordances, and deduplicate semantically equivalent open or answered questions.
4. **Routines are durable primitives.** A project can own recurring tasks and check-ins. Each scheduled occurrence has an idempotent run record. Notifications have explicit consent and timezone-aware delivery.
5. **Evidence compounds.** Explicit answers and verified facts are strongest. Commits, mail, calendar events, task changes, and inferred classifications are supporting signals. Repeated corroboration strengthens an index without converting activity into certainty.
6. **Area identity is useful, not ornamental.** Prefer a user image, then a discovered favicon, then initials. Web research may propose a domain or organization description as a candidate, but cannot silently verify it.
7. **Depth must read clearly.** The dot grid belongs to the environmental background. Foreground columns and cards occlude it, with higher-opacity surfaces and the existing display typography inherited inside generated artifacts.

## Verification target

Focused tests cover evidence weighting, routine scheduling/idempotency, question deduplication, upload validation, and GitHub normalization. The final pass also runs lint, typecheck, the relevant integration tests, the full test suite, a production build, and a collaborative-browser visual review at desktop and mobile breakpoints.
