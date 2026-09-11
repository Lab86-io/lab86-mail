'use client';

import type { ToolShape } from '@/lib/ai/tool-shapes';
import { hostOf } from '@/lib/chat/shape-format';
import { ShapeList, ShapeRow, ShapeShell } from './shape-shell';

export function SourcesCard({ shape }: { shape: Extract<ToolShape, { kind: 'sources' }> }) {
  return (
    <ShapeShell title={shape.title} summary={shape.summary}>
      <ShapeList>
        {shape.items.map((item, index) => (
          <ShapeRow
            key={item.url || `${item.title}-${index}`}
            rowKey={item.url || `${item.title}-${index}`}
            primary={item.title || item.url || 'Untitled'}
            meta={item.source || hostOf(item.url)}
            secondary={item.snippet}
            actions={item.actions}
          />
        ))}
      </ShapeList>
    </ShapeShell>
  );
}
