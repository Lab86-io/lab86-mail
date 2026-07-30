# Daily Brief cross-client Tool UI research

Date: 2026-07-27

## Goal

Extend the Daily Brief's semantic component vocabulary without turning the
edition into a dashboard of decorative widgets. The same document must produce
native, useful results on web and iOS.

## Mobbin searches

- iOS: daily planning dashboard with weather, calendar, priorities, progress,
  and one next action.
- iOS: email assistant message preview with excerpt, attachments, and quick
  reply or approval actions.
- Web: productivity dashboard with priority work, schedule, progress, tables,
  charts, and sources.
- Web: software release dashboard with build status, deployment progress,
  trends, code changes, and approval.
- iOS flow: review an AI-generated plan, inspect it, select an action, and
  confirm.

## Useful references

- [Timepage daily schedule and weather](https://mobbin.com/screens/01287266-ba8d-4a3c-af59-02600ee64df3):
  schedule and weather are separate, calm semantic bands; the forecast supports
  the day rather than competing with it.
- [Asana priority list on iOS](https://mobbin.com/screens/86316f70-3aba-4cd5-9b58-dcac0861f3f4):
  a wide table becomes a compact, horizontally constrained native list while
  preserving status and ownership columns.
- [Outlook email with suggested responses](https://mobbin.com/screens/0a6b0394-6009-4473-b072-e04a65f16e3b):
  the message stays primary and suggested actions sit immediately below it.
- [Gmail email with attachments and one-tap replies](https://mobbin.com/screens/ed639188-85c4-45c0-b641-945918e95c66):
  the preview contains enough real content to decide before opening the full
  thread.
- [Rox focus dashboard](https://mobbin.com/screens/62b4d10c-498e-49eb-bf78-3b944290f407):
  one dominant recommendation list is supported by a smaller agenda and task
  state instead of a uniform tile field.
- [ClickUp home dashboard](https://mobbin.com/screens/b529f546-bef5-49dc-a4cb-1c32b4e8ec29):
  recents, agenda, and assigned work use distinct modules with explicit local
  controls.
- [Vercel deployment list](https://mobbin.com/screens/ec4bb28a-d627-447c-bd3c-8a9fd371222e):
  repeated build events belong in one compact status table with the current
  release clearly identified.
- [GitLab value stream table](https://mobbin.com/screens/884d906b-db10-4e68-b571-8b02b3969afc):
  small trends belong beside comparable metrics, not in detached decorative
  charts.
- [OpenAI service health](https://mobbin.com/screens/d605f83d-3869-4ecc-8874-b913e09e2930):
  a high-level trend is paired with the underlying incident trail.
- [Tiimo weekly planning flow](https://mobbin.com/flows/ecbe2b3c-40dd-4b51-b149-f2127f8d0483):
  freeform intent becomes a generated plan, then a time-segmented daily list.

## Browser research

- [Sunsama Daily Planning](https://help.sunsama.com/docs/usage-guides/daily-planning/)
  sequences reflection, source import, predicted workload, timeboxing, and
  sharing. Crucially, it warns when estimated work exceeds the user's workload
  threshold before the plan is committed.
- [Linear Insights](https://linear.app/insights) treats charts as drill-down
  controls: measures, segments, and time series connect directly to the
  underlying work items.

## Product decisions

1. Keep the brief document as the shared semantic contract. React and SwiftUI
   render native components; neither client owns a second interpretation of the
   data.
2. Add iOS parity for `data_table` and `progress` before expanding the
   vocabulary.
3. Add source-grounded `weather`, `plan`, `email_preview`, `decision`,
   `citations`, `geo_map`, `code_diff`, and `terminal` leaves.
4. Correct chart semantics so line, area, grouped/stacked bar, and donut are
   visually distinct. Charts remain optional and must carry real source refs.
5. Interactive choices use existing brief actions with exact identifiers.
   Rendering a choice is never evidence that the underlying action succeeded.
6. iPhone tables cap visible columns and allow horizontal movement; plans,
   decisions, progress, and citations use vertical native lists with Dynamic
   Type-safe rows.
7. Weather is omitted when the server has no resolved location or forecast.
   Apple Weather attribution remains visible when WeatherKit supplied the data.
8. Technical output is read-only and bounded. The brief never executes code or
   terminal commands.

## Explicit non-goals

- Do not add media, social-post, order-summary, or shopping components to the
  Daily Brief simply because the web component library contains them.
- Do not infer coordinates, email identities, build states, completion, or
  source URLs.
- Do not make iOS host the web renderer. Native SwiftUI remains the presentation
  layer.
