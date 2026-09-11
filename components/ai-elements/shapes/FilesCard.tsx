'use client';

import type { ToolShape } from '@/lib/ai/tool-shapes';
import { fileKindLabel, formatShortDate } from '@/lib/chat/shape-format';
import { ShapeList, ShapeRow, ShapeShell } from './shape-shell';

export function FilesCard({ shape }: { shape: Extract<ToolShape, { kind: 'files' }> }) {
  return (
    <ShapeShell title={shape.title} summary={shape.summary}>
      <ShapeList>
        {shape.items.map((item) => (
          <ShapeRow
            key={`${item.connectionId}:${item.fileId}`}
            rowKey={`${item.connectionId}:${item.fileId}`}
            primary={item.name}
            meta={formatShortDate(item.modifiedIso)}
            secondary={[fileKindLabel(item.kind, item.mimeType), item.source].filter(Boolean).join(' · ')}
            actions={item.actions}
          />
        ))}
      </ShapeList>
    </ShapeShell>
  );
}
