'use client';

import type { ToolShape } from '@/lib/ai/tool-shapes';
import { formatEventSpan, joinWithMore } from '@/lib/chat/shape-format';
import { ActionBar, Facts, ShapeShell } from './shape-shell';

export function EventCard({ shape }: { shape: Extract<ToolShape, { kind: 'event' }> }) {
  const item = shape.item;
  const rowKey = `${item.account}:${item.eventId}`;
  return (
    <ShapeShell summary={shape.summary}>
      <div className="flex min-w-0 flex-col gap-1 px-3 py-2.5">
        <span className="truncate font-display text-[13px] font-semibold leading-snug">
          {item.title || '(untitled)'}
        </span>
        <span className="text-[12px] leading-snug text-[var(--color-text)]">
          {formatEventSpan(item.startIso, item.endIso, item.allDay)}
        </span>
        {item.location ? (
          <span className="truncate text-[12px] leading-snug text-[var(--color-text-muted)]">
            {item.location}
          </span>
        ) : null}
        {item.attendees?.length ? (
          <span className="truncate text-[12px] leading-snug text-[var(--color-text-muted)]">
            With {joinWithMore(item.attendees, 4)}
          </span>
        ) : null}
        <div className="flex min-w-0 items-baseline gap-3 pt-0.5">
          <Facts items={[item.calendarName, item.status]} className="min-w-0 flex-1" />
          <ActionBar rowKey={rowKey} actions={shape.actions.length ? shape.actions : item.actions} />
        </div>
      </div>
    </ShapeShell>
  );
}
