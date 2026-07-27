# Albatross AI Documents — editor and recommendation research

Date: 2026-07-27

## Product decision

Albatross documents are not export-only artifacts. A document, spreadsheet, or
presentation is a durable, revisioned work object that can be created from an
SBAR recommendation, edited inline by a person, updated through bounded AI
operations, exported to standard Office formats, and optionally written to a
connected provider.

The existing `docs/files-and-documents-plan.md` remains the implementation
foundation with two superseded constraints:

- Google Drive is writable for app-created or explicitly selected files.
- Full inline editing is part of the product slice, not a later "light tweaks"
  follow-up.

## Mobbin research

### Document editing

- [Grammarly document editor](https://mobbin.com/screens/198859d0-a91a-4cb3-a591-4de7f2d461b6)
  keeps the document dominant and makes the assistant a collapsible review
  rail.
- [WRITER suggestions](https://mobbin.com/screens/a44d5ab7-59fa-4b5c-b7ee-31077721385b)
  anchors categorized suggestions to exact content and requires an explicit
  Apply action.
- [ClickUp AI writing](https://mobbin.com/screens/065e6aba-8d4c-465a-aa0f-91f4e97b0a9f)
  inserts AI composition at the cursor instead of routing every operation
  through detached chat.

Applied pattern: the page remains primary; AI can work at the current selection
or through a stable side rail; every mutation identifies its target and remains
reviewable.

### Spreadsheet editing

- [Rows AI Analyst](https://mobbin.com/screens/670b8c42-9e3e-4b9d-bd18-63277744215d)
  keeps the formula/grid workspace intact while scoping AI to a selected table.
- [Rows AI guidance](https://mobbin.com/screens/b94ddeac-60ff-4a0a-839b-ab86fa2a85dd)
  describes concrete transformations such as add, aggregate, pivot, and chart.

Applied pattern: spreadsheet AI operations name the target tab/range, present a
bounded summary, then apply through the same command path as manual edits.

### Presentation editing

- [Manus deck](https://mobbin.com/screens/a6de9255-fd49-40ad-b2e3-57446ecf8896)
  uses the familiar filmstrip/canvas/notes structure for generated decks.
- [Pitch object editor](https://mobbin.com/screens/c0846d3f-2814-410d-972a-9b7d168ccdf7)
  keeps formatting controls contextual to the selected object.
- [Obvious presentation workspace](https://mobbin.com/screens/abff67ec-f070-4f6b-aa06-b4003fc3fda8)
  places conversation beside the artifact while preserving explicit
  Slides/Notes modes.

Applied pattern: one consistent AI rail surrounds type-specific editor controls;
slides retain filmstrip, canvas, notes, and object-level editing.

### Recommendation to artifact

- [Sana AI document creation](https://mobbin.com/flows/c9c8ace8-db31-4832-933e-af15d61396ab)
  turns a contextual suggestion into an explicit creation move, carries sources
  into the request, then renders generation beside the originating conversation
  with export/provider actions.

Applied pattern: an SBAR recommendation remains human-readable and carries a
grounded `create_document` action. The brief never creates an unexplained
background file; the user chooses the action, sees the source-grounded draft,
and lands directly in the editor.

### Drive navigation

- [Google Drive search](https://mobbin.com/flows/6344a323-d514-4d7d-a068-820a0b4c5748)
  progressively moves from suggestions into a durable result set while
  preserving type, people, date, source, and location filters.

Applied pattern: unified search stays immediate, while editable provider,
document type, and location remain explicit so the save target is never
ambiguous.

## Editor engine

Univer was evaluated for the web document/spreadsheet surface. The production
slice instead keeps small Albatross-owned semantic editors for all three file
types. This avoids making a third-party canvas serialization format the durable
storage contract and lets web and iOS use the same revisioned model.

The server exporters use focused open libraries:

- `docx` for `.docx`
- `exceljs` for `.xlsx`
- `pptxgenjs` for `.pptx`

The editors and exporters are deliberately separate. Human edits, AI proposals,
immutable revisions, provider conflict checks, and Google write-back all operate
on the canonical model.

## Native iOS research

- [Google Drive iOS file list](https://mobbin.com/screens/e95ac47e-b83e-4286-b01d-fc8107f22afc)
  uses a searchable, location-aware list with provider identity kept visible.
- [Notion iOS document editor](https://mobbin.com/screens/ca309b0a-cf15-409c-94e4-c22e2e639ce9)
  keeps the page dominant and moves secondary creation/AI controls out of the
  writing line.
- [Craft iOS cell editor](https://mobbin.com/screens/f0f6ddf1-8698-472d-b6bd-b556949dc4cf)
  uses a selected-cell formula/value field above the keyboard rather than
  shrinking the grid into a form.
- [Canva iOS deck editor](https://mobbin.com/screens/5e5f3737-cf55-437f-9be6-157fd59f56ac)
  preserves a slide canvas, page strip, and object actions on a compact screen.

Applied pattern: Files is a first-class native source; documents navigate to a
real editor destination; each editor preserves its familiar editing grammar;
Albatross suggestions use a review sheet; and Office export uses the system
share sheet. The iOS client talks to the same document APIs and revisions as web.

## Google write model

The preferred grant is `drive.readonly` plus `drive.file`: the explorer may
index the connected Drive while writes are limited to files the user explicitly
selects or Albatross creates. Google-native documents use the Docs, Sheets, and
Slides structured APIs; Office binaries use Drive download/update with explicit
revision checks.

Full `drive` scope remains an opt-in operational decision rather than a silent
permission expansion. The current grant combines browse access with structured
Docs/Sheets/Slides access. Existing read-only connections must reconnect once to
grant the write scopes.

Every Google link stores the provider version observed after import or sync.
Publishing first compares the current provider version and returns a conflict
instead of overwriting a newer Google edit. The editor exposes an explicit
"Import latest Google changes" action that creates a new Albatross revision.

## SBAR contract

The textual R stays readable:

> Create a comparison sheet from the vendor proposals before Thursday's review.

The same handoff carries a review-gated action:

```json
{
  "action": "create_document",
  "label": "Create comparison sheet",
  "payload": {
    "kind": "sheet",
    "title": "Vendor comparison",
    "brief": "Compare price, scope, timeline, and risk.",
    "handoffId": "handoff_...",
    "areaId": "area_...",
    "sourceRefs": []
  }
}
```

The created document persists the handoff, Area/Work context, and source
references. File creation is reversible by archiving the document and is never
treated as sending or publishing.
