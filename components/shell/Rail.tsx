'use client';

import { useQuery } from '@tanstack/react-query';
import {
  AlarmClock,
  Archive,
  Calendar,
  Cloud,
  Flag,
  Inbox,
  Keyboard,
  Layers,
  MailOpen,
  Pencil,
  Plus,
  Send,
  Star,
  Trash2,
} from 'lucide-react';
import { useEffect } from 'react';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
} from '@/components/ui/sidebar';
import { callTool } from '@/lib/api-client';
import { useClientStore } from '@/lib/client-state';
import { ThemeSwitcher } from './ThemeSwitcher';

interface MailboxItem {
  query: string;
  label: string;
  Icon: any;
}

const MAILBOXES: MailboxItem[] = [
  { query: 'in:inbox newer_than:30d', label: 'Inbox', Icon: Inbox },
  { query: 'is:unread newer_than:30d', label: 'Unread', Icon: MailOpen },
  { query: 'is:starred newer_than:365d', label: 'Starred', Icon: Star },
  { query: 'is:important newer_than:60d', label: 'Important', Icon: Flag },
  { query: 'from:(icloud.com OR me.com) newer_than:365d', label: 'iCloud', Icon: Cloud },
  { query: 'has:attachment newer_than:90d', label: 'Attachments', Icon: Layers },
  { query: 'newer_than:7d', label: 'This week', Icon: Calendar },
  { query: 'in:sent newer_than:365d', label: 'Sent', Icon: Send },
  { query: 'in:drafts', label: 'Drafts', Icon: Pencil },
  { query: '-in:trash newer_than:365d', label: 'All mail', Icon: Archive },
  { query: 'label:MailOS/Snoozed', label: 'Snoozed', Icon: AlarmClock },
  { query: 'in:trash newer_than:365d', label: 'Trash', Icon: Trash2 },
];

export const ALL_ACCOUNTS = '__all__';

export function Rail() {
  const account = useClientStore((s) => s.account);
  const setAccount = useClientStore((s) => s.setAccount);
  const setPrimaryAccount = useClientStore((s) => s.setPrimaryAccount);
  const query = useClientStore((s) => s.query);
  const setQuery = useClientStore((s) => s.setQuery);
  const openComposeNew = useClientStore((s) => s.openComposeNew);
  const setShortcutsOpen = useClientStore((s) => s.setShortcutsOpen);

  const { data: accountsData } = useQuery({
    queryKey: ['accounts'],
    queryFn: async () =>
      callTool<{ accounts: { email: string; authed: boolean; primary?: boolean }[] }>('list_accounts'),
  });
  const accounts = accountsData?.accounts || [];
  const authedAccounts = accounts.filter((a) => a.authed);

  // The inbox is always the unified "all mailboxes" view — there's no account
  // selector. We still resolve the primary account (compose "from") and force
  // ALL_ACCOUNTS whenever more than one mailbox is authed.
  useEffect(() => {
    if (!accounts.length) return;
    const primary = authedAccounts.find((a) => a.primary) || authedAccounts[0] || accounts[0];
    if (primary) setPrimaryAccount(primary.email);
    if (authedAccounts.length > 1) {
      if (account !== ALL_ACCOUNTS) setAccount(ALL_ACCOUNTS);
    } else if (!account && primary) {
      setAccount(primary.email);
    }
  }, [accounts, authedAccounts, account, setAccount, setPrimaryAccount]);

  return (
    <Sidebar collapsible="icon" className="bg-[var(--color-bg-subtle)]">
      <SidebarHeader className="gap-3">
        {/* Title bar: the title only shows when expanded; the trigger stays put
            and centers itself when collapsed so it doubles as the expand button. */}
        <div className="flex items-center justify-between gap-2 px-1 pt-1 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0">
          <span className="text-[15px] font-semibold tracking-tight text-[var(--color-text)] group-data-[collapsible=icon]:hidden">
            Lab86 Mail
          </span>
          <SidebarTrigger
            title="Toggle navigation rail"
            className="text-[var(--color-text-muted)] hover:bg-[var(--color-bg-muted)] hover:text-[var(--color-text)]"
          />
        </div>

        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              variant="outline"
              tooltip="Compose"
              onClick={() => openComposeNew()}
              className="font-medium shadow-[var(--shadow-soft)] hover:bg-[var(--color-accent-soft)] hover:text-[var(--color-accent)]"
            >
              <Plus />
              <span>Compose</span>
              <span className="ml-auto text-[10px] text-[var(--color-text-faint)] group-data-[collapsible=icon]:hidden">
                c
              </span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Mailboxes</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {MAILBOXES.map(({ query: q, label, Icon }) => (
                <SidebarMenuItem key={q}>
                  <SidebarMenuButton
                    isActive={q === query}
                    tooltip={label}
                    onClick={() => setQuery(q)}
                    className="data-[active=true]:bg-[var(--color-bg-elevated)] data-[active=true]:text-[var(--color-text)] data-[active=true]:shadow-[var(--shadow-soft)]"
                  >
                    <Icon />
                    <span>{label}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <div className="flex items-center justify-between rounded-md border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-1 shadow-[var(--shadow-soft)] group-data-[collapsible=icon]:flex-col group-data-[collapsible=icon]:gap-1 group-data-[collapsible=icon]:border-transparent group-data-[collapsible=icon]:bg-transparent group-data-[collapsible=icon]:p-0 group-data-[collapsible=icon]:shadow-none">
          <ThemeSwitcher />
          <button
            type="button"
            onClick={() => setShortcutsOpen(true)}
            className="grid h-7 w-7 place-items-center rounded-md text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg-subtle)] hover:text-[var(--color-text)]"
            title="Keyboard shortcuts (?)"
          >
            <Keyboard className="h-3.5 w-3.5" />
          </button>
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
