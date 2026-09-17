import type { ReactNode } from 'react';
import { DocumentPreview } from '@/components/files/DocumentPreview';

export function FileResult({
  title,
  detail,
  summary,
  documentId,
  kind,
  actions,
}: {
  title: string;
  detail?: string;
  summary?: string;
  documentId?: string;
  kind?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="chat-file-result" data-file-result>
      <DocumentPreview documentId={documentId} kind={kind} />
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-[13px] font-semibold" title={title}>
            {title}
          </span>
          {actions}
        </div>
        {detail ? (
          <p className="mt-1 line-clamp-2 text-[11px] text-[var(--color-text-muted)]">{detail}</p>
        ) : null}
        {summary ? (
          <p
            className="mt-1 line-clamp-2 text-[11px] leading-snug text-[var(--color-text-muted)]"
            title={summary}
          >
            {summary}
          </p>
        ) : null}
      </div>
    </div>
  );
}
