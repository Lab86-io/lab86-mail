# Albatross Issues 81-85 Research

Branch: `albatross/issues-81-85`

Standing contract: `docs/albatross-development-contract.md`. UI work must be performed by an Opus `claude -p` sub-agent after Mobbin and browser-based research.

## Mobbin Grounding

- GitHub project/issue/kanban screens:
  - https://mobbin.com/screens/021aca12-f736-4027-a089-2a1c0b57ef61
  - https://mobbin.com/screens/ac475fa0-8f46-4610-8956-9e03ac9df84b
  - https://mobbin.com/screens/4cf76327-af7d-4781-ae36-f571cdb2ed27
- Linear project overview screens:
  - https://mobbin.com/screens/5fd778b9-00c2-4f40-a7b6-bab9c6cdd6d8
  - https://mobbin.com/screens/52e2f6c6-9192-4ab8-a344-cb93c1f5e2ef
  - https://mobbin.com/screens/1f5446d3-7b62-4d15-bb6e-ab2cf2385727
- Workflow approval/review screens:
  - https://mobbin.com/screens/6f9bbbc2-3e3b-49b0-8b97-8a7311a3bd45
  - https://mobbin.com/screens/b2164443-6d0d-4e10-860d-847b70faf4ca
  - https://mobbin.com/screens/04e2e147-5ff0-4a6f-8905-9580d7bda5de

## Browserbase Findings

- AI dashboard trust guidance emphasizes reviewability, visible provenance, clear confidence/limits, and an audit trail. Relevant results included Groto's June 5, 2026 article on trustworthy AI dashboards, Lazarev's June 3, 2026 AI dashboard trust patterns, Suhas Bhairav's June 12, 2026 AI agent dashboard approval article, TechTarget's June 4, 2026 audit-trail piece, and OpenNash's June 26, 2026 workflow dashboard article.
- Anti-slop references consistently warn against generic gradients, shallow cards, decorative icon repetition, ungrounded copy, and UI that hides the actual work state. The implementation should keep Albatross dense, inspectable, and tied to artifacts, operations, approvals, and sources.

## UI Direction

- Project pane: GitHub/Linear-style object page: outcome/status at top, linked issues/tasks/evidence below, activity/applications and approvals near the object, not a marketing dashboard.
- Approval queue: review workspace with source, risk, exact action, and approve/reject/undo affordances. Human-facing actions must be visibly different from safe applied artifacts.
- Task tabs: simple segmented tabs for Kanban, Areas, Projects, Sprints. Existing standalone tasks remain first-class.
- Daily Report: compact Albatross strip. Loud unknown areas ask before centering; active intents/projects show even when quiet.
- New Intent: bottom-center floating button stays visible and separate from Ask Assistant.
