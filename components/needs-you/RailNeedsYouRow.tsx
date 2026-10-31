'use client';

import { Bell } from 'lucide-react';
import { SidebarMenuButton, SidebarMenuItem } from '@/components/ui/sidebar';
import type { NeedsYouSummary } from '@/lib/obligations/groups';
import { cn } from '@/lib/utils';
import { useNeedsYouSnapshot } from './data';
import { NeedsYouGate } from './NeedsYouGate';
import { useNeedsYou } from './useNeedsYou';

/**
 * The word at the right of the rail row: "2 now" when something needs the
 * user now, else "10 open", else nothing. `now` is the accent voice.
 */
export function railNeedsYouBadge(summary: Pick<NeedsYouSummary, 'now' | 'open'>): {
  text: string;
  now: boolean;
} | null {
  if (summary.now > 0) return { text: `${summary.now} now`, now: true };
  if (summary.open > 0) return { text: `${summary.open} open`, now: false };
  return null;
}

interface RowProps {
  active: boolean;
  onSelect: () => void;
}

function Row({ active, onSelect }: RowProps) {
  // Counts only: no current-move read.
  const { isLoading, summary } = useNeedsYou({ execution: false });
  const badge = isLoading ? null : railNeedsYouBadge(summary);
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        isActive={active}
        tooltip={badge ? `Needs you · ${badge.text}` : 'Needs you'}
        data-rail-target="needs-you"
        onClick={onSelect}
        className="rail-selection"
      >
        <Bell />
        <span>Needs you</span>
        {badge ? (
          <span
            className={cn(
              'ml-auto whitespace-nowrap text-[10.5px] group-data-[collapsible=icon]:hidden',
              badge.now ? 'font-medium text-[var(--color-accent)]' : 'text-[var(--color-text-muted)]',
            )}
          >
            {badge.text}
          </span>
        ) : null}
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

/** Reads only the snapshot first: a user outside the flag starts no second notification read. */
function RowWhenEnabled(props: RowProps) {
  const snapshot = useNeedsYouSnapshot();
  return snapshot?.enabled ? <Row {...props} /> : null;
}

/** The Needs you row at the top of the rail, for users in LAB86_NEEDS_YOU. */
export function RailNeedsYouRow(props: RowProps) {
  return (
    <NeedsYouGate fallback={null}>
      <RowWhenEnabled {...props} />
    </NeedsYouGate>
  );
}
