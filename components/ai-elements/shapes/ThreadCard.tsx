'use client';

import type { ToolShape } from '@/lib/ai/tool-shapes';
import { formatShortDate } from '@/lib/chat/shape-format';
import { decodeMailText, shortFrom } from '@/lib/shared/format';
import { ActionBar, Facts, ShapeShell } from './shape-shell';

export function ThreadCard({ shape }: { shape: Extract<ToolShape, { kind: 'thread' }> }) {
  const item = shape.item;
  const rowKey = `${item.account}:${item.threadId}`;
  const counts = [
    item.messageCount ? `${item.messageCount} message${item.messageCount === 1 ? '' : 's'}` : undefined,
    item.attachmentCount
      ? `${item.attachmentCount} attachment${item.attachmentCount === 1 ? '' : 's'}`
      : undefined,
  ];
  return (
    <ShapeShell summary={shape.summary}>
      <div className="flex min-w-0 flex-col gap-1 px-3 py-2.5">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate font-display text-[13px] font-semibold leading-snug">
            {shortFrom(item.from) || item.fromEmail || item.from}
          </span>
          <span className="shrink-0 text-[11px] tabular-nums text-[var(--color-text-faint)]">
            {formatShortDate(item.dateIso)}
          </span>
        </div>
        <span className="text-[12.5px] font-medium leading-snug text-[var(--color-text)]">
          {decodeMailText(item.subject) || '(no subject)'}
        </span>
        {shape.excerpt || item.snippet ? (
          <p className="line-clamp-4 text-[12px] leading-relaxed text-[var(--color-text-muted)]">
            {shape.excerpt || item.snippet}
          </p>
        ) : null}
        <div className="flex min-w-0 items-baseline gap-3 pt-0.5">
          <Facts items={[item.fromEmail, ...counts]} className="min-w-0 flex-1" />
          <ActionBar rowKey={rowKey} actions={shape.actions.length ? shape.actions : item.actions} />
        </div>
      </div>
    </ShapeShell>
  );
}
