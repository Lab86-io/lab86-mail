'use client';

import { Newspaper } from 'lucide-react';
import Link from 'next/link';
import { SidebarMenuButton } from '@/components/ui/sidebar';
import { PRODUCT_UPDATES } from '@/lib/updates/feed';
import { unseenUpdateCount } from '@/lib/updates/model';
import { useLastSeenUpdate } from '@/lib/updates/seen';

export function UpdatesLink({ onNavigate }: { onNavigate?: () => void }) {
  const lastSeenId = useLastSeenUpdate();
  const hasUnread = unseenUpdateCount(PRODUCT_UPDATES, lastSeenId) > 0;
  return (
    <SidebarMenuButton asChild tooltip={hasUnread ? 'What’s new · Unread updates' : 'What’s new'}>
      <Link
        href="/updates"
        onClick={onNavigate}
        aria-label={hasUnread ? 'What’s new, unread updates' : 'What’s new'}
      >
        <span className="relative size-4 shrink-0">
          <Newspaper className="size-4" aria-hidden />
          {hasUnread ? (
            <span
              aria-hidden
              className="absolute -right-1 -top-0.5 size-1.5 rounded-full bg-[var(--color-accent)]"
            />
          ) : null}
        </span>
        <span>What’s new</span>
      </Link>
    </SidebarMenuButton>
  );
}
