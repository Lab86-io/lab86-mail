# Files in the Corpus + Real Document Creation — Implementation Plan

Status: planned 2026-07-15. Two tracks that meet in the middle: (A) file sources feed
the context corpus; (B) Albatross authors real documents (decks, sheets, docs) grounded
in that corpus and exports them as actual .pptx/.xlsx/.docx/.pdf files.

## Context

Albatross's corpus today is mail + calendar + MCP items, all lexical Convex search.
Files are a blind spot: attachments are metadata-only, nothing parses PDFs/docs, and
there is no Drive/local-file ingestion. On the output side, Albatross can only produce
HTML artifacts (daily briefs, plan dossiers) — no real files.

Locked decisions:

- **Google Drive**: app-owned Google OAuth, full-drive sync via `drive.readonly`.
  Google Cloud app stays in Testing mode initially (small user base); CASA before GA.
  Note: Testing-mode refresh tokens expire after 7 days — settings must surface
  "Reconnect" cleanly.
- **iCloud Drive**: deferred (no public web API). The connector abstraction leaves a
  provider slot (`'icloud'`) so the native macOS/iOS apps can feed it later.
- **Local files**: first-class upload source (drag/drop + picker) into the corpus.
- **Retrieval**: lexical, but engineered to be *powerful* — multi-signal ranking,
  query expansion, windowed deep reads. Module boundaries chosen so a Convex
  `vectorIndex` upgrade is a drop-in later, not a rewrite.
- **Document creation**: AI-native structured JSON models (deck | sheet | doc) with
  live in-app preview, chat-driven iteration ("make slide 3 punchier"), and on-demand
  export to real formats. No full WYSIWYG editor this phase (light tweaks only).

---

# Track A — File sources → context corpus

## A1. Data model (`convex/schema.ts`)

New tables (mirror the proven `mcpConnections`/`mcpCredentials` split, NOT
`connectedAccounts`/`providerGrants`, which are Nylas-grant-shaped):

- **`fileSources`** — connector rows only (gdrive now, icloud later). `userId`,
  `sourceId` (`gdrive_<nanoid>`), `provider ('gdrive'|'icloud')`, `status`, `email`,
  `scopes`, `includeInBrief`, `includeInSearch`, `lastSyncedAt`, `error`.
  Indexes: `by_user`, `by_user_source`, `by_user_provider`.
- **`fileSourceCredentials`** — `accessTokenEncrypted` / `refreshTokenEncrypted`
  (via `encryptSecret` from `lib/security/crypto.ts`), `expiresAt`.
- **`fileCorpusItems`** — one row per file: `sourceId` (`'upload'` for local),
  `provider ('gdrive'|'upload'|'icloud')`, `providerFileId` (Drive id; uploads use the
  storageId string), `name`, `mimeType`, `mimeClass` ('pdf'|'doc'|'sheet'|'slide'|
  'text'|'code'|'other'), `size`, `modifiedAt`, `parents`, `path`, `webViewLink`,
  `storageId` (uploads only), `contentHash` (Drive md5 / sha256), `version`,
  `extractionStatus` ('pending'|'extracting'|'extracted'|'unsupported'|
  'skipped_too_large'|'error'), `retryCount`, `chunkCount`, `truncated`, `trashed`.
  Indexes: `by_user_source_file`, `by_user_hash` (upload dedupe), `by_user_status`
  (retry sweep), `by_user_modified`.
- **`fileCorpusChunks`** — the searchable layer. `itemId`, `chunkIndex`, `text` (raw),
  `searchText` (normalized, name/path-prefixed). **Search index `by_search_text`**
  on `searchText`, filterFields `[userId, sourceId, provider]` (Convex: one
  searchField per index, equality-only filters — `mimeClass` filters post-fetch).
- **`fileSyncStates`** — mirrors `mailSyncStates`: `status`, `cursor` (backfill
  pageToken), `changesPageToken` (incremental), `corpusReady`, `filesIndexed`.

Chunking constants (`lib/files/corpus.ts`): `FILE_CHUNK_CHARS = 20_000` normalized
chars, `FILE_CHUNK_OVERLAP = 1_000`, `MAX_CHUNKS_PER_FILE = 50` (~1 MB text cap,
then `truncated: true`). Stays inside the repo's 32k `searchText` convention and
Convex's ~1 MB doc limit. **Every file gets a chunk 0** whose text is prefixed with
name + path + metadata even when extraction fails/unsupported — filename search
always hits.

Also extend `areaArtifactLinks.artifactKind` union with `v.literal('file')` (plus the
two mirror validators in `convex/albatross.ts`) so files become area artifacts.

## A2. Convex functions

New `convex/fileCorpus.ts` (all `requireInternalSecret`-gated, copying
`convex/mailCorpus.ts` / `convex/mcp.ts` idioms):

- `upsertItemsBatch` — keyed on `by_user_source_file`; skips re-extraction when
  `contentHash`/`version` unchanged; returns `{itemId, needsExtraction}[]`.
- `replaceItemChunks` — atomic delete-old/insert-new + patch item status.
- `searchChunks(userId, query, limit, sourceId?)` — over-fetch `limit*5` (≤200),
  drop sources with `includeInSearch === false` ('upload' always allowed), group by
  `itemId` keeping best-ranked chunk, hydrate metadata, return snippets.
- `getItemWithChunkWindow(userId, itemId, fromChunk, toChunk)`.
- `claimFileBackfill` / `markFileSyncState` — ports of the mail corpus claim pattern.
- `deleteSourceBatch` (looped cascade: chunks → items → state → credentials → source;
  deletes upload `_storage` blobs), `setFileSourceToggles`, `listExtractionBacklog`,
  `listItems`, `countItemsBySource`, `listSyncTargetUserIds`.

New `convex/fileSync.ts` `tick` internalAction fanning out to
`/api/cron/file-sync` (port of `convex/mcpSync.ts`), registered in `convex/crons.ts`
every 20 min.

## A3. Google Drive engine (`lib/files/gdrive/`)

Plain REST `fetch` — **no `googleapis` dep** (repo has zero Google deps; we need
five endpoints). `client.ts`:

- `exchangeCodeForTokens` / `refreshAccessToken` (typed `DriveReauthRequiredError`
  on `invalid_grant`), `getAccessToken` (decrypt, refresh at `expiresAt - 60s`,
  re-encrypt + persist), `fetchUserinfo`.
- `listFilesPage` (`pageSize=300`, `q='trashed=false'`, tight `fields` mask),
  `getStartPageToken`, `listChangesPage`, `downloadFile` (`alt=media`),
  `exportFile` (native Google types).
- `withDriveRetry` cloned from `withRateLimitRetry` (corpus-sync.ts): backoff on
  403 rate-limit / 429 / 5xx.

`sync.ts`:

- Export mimes: gdoc → `text/plain`, gsheet → xlsx (so exceljs reads all tabs),
  gslides → `text/plain`; forms/sites/drawings → unsupported.
- `runDriveBackfill` — port of `runCorpusBackfill`: pipelined pages, atomic claim +
  debounce (`maybeKickDriveBackfill`), cursor resume/reset, `corpusReady` +
  `changesPageToken` captured at completion. `MAX_FILES_PER_SOURCE = 20_000`.
- `runDriveIncrementalSync` — `changes.list` from stored token; trashed/removed →
  delete; changed hash/version → re-extract; 410 expired token → re-kick backfill.
- `syncAllFileSources(userId)` — cron entry; reauth errors → source `status:'error'`
  with "Reconnect Google Drive".

No Drive push webhooks (watch channels need domain verification + renewal); the
20-min poll matches the mcp-sync freshness contract.

## A4. Extraction pipeline (`lib/files/extract.ts`, `lib/files/ingest.ts`)

Runs in Next server routes on Railway (never Convex actions — bundle/memory limits).
New deps, all **dynamically imported** server-side: **`unpdf`** (PDF — avoids
pdf-parse's import-time bug), **`mammoth`** (docx `extractRawText`), **`exceljs`**
(xlsx, all sheets → tab-joined lines), `TextDecoder` for text/md/csv/json/code.
Binary .pptx: unsupported this phase. `MAX_EXTRACT_BYTES = 25MB` →
`skipped_too_large`. `extractAndIndexItem` lifecycle: extracting → extracted/error
(retryCount < 3 swept by cron). Batch via `p-queue` (existing dep), concurrency 3.

Blob policy: **uploads keep raw bytes in Convex `_storage`** (only copy); **Drive
files never store raw bytes** — download, extract, persist chunks, discard.

## A5. Routes

- `app/api/files/gdrive/{connect,callback,disconnect}/route.ts` — mirror
  `app/api/nylas/*`: reuse `accounts.createOAuthState`/`consumeOAuthState`
  (`provider: 'gdrive'`), scope `drive.readonly openid email`,
  `access_type=offline&prompt=consent`, tokens encrypted, callback kicks backfill,
  redirect to `/settings?tab=files`.
- `app/api/files/upload/route.ts` — clone of agent uploads route (25MB/5 files,
  rate-limited): sha256 dedupe via `by_user_hash`, storage POST, item upsert,
  ACK then `void extractAndIndexItem`.
- `app/api/files/{status,toggle,resync}/route.ts` — mirror `/api/mcp/*`.
- `app/api/cron/file-sync/route.ts` — `isInternalCronRequest`, ACK 202, then
  incremental sync per user + extraction-retry sweep.

## A6. Retrieval — powerful lexical

Design goal: the best retrieval lexical can give, behind one module boundary
(`lib/files/retrieval.ts` + `convex/fileCorpus.ts:searchChunks`) so embeddings slot
in later as an additional signal, not a rewrite.

- **Two signals, merged**: (1) content-chunk search index hits; (2) metadata hits —
  chunk 0's name/path prefix makes filename/folder queries rank without a second
  index. Group-by-item keeps the best chunk per file; boost items where BOTH name
  and content match.
- **Query expansion** in `file_search` for zero/thin-result queries: one `nano`-tier
  gateway call generates 2–3 lexical variants (synonyms, split compounds, likely
  filenames), fan out, merge by best rank. Capped and cached per turn; skipped when
  the first pass returns enough.
- **Windowed deep reads**: `file_get_content` returns chunk windows (≤3 chunks
  ≈ 15k tokens) with `chunkCount`/`truncated` so the agent pages through big PDFs
  instead of truncating at one blob.
- **Recency + type awareness**: results carry `modifiedAt` and `mimeClass`; the tool
  supports `mimeClass` and `source` filters; merged ranking mildly favors recent.

New tools in `lib/tools/files.ts` (register in `lib/tools/index.ts` +
`AGENT_TOOL_NAMES` in `lib/ai/loop.ts`):

- `file_search {query, source?, mimeClass?, max≤25}` — tagged `source: 'file'`.
- `file_get_content {fileId, fromChunk, chunks≤3}`.
- `file_list {source?, limit?}`.

Modify `lib/tools/corpus.ts` `corpus_search`: third parallel branch fanning into
`searchChunks`, mapped to `{source:'file', title, url: webViewLink, lastDate, snippet}`
and merged into the existing recency sort. System prompt gains a short files section.

**Areas integration**: area-classify cron pulls recently modified `fileCorpusItems`
(name/path/first-chunk snippet) through the existing deterministic-fact + nano-LLM
pipeline in `lib/albatross/area-classifier.ts`; files render in area panes like
mail links do.

## A7. Settings UI

New `files` tab in `SETTINGS_TABS` (`lib/albatross/teach-ui.ts`) + `FilesSection` in
`app/settings/page.tsx` cloned from `ConnectionsSection`: Connect Google Drive
button (OAuth redirect), per-source card (sync status pill, includeInBrief /
includeInSearch toggles, Resync, Disconnect), plus an Uploads card with
`react-dropzone` (pattern: `components/thread/InlineComposer.tsx`), recent uploads
with extraction status + delete. Mobbin research before building.

## A8. Ops

- Env (`.env.example`): `GOOGLE_DRIVE_CLIENT_ID`, `GOOGLE_DRIVE_CLIENT_SECRET`,
  optional `GOOGLE_DRIVE_REDIRECT_URI` (default via new `gdriveRedirectUri()` in
  `lib/hosted/env.ts`), `LAB86_MAIL_FILE_SOURCES_ENABLED` kill switch.
- Google Cloud runbook: project → Drive API → consent screen External/Testing →
  test users → web client + redirect URI. Flag the 7-day Testing refresh-token
  expiry and the CASA requirement for GA.
- Entitlement-gate connect/upload via `getAiBillingEntitlement()`.

---

# Track B — AI-native documents + real-file export

## B1. Document model (`lib/documents/schema.ts`)

Zod discriminated union on `kind`, `modelVersion: 1` + `migrateModel()` from day one.
Stable ids on every slide/block/tab so update ops survive reordering.

- **deck**: slides (≤60) with layout ('title'|'title-body'|'two-column'|'full-bleed'|
  'section'), blocks (title, bullets, image, chart {bar|line|pie, categories,
  series}, table, quote), speaker `notes`, theme tokens (accent, font, density).
- **sheet**: tabs (≤10) with typed columns (text|number|currency|percent|date|
  boolean, exceljs `numFmt` passthrough), rows (≤5000), cells as literals or
  `{value, formula?}`. **Formula stance: AI computes literal `value`s; optional
  `formula` strings are written verbatim to xlsx on export only** (Excel
  recalculates on open). No in-app formula engine.
- **doc**: ordered blocks (heading 1-3, paragraph as inline-markdown, list, table,
  image, callout, divider), rendered via existing `marked` + `dompurify`.

`lib/documents/ops.ts` — pure `applyOps(model, ops)`; `lib/documents/limits.ts` —
`MAX_MODEL_BYTES = 800_000` (headroom under Convex 1 MB), clamp-never-reject style.

## B2. Convex (`convex/documents.ts` + schema)

- **`documents`**: `kind`, `title`, `model` as **stringified JSON** (`v.string()`,
  measured `modelBytes` ≤ 800k), `revision`, `createdBy ('albatross'|'user')`,
  optional `areaId`/`projectId`, `exportedFiles [{format, storageId, revision, size,
  exportedAt}]` (latest per format; superseded blobs `ctx.storage.delete`d),
  `archivedAt`. Indexes `by_user_updated`, `by_user_kind`.
- **`documentRevisions`**: prior model snapshot per revision, pruned to newest 20.
- Functions: `create`, `get`, `list`, `applyModel` (takes `expectedRevision`,
  optimistic-concurrency reject on mismatch), `restoreRevision`, `registerExport`,
  `archive`. Ops apply in Node; Convex stores validated strings.

## B3. Agent tools (`lib/tools/documents.ts`)

Add `'documents'` to the registry category union. Five tools:

- `document_create {kind, title, model? | brief?, areaId?, projectId?}` (mutating) —
  small docs pass a full model; big ones pass a `brief` → compose helper (B6).
- `document_update {documentId, ops[], expectedRevision?}` (mutating) — **typed
  targeted ops, not JSON Patch** (id-targeted, LLM-reliable): shared `set_title` /
  `set_theme` / `replace_model`; deck `insert_slide` / `replace_slide` /
  `remove_slide` / `move_slide` / `set_notes`; sheet `set_range {sheetId, startCell,
  rows}` / `insert_rows` / `delete_rows` / `set_columns` / `add_sheet` /
  `remove_sheet`; doc `insert_blocks` / `replace_block` / `remove_blocks` /
  `move_block`. Undo via operation record + `document_revert` executor →
  `restoreRevision`.
- `document_get {documentId, view: 'outline'|'full'|'slides'|'range'|'blocks', ...}`
  — outline default; `range: 'A1:F50'` reads keep 5k-row sheets out of context.
- `document_list {kind?, limit?}`.
- `document_export {documentId, format}` — generates bytes, stores to `_storage`,
  **also registers an `agentUploads` row** so `send_message {chatUploadId}` and
  `tasks_attach_file` work unchanged. Returns download URL + `chatUploadId`.

Context flows in through existing retrieval tools (corpus_search, file_search,
calendar, threads) — doc tools never duplicate retrieval. System prompt: "gather
context first, then author." Image blocks accept `storage:<agentUploadId>`.

## B4. Preview UI

- **In chat**: document tools return the `{ok, component:'document', payload}` display
  contract → new `components/tool-ui/document/` card (schema.ts + _adapter.tsx per
  convention), added to the `tool-ui-part.tsx` switch + `TOOL_UI_RENDERED_TOOLS`.
  The card `useQuery`s the document — Convex reactivity live-updates it as the agent
  edits. Actions: Open, Export ▾. Voice rules apply (no icon-before-text, no filler).
- **Panel viewer** (`components/documents/`): `DocumentsPanel` list (Rail entry,
  nuqs `?document=<id>` deep link — single-shell app, no new route);
  `DeckPreview` (filmstrip + 16:9 canvas + notes, charts via recharts);
  `SheetPreview` (**`@tanstack/react-virtual`** — already a dep; no AG-Grid; sticky
  header, type-aware formatting); `DocPreview` (rendered blocks).
- Light tweaks only: title rename + sheet cell edit, through the same `applyModel`
  path as `createdBy: 'user'`. Mobbin research before building.

## B5. Export engines (`lib/documents/export/`)

One pure `(model) => Buffer` per format, all dynamically imported (add to
`serverExternalPackages` in `next.config.ts` if needed; ~10–15 MB node_modules,
no puppeteer ever):

- **pptx.ts — `pptxgenjs`**: native `addChart` for chart blocks (real editable
  PowerPoint charts, zero rasterization), `addTable`, `addNotes`, theme → master.
- **xlsx.ts — `exceljs`**: `numFmt` from column types, frozen headers,
  `{formula, result}` cells.
- **docx.ts — `docx`**: headings/lists/tables; callout = shaded 1-cell table;
  inline markdown via `marked` lexer → runs.
- **pdf.ts — `@react-pdf/renderer`**: pure-JS, all three kinds (deck = 16:9 pages,
  doc = flowing, sheet = paginated table). Stated v1 tradeoff: PDF charts render as
  styled data tables; later upgrade via SVG primitives.

Export route `app/api/documents/[documentId]/export/[format]/route.ts` (auth +
ownership, pattern from the attachments route): cache hit on `(revision, format)` →
stream from storage; else generate, store, `registerExport`, stream with
`content-disposition` + `sanitizeFilename`.

## B6. Compose + gateway

`FEATURE_MAX_TOKENS['document_compose'] = 24000`, added to `FAILOVER_FEATURES`.
Targeted updates run inside the agent loop (fit the 12k agent cap); initial large
generations go through `lib/documents/compose.ts draftDocumentModel(kind, title,
brief)` — one-shot primary-tier call (same pattern as `daily_report_artifact`),
Zod parse + one repair retry, bounded under the 75s tool timeout.

---

# Phasing (shippable milestones)

1. **M1 — Local files into the corpus**: file corpus tables + chunking + extraction
   (`unpdf`/`mammoth`/`exceljs`), upload route, Files settings tab with dropzone,
   `file_search`/`file_get_content`/`file_list` + `corpus_search` fan-in. No Google.
2. **M2 — Documents core (sheets + docs)**: document schema/ops/Convex, five tools,
   chat DocumentCard, Sheet/Doc previews, xlsx + docx export, compose feature.
3. **M3 — Google Drive**: OAuth routes, REST client, backfill engine, settings
   connect card, Google Cloud runbook.
4. **M4 — Decks + Drive incremental**: DeckModel + pptx (native charts), DeckPreview,
   DocumentsPanel + deep link; `changes.list` incremental sync + file-sync cron +
   retry sweep.
5. **M5 — Integration polish**: PDF export, attach-to-email/card wiring, area
   classification of files, query expansion in `file_search`, revision compare,
   export-cache pruning, voice/style pass.

# Testing (bun test, flat files in `tests/` — note `tests/files.test.ts` is taken)

- `tests/file-corpus.test.ts` — chunk boundaries/overlap/truncation, name-prefix
  under 32k cap, `mimeClassFor`, metadata-only chunk 0.
- `tests/file-extract.test.ts` — mime dispatch, unsupported fallback, size cap.
- `tests/gdrive-sync.test.ts` — export-mime selection, change-delta classification,
  cursor reset, reauth error state (injectable deps like `tests/mcp-sync.test.ts`).
- `tests/tools-files.test.ts` / `tests/documents-tools.test.ts` — registration, zod
  I/O, chunk paging, create→update→export flow, undo inverse.
- `tests/documents-schema.test.ts` / `tests/documents-ops.test.ts` — parsers, every
  op type, unknown-id errors, size guards.
- `tests/documents-export.test.ts` — golden structural: unzip pptx (slide count +
  chart XML part), read xlsx back with exceljs (values/formulas/numFmt), unzip docx
  (document.xml headings), PDF magic + page count.

# Verification (end-to-end, per milestone)

- M1: upload a real PDF + xlsx in settings → watch extraction status → ask Albatross
  a question only answerable from the PDF → confirm `file_search`/`file_get_content`
  calls and a correct grounded answer; confirm `corpus_search` merges file hits.
- M2: "build me a budget spreadsheet from my recent invoices" → DocumentCard appears,
  iterate ("add a Q3 column") → card live-updates → export .xlsx → open in
  LibreOffice/Excel and verify formatting + formulas.
- M3: connect a real Google account (Testing mode, own account) → backfill completes
  (`fileSyncStates` ready) → search for a Drive doc's content.
- M4/M5: edit a Drive file → appears within 20 min; generate a deck → export .pptx →
  open in LibreOffice Impress; attach an exported file to an outgoing email.
- Headless UI checks per the screenshot memory (localhost, playwright chromium).

# Key constraints designed around

Convex: one searchField per search index, equality-only filterFields, ~1 MB doc
limit, `take() ≤ 1024`. Gateway: always-capped tokens (OpenRouter 402 lesson).
Agent: 12k token cap → windowed reads + targeted ops; 75s tool timeout. Railway:
pure-JS libs only, dynamic imports, no puppeteer. Google: `drive.readonly` is
restricted (CASA for GA), Testing-mode 7-day refresh tokens.
