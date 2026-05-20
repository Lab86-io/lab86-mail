'use client';

import { useQuery } from '@tanstack/react-query';
import {
  AlarmClock,
  Archive,
  Calendar,
  Cloud,
  Inbox,
  Keyboard,
  Layers,
  MailOpen,
  Pencil,
  Plus,
  Flag,
  Send,
  Star,
  Trash2,
} from 'lucide-react';
import { useEffect } from 'react';
import { callTool } from '@/lib/api-client';
import { useClientStore } from '@/lib/client-state';
import { cn } from '@/lib/utils';
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
  const setComposeOpen = useClientStore((s) => s.setComposeOpen);
  const setShortcutsOpen = useClientStore((s) => s.setShortcutsOpen);

  const { data: accountsData } = useQuery({
    queryKey: ['accounts'],
    queryFn: async () => callTool<{ accounts: { email: string; authed: boolean; primary?: boolean }[] }>('list_accounts'),
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
    <aside className="flex h-full w-full flex-col gap-3 bg-[var(--color-bg-subtle)] p-3 text-sm">
      <div className="flex items-center gap-2.5 px-1 pt-1">
        <div className="grid h-7 w-7 place-items-center rounded-md bg-[var(--color-accent)] font-mono text-[12px] font-bold text-[var(--color-accent-foreground)] shadow-[var(--shadow-soft)]">
          M
        </div>
        <div className="flex flex-col leading-tight">
          <span className="font-semibold tracking-tight">Mail OS</span>
          <span className="text-[10px] uppercase tracking-wider text-[var(--color-text-faint)]">v2 · personal</span>
        </div>
      </div>

      <button
        type="button"
        onClick={() => setComposeOpen(true)}
        className="group relative flex items-center justify-between rounded-md border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-3 py-2 text-left text-sm font-medium shadow-[var(--shadow-soft)] transition-colors hover:bg-[var(--color-accent-soft)] hover:text-[var(--color-accent)]"
      >
        <span className="flex items-center gap-2">
          <Plus className="h-4 w-4" />
          Compose
        </span>
        <span className="text-[10px] text-[var(--color-text-faint)] group-hover:text-[var(--color-accent)]">c</span>
      </button>

      <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-0.5">
        <div className="px-1 pb-1 pt-2 text-[10px] uppercase tracking-wider text-[var(--color-text-faint)]">
          Mailboxes
        </div>
        {MAILBOXES.map(({ query: q, label, Icon }) => {
          const active = q === query;
          return (
            <button
              key={q}
              type="button"
              onClick={() => setQuery(q)}
              className={cn(
                'flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors',
                active
                  ? 'bg-[var(--color-bg-elevated)] text-[var(--color-text)] shadow-[var(--shadow-soft)]'
                  : 'text-[var(--color-text-muted)] hover:bg-[var(--color-bg-muted)]/60 hover:text-[var(--color-text)]',
              )}
            >
              <Icon className="h-3.5 w-3.5 opacity-70" />
              {label}
            </button>
          );
        })}
      </nav>

      <div className="flex items-center justify-between rounded-md border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-1 shadow-[var(--shadow-soft)]">
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
    </aside>
  );
}
