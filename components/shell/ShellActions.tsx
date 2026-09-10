'use client';

import { MessageCircle, Plus, Search } from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/button';
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from '@/components/ui/sidebar';
import { cn } from '@/lib/utils';

/** The two global doors share alignment, radius and keyboard affordances.
 * Navigation and assistant state remain owned by the shell, not this view. */
export function RailPrimaryActions({
  captureLabel,
  searchShortcut,
  onCapture,
  onSearch,
}: {
  captureLabel: string;
  searchShortcut: string;
  onCapture: () => void;
  onSearch: () => void;
}) {
  return (
    <SidebarMenu className="gap-2">
      <SidebarMenuItem>
        <SidebarMenuButton
          tooltip={captureLabel}
          onClick={onCapture}
          className={cn(
            buttonVariants(),
            'h-11 justify-start gap-2 px-2.5 text-[12.5px] hover:text-[var(--color-accent-foreground)]',
          )}
        >
          <Plus className="size-4 shrink-0" aria-hidden />
          <span>{captureLabel}</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
      <SidebarMenuItem>
        <SidebarMenuButton
          tooltip={`Search everything (${searchShortcut} or /)`}
          aria-label={`Search everything (${searchShortcut} or slash)`}
          aria-keyshortcuts="Meta+F Control+F /"
          title={`Search everything (${searchShortcut} or /)`}
          onClick={onSearch}
          className={cn(
            buttonVariants({ variant: 'outline' }),
            'h-10 justify-start gap-2 px-2.5 text-[12.5px]',
          )}
        >
          <Search className="size-4 shrink-0 text-[var(--color-text-muted)]" aria-hidden />
          <span>Search</span>
          <span className="ml-auto group-data-[collapsible=icon]:hidden" aria-hidden>
            <kbd className="control-key">{searchShortcut}</kbd>
          </span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

export function AssistantLauncher({
  placement,
  shortcut,
  onOpen,
}: {
  placement: 'stacked' | 'corner';
  shortcut: string;
  onOpen: () => void;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      onClick={onOpen}
      title={`Ask Assistant (${shortcut})`}
      aria-label="Ask Assistant"
      aria-keyshortcuts="Meta+K Control+K"
      data-placement={placement}
      className={cn(
        'fixed right-4 z-50 h-11 gap-2.5 rounded-xl px-3.5 text-[12.5px] shadow-[var(--shadow-soft)] sm:right-6',
        placement === 'stacked' ? 'bottom-[4.5rem]' : 'bottom-6',
      )}
    >
      <MessageCircle className="size-4 text-[var(--color-accent)]" aria-hidden />
      <span>Ask Assistant</span>
      <kbd className="control-key ml-1" aria-hidden>
        {shortcut}
      </kbd>
    </Button>
  );
}
