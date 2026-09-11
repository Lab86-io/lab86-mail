'use client';

import type { ToolShape } from '@/lib/ai/tool-shapes';
import { formatShortDate } from '@/lib/chat/shape-format';
import { decodeMailText, shortFrom } from '@/lib/shared/format';
import { ShapeList, ShapeMore, ShapeRow, ShapeShell } from './shape-shell';

export function ThreadsCard({ shape }: { shape: Extract<ToolShape, { kind: 'threads' }> }) {
  const more = (shape.total ?? shape.items.length) - shape.items.length;
  return (
    <ShapeShell title={shape.title} summary={shape.summary}>
      <ShapeList>
        {shape.items.map((item) => (
          <ShapeRow
            key={`${item.account}:${item.threadId}`}
            rowKey={`${item.account}:${item.threadId}`}
            primary={shortFrom(item.from) || item.fromEmail || item.from}
            meta={formatShortDate(item.dateIso)}
            emphasis={item.unread}
            secondary={
              <>
                <span
                  className={
                    item.unread ? 'font-medium text-[var(--color-text)]' : 'text-[var(--color-text)]'
                  }
                >
                  {decodeMailText(item.subject) || '(no subject)'}
                </span>
                {item.snippet ? (
                  <span className="text-[var(--color-text-muted)]"> — {item.snippet}</span>
                ) : null}
              </>
            }
            actions={item.actions}
          />
        ))}
      </ShapeList>
      <ShapeMore count={more} noun={more === 1 ? 'thread' : 'threads'} />
    </ShapeShell>
  );
}
