'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useQuery_experimental as useConvexQuery } from 'convex/react';
import { ChevronDown, Settings2 } from 'lucide-react';
import { useState } from 'react';
import { SmartLabelsSettings } from '@/components/inbox/SmartLabelsSettings';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { api } from '@/convex/_generated/api';
import { callTool } from '@/lib/api-client';
import { useClientStore } from '@/lib/client-state';
import { QUICK_SEARCH_QUERIES } from '@/lib/mail/search/constants';
import { cn } from '@/lib/utils';

// These used to be sixteen rows in the navigation rail. Mail folders are not
// peers of the product's surfaces, so they moved in here, next to the mail.
export const MAILBOXES: Array<{ query: string; label: string }> = [
  { query: QUICK_SEARCH_QUERIES.unread, label: 'Unread' },
  { query: QUICK_SEARCH_QUERIES.starred, label: 'Starred' },
  { query: QUICK_SEARCH_QUERIES.important, label: 'Important' },
  { query: QUICK_SEARCH_QUERIES.attachments, label: 'Attachments' },
  { query: QUICK_SEARCH_QUERIES.thisWeek, label: 'This week' },
  { query: QUICK_SEARCH_QUERIES.sent, label: 'Sent' },
  { query: QUICK_SEARCH_QUERIES.drafts, label: 'Drafts' },
  { query: QUICK_SEARCH_QUERIES.allMail, label: 'All mail' },
  { query: 'label:MailOS/Snoozed', label: 'Snoozed' },
  { query: QUICK_SEARCH_QUERIES.trash, label: 'Trash' },
];

export const SMART_CATEGORIES: Array<{ id: string; label: string }> = [
  { id: 'main', label: 'Main' },
  { id: 'codes', label: 'Codes' },
  { id: 'orders', label: 'Orders' },
  { id: 'noise', label: 'Noise' },
];

export function MailNav() {
  const query = useClientStore((s) => s.query);
  const setQuery = useClientStore((s) => s.setQuery);
  const smartCategory = useClientStore((s) => s.smartCategory);
  const setSmartCategory = useClientStore((s) => s.setSmartCategory);
  const openComposeNew = useClientStore((s) => s.openComposeNew);
  const accountFilter = useClientStore((s) => s.accountFilter);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const queryClient = useQueryClient();

  const liveCounts = useConvexQuery({
    query: (api as any).liveMail.categoryCounts,
    args: { accountIds: accountFilter.length ? accountFilter : undefined },
  });
  const counts =
    liveCounts.status === 'success'
      ? (liveCounts.data?.counts as Record<string, { unread: number; attention: boolean }> | undefined)
      : undefined;

  const { data: smartLabels } = useQuery({
    queryKey: ['smart-labels'],
    queryFn: async () => callTool<{ custom: any[] }>('list_smart_labels', {}),
    staleTime: 60_000,
  });
  const customLabels = (smartLabels?.custom || []).filter((label: any) => label.sidebarVisible);
  const activeFolder = MAILBOXES.find((mailbox) => mailbox.query === query);

  return (
    <div className="flex flex-wrap items-center gap-1.5 border-b border-[var(--color-border)] px-3 py-2">
      <Button size="sm" onClick={() => openComposeNew()} className="mr-1">
        Compose
      </Button>

      {[...SMART_CATEGORIES, ...customLabels.map((l: any) => ({ id: `custom:${l._id}`, label: l.name }))].map(
        (category) => {
          const active = smartCategory === category.id && !activeFolder;
          const unread = counts?.[category.id]?.unread;
          return (
            <button
              key={category.id}
              type="button"
              onClick={() => setSmartCategory(category.id)}
              className={cn(
                'rounded-full px-3 py-1 text-[12.5px] transition-colors',
                active
                  ? 'bg-[var(--color-accent-soft)] font-medium text-[var(--color-accent)]'
                  : 'text-[var(--color-text-muted)] hover:bg-[var(--color-bg-subtle)] hover:text-[var(--color-text)]',
              )}
            >
              {category.label}
              {unread ? (
                <span className="ml-1.5 tabular-nums text-[11px] text-[var(--color-text-faint)]">
                  {unread >= 100 ? '99+' : unread}
                </span>
              ) : null}
            </button>
          );
        },
      )}

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={cn(
              'ml-auto flex items-center gap-1 rounded-full px-3 py-1 text-[12.5px] transition-colors',
              activeFolder
                ? 'bg-[var(--color-accent-soft)] font-medium text-[var(--color-accent)]'
                : 'text-[var(--color-text-muted)] hover:bg-[var(--color-bg-subtle)] hover:text-[var(--color-text)]',
            )}
          >
            {activeFolder ? activeFolder.label : 'Folders'}
            <ChevronDown className="size-3" aria-hidden />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          {MAILBOXES.map((mailbox) => (
            <DropdownMenuItem
              key={mailbox.query}
              onSelect={() => setQuery(mailbox.query)}
              className="text-[12.5px]"
            >
              {mailbox.label}
              {mailbox.query === query ? <span className="ml-auto text-[var(--color-accent)]">✓</span> : null}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setSettingsOpen(true)} className="gap-2 text-[12.5px]">
            <Settings2 className="size-3.5" aria-hidden />
            Category settings
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <SmartLabelsSettings
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        labels={customLabels}
        onChanged={() => {
          queryClient.invalidateQueries({ queryKey: ['smart-labels'] });
        }}
      />
    </div>
  );
}
