'use client';

import type { ToolShape } from '@/lib/ai/tool-shapes';
import { fileKindLabel } from '@/lib/chat/shape-format';
import { previewDocumentId } from '@/lib/documents/preview';
import { FileResult } from './file-result';
import { ActionBar, ShapeShell } from './shape-shell';

export function DocumentCard({ shape }: { shape: Extract<ToolShape, { kind: 'document' }> }) {
  return (
    <ShapeShell>
      <FileResult
        title={shape.title}
        summary={shape.summary}
        detail={[
          fileKindLabel(shape.docKind),
          shape.status,
          shape.revision != null ? `Revision ${shape.revision}` : undefined,
        ]
          .filter(Boolean)
          .join(' · ')}
        documentId={previewDocumentId(shape.path, shape.documentId)}
        kind={shape.docKind}
        actions={<ActionBar rowKey={shape.documentId} actions={shape.actions} />}
      />
    </ShapeShell>
  );
}
