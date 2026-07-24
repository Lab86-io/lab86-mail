# Daily Brief Handoff — Product Research Notes

Date: 2026-07-24
Change: SBAR-inspired attention index and action-first Daily Brief

## Product decision

Use the omission-resistant structure of SBAR without exposing clinical terminology. SBAR is the
canonical brief-time index across mail, tasks, calendar, Areas/Work, and connected tools—not a
mail-card decoration. Actionable cards use the existing Albatross editorial language:

- **Why now**
- **Relevant trail**
- **My read**
- **Your move**

The recommendation remains visible in the collapsed card. Supporting provenance is available through
one inline `Why this?` disclosure. Drafting remains review-gated.

## Backbone and lifecycle

The durable flow for each report edition is:

`source stores → atomic SBAR items → dedupe/merge cycle → canonical SBAR index → brief projections`

- Source stores remain authoritative for mutable state. The index does not copy ownership of task
  completion, thread resolution, event state, or Work state.
- Each saved report edition carries its validated SBAR index so the reasoning and source trail are
  inspectable later.
- Old report editions derive the index during read migration.
- Model-authored and deterministic briefs both consume the same index. Raw source arrays are
  supporting evidence and draft context, not a second independent triage pass.
- Protected records (reply owed, follow-up owed, tracked, overdue/high-priority tasks, imminent
  events, and explicit Area/context decisions) are structurally restored if a model omits them.

## Deduplication and merging

The merge cycle is deliberately conservative:

1. Collapse exact source identities, including one mail thread appearing in reply and tracked lanes.
2. Merge records only when a source relationship proves relevance:
   - task → source mail thread;
   - task → source calendar event;
   - Work/intent/project/context item → Area.
3. Keep unrelated records separate even when titles look similar.
4. A merged SBAR retains each atomic member, every source reference, distinct recommendations, and
   source-specific actions. The aggregate card may therefore show several “Your moves.”

This avoids model-only semantic grouping that would be difficult to explain or safely undo. A later
semantic merge stage can be added only if it emits explicit evidence and passes the same validator.

## References inspected

### AHRQ TeamSTEPPS — SBAR

<https://www.ahrq.gov/teamstepps-program/curriculum/communication/tools/sbar.html>

Useful pattern: a handoff has a predictable location for the assessment and the requested next
action. Lab86 adopts the fixed content guarantee, not the medical labels or visual form.

### Front — inbox thread

<https://mobbin.com/screens/e1fbb598-ea2f-4f28-b02c-0af2e870e250>

Useful pattern: status history, ownership, source conversation, and reply action remain in one
context. Lab86 keeps the action adjacent to the recommendation and keeps the source thread one action
away.

### Manus — meeting artifact

<https://mobbin.com/screens/e9e539af-f2c1-46e8-893d-c2d39082600b>

Useful pattern: summary, decisions, action items, and suggested follow-ups have distinct semantic
roles instead of becoming one paragraph. Lab86 gives assessment and recommendation separate
hierarchy while keeping the default card compact.

### Notion Mail — reply flow

<https://mobbin.com/flows/9523fb63-69fb-4c05-a2e6-35f341224c41>

Useful pattern: reading, replying, sent state, and undo remain in the thread context. Lab86 uses the
existing review-gated draft action and never sends from the brief.

## Existing flow inspected

- Legacy structured Daily Report rows in `components/report/DailyReport.tsx`.
- Typed web Brief Document renderer in `components/report/brief-canvas/BriefNodeView.tsx`.
- Native Brief Document renderer in
  `apps/ios/Lab86Mail/Features/Today/BriefDocument/BriefDocumentView.swift`.
- Shared Brief Document v2 validation/repair in `lib/shared/brief-document.ts`.
- Daily report priority floor, enrichment, tracking, and assembly in `lib/mail/daily-report.ts`.
- Agent-authored Brief Document generation in `lib/mail/agent-report.ts`.

## Fit with the Albatross design system

- Preserve current card density and semantic theme tokens.
- Use existing typography, border, muted-fill, disclosure, and action primitives.
- Do not add a new modal for explanation.
- Do not create a new node kind when an additive entity handoff can preserve old-client degradation.
- On iOS use native `DisclosureGroup`, semantic fonts/colors, Dynamic Type-friendly text, and the
  existing review action flow.

## Explicit non-goals

- Files and document ingestion.
- Plaid or finance integrations.
- Opportunity-cost coaching.
- Automatic sending.
- Provider/sync changes.
