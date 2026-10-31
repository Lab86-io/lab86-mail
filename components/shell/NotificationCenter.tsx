'use client';

import { Bell } from 'lucide-react';
import { NeedsYouGate } from '@/components/needs-you/NeedsYouGate';
import { useNeedsYou } from '@/components/needs-you/useNeedsYou';
import { useNotifications } from '@/components/notifications/useNotifications';
import { useClientStore } from '@/lib/client-state';
import { cn } from '@/lib/utils';

export { visibleExecutionNotifications } from '@/components/notifications/model';

interface CenterProps {
  className?: string;
  onOpen?: () => void;
}

/** The words of the bell: its tooltip and its label for a screen reader. */
export function bellWords(count: number, needsYou: boolean): { title: string; label: string } {
  if (needsYou) {
    return {
      title: count ? `Needs you · ${count} now` : 'Needs you',
      label: count ? `Needs you, ${count} now` : 'Needs you',
    };
  }
  return {
    title: 'Notifications',
    label: count ? `Notifications, ${count} items need attention` : 'Notifications',
  };
}

function BellButton({
  className,
  onOpen,
  count,
  needsYou,
}: CenterProps & { count: number; needsYou: boolean }) {
  const setPrimaryView = useClientStore((state) => state.setPrimaryView);
  const selected = useClientStore((state) => state.primaryView === 'notifications');
  const words = bellWords(count, needsYou);
  return (
    <button
      type="button"
      title={words.title}
      aria-label={words.label}
      aria-current={selected ? 'page' : undefined}
      onClick={onOpen || (() => setPrimaryView('notifications'))}
      className={cn(
        'corner-smooth relative grid size-8 shrink-0 place-items-center rounded-[var(--radius-control)] text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-hover-soft)] hover:text-[var(--color-text)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-ring)]',
        selected && 'bg-[var(--color-control)] text-[var(--color-text)]',
        className,
      )}
    >
      <Bell className="size-4" aria-hidden />
      {count > 0 && (
        <span
          aria-hidden
          className="absolute -right-1 -top-1 min-w-4 rounded-full border-2 border-[var(--color-bg-elevated)] bg-[var(--color-text)] px-1 text-center text-[9px] font-semibold leading-3 text-[var(--color-bg)]"
        >
          {count > 99 ? '99+' : count}
        </span>
      )}
    </button>
  );
}

/** The bell before Needs you: one number, the items that need attention. */
function LegacyCenter(props: CenterProps) {
  const { projection, isLoading } = useNotifications();
  return <BellButton {...props} count={isLoading ? 0 : projection.count} needsYou={false} />;
}

/** The bell with Needs you: the count of the Now group. */
function NeedsYouCenter(props: CenterProps) {
  // Counts only: no current-move read.
  const { enabled, isLoading, summary, notifications } = useNeedsYou({ execution: false });
  const count = isLoading ? 0 : enabled ? summary.now : notifications.projection.count;
  return <BellButton {...props} count={count} needsYou={enabled} />;
}

/** The bell is a destination, not a second feed with its own unread arithmetic. */
export function NotificationCenter(props: CenterProps = {}) {
  return (
    <NeedsYouGate fallback={<LegacyCenter {...props} />}>
      <NeedsYouCenter {...props} />
    </NeedsYouGate>
  );
}
