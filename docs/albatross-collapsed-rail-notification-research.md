# Collapsed Rail Notification Research

Date: 2026-07-15

Implementation path: 5.6-sol direct.

## Scope

- Surface: the notification control in the Albatross navigation rail header.
- Files: `components/shell/Rail.tsx`, `lib/notifications/rail-visibility.ts`, and focused tests.
- Acceptance criteria: keep the notification control available in the expanded rail; do not render it in the collapsed desktop rail; preserve the existing mobile and expanded-rail layout.

## Grounding

- Mobbin: [Better Stack collapsed sidebar dashboard](https://mobbin.com/explore/screens/a9f99d5e-7f0f-4fd1-b3da-c8a87d042f8d)
- Mobbin: [incident.io collapsing sidebar flow](https://mobbin.com/explore/flows/54fb586a-ab21-42b7-8a51-7d7500bc51ae)
- Mobbin: [Slite collapsing sidebar flow](https://mobbin.com/explore/flows/fb5dbbe0-7dc3-4753-b721-2eaf1dde42df)

These references keep the collapsed state focused on primary navigation and the rail expansion affordance. The notification control is secondary header chrome, so it remains in the expanded rail and is omitted from the collapsed desktop rail instead of being squeezed into the icon column.
