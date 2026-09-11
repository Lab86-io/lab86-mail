'use client';

import type { ToolShape } from '@/lib/ai/tool-shapes';
import { formatEventSpan } from '@/lib/chat/shape-format';
import { ShapeList, ShapeMore, ShapeRow, ShapeShell } from './shape-shell';

export function EventsCard({ shape }: { shape: Extract<ToolShape, { kind: 'events' }> }) {
  const more = (shape.total ?? shape.items.length) - shape.items.length;
  return (
    <ShapeShell title={shape.title} summary={shape.summary}>
      <ShapeList>
        {shape.items.map((item) => (
          <ShapeRow
            key={`${item.account}:${item.eventId}`}
            rowKey={`${item.account}:${item.eventId}`}
            primary={item.title || '(untitled)'}
            meta={formatEventSpan(item.startIso, item.endIso, item.allDay)}
            secondary={[item.location, item.calendarName].filter(Boolean).join(' · ')}
            actions={item.actions}
          />
        ))}
      </ShapeList>
      <ShapeMore count={more} noun={more === 1 ? 'event' : 'events'} />
    </ShapeShell>
  );
}
