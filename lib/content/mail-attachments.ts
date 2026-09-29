import { readMailAttachmentBytes } from '../attachments/mail-files';
import { api, convexMutation, convexQuery } from '../hosted/convex';
import { contentVersion } from './cloud-sync';
import { extractContent, MAX_DOWNLOAD_BYTES, supportedContent } from './extract';

const defaults = { convexMutation, convexQuery, readMailAttachmentBytes, extractContent };
export async function syncMailAttachments(userId: string, files: any[], deps = defaults) {
  const unique = [
    ...new Map(
      files
        .filter((file) => file.attachmentId)
        .map((file) => [`${file.connectionId}:${file.messageId}:${file.attachmentId}`, file]),
    ).values(),
  ].slice(0, 100);
  const candidates = unique.map((file) => ({
    file,
    id: JSON.stringify([file.messageId, file.attachmentId]),
    version: contentVersion([file.messageId, file.attachmentId, file.filename, file.size]),
  }));
  if (!candidates.length) return;
  const versions = await deps.convexQuery<Record<string, string | null>>(api.content.versions, {
    userId,
    keys: candidates.map(({ file, id }) => `attachment:${file.connectionId}:${id}`),
  });
  for (const { file, id, version } of candidates
    .filter(({ file, id, version }) => versions[`attachment:${file.connectionId}:${id}`] !== version)
    .slice(0, 8)) {
    let text = '';
    let partial = true;
    if (Number(file.size || 0) <= MAX_DOWNLOAD_BYTES && supportedContent(file.mimeType, file.filename)) {
      try {
        // Our encrypted storage first, so the index does not download a
        // stored file again. A provider file that the queue policy takes is
        // stored on the way.
        const read = await deps.readMailAttachmentBytes(
          {
            userId,
            account: file.connectionId,
            messageId: file.messageId,
            attachmentId: file.attachmentId,
          },
          {
            maxBytes: MAX_DOWNLOAD_BYTES,
            fill: 'policy',
            hint: {
              filename: file.filename,
              mimeType: file.mimeType,
              size: Number(file.size) || undefined,
              receivedAt: Number(file.modifiedAt) || undefined,
            },
          },
        );
        if (read) {
          const parsed = await deps.extractContent(read.bytes, file.mimeType, file.filename);
          text = parsed.text;
          partial = parsed.partial;
        }
      } catch (error) {
        const value = error as {
          name?: string;
          message?: string;
          statusCode?: number;
          status?: number;
          response?: { status?: number };
        };
        const status = Number(value?.statusCode ?? value?.status ?? value?.response?.status);
        const permanent =
          [403, 404, 410].includes(status) ||
          ['InvalidPDFException', 'PasswordException'].includes(value?.name || '') ||
          /size limit|corrupted zip|can't find end of central directory/i.test(value?.message || '');
        if (!permanent) continue;
      }
    }
    await deps.convexMutation(api.content.upsert, {
      userId,
      items: [
        {
          source: 'attachment',
          connectionId: file.connectionId,
          externalId: id,
          title: file.filename,
          text: `${file.filename}\n${text}`,
          version,
          modifiedAt: file.modifiedAt,
          partial,
          deleted: false,
        },
      ],
    });
  }
}
