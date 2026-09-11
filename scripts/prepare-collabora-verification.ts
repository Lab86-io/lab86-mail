import { writeFileSync } from 'node:fs';
import { startCollaboraSession } from '../lib/documents/collabora';
import { exportDocument } from '../lib/documents/export';
import { createDefaultDocumentModel } from '../lib/documents/model';
import { validateOfficeArchive } from '../lib/documents/office-security';
import { createOfficeFile, getOfficeFile, storeOfficeBytes } from '../lib/documents/office-service';

const userId = `office-verification-${crypto.randomUUID()}`;
const files = [];
for (const kind of ['doc', 'sheet', 'deck'] as const) {
  const exported = await exportDocument({
    documentId: 'synthetic',
    title: 'Albatross verification',
    kind,
    model: createDefaultDocumentModel(kind),
    currentRevision: 1,
    sourceRefs: [],
    createdAt: 1,
    updatedAt: 1,
  });
  const bytes = new Uint8Array(exported.bytes);
  const storageId = await storeOfficeBytes(userId, bytes, exported.extension);
  const created = await createOfficeFile({
    userId,
    title: `Albatross verification.${exported.extension}`,
    extension: exported.extension,
    storageId,
    size: bytes.length,
    sha256: validateOfficeArchive(bytes, exported.extension),
  });
  const file = await getOfficeFile(userId, created.documentId);
  if (!file) throw new Error('Synthetic copy missing.');
  const session = await startCollaboraSession(userId, file);
  files.push({ kind, documentId: created.documentId, session });
  console.log(`${kind.toUpperCase()}: synthetic working copy and signed editor session created.`);
}
writeFileSync('/tmp/chat-doc-collabora-sessions.json', JSON.stringify({ userId, files }), { mode: 0o600 });
