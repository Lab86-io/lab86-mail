# Goal runs: documents (G4) notes

Date: 2026-10-15. Branch: `claude/goal-runs-documents`. Design: `docs/albatross-goal-runs.md`, G4.

## What changed

- `lib/documents/templates/`: one renderer for each template (`invoice`, `letter`, `memo`,
  `report`) and a typed zod schema for each `data` shape. The model sends facts only. The
  templates own every font, size, color, rule, and space.
- `lib/documents/templates/house.ts`: the house tokens. The page is white. Ink 1F1D1A, muted
  6B665D, rule D9D3C7. One accent, 216440: the app accent `oklch(0.45 0.09 156)` from
  `app/globals.css` as sRGB. Only the invoice total rule and the blank underline use it.
  Fraunces Display for titles and the invoice total, Geist for body text (19 half-points).
  US Letter, 1152-twip (0.8 inch) margins. The layout is from the approved prototype.
- Design review of 2026-10-15: the prototype accent AE4B2B and the tint F6E9E3 are removed,
  because a brick accent on a cream fill is a common generated look. Footers and the report
  byline do not join text with middle dots.
- Review of the previews (2026-10-15): no fact shows twice on a page. The invoice masthead is
  the sender, so the invoice has no "From" column. Under the facts row, "Bill to" takes the first
  half of the fact columns, and "Engagement" (when present) takes the rest. Page 1 of an
  invoice, a memo, or a report shows only "Page N of M" in the footer.
- `lib/documents/templates/fonts/`: Geist Regular, Geist Bold, and Fraunces Display Regular, as
  Latin subsets (140 KB in total, about 73 KB in a DOCX). `scripts/build-template-fonts.py` makes
  them from `public/fonts`. The OFL text is in `fonts/LICENSE.md`.
- `word_document_create` takes `template` and `data`, and returns `template` and `blanks`.
- `word_document_edit` has the op `fill_blank` `{ blank, value }`.
- `word_document_get` returns `blanks: Array<{ name, value, filled }>`.
- `lib/documents/office-pdf.ts`: `exportOfficePdf`, `saveOfficePdf`, and `saveDocxBytesAsPdf`.
- `document_export` takes `format: 'native' | 'pdf'`. With `pdf`, it returns the saved file shape.
- `lib/ai/system-prompt.ts`: one line tells the chat to use a template for these four kinds.

## Invoice numbers

- An item uses `hours` or `quantity`, then `rate`. The server multiplies them and rounds to
  cents. A given `amount` wins.
- When every line has an amount, the server shows the subtotal and the total. When one line has
  no amount, the total is the blank "Total due" in both places (the facts row and the totals).
- `adjustments` (max 6): tax, discount, or another line, as a percent of the subtotal or as an
  amount. A discount is negative. The "Subtotal" row shows only when one or more adjustments
  exist, because without one it repeats "Total due".
- The column is "Hours" when one or more lines have hours. Otherwise it is "Qty".
- Currency uses `Intl.NumberFormat` with the ISO code (default USD). An unknown code shows as
  "10.00 ZZZ".
- A date in the form YYYY-MM-DD shows as "October 15, 2026". Other text stays as written.

## Blanks

- An empty value becomes an inline content control: `w:sdt` with `w:tag` `blank:<slug>`,
  `w:alias` the label, `w:showingPlcHdr`, and `w:text` (`multiLine` for long fields).
- The placeholder is an empty underlined slot: the label in the muted color, a single underline
  in the accent, and six non-breaking spaces that carry the line past the label. There is no
  fill. `w:sdtPr/w:rPr` holds the body style. Word and LibreOffice use it for typed text, and
  `fill_blank` uses it too. A filled value has no underline.
- Labels are 40 characters or less. Two places with the same label are one blank, so one
  `fill_blank` fills both ("Total due", "Your name").
- An item blank uses the item title when it is short and unique ("Summary: August 2026").
  Otherwise it uses the line number ("Rate: line 2").
- `fill_blank` finds a blank by its name or its slug, with no regard to case. An empty value
  shows the placeholder again. An unknown name fails and lists the real names.
- Read rules: `showingPlcHdr` means empty. Text equal to the label also means empty, because an
  editor can drop the flag. A block-level control reads each paragraph as one line.
- Round trip: fill, save as DOCX in LibreOffice 25.8, read. The tags, aliases, and values stay.

## Page numbers

From page 2, the footer has a short plain line on the left (for example "Invoice INV-1042 from
Mara Ellison") and "Page N of M" on the right. Page 1 shows only "Page N of M". Each field is five runs (begin, instruction, separate, result,
end). Each run has its own copy of the footer run properties (15 half-points, muted). The docx
library puts a field in one run, and LibreOffice then shows it in the body size. The letter has
no footer on page 1 (`titlePg`).

`lib/documents/rich-docx-fixture.ts` still uses `PageNumber.CURRENT`. Its runs have no size, so
the problem does not occur there. The fixture is test data only.

## Embedded fonts: verification

- The docx library embeds a regular face only. The templates write `fontTable.xml` themselves:
  `w:embedRegular` and `w:embedBold` for Geist, `w:embedRegular` for Fraunces Display. Each part is
  obfuscated with its own GUID key (ECMA-376 Part 1, 17.8.1). A test proves that the result is
  the same as the docx library output for the same key.
- `w:embedTrueTypeFonts` is set in `settings.xml`, so Word and LibreOffice embed the fonts again
  when they save.
- Test: a clean `HOME` and clean XDG folders, so fontconfig sees no Geist and no Fraunces
  (`fc-list` count 0). Then `soffice --headless --convert-to pdf`. The four PDFs use
  `Geist-Regular`, `Geist-Bold`, and `FrauncesDisplay-Regular` from the DOCX.
- A DOCX that LibreOffice saved again, converted again in the same clean setup, also uses the
  embedded fonts.

## Size after an editor save

When LibreOffice (and so Collabora) saves a template document, it also embeds the fonts of its
own default styles. Before the fix, the file grew from 85 KB to 1.8 MB (Liberation Sans and
Liberation Serif). A house "Heading" style removes Liberation Sans. The file is now about
0.97 MB after a save. Liberation Serif comes from the internal defaults of LibreOffice. No DOCX
setting stops it. Each Collabora save of a template document stores about 0.9 MB more than a
plain document. This is a storage cost, not an I/O cost on the database. Accepted on 2026-10-15.
Documents keep the fixed house accent 216440, not the accent that the user sets in the app.

## PDF export and the document server

Production state (read-only checks on 2026-10-15):

- `GET https://documents-production-9780.up.railway.app/hosting/capabilities` gives
  `productVersion` 26.04.3.2 and `"convert-to": { "available": false }`.
- `POST /cool/convert-to/pdf` with an invented one-line DOCX gives 403.

Collabora allows `convert-to` only from an address in `net.post_allow.host`. The default list
holds loopback and the private IPv4 blocks. The call from the web service now goes through the
public Railway URL, so the server sees an outside address and refuses it.

The code is ready. It calls `<OFFICE_CONVERT_URL or OFFICE_DOCUMENT_SERVER_URL>/cool/convert-to/pdf`.
A 403 gives the error "The document server does not accept PDF conversion from this app. Its
settings must allow this app first."

Config change to make. The coordinator makes it at deploy time (decision of 2026-10-15):

1. On the `web` service, set `OFFICE_CONVERT_URL=http://documents.railway.internal:9980`. The
   call then uses the private network (WireGuard), not the public URL. The code allows plain
   HTTP only for a `*.railway.internal` host.
2. Make one PDF export. If it gives 403, read the `documents` service log. Collabora writes
   `convert-to: Requesting address is denied: <address>` at warning level.
3. On the `documents` service, add an allow rule for that address to `extra_params`. The list
   must stay continuous, so replace entry 0 (the 192.168 block, which Railway does not use).
   For a legacy (IPv6-only) private network: `--o:net.post_allow.host[0]=fd[0-9a-f]{2}:.*`.
   Only services in the same project and environment can reach the private network.
4. If the address from step 2 is a private IPv4 address in the default list, no change on the
   `documents` service is necessary.

Do not allow the public egress address of the web service. Railway does not keep it fixed.

## Themed chrome (`OFFICE_THEMED_CHROME`)

Verdict: safe to turn on in production with current main, with a manual check.

- The server reads the flag at run time for each session (`lib/documents/collabora.ts`). A restart
  applies it. `OFFICE_THEMED_CHROME=false` turns it off again.
- It adds `ui_defaults` and `css_variables` to the editor URL. After `Document_Loaded`, it hides
  the menu bar, the Save command, and the Print command, and it adds the Albatross button before
  Undo. In the dark theme it keeps the page white. It also adds "All tools / Compact tools" to
  the title row.
- The CSP already allows the document server. `/office/albatross-toolbar.svg` gives 200 in
  production.
- Production runs Collabora 26.04.3.2, the build that the chrome was made for. Staging used the
  chrome by default from 2026-09-15 to 2026-09-29. The chrome tests pass (26 tests).
- Known limits: the classic Save and Print buttons stay. On a phone, "All tools" does nothing.
  The iOS and macOS apps show the same web editor, so they change at the same time.
- The manual check: open a DOCX, an XLSX, and a PPTX in light and dark mode on the web and on an
  iPhone. Check the icon, the Albatross button, All tools, and Save.
- `scripts/verify-collabora-live.ts` is not read-only. The prepare script writes Office rows and
  sessions under a synthetic owner, and the verify script saves through WOPI. Production is the
  only WOPI host, so a run writes to production. It was not run.

Deck flags:

- `DECK_V2_AUTHORING` (server, run time): new and blank decks use the version 2 generator, and
  restyle uses `proposeDeckRestyle`. When it is off, a version 2 brief fails with "Version 2
  presentation authoring is disabled". The `document_create` tool tells the model to prefer the
  version 2 brief, so decks from the model can fail in production now.
- `NEXT_PUBLIC_DECK_V2_AUTHORING` (client, set at build time): the Line, Image, and Chart insert
  items, Artwork, and the rich inspector and theme panel in the presentation editor. A restart is
  not sufficient; the variable must be set before the build.
- The code does not need both. Set both, so that decks from the model and the editor tools agree.

## Previews

Invented data (`scripts/fixtures/document-template-samples.ts`). Run
`bun scripts/preview-document-templates.ts /tmp/goal-docs-preview`, then convert with
`soffice --headless --convert-to pdf`. The 2026-10-15 run made one page for each template.
