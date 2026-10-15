# Match Sprebuild’s update flow

## Correction and source inspection

The user rejected the permanent sidebar destination and asked for the same flow
as Sprebuild. Inspected its actual `components/updates/AppUpdates.tsx`,
`components/updates/updates.module.css`, `lib/releases/receipt.ts`,
`lib/releases/poll.ts`, `lib/releases/schema.ts`, `app/layout.tsx`, and
`docs/UPDATES.md` in the existing source checkout.

Sprebuild mounts its update flow globally. A portal places a small notice at the
bottom left, 16px from the edges or safe area. Only an available release makes
this notice visible. Opening it presents release notes with Later and Update now.
Refresh or a later visit on a changed build opens the installed notes automatically
with Got it. A first visit establishes a quiet baseline. Acknowledgement advances
only when the installed notes are dismissed. Session storage takes precedence
over local storage so each open tab keeps its own baseline. Returning after
several releases includes all new entries; a rollback can show maintenance notes.

The earlier Albatross implementation copied discovery and explicit reload, but
its sidebar placement and missing arrival acknowledgement did not match that flow.

## Design plan

- Color: existing Albatross canvas `#f6f8fb`, paper `#ffffff`, text `#17202a`,
  muted `#5d6b7a`, accent `#0f5132`, and soft accent `#e5f2eb`. Implementation
  uses the existing semantic variables so user-selected and dark themes carry over.
- Type: existing Geist UI text at 13px for the notice and existing dialog/feed
  typography. Summary demos retain the existing display-serif treatment.
- Layout: left-aligned notice, bottom-left safe area, compact wrapping at phone
  widths. Keep the app’s established centered dialog above it. Portal placement
  avoids sidebar clipping or transforms. Reuse existing dialog focus management.

```text
Current workspace                        Review dialog
                                         What’s new in Albatross
                                         Summary + its own HTML demo
                                         Expand full changes
[ A new version is ready | Update available ]    Later / Update now

After refresh: installed notes open → Got it → normal workspace
```

Review against the brief: a permanent link or an unread badge would keep the
rejected navigation model. Remove both. The floating notice and arrival modal
carry the update flow. Keep `/updates` reachable for existing direct links,
without making it a sidebar destination. The installed modal acknowledges on
Got it, Escape, or other normal dismissal, matching Sprebuild.

## Research constraints and browser sources

The Mobbin research skill was used, but this session exposes neither
`search_screens` nor `search_flows`; no Mobbin results are claimed. The primary
reference is the explicitly requested Sprebuild source. Its live deployment is
protected, and the web browse could not read it. T3’s browser also reports that
this host blocks its sandbox (AppArmor). Installed Chromium is the browser fallback.

Revisited the official [Linear changelog](https://linear.app/changelog) and
[Raycast changelog](https://www.raycast.com/changelog) for compact highlights and
full-note disclosure. These support the retained feed structure; Sprebuild
specifies the entry point and acknowledgement behavior for this correction.

## Albatross integration

The root app provider hosts the update flow on the workspace, Settings, update
history, narrative and brief pages. Sign-in, public pages, native handoffs and
development previews do not poll or consume a receipt. The active root layout
keeps the flow stable when navigating between product pages.

Existing readers of the former sidebar feed migrate their last-seen batch to
known entry IDs. They receive new notes without replaying acknowledged history.
The receipt stores only schema version, release ID and entry IDs. Failed reads,
failed writes or blocked storage preserve live update detection. Polling remains
same-origin, uncached, once a minute while visible, and on focus/reconnect.
The existing deployment workflow supplies versioned identities; no Supabase,
webhooks, backend tables or hosting changes are needed.

The strict more-than-three rule, structured summary HTML demo, opaque sandbox,
script prohibition, screenshots, theme support and authored immutable notes remain.

## Verification

- 66 focused update, component, icon-rule and shell-vocabulary tests pass. App and test
  typechecks pass. Receipt cases cover first visits, refresh before dismissal,
  all intervening batches, rollbacks, removed notes, legacy migration, corrupted
  stores, blocked stores, and independent active tabs.
- Chromium checks against the app with enforced CSP pass: the first visit stays
  quiet; polling shows only the floating notice; Later preserves it and restores
  focus; failed checks show retry guidance; superseded releases require another
  review; explicit Update now still runs a native beforeunload guard. Installed
  notes appear automatically, retain their receipt through refresh, and stop
  appearing after Got it or normal dismissal. Legacy readers see just the new
  batch. Public pages neither poll nor consume the pending receipt.
- Verified 320px/360px notice placement, dark phone appearance, keyboard-operated
  HTML demos inside the summary, collapsed full notes, and no uncaught page errors.
  The dialog initially focuses its heading so long notes begin at the top.
- The production build passes, and the browser scenarios pass against that
  build too, including heading focus and blocked-storage live detection. The
  full suite passes 7,873 tests with one skip and no failures; three additional
  component regressions pass separately and are included in the final CI run.
  New update logic has 100% line coverage. No production credentials are used
  in local validation.
