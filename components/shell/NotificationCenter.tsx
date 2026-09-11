'use client';

import { Bell } from 'lucide-react';
import { useNotifications } from '@/components/notifications/useNotifications';
import { useClientStore } from '@/lib/client-state';
import { cn } from '@/lib/utils';

export { visibleExecutionNotifications } from '@/components/notifications/model';

/** The bell is a destination, not a second feed with its own unread arithmetic. */
export function NotificationCenter({ className, onOpen }: { className?: string; onOpen?: () => void } = {}) {
  const { projection, isLoading } = useNotifications();
  const setPrimaryView = useClientStore((state) => state.setPrimaryView);
  const selected = useClientStore((state) => state.primaryView === 'notifications');
  const count = isLoading ? 0 : projection.count;
  return (
    <button
      type="button"
      title="Notifications"
      aria-label={count ? `Notifications, ${count} items need attention` : 'Notifications'}
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
