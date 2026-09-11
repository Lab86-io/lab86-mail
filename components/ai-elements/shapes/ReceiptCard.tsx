'use client';

import type { ToolShape } from '@/lib/ai/tool-shapes';
import { receiptTargetEntries } from '@/lib/chat/shape-format';
import { ActionBar, ShapeShell } from './shape-shell';

const SURFACE_LABEL: Record<string, string> = {
  mail: 'Mail',
  calendar: 'Calendar',
  tasks: 'Tasks',
  albatross: 'Work',
  documents: 'Files',
  memory: 'Memory',
  other: '',
};

export function ReceiptCard({ shape }: { shape: Extract<ToolShape, { kind: 'receipt' }> }) {
  const entries = receiptTargetEntries(shape.target);
  const rowKey = shape.operationId || shape.title;
  return (
    <ShapeShell>
      <div className="flex min-w-0 flex-col gap-1 px-3 py-2.5">
        <div className="flex min-w-0 items-baseline gap-3">
          <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium leading-snug text-[var(--color-accent-3)]">
            {shape.title}
          </span>
          {SURFACE_LABEL[shape.surface] ? (
            <span className="shrink-0 text-[11px] text-[var(--color-text-faint)]">
              {SURFACE_LABEL[shape.surface]}
            </span>
          ) : null}
        </div>
        {shape.summary ? (
          <span className="text-[12px] leading-snug text-[var(--color-text-muted)]">{shape.summary}</span>
        ) : null}
        {entries.length ? (
          <dl className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11.5px]">
            {entries.map(([key, value]) => (
              <div key={key} className="flex min-w-0 items-baseline gap-1">
                <dt className="shrink-0 text-[var(--color-text-faint)]">{key}</dt>
                <dd className="truncate text-[var(--color-text-muted)]">{value}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        {shape.actions.length ? (
          <div className="flex justify-end pt-0.5">
            <ActionBar rowKey={rowKey} actions={shape.actions} />
          </div>
        ) : null}
      </div>
    </ShapeShell>
  );
}
