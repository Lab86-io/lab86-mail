# Goal runs: files notes (2026-10-15)

Branch `claude/goal-runs-files`. Design: `docs/albatross-goal-runs.md` (G3 "Attachments on drafts",
G5 "pdf_form_fields", "pdf_form_fill", "Secret values in a PDF").

## What is in this branch

- `lib/files/pdf-forms.ts`: read and fill AcroForm fields with `pdf-lib` 1.17.1. The form stays
  fillable. A signature field is never filled.
- `lib/files/sealed-fields.ts`: checks a `{{secure:<id>.<field>}}` reference against the item
  list (no value), and gets the recipient domains of a mail.
- `lib/files/materialize.ts`: `materializeSavedFile(userId, fileId, purpose)` fills sealed fields
  in memory for a send or a download. `checkSavedFileSend` checks a send without a fill.
- `lib/files/draft-attachments.ts`: checks the files of a draft and reads their bytes at send time.
- `lib/files/saved-file-route.ts` and `app/api/files/saved/[fileId]/route.ts`: the download route.
- `lib/tools/pdf-forms.ts`: `pdf_form_fields` and `pdf_form_fill`, tool group `pdf_forms`.
- `lib/documents/office-pdf.ts`: a placeholder `exportOfficePdf`. The documents builder replaces it.

## Field labels

The label of a field comes from, in this order:

1. The field tooltip (`TU`), on the field or a parent.
2. The XFA template of the file (IRS forms have one): the tool tip, the caption, or the spoken text
   of the field with the same SOM path.
3. The page text next to the field (pdfjs): left on the same line, right of a check box, or just
   above. This step also replaces a weak label: a long text whose first sentence is only a section
   mark, such as "Part I." or "3a.".
4. The last part of the field name.

A text field with a limit of 40 characters or fewer gets "(N characters at most)" in its label, so
the model can split a value (a Social Security number in three boxes).

## The W-9 test file

`tests/fixtures/irs-fw9-2024-03.pdf` is Form W-9 (Rev. March 2024) from
`https://www.irs.gov/pub/irs-pdf/fw9.pdf`, downloaded one time on 2026-10-15 for tests only. IRS
forms are works of the United States government and are in the public domain. The product gets
the file through `web_file_save` (Browserbase), not through this copy.

Facts about the file:

- 23 fillable fields on page 1. The Social Security number has three boxes (3, 2, and 4
  characters). The employer number has two boxes (2 and 7).
- The file has an XFA copy of the form and a usage-rights signature (`/Perms`). A filled copy
  drops both: `pdf-lib` writes the AcroForm only, and a changed file breaks the usage rights
  (Acrobat then shows a warning).

## Decisions

- **Only IDs and a date of birth go into a PDF.** A sign-in or an API key is refused at fill time.
- **A raw secret-shaped value is refused.** `pdf_form_fill` refuses a plain value that looks like
  a Social Security number, a card number, or an API key (`detectSecretShapes`), and asks for a
  reference.
- **The grant for a send is the item's site list.** Each recipient domain must be covered by one
  of the item's sites, as for a page. There is no "Allow once" for a send. To send a W-9 to
  `ap@example.com`, the user adds `example.com` to the Social Security number item (identity
  check). This also lets a run type the number on `example.com` pages.
- **A held send keeps a reference.** The outbox payload is in Convex storage without our key, and
  a failed send keeps it for 7 days. So a sealed file goes into the payload as
  `sealedAttachments: [{ fileId, filename }]`, is checked at enqueue, and fills at dispatch. A
  refusal at dispatch (for example, the user removed the site) fails the send before the provider.
- **A scheduled send refuses a sealed file.** Nylas holds a scheduled message on its side, and the
  outbox holds a Google one for up to 30 days, with the bytes.
- **The use is recorded when the value is filled**, not when the provider confirms the send. This
  is the same as a run that types a value.
- **New use outcome `downloaded`.** Web line: "Filled in a PDF that you downloaded". The Swift
  enum has no case for it yet and shows "Used".
- **`DraftAttachment.sealed?: boolean`** (new optional field in `lib/shared/types.ts`). The server
  sets it when the saved file has sealed fields, so a composer can say that saved details fill in
  at send time.

## Open questions

- Should a send have its own "Allow once" (one mail, one domain), so the user does not add a site
  to the item for runs too?
- The download route needs the identity check for each download of a sealed file. A web client
  that previews the PDF inline gets the check too.
- `pdf_form_fields` returns the exact shared shape, so it does not say which fields of a filled
  file are sealed. The model sees them as empty. `pdf_form_fill` keeps them sealed unless the
  model gives the field a new value.
