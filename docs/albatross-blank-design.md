# The blank: Albatross and Documents design (2026-10-09)

Made with the `frontend-design` skill (anthropics/skills). Approved mock:
https://files.lab86.io/albatross-blank-design-2026-10-09/index.html

## Idea

Albatross does errands, and most errands are paperwork. When an errand needs the user, it
almost always needs a blank: hours, a rate, an invoice number. The user's part shows as the
form line that it is: one sentence in the display font, with an empty line for each field and
the field name under the line.

    Fill in ________, ________, and ________.
            hours for     hourly rate   invoice number
            each week

The same blank shows in the list, the open Albatross, document mode, and the Documents page.
A line in the highlight color means "yours to fill". Everything else stays quiet.

## Data

- `next.blanks?: string[]` on a step run handoff (tool `step_handoff`, Convex
  `albatrossStepRuns.next.blanks`, view `StepRunView.next.blanks`, always an array in the
  view). At most six names, 40 characters each, trimmed and unique (`cleanBlanks`).
- The runner names each field that it left empty for the user in a draft, document, or form.
- The list activity carries `nextBlanks`; `ThreadRow` carries `nextLabel` and `blanks` for an
  open `ready_for_you` or `your_turn` handoff only.
- `lib/albatross/blanks.ts` builds the sentence: `Fill in [a].`, `Fill in [a] and [b].`,
  `Fill in [a], [b], and [c].` Swift mirrors it in `BlankSentence.swift`.
- No blanks: the surface shows `next.detail` in the same display style, without lines.

## Visual rules

- Color: only theme roles. The blank line and its field name use the highlight voice
  (`--color-accent-3`, Swift `accent3`). Nothing else on these surfaces uses it for text.
  Buttons stay in the action voice (`--color-accent`). Albatross at work is one small
  `--color-accent-2` dot.
- Type: the display font (`font-display`, Fraunces by default) only for page titles and the
  blank sentence. Geist for everything else, and for the field names (11 px, medium).
- The line: 2 px, about 5.4 em minimum width, the field name centered under it. The sentence
  line height leaves room for the names (about 1.8 to 1.9).
- No labels above blocks ("Your move", "Your part", "Albatross asks"). No meta joined with
  middle dots. No card boxes around list rows: space separates rows.
- Write the next action, not a status. A status word shows only when there is no action.

## Surfaces

- List: a display title and one count sentence ("3 wait for you. Albatross does 2.").
  Groups in order: yours, Albatross's, the rest. A row of yours shows its title, the time,
  the blank sentence (or the next detail), and its action.
- One Albatross: the blank sentence is the largest text of the handoff, with "Mark step done"
  beside the main button.
- Document mode: the "your part" card and bar show the blank sentence and "Done, continue".
- Documents: a display title, and a "Waiting for you" section above the files: each open
  handoff whose target is a document, with its errand name, the blank sentence, and the
  button that opens the document in the Albatross.

## Native

iOS and macOS render the same sentence with `BlankSentence` (SwiftUI): text runs in the
display font, each blank an empty underline in `accent3` with the field name under it. The
handoff in `RunBlockView`, the document mode card and bar, and the native list rows use it.
