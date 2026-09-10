import { createHash } from 'node:crypto';
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { parseDocumentModel } from '@/lib/documents/model';
import { OfficeError, readOfficeRequest } from '@/lib/documents/office-security';
import {
  createImportedDocument,
  DocumentImportUnconfirmedError,
  generateImportUploadUrl,
} from '@/lib/documents/service';
import {
  assertModelWithinLimit,
  DocumentTooLargeError,
  isSheetWorkbookModel,
  MAX_DOCUMENT_MODEL_BYTES,
} from '@/lib/documents/sheet-workbook';
import {
  assertSupportedContentTypes,
  inflateEntryText,
  inspectXlsxContainer,
  MAX_XLSX_BYTES,
  XlsxImportError,
} from '@/lib/documents/xlsx-validation';
import { enforceUserRateLimit, RateLimitError, rateLimitJson } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

export const MAX_IMPORT_BYTES = MAX_XLSX_BYTES;
export const MAX_IMPORT_REQUEST_BYTES = MAX_IMPORT_BYTES + MAX_DOCUMENT_MODEL_BYTES + 512 * 1024;
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const fieldsSchema = z.object({
  title: z.string().max(500).optional(),
  warnings: z.array(z.string().max(1_000)).max(200).default([]),
});

interface ImportDependencies {
  requireCurrentUser: typeof requireCurrentUser;
  enforceUserRateLimit: typeof enforceUserRateLimit;
  generateImportUploadUrl: typeof generateImportUploadUrl;
  createDocument: typeof createImportedDocument;
  fetch: typeof fetch;
}

const defaultDependencies: ImportDependencies = {
  requireCurrentUser,
  enforceUserRateLimit,
  generateImportUploadUrl,
  createDocument: createImportedDocument,
  fetch,
};

/**
 * The browser reads the workbook with the spreadsheet engine (the engine's
 * Excel reader needs a DOM parser) and sends both the engine snapshot and the
 * untouched original bytes. The bytes are stored as-is and stay downloadable.
 */
export function createDocumentImportPost(deps: ImportDependencies = defaultDependencies) {
  return async function documentImportPost(req: NextRequest) {
    try {
      const user = await deps.requireCurrentUser();
      await deps.enforceUserRateLimit({
        userId: user.userId,
        key: 'document-import',
        limit: 20,
        windowMs: 60_000,
      });
      const contentType = req.headers.get('content-type') || '';
      if (!contentType.toLowerCase().startsWith('multipart/form-data;')) {
        return NextResponse.json(
          { ok: false, error: 'Attach an .xlsx file using a multipart upload.' },
          { status: 400 },
        );
      }
      const requestBytes = await readOfficeRequest(req, MAX_IMPORT_REQUEST_BYTES);
      let form: FormData;
      try {
        form = await new Response(requestBytes, { headers: { 'content-type': contentType } }).formData();
      } catch {
        return NextResponse.json(
          { ok: false, error: 'The workbook upload could not be read.' },
          { status: 400 },
        );
      }
      const file = form.get('file');
      if (!(file instanceof File)) {
        return NextResponse.json({ ok: false, error: 'Attach an .xlsx file.' }, { status: 400 });
      }
      if (!/\.xlsx$/iu.test(file.name)) {
        return NextResponse.json(
          { ok: false, error: 'Only Excel workbooks (.xlsx) can be imported into the spreadsheet engine.' },
          { status: 400 },
        );
      }
      if (file.size > MAX_IMPORT_BYTES) {
        return NextResponse.json(
          { ok: false, error: `Workbooks above ${MAX_IMPORT_BYTES / (1024 * 1024)} MB cannot be imported.` },
          { status: 413 },
        );
      }
      const fields = fieldsSchema.parse({
        title: form.get('title') ?? undefined,
        warnings: JSON.parse(String(form.get('warnings') || '[]')),
      });
      const model = parseDocumentModel(JSON.parse(String(form.get('model') || 'null')), 'sheet');
      if (!isSheetWorkbookModel(model)) {
        return NextResponse.json(
          { ok: false, error: 'The import must carry the engine workbook snapshot.' },
          { status: 400 },
        );
      }
      assertModelWithinLimit(model);
      const bytes = new Uint8Array(await file.arrayBuffer());
      inspectXlsxContainer(bytes);
      const { default: JSZip } = await import('jszip');
      const zip = await JSZip.loadAsync(bytes).catch(() => {
        throw new XlsxImportError(
          'The workbook archive could not be read. Save a fresh .xlsx copy and try again.',
        );
      });
      const contentTypes = zip.file('[Content_Types].xml');
      if (!contentTypes) throw new XlsxImportError('This file is not an Excel workbook (.xlsx).');
      assertSupportedContentTypes(await inflateEntryText(contentTypes, 1024 * 1024));
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const uploadUrl = await deps.generateImportUploadUrl();
      const upload = await deps.fetch(uploadUrl, {
        method: 'POST',
        headers: { 'Content-Type': XLSX_MIME },
        body: bytes,
      });
      const uploaded = (await upload.json().catch(() => ({}))) as { storageId?: string };
      if (!upload.ok || !uploaded.storageId) {
        return NextResponse.json(
          { ok: false, error: 'The original workbook could not be stored. Nothing was imported.' },
          { status: 502 },
        );
      }
      const document = await deps.createDocument({
        userId: user.userId,
        kind: 'sheet',
        title: fields.title?.trim() || file.name.replace(/\.xlsx$/iu, ''),
        model,
        sourceRefs: [{ kind: 'upload', id: sha256, label: file.name }],
        reason: `Imported ${file.name}`,
        importSource: {
          format: 'xlsx',
          filename: file.name,
          mimeType: XLSX_MIME,
          size: file.size,
          sha256,
          storageId: uploaded.storageId,
          warnings: fields.warnings,
          importedAt: Date.now(),
        },
      });
      return NextResponse.json({ ok: true, document }, { status: 201 });
    } catch (error) {
      if (error instanceof RateLimitError) return rateLimitJson(error);
      if (error instanceof AuthRequiredError) {
        return NextResponse.json({ ok: false, error: error.message }, { status: 401 });
      }
      if (error instanceof DocumentTooLargeError) {
        return NextResponse.json({ ok: false, error: error.message }, { status: 413 });
      }
      if (error instanceof DocumentImportUnconfirmedError) {
        return NextResponse.json(
          { ok: false, error: error.message, code: 'IMPORT_UNCONFIRMED' },
          { status: 503 },
        );
      }
      if (error instanceof XlsxImportError || error instanceof OfficeError) {
        return NextResponse.json({ ok: false, error: error.message }, { status: error.status });
      }
      if (error instanceof z.ZodError || error instanceof SyntaxError) {
        return NextResponse.json(
          { ok: false, error: 'The workbook snapshot could not be read.' },
          { status: 400 },
        );
      }
      console.error('[document-import]', error);
      return NextResponse.json({ ok: false, error: 'Import failed.' }, { status: 500 });
    }
  };
}

export const POST = createDocumentImportPost();
