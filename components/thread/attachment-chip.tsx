'use client';

import {
  FileArchive,
  FileAudio,
  File as FileIcon,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
} from 'lucide-react';

export function AttachmentIcon({ mime, className = 'size-4' }: { mime: string; className?: string }) {
  const m = (mime || '').toLowerCase();
  if (m.startsWith('image/')) return <FileImage className={className} />;
  if (m === 'application/pdf') return <FileText className={className} />;
  if (m.startsWith('audio/')) return <FileAudio className={className} />;
  if (m.startsWith('video/')) return <FileVideo className={className} />;
  if (/(zip|compressed|tar|rar|7z|gzip)/.test(m)) return <FileArchive className={className} />;
  if (/(sheet|excel|csv|numbers)/.test(m)) return <FileSpreadsheet className={className} />;
  if (m.startsWith('text/') || /(document|word|pdf|rtf)/.test(m)) return <FileText className={className} />;
  return <FileIcon className={className} />;
}
