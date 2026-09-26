import { createHash } from 'node:crypto';
import { mapConcurrent } from '../classifier/client';
import { getCloudFileAccess, listCloudFileConnections } from '../files/connections';
import { api, convexMutation, convexQuery } from '../hosted/convex';
import { boundedBytes, extractContent, MAX_DOWNLOAD_BYTES, supportedContent } from './extract';

const ref = (api as any).content;
class SourceAccessError extends Error {}
class SourceCursorError extends Error {}
class SourceFileUnavailable extends Error {
  constructor(readonly status: number) {
    super('File is unavailable.');
  }
}
export function contentVersion(input: unknown) {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}
export function safeDeltaUrl(value: string) {
  const url = new URL(value);
  if (
    url.origin !== 'https://graph.microsoft.com' ||
    !/^\/v1\.0\/(me\/drive|drives\/[^/]+)\//.test(url.pathname) ||
    url.username ||
    url.password
  )
    throw new Error('Invalid drive continuation.');
  return url.href;
}
const defaults = {
  getCloudFileAccess,
  listCloudFileConnections,
  convexMutation,
  convexQuery,
  fetch,
  extractContent,
};
export async function syncCloudContent(userId: string, deps = defaults, connectionIds?: readonly string[]) {
  const connections = (await deps.listCloudFileConnections(userId)).filter(
    (connection) => !connectionIds || connectionIds.includes(connection.connectionId),
  );
  return mapConcurrent(connections, 2, async (connection) => {
    const claim = await deps.convexMutation<any>(ref.claimSync, {
      userId,
      connectionId: connection.connectionId,
    });
    if (!claim) return { ok: false, pending: true };
    let indexed = 0;
    let skipped = 0;
    let cursor = claim.cursor;
    try {
      if (cursor?.phase === 'reconcile') {
        const result = await deps.convexMutation<any>(ref.reconcileScan, {
          userId,
          connectionId: connection.connectionId,
          lease: claim.lease,
          generation: cursor.generation,
          cursor: cursor.page || undefined,
        });
        await deps.convexMutation(ref.finishSync, {
          userId,
          connectionId: connection.connectionId,
          lease: claim.lease,
          cursor: result.done ? cursor.resume : { ...cursor, page: result.cursor },
          indexed: 0,
          skipped: 0,
          status: result.done ? 'ready' : 'indexing',
        });
        return { ok: true, pending: !result.done };
      }
      const access = await deps.getCloudFileAccess({ userId, connectionId: connection.connectionId });
      if (!access) throw new SourceAccessError('Reconnect to resume indexing.');
      async function request(url: string, file = false) {
        const response = await deps.fetch(url, {
          headers: { Authorization: `Bearer ${access!.accessToken}` },
          signal: AbortSignal.timeout(15_000),
          cache: 'no-store',
        });
        if (file && [403, 404].includes(response.status)) throw new SourceFileUnavailable(response.status);
        if ([401, 403].includes(response.status))
          throw new SourceAccessError('Reconnect or check access to this source.');
        if (response.status === 410) throw new SourceCursorError('Restarting expired change cursor.');
        if (!response.ok) throw new Error('Source temporarily unavailable.');
        return response;
      }
      let files: any[];
      let next: any;
      if (cursor?.pending) {
        files = cursor.pending;
        next = cursor.next;
      } else if (connection.provider === 'google_drive') {
        if (!cursor) {
          const start = await (
            await request('https://www.googleapis.com/drive/v3/changes/startPageToken?supportsAllDrives=true')
          ).json();
          cursor = { phase: 'backfill', token: start.startPageToken, generation: crypto.randomUUID() };
        }
        const changes = cursor.phase === 'changes';
        const url = new URL(`https://www.googleapis.com/drive/v3/${changes ? 'changes' : 'files'}`);
        url.searchParams.set('pageSize', '20');
        url.searchParams.set('supportsAllDrives', 'true');
        url.searchParams.set('includeItemsFromAllDrives', 'true');
        const fields = 'id,name,mimeType,modifiedTime,webViewLink,size,version,trashed';
        url.searchParams.set(
          'fields',
          changes
            ? `nextPageToken,newStartPageToken,changes(fileId,removed,file(${fields}))`
            : `nextPageToken,files(${fields})`,
        );
        if (changes) url.searchParams.set('pageToken', cursor.page || cursor.token);
        else {
          url.searchParams.set('q', 'trashed = false');
          url.searchParams.set('orderBy', 'modifiedTime desc');
          if (cursor.page) url.searchParams.set('pageToken', cursor.page);
        }
        const data = await (await request(url.href)).json();
        files = changes
          ? (data.changes || []).map((c: any) => ({ ...c.file, id: c.fileId, removed: c.removed }))
          : data.files || [];
        next = data.nextPageToken
          ? { ...cursor, page: data.nextPageToken }
          : { phase: 'changes', token: data.newStartPageToken || cursor.token };
      } else {
        if (!cursor) cursor = { generation: crypto.randomUUID() };
        const url = cursor?.url
          ? safeDeltaUrl(cursor.url)
          : 'https://graph.microsoft.com/v1.0/me/drive/root/delta?$top=20';
        const data = await (await request(url)).json();
        files = data.value || [];
        next = {
          url: safeDeltaUrl(data['@odata.nextLink'] || data['@odata.deltaLink']),
          ...(data['@odata.nextLink'] && cursor.generation ? { generation: cursor.generation } : {}),
        };
      }
      // Bound downloads per run, retaining the actual remaining metadata so
      // a changing provider page cannot make an offset skip a file.
      const remaining = files.slice(8);
      files = files.slice(0, 8);
      const items = [];
      const versions = await deps.convexQuery<Record<string, string | null>>(ref.versions, {
        userId,
        keys: files
          .filter((file) => file.id)
          .map((file) => `${connection.provider}:${connection.connectionId}:${file.id}`)
          .slice(0, 100),
      });
      for (const file of files) {
        if (!file.id || file.folder || file.mimeType === 'application/vnd.google-apps.folder') continue;
        let deleted = Boolean(file.removed || file.deleted || file.trashed);
        const mime = file.mimeType || file.file?.mimeType || '';
        const title = file.name || '(removed file)';
        let version = contentVersion([
          1,
          file.version || file.eTag || file.cTag || file.modifiedTime || file.lastModifiedDateTime,
          title,
          mime,
          deleted,
        ]);
        if (versions[`${connection.provider}:${connection.connectionId}:${file.id}`] === version) continue;
        let text = '';
        let partial = false;
        if (!deleted && supportedContent(mime, title) && Number(file.size || 0) <= MAX_DOWNLOAD_BYTES) {
          let url: string;
          let readMime = mime;
          let readName = title;
          if (connection.provider === 'google_drive') {
            const exports: Record<string, string> = {
              'application/vnd.google-apps.document': 'text/plain',
              'application/vnd.google-apps.spreadsheet':
                'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
              'application/vnd.google-apps.presentation':
                'application/vnd.openxmlformats-officedocument.presentationml.presentation',
            };
            const exportMime = exports[mime];
            readMime = exportMime || mime;
            readName = mime.endsWith('.presentation')
              ? `${title}.pptx`
              : mime.endsWith('.spreadsheet')
                ? `${title}.xlsx`
                : title;
            url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}${exportMime ? `/export?mimeType=${encodeURIComponent(exportMime)}` : '?alt=media&supportsAllDrives=true'}`;
          } else
            url = `https://graph.microsoft.com/v1.0/me/drive/items/${encodeURIComponent(file.id)}/content`;
          try {
            const bytes = await boundedBytes(await request(url, true));
            const parsed = await deps
              .extractContent(bytes, readMime, readName)
              .catch(() => ({ text: '', partial: true }));
            text = parsed.text;
            partial = parsed.partial;
          } catch (error) {
            if (error instanceof SourceAccessError) throw error;
            if (error instanceof SourceFileUnavailable) {
              deleted = error.status === 404;
              partial = !deleted;
              // A file-level download restriction must not block the account's
              // change feed or keep its previously cached body searchable.
              version += `:unavailable-${error.status}`;
            } else {
              // Retry the same source page after transient failures.
              if (!(error instanceof Error && /size limit/.test(error.message))) throw error;
              partial = true;
            }
            skipped++;
          }
        } else if (!deleted) {
          partial = true;
          skipped++;
        }
        items.push({
          source: connection.provider,
          connectionId: connection.connectionId,
          externalId: file.id,
          title,
          text: deleted ? '' : `${title}\n${text}`,
          url: file.webViewLink || file.webUrl,
          version,
          modifiedAt: Date.parse(file.modifiedTime || file.lastModifiedDateTime) || Date.now(),
          partial,
          deleted,
        });
      }
      for (let start = 0; start < items.length; start += 5)
        indexed += (
          await deps.convexMutation<any>(ref.upsert, { userId, items: items.slice(start, start + 5) })
        ).changed;
      if (cursor?.generation)
        await deps.convexMutation(ref.reconcileScan, {
          userId,
          connectionId: connection.connectionId,
          lease: claim.lease,
          generation: cursor.generation,
          keys: files
            .filter((file) => file.id)
            .map((file) => `${connection.provider}:${connection.connectionId}:${file.id}`),
        });
      if (remaining.length) next = { generation: cursor?.generation, pending: remaining, next };
      else if (cursor?.generation && !next.generation)
        next = { phase: 'reconcile', generation: cursor.generation, resume: next };
      const pending =
        next.phase === 'backfill' || next.phase === 'reconcile' || Boolean(next.pending || next.generation);
      await deps.convexMutation(ref.finishSync, {
        userId,
        connectionId: connection.connectionId,
        lease: claim.lease,
        cursor: next,
        indexed,
        skipped,
        status: pending ? 'indexing' : 'ready',
      });
      return { ok: true, pending };
    } catch (error) {
      await deps.convexMutation(ref.finishSync, {
        userId,
        connectionId: connection.connectionId,
        lease: claim.lease,
        cursor: error instanceof SourceCursorError ? null : cursor,
        indexed,
        skipped,
        status: error instanceof SourceAccessError ? 'access_lost' : 'error',
        error:
          error instanceof SourceAccessError
            ? error.message
            : 'Sync interrupted; the saved cursor will retry.',
      });
      return { ok: false, pending: true };
    }
  });
}
