import { randomUUID } from 'node:crypto';
import { api, convexMutation } from '@/lib/hosted/convex';
import { exportDocument } from './export';
import { OfficeError, readOfficeResponse, validateOfficeArchive } from './office-security';
import { createOfficeFile, getOfficeFile, requireOffice, storeOfficeBytes } from './office-service';
import { getDocument } from './service';
import { createWordPackage, editWordPackage, readWordPackage, type WordEdit } from './word-package';

const defaults = {
  requireOffice,
  getDocument,
  exportDocument,
  getOfficeFile,
  createOfficeFile,
  storeOfficeBytes,
  convexMutation,
  fetch: (...args: Parameters<typeof fetch>) => fetch(...args),
  randomUUID,
  now: () => Date.now(),
  wait: (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),
};
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
      input: { title: string; edits?: WordEdit[]; sourceDocumentId?: string; expectedRevision?: number },
    ) {
      deps.requireOffice();
      let title = input.title.trim() || 'Untitled document';
      let bytes: Uint8Array;
      if (input.sourceDocumentId) {
        const source = await deps.getDocument(userId, input.sourceDocumentId);
        if (!source || source.kind !== 'doc') throw new OfficeError('Source document not found.', 404);
        if (source.currentRevision !== input.expectedRevision)
          throw new OfficeError('The source changed. Save and reopen the latest version first.', 409);
        title = source.title;
        bytes = (await deps.exportDocument(source)).bytes;
        if (input.edits?.length) bytes = await editWordPackage(bytes, input.edits);
      } else bytes = await createWordPackage(title, input.edits);
      const sha256 = validateOfficeArchive(bytes, 'docx');
      const storageId = await deps.storeOfficeBytes(userId, bytes, 'docx');
      const file = await deps.createOfficeFile({
        userId,
        title: `${title.replace(/\.docx$/i, '')}.docx`,
        extension: 'docx',
        storageId,
        size: bytes.length,
        sha256,
      });
      return {
        ok: true as const,
        documentId: file.documentId,
        title: file.title,
        revision: file.currentRevision,
        openPath: `/?view=files&office=${encodeURIComponent(file.documentId)}`,
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
    async edit(userId: string, documentId: string, expectedRevision: number, edits: WordEdit[]) {
      deps.requireOffice();
      let { file, bytes } = await load(userId, documentId);
      if (file.currentRevision !== expectedRevision)
        throw new OfficeError('The document changed. Read the latest revision before editing.', 409);
      let requestId: string | undefined;
      let complete = false;
      const coordinate = (action: 'request' | 'complete' | 'fail') =>
        deps.convexMutation<{ ok: boolean; ready?: boolean }>((api as any).officeDocuments.coordinateEdit, {
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
        const updated = await editWordPackage(bytes, edits);
        const sha256 = validateOfficeArchive(updated, 'docx');
        if (sha256 === file.version?.sha256)
          throw new OfficeError('The requested edits did not change the document.');
        const storageId = await deps.storeOfficeBytes(userId, updated, 'docx');
        const result = await deps.convexMutation<{ ok: boolean; revision?: number; code?: string }>(
          (api as any).officeDocuments.saveEditedVersion,
          {
            userId,
            documentId,
            expectedRevision,
            storageId,
            size: updated.length,
            sha256,
            ...(requestId ? { requestId } : {}),
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
        };
      } finally {
        if (requestId) await coordinate(complete ? 'complete' : 'fail').catch(() => undefined);
      }
    },
  };
}
export const wordDocuments = createWordService();
