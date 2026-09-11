'use client';

import type { ToolShape } from '@/lib/ai/tool-shapes';
import { formatShortDate } from '@/lib/chat/shape-format';
import { fromInitials } from '@/lib/shared/format';
import { ActionBar, Facts, ShapeShell } from './shape-shell';

export function ContactCard({ shape }: { shape: Extract<ToolShape, { kind: 'contact' }> }) {
  const name = shape.name || shape.email;
  const lastSeen = formatShortDate(shape.lastSeenIso);
  return (
    <ShapeShell summary={shape.summary}>
      <div className="flex min-w-0 items-start gap-3 px-3 py-2.5">
        <span
          aria-hidden
          className="grid size-8 shrink-0 place-items-center rounded-full bg-[var(--color-accent-soft)] font-display text-[12px] font-semibold text-[var(--color-accent)]"
        >
          {fromInitials(name)}
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate font-display text-[13px] font-semibold leading-snug">{name}</span>
          {shape.name ? (
            <span className="truncate text-[12px] text-[var(--color-text-muted)]">{shape.email}</span>
          ) : null}
          <Facts
            items={[
              shape.totalMessages != null
                ? `${shape.totalMessages} message${shape.totalMessages === 1 ? '' : 's'}`
                : undefined,
              lastSeen ? `Last ${lastSeen}` : undefined,
            ]}
          />
          {shape.memory ? (
            <p className="line-clamp-3 text-[12px] leading-relaxed text-[var(--color-text-muted)]">
              {shape.memory}
            </p>
          ) : null}
          <div className="flex min-w-0 items-baseline justify-end gap-3 pt-1">
            <ActionBar rowKey={shape.email} actions={shape.actions} />
          </div>
        </div>
      </div>
    </ShapeShell>
  );
}
