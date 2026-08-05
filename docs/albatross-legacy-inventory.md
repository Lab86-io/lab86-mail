# Legacy surface inventory

Date: 2026-08-01
Round: 1 (identity and navigation)

Nothing was deleted in this round. Surfaces that the new shell replaced are
listed here with what still has to be proved before any of them can go. Delete
only after the replacement passes a behavioural check, not before.

## Replaced, still present

| Surface | Lines | Replaced by | Unique behaviour to check first |
|---|---|---|---|
| `AlbatrossSurfaces.IntentsSurface` | ~1500 | `PlansSurface` + `AlbatrossesSurface` | Its question rows carry option lists with address/hours/website fields. Confirm `PlansSurface` renders the same option shape before removal. |
| `AlbatrossSurfaces.AreasSurface` | ~700 | `AreaHome` | Fact review flows (`FactsTab`, `FactRow`, correction), the area lens counts, and the changes tab. `AreaHome` has no fact review. Decide in round 2 whether fact review belongs inside an Albatross. |
| `AlbatrossSurfaces.UnassignedSurface` | ~300 | `albatrosses` filter | The review queue's assign/reject actions. The filter does not exist yet — it is a round-2 item. Until then this is reachable only in code. |
| `AreasLive.tsx` | 335 | `AreaHome` | No importer at all, and none since the shell stopped routing it. Lowest-risk deletion of the three, still not deleted this round. |
| `PlansSurface.tsx` | 1999 | **nothing — this is the one being promoted** | Not legacy. Round 2 mounts it as the Albatross detail. Do not remove. |

## Now unreachable, kept on purpose

| Thing | Where | Why it is still here |
|---|---|---|
| `AlbatrossCompanion` picture-in-picture | `components/albatross/AlbatrossCompanion.tsx` | The floating card that opened it was removed (it duplicated the notification popover and truncated the question). The picture-in-picture portal itself still works if a window is already open, and needs a new trigger on the Albatross page in round 2. |
| Board `ShareDialog` | `components/tasks/TasksSurface.tsx` | The header control is hidden; the dialog and its API are untouched. Restore the control if the product ever gains collaboration. |
| `AIBarTrigger` | `components/shell/AIBar.tsx` | No longer mounted by the shell — one floating control only. `AssistantChat` still opens on the shortcut. |

## Routes kept for saved links

`tasks` stays in the view enum. It left the rail and is off by default; Settings
→ Advanced turns it back on. A saved `?view=tasks` link still opens the board.

Every other legacy name maps forward in `LEGACY_PRIMARY_VIEWS`
(`lib/shared/types.ts`), covered by `tests/albatross-shell.test.ts`:

```
daily_report → today
intents      → albatrosses
unassigned   → albatrosses
plans        → albatrosses
work         → albatrosses
inbox        → mail
```

## Kept deliberately

`Lab86 Mail` survives in `app/privacy/page.tsx`, `app/terms/page.tsx` and
`app/support/page.tsx`. That is the legal service name, not the product name.
Change it only with the terms themselves.
