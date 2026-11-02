import { createHash, randomUUID } from 'node:crypto';
import { api, convexMutation } from '@/lib/hosted/convex';
import { exportDocument } from './export';
import { OfficeError, readOfficeResponse, validateOfficeArchive } from './office-security';
import {
  createOfficeFile,
  getOfficeFile,
  type OfficeTemplateRecord,
  requireOffice,
  storeOfficeBytes,
} from './office-service';
import { verifyOfficePackage } from './office-verify';
import { documentExecution, getDocument } from './service';
import { type DocumentTemplate, renderTemplate } from './templates';
import {
  applyInvoiceBlanks,
  InvoiceBlankError,
  type InvoiceData,
  invoiceDataSchema,
} from './templates/invoice';
import {
  createWordPackage,
  editWordPackage,
  emptyWordBlanks,
  readWordBlanks,
  readWordPackage,
  type WordEdit,
} from './word-package';

const defaults = {
  requireOffice,
  getDocument,
  exportDocument,
  renderTemplate,
  documentExecution,
  getOfficeFile,
  createOfficeFile,
  storeOfficeBytes,
  convexMutation,
  fetch: (...args: Parameters<typeof fetch>) => fetch(...args),
  randomUUID,
  now: () => Date.now(),
  wait: (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),
};
function applyInvoiceFills(data: InvoiceData, fills: ReadonlyArray<Extract<WordEdit, { op: 'fill_blank' }>>) {
  try {
    return applyInvoiceBlanks(data, fills);
  } catch (error) {
    if (error instanceof InvoiceBlankError) throw new OfficeError(error.message);
    throw error;
  }
}

const CHANGED_SINCE_RENDER_NOTE =
  'This file changed after the server rendered it, so the amounts and the totals did not update. Check them.';
const sha256Of = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

export function createWordService(overrides: Partial<typeof defaults> = {}) {
  const deps = { ...defaults, ...overrides };
  const load = async (userId: string, documentId: string) => {
    const file = await deps.getOfficeFile(userId, documentId);
    if (!file?.version?.url || file.extension !== 'docx')
      throw new OfficeError('Word document not found.', 404);
    const response = await deps.fetch(file.version.url, {
      redirect: 'error',
      signal: AbortSignal.timeout(45_000),
    });
    return { file, bytes: await readOfficeResponse(response) };
  };
  return {
    async create(
      userId: string,
      input: {
        title: string;
        edits?: WordEdit[];
        sourceDocumentId?: string;
        expectedRevision?: number;
        template?: DocumentTemplate;
        data?: unknown;
      },
      options: { signal?: AbortSignal } = {},
    ) {
      deps.requireOffice();
      options.signal?.throwIfAborted();
      let title = input.title.trim() || 'Untitled document';
      let bytes: Uint8Array;
      if (input.template) {
        if (input.sourceDocumentId) throw new OfficeError('Use a template or a source document, not both.');
        bytes = (await deps.renderTemplate(input.template, input.data ?? {}, { title })).bytes;
        if (input.edits?.length) bytes = await editWordPackage(bytes, input.edits);
      } else if (input.sourceDocumentId) {
        const source = await deps.getDocument(userId, input.sourceDocumentId);
        if (!source || source.kind !== 'doc') throw new OfficeError('Source document not found.', 404);
        if (source.currentRevision !== input.expectedRevision)
          throw new OfficeError('The source changed. Save and reopen the latest version first.', 409);
        title = source.title;
        bytes = (await deps.exportDocument(source)).bytes;
        if (input.edits?.length) bytes = await editWordPackage(bytes, input.edits);
      } else bytes = await createWordPackage(title, input.edits);
      const sha256 = validateOfficeArchive(bytes, 'docx');
      await verifyOfficePackage(bytes, 'docx');
      // The blanks still empty after any edits, in page order (the package item `blanks`).
      const blanks = input.template
        ? (await readWordBlanks(bytes)).filter((blank) => !blank.filled).map((blank) => blank.name)
        : undefined;
      // An invoice keeps its data, so that fill_blank can render it again with computed totals.
      const data =
        input.template === 'invoice' && !input.edits?.length
          ? invoiceDataSchema.parse(input.data)
          : undefined;
      // Stop means that no file lands: check before the upload and before the commit.
      options.signal?.throwIfAborted();
      const storageId = await deps.storeOfficeBytes(userId, bytes, 'docx');
      options.signal?.throwIfAborted();
      const execution = deps.documentExecution();
      const file = await deps.createOfficeFile({
        userId,
        title: `${title.replace(/\.docx$/i, '')}.docx`,
        extension: 'docx',
        storageId,
        size: bytes.length,
        sha256,
        ...(data
          ? { template: { kind: 'invoice' as const, dataJson: JSON.stringify(data), renderedSha256: sha256 } }
          : {}),
        ...(execution ? { execution } : {}),
      });
      return {
        ok: true as const,
        documentId: file.documentId,
        title: file.title,
        revision: file.currentRevision,
        openPath: `/?view=files&office=${encodeURIComponent(file.documentId)}`,
        ...(input.template ? { template: input.template, blanks: blanks ?? [] } : {}),
      };
    },
    async read(userId: string, documentId: string) {
      const { file, bytes } = await load(userId, documentId);
      return {
        ok: true as const,
        documentId,
        title: file.title,
        revision: file.currentRevision,
        ...(await readWordPackage(bytes)),
        openPath: `/?view=files&office=${encodeURIComponent(documentId)}`,
      };
    },
    async edit(
      userId: string,
      documentId: string,
      expectedRevision: number,
      edits: WordEdit[],
      options: { signal?: AbortSignal } = {},
    ) {
      deps.requireOffice();
      options.signal?.throwIfAborted();
      let { file, bytes } = await load(userId, documentId);
      if (file.currentRevision !== expectedRevision)
        throw new OfficeError('The document changed. Read the latest revision before editing.', 409);
      let requestId: string | undefined;
      let complete = false;
      const coordinate = (action: 'request' | 'complete' | 'fail') =>
        deps.convexMutation<{ ok: boolean; ready?: boolean }>(api.officeDocuments.coordinateEdit, {
          userId,
          documentId,
          requestId: requestId!,
          action,
        });
      try {
        if (file.wopiLock && file.wopiLock.expiresAt > deps.now()) {
          requestId = deps.randomUUID();
          const requested = await coordinate('request');
          if (!requested.ok) {
            requestId = undefined;
            throw new OfficeError('Another edit is already running for this document.', 409);
          }
          if (!requested.ready) {
            const deadline = deps.now() + 55_000;
            let prepared = false;
            while (deps.now() < deadline) {
              options.signal?.throwIfAborted();
              await deps.wait(500);
              const current = await deps.getOfficeFile(userId, documentId);
              if (current?.aiEdit?.id !== requestId || current.aiEdit.state === 'failed')
                throw new OfficeError(
                  'The editor could not prepare the document. Its saved content has not been changed.',
                  409,
                );
              if (
                current.aiEdit.state === 'prepared' &&
                (!current.wopiLock || current.wopiLock.expiresAt <= deps.now())
              ) {
                prepared = true;
                break;
              }
            }
            if (!prepared)
              throw new OfficeError(
                'The open editor did not finish preparing this edit. Keep it connected and retry.',
                409,
              );
          } else requestId = undefined;
          ({ file, bytes } = await load(userId, documentId));
          if (file.currentRevision !== expectedRevision)
            throw new OfficeError(
              `The editor autosaved new changes as revision ${file.currentRevision}. Read word_document_get again and apply the edit against that revision.`,
              409,
            );
        }
        const fills = edits.flatMap((edit) => (edit.op === 'fill_blank' ? [edit] : []));
        const notes: string[] = [];
        let updated: Uint8Array;
        let template: OfficeTemplateRecord | undefined;
        // The stored data matches the file only while no other save has changed the file.
        if (fills.length && file.template?.renderedSha256 === file.version?.sha256 && file.template) {
          if (fills.length !== edits.length)
            throw new OfficeError(
              'An invoice renders again from its data. Send fill_blank edits by themselves, and send other edits after them.',
            );
          const data = applyInvoiceFills(JSON.parse(file.template.dataJson), fills);
          updated = (
            await deps.renderTemplate('invoice', data, { title: file.title.replace(/\.docx$/i, '') })
          ).bytes;
          await verifyOfficePackage(updated, 'docx');
          template = { kind: 'invoice', dataJson: JSON.stringify(data), renderedSha256: sha256Of(updated) };
        } else {
          updated = await editWordPackage(bytes, edits);
          if (fills.length && file.template) notes.push(CHANGED_SINCE_RENDER_NOTE);
        }
        const sha256 = validateOfficeArchive(updated, 'docx');
        if (sha256 === file.version?.sha256)
          throw new OfficeError('The requested edits did not change the document.');
        const blanks = fills.length ? await emptyWordBlanks(updated) : undefined;
        // Stop means that no revision lands: check before the upload and before the commit.
        options.signal?.throwIfAborted();
        const storageId = await deps.storeOfficeBytes(userId, updated, 'docx');
        options.signal?.throwIfAborted();
        const execution = deps.documentExecution();
        const result = await deps.convexMutation<{ ok: boolean; revision?: number; code?: string }>(
          api.officeDocuments.saveEditedVersion,
          {
            userId,
            documentId,
            expectedRevision,
            storageId,
            size: updated.length,
            sha256,
            ...(requestId ? { requestId } : {}),
            ...(template ? { template } : {}),
            ...(execution ? { execution } : {}),
          },
        );
        if (!result.ok)
          throw new OfficeError(
            result.code === 'LOCKED'
              ? 'The word processor changed while Albatross was editing. Read the latest revision and retry.'
              : 'The document changed while Albatross was editing. Read the latest revision and retry.',
            409,
          );
        complete = true;
        return {
          ok: true as const,
          title: file.title,
          documentId,
          revision: result.revision!,
          openPath: `/?view=files&office=${encodeURIComponent(documentId)}`,
          ...(blanks ? { blanks } : {}),
          ...(notes.length ? { notes } : {}),
        };
      } finally {
        if (requestId) await coordinate(complete ? 'complete' : 'fail').catch(() => undefined);
      }
    },
  };
}
export const wordDocuments = createWordService();
