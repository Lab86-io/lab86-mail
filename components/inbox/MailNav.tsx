'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useConvexAuth, useQuery_experimental as useConvexQuery } from 'convex/react';
import { ChevronDown, Settings2, SquarePen } from 'lucide-react';
import { useState } from 'react';
import { SmartLabelsSettings } from '@/components/inbox/SmartLabelsSettings';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { api } from '@/convex/_generated/api';
import { callTool } from '@/lib/api-client';
import { useClientStore } from '@/lib/client-state';
import {
  MAILBOXES,
  MORE_MAIL_VIEWS,
  mailNavigationSelection,
  PRIMARY_MAIL_VIEWS,
} from '@/lib/mail/navigation';
import { unreadBadgeLabel } from '@/lib/shared/format';
import { cn } from '@/lib/utils';

export function MailNav() {
  const query = useClientStore((s) => s.query);
  const setQuery = useClientStore((s) => s.setQuery);
  const smartCategory = useClientStore((s) => s.smartCategory);
  const setSmartCategory = useClientStore((s) => s.setSmartCategory);
  const openComposeNew = useClientStore((s) => s.openComposeNew);
  const accountFilter = useClientStore((s) => s.accountFilter);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const queryClient = useQueryClient();

  // categoryCounts requires an identity and throws without one. Before Convex
  // has authenticated, asking is an error, not an empty result.
  const { isAuthenticated } = useConvexAuth();
  const liveCounts = useConvexQuery({
    query: (api as any).liveMail.categoryCounts,
    args: isAuthenticated
      ? { accountIds: accountFilter.length ? accountFilter : undefined }
      : ('skip' as never),
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
  return (
    <>
      <MailNavView
        query={query}
        smartCategory={smartCategory}
        customLabels={customLabels}
        counts={counts}
        onCategory={setSmartCategory}
        onFolder={setQuery}
        onCompose={openComposeNew}
        onSettings={() => setSettingsOpen(true)}
      />
      <SmartLabelsSettings
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        labels={customLabels}
        onChanged={() => {
          queryClient.invalidateQueries({ queryKey: ['smart-labels'] });
        }}
      />
    </>
  );
}

export function MailNavView({
  query,
  smartCategory,
  customLabels,
  counts,
  onCategory,
  onFolder,
  onCompose,
  onSettings,
}: {
  query: string;
  smartCategory: string | null;
  customLabels: Array<{ _id: string; name: string }>;
  counts?: Record<string, { unread: number; attention: boolean }>;
  onCategory: (id: string) => void;
  onFolder: (query: string) => void;
  onCompose: () => void;
  onSettings: () => void;
}) {
  const selection = mailNavigationSelection(smartCategory, query, customLabels);
  const extras = [
    ...MORE_MAIL_VIEWS,
    ...customLabels.map((item) => ({ id: `custom:${item._id}`, label: item.name })),
  ];
  return (
    <nav
      aria-label="Mail views"
      className="flex h-12 shrink-0 items-center gap-1.5 border-b border-[var(--color-border)] px-2 sm:px-3"
    >
      <Button
        size="sm"
        aria-label="Compose"
        title="Compose"
        className="size-8 shrink-0 p-0 sm:w-auto sm:px-3"
        onClick={onCompose}
      >
        <SquarePen className="size-4 sm:hidden" aria-hidden />
        <span className="hidden sm:inline">Compose</span>
      </Button>
      <span aria-hidden className="mx-0.5 h-4 w-px shrink-0 bg-[var(--color-border)]" />
      <div className="no-scrollbar flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto sm:gap-1.5">
        {PRIMARY_MAIL_VIEWS.map((category) => {
          const active = smartCategory === category.id;
          const badge = unreadBadgeLabel(counts?.[category.id]?.unread);
          return (
            <button
              key={category.id}
              type="button"
              aria-current={active ? 'page' : undefined}
              onClick={() => onCategory(category.id)}
              className={cn(
                'shrink-0 whitespace-nowrap corner-smooth rounded-[var(--radius-control)] px-2 py-1 text-[12.5px] transition-colors sm:px-3',
                active
                  ? 'bg-[var(--color-accent-soft)] font-medium text-[var(--color-accent)]'
                  : 'text-[var(--color-text-muted)] hover:bg-[var(--color-bg-subtle)] hover:text-[var(--color-text)]',
              )}
            >
              {category.label}
              {badge ? (
                <span className="ml-1.5 hidden tabular-nums text-[11px] text-[var(--color-text-faint)] sm:inline">
                  {badge}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`More mail views${selection.moreActive ? `: ${selection.moreLabel}` : ''}`}
            className={cn(
              'flex max-w-28 shrink-0 items-center gap-1 corner-smooth rounded-[var(--radius-control)] px-2 py-1 text-[12.5px] transition-colors',
              selection.moreActive
                ? 'bg-[var(--color-accent-soft)] font-medium text-[var(--color-accent)]'
                : 'text-[var(--color-text-muted)] hover:bg-[var(--color-bg-subtle)] hover:text-[var(--color-text)]',
            )}
          >
            <span className="sm:hidden">More</span>
            <span className="hidden truncate sm:inline">{selection.moreLabel}</span>
            <ChevronDown className="size-3 shrink-0" aria-hidden />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="max-h-[70vh] w-56 overflow-y-auto">
          <DropdownMenuLabel>Views</DropdownMenuLabel>
          {extras.map((category) => (
            <DropdownMenuItem
              key={category.id}
              onSelect={() => onCategory(category.id)}
              className="text-[12.5px]"
            >
              <span className="truncate">{category.label}</span>
              {smartCategory === category.id ? (
                <span className="ml-auto text-[var(--color-accent)]">✓</span>
              ) : null}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuLabel>Folders</DropdownMenuLabel>
          {MAILBOXES.map((mailbox) => (
            <DropdownMenuItem
              key={mailbox.query}
              onSelect={() => onFolder(mailbox.query)}
              className="text-[12.5px]"
            >
              {mailbox.label}
              {selection.folder?.query === mailbox.query ? (
                <span className="ml-auto text-[var(--color-accent)]">✓</span>
              ) : null}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={onSettings} className="gap-2 text-[12.5px]">
            <Settings2 className="size-3.5" aria-hidden />
            Category settings
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </nav>
  );
}
