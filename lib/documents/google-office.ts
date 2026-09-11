import { createHash } from 'node:crypto';
import { api, convexMutation, convexQuery } from '@/lib/hosted/convex';
import { decryptSecret } from '@/lib/security/crypto';
import { downloadGoogleWorkingCopy, saveGoogleWorkingCopy } from './google-working-copy';
import { OfficeError, readOfficeResponse, validateOfficeArchive } from './office-security';
import { createOfficeFile, getOfficeFile, type OfficeFile, storeOfficeBytes } from './office-service';

const defaults = {
  convexMutation,
  convexQuery,
  decryptSecret,
  downloadGoogleWorkingCopy,
  saveGoogleWorkingCopy,
  createOfficeFile,
  getOfficeFile,
  storeOfficeBytes,
  fetch: (...args: Parameters<typeof fetch>) => fetch(...args),
};
let deps = defaults;
export function __setGoogleOfficeDepsForTest(overrides: Partial<typeof defaults> = {}) {
  deps = { ...defaults, ...overrides };
}
const office = (api as any).officeDocuments;
function version(session: string) {
  return JSON.parse(deps.decryptSecret(session)) as {
    userId: string;
    connectionId: string;
    fileId: string;
    etag: string;
    version: string;
  };
}
function sameVersion(a: ReturnType<typeof version>, b: ReturnType<typeof version>) {
  return a.etag === b.etag && a.version === b.version;
}

/** Reuse one working-copy identity, retaining dirty edits when Google changes. */
export async function openGoogleOfficeFile(input: { userId: string; connectionId: string; fileId: string }) {
  const copy = await deps.downloadGoogleWorkingCopy(input);
  const stableId = `google-${createHash('sha256')
    .update(JSON.stringify([input.userId, input.connectionId, input.fileId]))
    .digest('hex')
    .slice(0, 40)}`;
  let existing = await deps.getOfficeFile(input.userId, stableId);
  if (!existing) {
    // Reuse an older etag-based identity as well; never delete a user's recovery copies.
    const legacy = await deps.convexQuery<{ documentId: string } | null>(office.findGoogle, input);
    if (legacy) existing = await deps.getOfficeFile(input.userId, legacy.documentId);
  }
  if (existing?.google?.pendingSave) existing = await recoverPendingSave(input.userId, existing);
  if (existing?.google) {
    const documentId = existing.documentId;
    const expectedSession = existing.google.session;
    const changed = !sameVersion(version(expectedSession), version(copy.session));
    if (!changed) {
      const linked = await deps.convexMutation<{ ok: boolean }>(office.linkGoogle, {
        userId: input.userId,
        documentId,
        expectedSession,
        session: copy.session,
        syncedRevision: existing.google.syncedRevision,
        providerVersion: version(copy.session).version,
      });
      if (!linked.ok)
        throw new OfficeError('The working copy changed while opening. Try opening it again.', 409);
    } else {
      if (
        existing.currentRevision !== existing.google.syncedRevision ||
        (existing.wopiLock && existing.wopiLock.expiresAt > Date.now())
      )
        throw new OfficeError(
          'Google changed while this working copy has edits or an open editor. Your edits are preserved; close the editor and resolve them before importing Google changes.',
          409,
        );
      const sha256 = validateOfficeArchive(copy.bytes, copy.extension);
      const storageId = await deps.storeOfficeBytes(input.userId, copy.bytes, copy.extension);
      const refreshed = await deps.convexMutation<{ ok: boolean }>(office.refreshGoogle, {
        userId: input.userId,
        documentId,
        expectedSession,
        expectedRevision: existing.currentRevision,
        session: copy.session,
        storageId,
        sha256,
        size: copy.bytes.length,
        title: copy.title,
        extension: copy.extension,
      });
      if (!refreshed.ok)
        throw new OfficeError(
          'The working copy changed while importing Google updates. Try opening it again.',
          409,
        );
    }
    return { documentId, created: false };
  }
  const sha256 = validateOfficeArchive(copy.bytes, copy.extension);
  const storageId = await deps.storeOfficeBytes(input.userId, copy.bytes, copy.extension);
  await deps.createOfficeFile({
    userId: input.userId,
    documentId: stableId,
    title: copy.title,
    extension: copy.extension,
    storageId,
    size: copy.bytes.length,
    sha256,
    google: {
      connectionId: input.connectionId,
      fileId: input.fileId,
      session: copy.session,
      syncedRevision: 1,
    },
  });
  return { documentId: stableId, created: true };
}

/** Preserve a successful provider write's version token without replacing newer state. */
async function reconcileGoogleSession(userId: string, file: OfficeFile, refreshedSession: string) {
  const refreshed = version(refreshedSession);
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await deps.getOfficeFile(userId, file.documentId);
    if (!current?.google) return;
    const latest = version(current.google.session);
    if (
      latest.userId !== refreshed.userId ||
      latest.connectionId !== refreshed.connectionId ||
      latest.fileId !== refreshed.fileId
    )
      return;
    // Google versions are monotonic decimal integers. A competing later save wins.
    if (!/^\d+$/.test(latest.version) || !/^\d+$/.test(refreshed.version)) return;
    const newer = BigInt(latest.version) > BigInt(refreshed.version);
    const linked = await deps.convexMutation<{ ok: boolean }>(office.linkGoogle, {
      userId,
      documentId: file.documentId,
      expectedSession: current.google.session,
      session: newer ? current.google.session : refreshedSession,
      syncedRevision: newer ? current.google.syncedRevision : file.currentRevision,
      providerVersion: newer ? latest.version : refreshed.version,
    });
    if (linked.ok) return;
  }
}

/** Resume a previously completed provider write before opening or saving again. */
async function recoverPendingSave(userId: string, file: OfficeFile) {
  const pending = file.google?.pendingSave;
  if (!pending) return file;
  await reconcileGoogleSession(userId, { ...file, currentRevision: pending.revision }, pending.session);
  const current = await deps.getOfficeFile(userId, file.documentId);
  if (!current || current.google?.pendingSave)
    throw new OfficeError(
      'Google save reconciliation is still pending. Your saved revision is preserved; try again shortly.',
      409,
    );
  return current;
}

/** Update the original only after its exact WOPI receipt is durable. */
export async function saveGoogleOfficeFile(userId: string, documentId: string, saveId: unknown) {
  if (typeof saveId !== 'string' || !saveId || saveId.length > 80)
    throw new OfficeError('Save the editor copy before updating Google.');
  let file = await deps.getOfficeFile(userId, documentId);
  if (file?.google?.pendingSave) file = await recoverPendingSave(userId, file);
  if (!file?.google || !file.version?.url) throw new OfficeError('Google working copy not found.', 404);
  if (file.lastWopiSave?.id !== saveId)
    throw new OfficeError('The editor is still saving. Wait for the upload to finish, then try again.', 409);
  if (file.google.syncedRevision === file.currentRevision)
    return { ok: true, revision: file.currentRevision };
  const response = await deps.fetch(file.version.url, {
    signal: AbortSignal.timeout(45_000),
    redirect: 'error',
  });
  const bytes = await readOfficeResponse(response);
  const result = await deps.saveGoogleWorkingCopy({
    userId,
    session: file.google.session,
    bytes,
    extension: file.extension,
  });
  const linked = await deps.convexMutation<{ ok: boolean }>(office.linkGoogle, {
    userId,
    documentId,
    expectedSession: file.google.session,
    session: result.session,
    syncedRevision: file.currentRevision,
    providerVersion: version(result.session).version,
  });
  if (!linked.ok) {
    await reconcileGoogleSession(userId, file, result.session);
    throw new OfficeError(
      'Google saved this revision, but the working copy changed. Reopen it before saving again.',
      409,
    );
  }
  return { ok: true, revision: file.currentRevision, webUrl: result.webUrl };
}
