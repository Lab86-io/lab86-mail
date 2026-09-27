import { api, convexMutation, convexQuery } from '../hosted/convex';
import { downloadNylasAttachment } from '../nylas/provider';
import { contentVersion } from './cloud-sync';
import { boundedBytes, extractContent, MAX_DOWNLOAD_BYTES, supportedContent } from './extract';

const defaults = { convexMutation, convexQuery, downloadNylasAttachment, extractContent };
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
        const stream = await deps.downloadNylasAttachment({
          userId,
          account: file.connectionId,
          messageId: file.messageId,
          attachmentId: file.attachmentId,
        });
        if (stream) {
          const parsed = await deps.extractContent(
            await boundedBytes(new Response(stream)),
            file.mimeType,
            file.filename,
          );
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
