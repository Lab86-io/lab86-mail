'use client';

import type { ToolShape } from '@/lib/ai/tool-shapes';
import { fileKindLabel, formatShortDate } from '@/lib/chat/shape-format';
import { FileResult } from './file-result';
import { ActionBar, ShapeList, ShapeShell } from './shape-shell';

export function FilesCard({ shape }: { shape: Extract<ToolShape, { kind: 'files' }> }) {
  return (
    <ShapeShell title={shape.title} summary={shape.summary}>
      <ShapeList>
        {shape.items.map((item) => (
          <div
            key={`${item.connectionId}:${item.fileId}`}
            className="border-t border-[var(--surface-border)] first:border-t-0"
          >
            <FileResult
              title={item.name}
              kind={item.kind}
              documentId={item.documentId}
              detail={[
                fileKindLabel(item.kind, item.mimeType),
                item.source,
                formatShortDate(item.modifiedIso),
              ]
                .filter(Boolean)
                .join(' · ')}
              actions={<ActionBar rowKey={`${item.connectionId}:${item.fileId}`} actions={item.actions} />}
            />
          </div>
        ))}
      </ShapeList>
    </ShapeShell>
  );
}
