'use client';

import type { ToolShape } from '@/lib/ai/tool-shapes';
import { formatDue } from '@/lib/chat/shape-format';
import { ShapeList, ShapeRow, ShapeShell } from './shape-shell';

export function TasksCard({ shape }: { shape: Extract<ToolShape, { kind: 'tasks' }> }) {
  return (
    <ShapeShell title={shape.title || shape.boardTitle} summary={shape.summary}>
      <ShapeList>
        {shape.items.map((item) => (
          <ShapeRow
            key={item.cardId}
            rowKey={item.cardId}
            primary={item.title}
            meta={formatDue(item.dueIso)}
            done={item.completed}
            secondary={[item.column, item.priority].filter(Boolean).join(' · ')}
            actions={item.actions}
          />
        ))}
      </ShapeList>
    </ShapeShell>
  );
}
