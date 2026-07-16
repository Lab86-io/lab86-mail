# Issue #100 — Sparse, body-grounded, reclassifiable Area routing: research

Research performed for [#100](https://github.com/Lab86-io/lab86-mail/issues/100) before implementation, per
`docs/albatross-development-contract.md`.

The question this research had to answer: **what does a mature product do when an item belongs to no
bucket?** Albatross today answers "invent a catch-all called Personal." Every comparable product
surveyed below answers "nothing — zero is a normal, first-class state."

## Tool availability

| Tool | Status |
| --- | --- |
| Mobbin MCP (`search_screens`) | Available and authorized. Screens inspected below. |
| Browser/web research (`WebSearch`/`WebFetch`) | Available. Sources below. |
| Figma MCP | **Unavailable** — server requires OAuth and this session is non-interactive. Not used; no Figma grounding claimed. |

## Mobbin: sparse / opt-in assignment patterns

### Linear — optional Project on an issue (web)

- [Issue detail, Labels popover open](https://mobbin.com/screens/c5b51239-25b1-4b91-8075-21ac8a65755d)
- [Issue detail, "Create new label" inline](https://mobbin.com/screens/0ac71711-e7a3-414d-83e9-df29344783ab)
- [Issue detail, Project + Milestone properties](https://mobbin.com/screens/a9e8ca62-7809-4deb-a861-9524482dbb54)
- [Issue detail with no Project property set](https://mobbin.com/screens/f195d249-1d7c-4559-9e18-2d0108173a90)

Findings that transfer:

1. **Unset renders as a ghost affordance, never a default value.** The right rail shows `Milestone → Set
   milestone` and `Cycle → Add to cycle` in dimmed placeholder type. Linear never invents a "General"
   milestone to avoid an empty row. The empty state *is* the affordance.
2. **Labels are additive and multi-valued**, added through a `+` next to the section. Zero labels is the
   overwhelmingly common case and is not styled as an error or a warning.
3. **Creating the container is inline and explicit** ("Create new label: '3rd Party'"). The system never
   pre-seeds a label so that the picker is non-empty.

### Notion — opt-in Projects, honest empty states (web)

- [Projects teamspace: template picker before anything exists](https://mobbin.com/screens/c170d9ae-5489-499c-82fc-0d30bf7fac38)
- [Projects teamspace, alternate template selected](https://mobbin.com/screens/330e748d-5c24-4435-963a-7fe48adc2bd2)
- [My Tasks: "No matching tasks." + New task](https://mobbin.com/screens/120f4d36-a239-43f8-bede-b41ef7d96dab)
- [Empty view: "No data source — Select a data source to continue"](https://mobbin.com/screens/2a3c9ede-fa76-4e52-8b0d-b1ae025ec0c6)

Findings that transfer:

1. The zero state is a **short factual line plus one primary action** ("No matching tasks." / "+ New task").
   No filler illustration, no apologetic copy, no fabricated starter content.
2. Notion states the *scope of what it did* ("No matching tasks"), not a promise about coverage. It never
   claims everything is filed.

### Intercom — "Unassigned" as a real, selectable value (web)

- [Inbox with Unassigned view in the rail and Assignee: Unassigned](https://mobbin.com/screens/d73ae3c2-a8ea-400d-ae07-226994ad3659)
- [Assign-to command palette listing "Unassigned" as an explicit option](https://mobbin.com/screens/b2f84189-60b1-4e0e-bc26-5820f372301c)
- [Dense inbox with Unassigned count in rail](https://mobbin.com/screens/8fb596cd-1ad3-4a18-9e02-9cbbe52a2d4e)

Findings that transfer — **this is the most directly applicable pattern in the survey**:

1. `Unassigned` is a **first-class choice in the assignment picker**, sitting in the same list as real
   assignees. It is not a fallback the system silently applies; the user can deliberately select it.
2. `Unassigned` is a **rail view with a live count**, so the unrouted set is visible and workable rather
   than hidden inside a junk bucket.
3. The details rail shows `Assignee: Unassigned` / `Team: Unassigned` as a normal readable state.

This is the model for assignment controls: **"No Area" must be a selectable option, not an absence** —
which is exactly what acceptance criterion "chooser must support no Area without silently substituting
Personal" is asking for. The Area overview itself remains a list of real Areas; its null selection is the
overview, so adding a fake "No Area" row there would conflate navigation with assignment.

## Non-Mobbin product research

### 1. HEY — The Screener (opt-in routing at the source)

Sources: [The Screener (help)](https://help.hey.com/article/722-the-screener),
[The Screener (feature page)](https://www.hey.com/features/the-screener/),
[How HEY works](https://www.hey.com/how-it-works/)

- First-time senders are **not auto-filed anywhere**. They land in the Screener and the user answers
  Yes/No. Routing is *earned by an explicit decision*, never assumed.
- Only *after* a Yes does mail route onward (Imbox / The Feed / The Paper Trail).
- HEY's thesis is precision over coverage: it "curbs unsolicited volume at the source rather than relying
  on filters." An un-screened sender has no bucket, and that is the designed outcome — not a gap.

Transfers directly to AC #1: **zero Areas is a successful verdict**, and the honest surface for
"we don't know" is an explicit undecided state, not a catch-all.

### 2. Gmail — exhaustive ML tabs vs. sparse user labels

Sources: [Gmail labels](https://support.google.com/mail/answer/118708),
[Optimize your Gmail inbox](https://support.google.com/a/users/answer/9282734),
[Gmail labels & filters guide](https://support.cloudhq.net/how-to-categorize-your-gmail-messages-using-labels/)

This is the closest structural analogue to what #100 wants, and it validates the two-tier split:

| Gmail | Albatross | Density |
| --- | --- | --- |
| Category tabs (Primary/Promotions/Updates…) — ML, sender signals + past interaction | **Smart Categories** | **Exhaustive** — every message gets exactly one |
| Labels — user-created, multi-valued, opt-in | **Areas** | **Sparse** — most messages have zero |
| Filters (`from:(@vendor.com)` → apply label) — deterministic, user-authored | **Verified email/domain area facts** | **Authoritative** |

Findings that transfer:

1. **Labels are non-exclusive and optional.** A message may carry many labels or none; Gmail never invents
   a "Misc" label to guarantee every message is labeled. Coverage is the *tabs'* job, not the labels' job.
2. **Deterministic filters are the precise tier.** A user-authored `from:@domain` rule routes with
   certainty. ML is used for the exhaustive tier where a wrong guess is cheap (a tab), not for the sparse
   tier where a wrong guess is expensive (a label on the wrong project).
3. Labels are user-private organizational intent — the system does not get to assert them speculatively.

## Design conclusions carried into implementation

1. **Zero Areas is the default outcome, not a failure.** Nothing in copy or layout may imply every message
   is filed. Status language reports *what was examined*, not *that everything landed somewhere*
   (Notion's "No matching tasks", not "All mail filed").
2. **No catch-all.** Retire the system Personal Area. "Personal" becomes an ordinary user-creatable name
   (Gmail lets you make a `Personal` label; it just doesn't make one for you).
3. **"No Area" is selectable, not silent.** Per Intercom's Assign-to palette, assignment and capture
   controls preserve an explicit no-Area choice rather than defaulting to a bucket. Area navigation lists
   only real user-created Areas.
4. **Empty states = one factual line + one primary action** (Notion), preserving current density; no
   illustrations, no invented starter Areas.
5. **Precision tiering mirrors Gmail:** verified exact email/domain facts route deterministically
   (filters); the model proposes *candidate* overlays only (never verified); candidate facts and general
   context never route on their own.
6. **Unrouted mail stays visible and workable** (Intercom's Unassigned view with a count) instead of being
   swept into Personal — the user can still find it via Smart Categories and search.

## Cost and operational constraints

Per-message classification intentionally increases model-call volume in exchange for body-grounded
precision. The dedicated `classify` model tier, small structured response, 20-message batches, concurrency
of four, five-batch request ceiling, and periodic cron cap the model side. Full historical Area scans are a
separate operation and must be coalesced per user: sequential intent/fact writes request one scan (plus at
most one follow-up if a write lands mid-run), pagination has a non-advancing-cursor guard, and each run has
a hard 100-page/10,000-thread safety limit. This is required because an earlier uncoalesced staging burst
exhausted the Convex spend cap on 2026-07-16.

## Design-system constraints honored

Per the house taste rules and existing Albatross surfaces: no sparkle/star icons, no icons before text, no
ALL-CAPS micro-labels, no meaningless copy. Existing rail density, type scale, and accent palette are
preserved — this issue changes *what is true*, not the visual language.
