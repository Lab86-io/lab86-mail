import { formatBytes } from '@/lib/shared/files';

export type AttachmentPreviewKind =
  | 'image'
  | 'pdf'
  | 'text'
  | 'code'
  | 'video'
  | 'audio'
  | 'office'
  | 'archive'
  | 'calendar'
  | 'email'
  | 'unknown';

export type AttachmentPreviewItem = {
  filename: string;
  mime: string;
  meta: string;
  previewLabel: string;
  downloadHref: string;
  previewHref: string;
  previewKind: AttachmentPreviewKind;
};

type AttachmentPreviewInput = {
  filename?: string | null;
  mimeType?: string | null;
  size?: number | null;
  downloadHref: string;
  previewHref: string;
};

const IMAGE_EXTENSIONS = new Set(['avif', 'bmp', 'gif', 'heic', 'jpeg', 'jpg', 'png', 'svg', 'webp']);
const TEXT_EXTENSIONS = new Set(['csv', 'log', 'md', 'markdown', 'rtf', 'tab', 'tsv', 'txt']);
const CODE_EXTENSIONS = new Set(['css', 'html', 'js', 'json', 'jsx', 'ts', 'tsx', 'xml', 'yaml', 'yml']);
const OFFICE_EXTENSIONS = new Set([
  'doc',
  'docx',
  'key',
  'numbers',
  'pages',
  'potx',
  'ppsx',
  'ppt',
  'pptx',
  'xls',
  'xlsm',
  'xlsx',
]);
const ARCHIVE_EXTENSIONS = new Set(['7z', 'bz2', 'gz', 'rar', 'tar', 'tgz', 'xz', 'zip']);

export function attachmentPreviewKind(
  mimeType: string | null | undefined,
  filename: string | null | undefined,
): AttachmentPreviewKind {
  const mime = String(mimeType || '').toLowerCase();
  const ext = extensionFromFilename(filename);

  if (mime.startsWith('image/') || IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (mime === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (mime.startsWith('video/') || ['mov', 'mp4', 'm4v', 'webm'].includes(ext)) return 'video';
  if (mime.startsWith('audio/') || ['aac', 'aiff', 'flac', 'm4a', 'mp3', 'ogg', 'wav'].includes(ext)) {
    return 'audio';
  }
  if (mime === 'text/calendar' || mime === 'application/ics' || ext === 'ics') return 'calendar';
  if (mime === 'message/rfc822' || ext === 'eml') return 'email';
  if (isOfficeMime(mime) || OFFICE_EXTENSIONS.has(ext)) return 'office';
  if (isArchiveMime(mime) || ARCHIVE_EXTENSIONS.has(ext)) return 'archive';
  if (isCodeMime(mime) || CODE_EXTENSIONS.has(ext)) return 'code';
  if (mime.startsWith('text/') || TEXT_EXTENSIONS.has(ext)) return 'text';
  return 'unknown';
}

export function buildAttachmentPreviewItem(input: AttachmentPreviewInput): AttachmentPreviewItem {
  const filename = input.filename?.trim() || 'Attachment';
  const mime = input.mimeType?.trim() || 'application/octet-stream';
  const previewKind = attachmentPreviewKind(mime, filename);
  const ext = extensionFromFilename(filename).slice(0, 6).toUpperCase();
  const meta = [attachmentKindLabel(previewKind, ext), formatBytes(input.size || 0)]
    .filter(Boolean)
    .join(' · ');
  return {
    filename,
    mime,
    meta,
    previewLabel: attachmentKindLabel(previewKind, ext) || 'File',
    downloadHref: input.downloadHref,
    previewHref: input.previewHref,
    previewKind,
  };
}

export function canEmbedAttachmentPreview(kind: AttachmentPreviewKind): boolean {
  return ['image', 'pdf', 'text', 'code', 'calendar', 'video', 'audio'].includes(kind);
}

export function attachmentKindLabel(kind: AttachmentPreviewKind, ext = ''): string {
  switch (kind) {
    case 'image':
      return 'Image';
    case 'pdf':
      return 'PDF';
    case 'text':
      return 'Text';
    case 'code':
      return ext || 'Code';
    case 'video':
      return 'Video';
    case 'audio':
      return 'Audio';
    case 'office':
      return ext || 'Document';
    case 'archive':
      return 'Archive';
    case 'calendar':
      return 'Calendar';
    case 'email':
      return 'Email';
    default:
      return ext || 'File';
  }
}

function extensionFromFilename(filename: string | null | undefined): string {
  const value = String(filename || '').toLowerCase();
  const last = value.split(/[/?#]/)[0]?.split('.').pop() || '';
  return last === value ? '' : last;
}

function isOfficeMime(mime: string): boolean {
  return (
    mime.includes('officedocument') ||
    mime.includes('msword') ||
    mime.includes('ms-excel') ||
    mime.includes('ms-powerpoint') ||
    mime.includes('spreadsheet') ||
    mime.includes('presentation') ||
    mime.includes('wordprocessingml') ||
    mime.includes('vnd.apple.keynote') ||
    mime.includes('vnd.apple.pages') ||
    mime.includes('vnd.apple.numbers')
  );
}

function isArchiveMime(mime: string): boolean {
  return (
    mime.includes('zip') ||
    mime.includes('x-tar') ||
    mime.includes('x-7z') ||
    mime.includes('x-rar') ||
    mime.includes('gzip') ||
    mime.includes('x-bzip') ||
    mime.includes('x-xz')
  );
}

function isCodeMime(mime: string): boolean {
  return (
    mime.includes('json') ||
    mime.includes('xml') ||
    mime.includes('yaml') ||
    mime === 'application/javascript' ||
    mime === 'text/javascript' ||
    mime === 'text/css' ||
    mime === 'text/html'
  );
}
