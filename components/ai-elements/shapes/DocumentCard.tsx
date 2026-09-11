'use client';

import type { ToolShape } from '@/lib/ai/tool-shapes';
import { ActionBar, Facts, ShapeShell } from './shape-shell';

export function DocumentCard({ shape }: { shape: Extract<ToolShape, { kind: 'document' }> }) {
  return (
    <ShapeShell summary={shape.summary}>
      <div className="flex min-w-0 flex-col gap-1 px-3 py-2.5">
        <div className="flex min-w-0 items-baseline gap-3">
          <span className="min-w-0 flex-1 truncate font-display text-[13px] font-semibold leading-snug">
            {shape.title}
          </span>
          <ActionBar rowKey={shape.documentId} actions={shape.actions} />
        </div>
        <Facts
          items={[
            shape.docKind,
            shape.status,
            shape.revision != null ? `Revision ${shape.revision}` : undefined,
          ]}
        />
      </div>
    </ShapeShell>
  );
}
