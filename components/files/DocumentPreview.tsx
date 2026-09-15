'use client';

import { QueryClientContext, useQuery } from '@tanstack/react-query';
import { FileSpreadsheet, FileText, Presentation } from 'lucide-react';
import { useContext, useEffect, useRef, useState } from 'react';
import { documentPreviewPages, type PreviewPage } from '@/lib/documents/preview';

export function DocumentPreview({ documentId, kind }: { documentId?: string; kind?: string }) {
  const client = useContext(QueryClientContext);
  return client && documentId ? (
    <LiveDocumentPreview documentId={documentId} kind={kind} />
  ) : (
    <DocumentPreviewStack pages={[]} kind={kind} />
  );
}

function LiveDocumentPreview({ documentId, kind }: { documentId: string; kind?: string }) {
  const container = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!container.current || typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: '120px' },
    );
    observer.observe(container.current);
    return () => observer.disconnect();
  }, []);
  const query = useQuery<{ ok: true; document: { model: unknown } }>({
    queryKey: ['document', documentId],
    queryFn: async ({ signal }) => {
      const response = await fetch(`/api/documents/${encodeURIComponent(documentId)}`, { signal });
      if (!response.ok) throw new Error('Preview unavailable');
      const result = await response.json();
      if (!result.ok || !result.document) throw new Error('Preview unavailable');
      return result;
    },
    enabled: visible,
    staleTime: 60_000,
    retry: false,
  });
  return (
    <div ref={container} className="chat-file-preview-slot">
      <DocumentPreviewStack pages={documentPreviewPages(query.data?.document.model)} kind={kind} />
    </div>
  );
}

export function DocumentPreviewStack({ pages, kind }: { pages: PreviewPage[]; kind?: string }) {
  const Icon = kind === 'deck' ? Presentation : kind === 'sheet' ? FileSpreadsheet : FileText;
  return (
    <div
      className="chat-file-preview"
      data-preview-state={pages.length ? 'ready' : 'unavailable'}
      aria-hidden="true"
      title={pages.length ? 'Current file preview' : 'Preview unavailable'}
    >
      {pages.length ? (
        pages.slice(0, 3).map((page, index) => (
          <div
            key={page.id}
            className="chat-file-preview__page rounded-ui"
            data-page={index}
            data-kind={page.kind}
            style={page.kind === 'deck' ? { backgroundColor: page.background } : undefined}
          >
            {page.kind === 'doc' ? (
              <div className="chat-file-preview__text">
                {page.blocks.map((block) => (
                  <p key={block.id} data-heading={block.heading}>
                    {block.text}
                  </p>
                ))}
              </div>
            ) : page.kind === 'sheet' ? (
              <div className="chat-file-preview__sheet">
                <strong>{page.name}</strong>
                <table>
                  <tbody>
                    {page.rows.map((row) => (
                      <tr key={row.id}>
                        {row.cells.map((cell) => (
                          <td key={cell.address}>{cell.text}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              page.elements.map((element) => (
                <span
                  key={element.id}
                  className="chat-file-preview__element"
                  style={{
                    left: `${element.x}%`,
                    top: `${element.y}%`,
                    width: `${element.width}%`,
                    height: `${element.height}%`,
                    fontSize: `${element.fontSize * 0.08}px`,
                    color: element.color,
                    backgroundColor: element.fill,
                  }}
                >
                  {element.text}
                </span>
              ))
            )}
          </div>
        ))
      ) : (
        <div className="chat-file-preview__fallback rounded-ui">
          <Icon className="size-6" />
        </div>
      )}
    </div>
  );
}
