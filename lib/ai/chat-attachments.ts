/** Shared picker/upload rules. MIME hints are normalized for browsers that omit them. */
export const MAX_CHAT_FILES = 5;
export const MAX_CHAT_BYTES = 25 * 1024 * 1024;
const extensions: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  pdf: 'application/pdf',
  txt: 'text/plain',
  csv: 'text/csv',
  md: 'text/markdown',
  json: 'application/json',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};
export const CHAT_FILE_ACCEPT = Object.keys(extensions)
  .map((ext) => `.${ext}`)
  .join(',');
export function chatFileType(file: { name: string; type?: string }) {
  const type = file.type?.toLowerCase();
  return type && Object.values(extensions).includes(type)
    ? type
    : extensions[file.name.split('.').pop()?.toLowerCase() || ''];
}
export function validateChatFiles(
  files: Array<{ name: string; type?: string; size: number }>,
): string | null {
  if (files.length > MAX_CHAT_FILES) return `Attach at most ${MAX_CHAT_FILES} files per message.`;
  if (files.reduce((sum, file) => sum + file.size, 0) > MAX_CHAT_BYTES)
    return 'Attachments must total 25 MB or less.';
  for (const file of files) {
    if (!file.size) return `${file.name} is empty. Choose a file with content.`;
    if (!chatFileType(file))
      return `${file.name} is not supported. Use an image, PDF, text, CSV, DOCX, XLSX, or PPTX file.`;
  }
  return null;
}
export function chatUploadPath(uploadId: string) {
  return `/api/agent/uploads/${encodeURIComponent(uploadId)}`;
}
export function chatUploadId(url: string): string | null {
  const match = /^\/api\/agent\/uploads\/([a-zA-Z0-9_-]+)$/.exec(url);
  return match?.[1] || null;
}

export function isChatAttachmentUrl(url: string): boolean {
  if (chatUploadId(url)) return true;
  const inline = /^data:([^;,]+);base64,[a-zA-Z0-9+/=\r\n]+$/.exec(url);
  return Boolean(inline && chatFileType({ name: '', type: inline[1] }) === inline[1]);
}
