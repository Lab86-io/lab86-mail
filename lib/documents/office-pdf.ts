// PDF export of Word files through the document server (docs/albatross-goal-runs.md, G4).
// Collabora converts with `POST /cool/convert-to/pdf`. The server allows that
// call only from addresses in its `net.post_allow.host` list, so production
// needs a config change first (docs/research/goal-runs-documents-notes-2026-10-15.md).

import { type SavedFile, savedFileName, saveFileBytes } from '@/lib/files/saved-files';
import {
  OFFICE_MIME,
  OfficeError,
  type OfficeExtension,
  readOfficeResponse,
  validateOfficeArchive,
} from './office-security';
import { getOfficeFile } from './office-service';

const defaults = {
  getOfficeFile,
  saveFileBytes,
  fetch: (...args: Parameters<typeof fetch>) => fetch(...args),
  env: () => process.env as Record<string, string | undefined>,
};
let dependencies = defaults;
export function __setOfficePdfDepsForTest(overrides: Partial<typeof defaults> = {}) {
  dependencies = { ...defaults, ...overrides };
}

// The agent tool limit is 75 seconds; the storage read comes first.
const PDF_TIMEOUT_MS = 55_000;

/**
 * The convert-to address. `OFFICE_CONVERT_URL` can point to the private
 * address of the document server (for example
 * `http://documents.railway.internal:9980`); the default is the public
 * `OFFICE_DOCUMENT_SERVER_URL`. Plain HTTP is allowed only for a Railway
 * private host or, outside production, a loopback host.
 */
export function officeConvertUrl(env: Record<string, string | undefined> = dependencies.env()) {
  const raw = (env.OFFICE_CONVERT_URL || env.OFFICE_DOCUMENT_SERVER_URL || '').trim();
  if (!raw) throw new OfficeError('PDF export needs a document server. None is set up.', 503);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new OfficeError('The document server address is not valid.', 503);
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  const privateHost = url.hostname.endsWith('.railway.internal');
  const allowed =
    url.protocol === 'https:' ||
    (url.protocol === 'http:' && (privateHost || (loopback && env.NODE_ENV !== 'production')));
  if (!allowed || url.username || url.password || url.search || url.hash || url.pathname !== '/')
    throw new OfficeError('The document server address must be an HTTPS origin.', 503);
  return `${url.origin}/cool/convert-to/pdf`;
}

/** Converts Office bytes to PDF bytes on the document server. */
export async function convertOfficeToPdf(bytes: Uint8Array, extension: OfficeExtension): Promise<Uint8Array> {
  const endpoint = officeConvertUrl();
  validateOfficeArchive(bytes, extension);
  const form = new FormData();
  form.append(
    'data',
    new Blob([new Uint8Array(bytes)], { type: OFFICE_MIME[extension] }),
    `document.${extension}`,
  );
  let response: Response;
  try {
    response = await dependencies.fetch(endpoint, {
      method: 'POST',
      body: form,
      redirect: 'error',
      signal: AbortSignal.timeout(PDF_TIMEOUT_MS),
    });
  } catch {
    throw new OfficeError('The document server did not answer. Try the PDF again in a few minutes.', 503);
  }
  if (response.status === 403) {
    await response.body?.cancel().catch(() => undefined);
    throw new OfficeError(
      'The document server does not accept PDF conversion from this app. Its settings must allow this app first.',
      503,
    );
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new OfficeError('The document server could not make the PDF.', 502);
  }
  const pdf = new Uint8Array(await readOfficeResponse(response));
  if (Buffer.from(pdf.subarray(0, 5)).toString('latin1') !== '%PDF-')
    throw new OfficeError('The document server did not return a PDF.', 502);
  return pdf;
}

const pdfName = (title: string) =>
  savedFileName(`${title.replace(/\.(docx|xlsx|pptx)$/i, '')}.pdf`, 'document.pdf');

/** The PDF of the saved revision of a Word file. */
export async function exportOfficePdf(
  userId: string,
  documentId: string,
): Promise<{ bytes: Uint8Array; name: string }> {
  const file = await dependencies.getOfficeFile(userId, documentId);
  if (!file?.version?.url) throw new OfficeError('Word document not found.', 404);
  if (file.extension !== 'docx') throw new OfficeError('PDF export works for Word files only.', 400);
  const response = await dependencies.fetch(file.version.url, {
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  const source = await readOfficeResponse(response);
  return { bytes: await convertOfficeToPdf(source, 'docx'), name: pdfName(file.title) };
}

/** Exports a Word file as PDF and saves the PDF in Files (origin `export`). */
export async function saveOfficePdf(userId: string, documentId: string, workId?: string): Promise<SavedFile> {
  const { bytes, name } = await exportOfficePdf(userId, documentId);
  return dependencies.saveFileBytes({
    userId,
    bytes,
    name,
    contentType: 'application/pdf',
    origin: 'export',
    ...(workId ? { workId } : {}),
  });
}

/** Converts DOCX bytes that are not an Office file (an exported Albatross document) and saves the PDF. */
export async function saveDocxBytesAsPdf(
  userId: string,
  bytes: Uint8Array,
  title: string,
  workId?: string,
): Promise<SavedFile> {
  return dependencies.saveFileBytes({
    userId,
    bytes: await convertOfficeToPdf(bytes, 'docx'),
    name: pdfName(title),
    contentType: 'application/pdf',
    origin: 'export',
    ...(workId ? { workId } : {}),
  });
}
