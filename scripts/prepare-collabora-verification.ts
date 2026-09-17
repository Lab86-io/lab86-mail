import { chmodSync, rmSync, writeFileSync } from 'node:fs';
import { startCollaboraSession } from '../lib/documents/collabora';
import { exportDocument } from '../lib/documents/export';
import { createDefaultDocumentModel } from '../lib/documents/model';
import { validateOfficeArchive } from '../lib/documents/office-security';
import { createOfficeFile, getOfficeFile, storeOfficeBytes } from '../lib/documents/office-service';
import { buildRichDocxFixture } from '../lib/documents/rich-docx-fixture';

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
// A rich Word file proves save and reopen on a table, an image, comments,
// a header and a footer, not only on a blank document.
{
  const bytes = await buildRichDocxFixture();
  const storageId = await storeOfficeBytes(userId, bytes, 'docx');
  const created = await createOfficeFile({
    userId,
    title: 'Albatross rich verification.docx',
    extension: 'docx',
    storageId,
    size: bytes.length,
    sha256: validateOfficeArchive(bytes, 'docx'),
  });
  const file = await getOfficeFile(userId, created.documentId);
  if (!file) throw new Error('Synthetic rich copy missing.');
  const session = await startCollaboraSession(userId, file);
  files.push({ kind: 'doc', rich: true, documentId: created.documentId, session });
  console.log('RICH DOCX: synthetic working copy and signed editor session created.');
}
const path = '/tmp/chat-doc-collabora-sessions.json';
rmSync(path, { force: true });
writeFileSync(path, JSON.stringify({ userId, files }), { mode: 0o600, flag: 'wx' });
chmodSync(path, 0o600);
