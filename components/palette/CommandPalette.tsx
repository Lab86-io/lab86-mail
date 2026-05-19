'use client';

import { useEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Inbox, MailOpen, Star, Send, Pencil, Sparkles, Moon, Sun, Cloud, AlarmClock } from 'lucide-react';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Command, CommandInput, CommandList, CommandGroup, CommandItem, CommandEmpty, CommandShortcut } from '@/components/ui/command';
import { useClientStore } from '@/lib/client-state';
import { callTool } from '@/lib/api-client';
import { useTheme } from 'next-themes';
import { shortFrom } from '@/lib/shared/format';

export function CommandPalette() {
  const open = useClientStore((s) => s.paletteOpen);
  const setOpen = useClientStore((s) => s.setPaletteOpen);
  const setQuery = useClientStore((s) => s.setQuery);
  const setSelectedThread = useClientStore((s) => s.setSelectedThread);
  const setComposeOpen = useClientStore((s) => s.setComposeOpen);
  const account = useClientStore((s) => s.account);
  const setAccount = useClientStore((s) => s.setAccount);
  const { setTheme } = useTheme();

  const { data: accountsData } = useQuery({
    queryKey: ['accounts'],
    queryFn: async () => callTool<{ accounts: any[] }>('list_accounts'),
    enabled: open,
  });

  const { data: recent } = useQuery({
    queryKey: ['recent-threads'],
    queryFn: async () => callTool<{ threads: any[] }>('recent_threads', { limit: 40 }),
    enabled: open,
  });

  const close = () => setOpen(false);
  const run = (fn: () => void) => {
    close();
    fn();
  };

  // Keyboard binding (⌘P also opens).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [setOpen]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-[600px] overflow-hidden p-0" showCloseButton={false}>
        <Command shouldFilter>
          <CommandInput placeholder="Search threads, accounts, actions…" />
          <CommandList>
            <CommandEmpty>No matches.</CommandEmpty>

            <CommandGroup heading="Mailboxes">
              {[
                ['in:inbox newer_than:30d', 'Inbox', Inbox],
                ['is:unread newer_than:30d', 'Unread', MailOpen],
                ['is:starred newer_than:365d', 'Starred', Star],
                ['is:important newer_than:60d', 'Important', Sparkles],
                ['from:(icloud.com OR me.com) newer_than:365d', 'iCloud', Cloud],
                ['has:attachment newer_than:90d', 'Attachments', Sparkles],
                ['in:sent newer_than:365d', 'Sent', Send],
                ['in:drafts', 'Drafts', Pencil],
                ['label:MailOS/Snoozed', 'Snoozed', AlarmClock],
              ].map(([q, label, Icon]: any) => (
                <CommandItem key={q} value={`mailbox ${label}`} onSelect={() => run(() => setQuery(q))}>
                  <Icon className="h-3.5 w-3.5 opacity-60" /> {label}
                </CommandItem>
              ))}
            </CommandGroup>

            <CommandGroup heading="AI">
              <CommandItem value="ai compose" onSelect={() => run(() => setComposeOpen(true))}>
                <Sparkles className="h-3.5 w-3.5 text-[var(--color-accent)]" /> Compose new message
                <CommandShortcut>c</CommandShortcut>
              </CommandItem>
              <CommandItem
                value="ai triage 25"
                onSelect={() =>
                  run(() => {
                    setOpen(false);
                    document.dispatchEvent(new CustomEvent('mail-os:ask', { detail: 'Triage my newest 25 inbox threads' }));
                  })
                }
              >
                <Sparkles className="h-3.5 w-3.5 text-[var(--color-accent)]" /> AI · triage newest 25
              </CommandItem>
              <CommandItem
                value="ai daily digest"
                onSelect={() =>
                  run(() => {
                    document.dispatchEvent(new CustomEvent('mail-os:ask', { detail: 'Summarize my unread from today and propose 3 replies' }));
                  })
                }
              >
                <Sparkles className="h-3.5 w-3.5 text-[var(--color-accent)]" /> AI · summarize today
              </CommandItem>
            </CommandGroup>

            {(accountsData?.accounts || []).filter((a: any) => a.authed).length > 1 ? (
              <CommandGroup heading="Accounts">
                {(accountsData?.accounts || [])
                  .filter((a: any) => a.authed)
                  .map((a: any) => (
                    <CommandItem
                      key={a.email}
                      value={`account ${a.email}`}
                      onSelect={() => run(() => setAccount(a.email))}
                    >
                      <span className={account === a.email ? 'font-semibold' : ''}>{a.email}</span>
                      {a.primary ? <CommandShortcut>primary</CommandShortcut> : null}
                    </CommandItem>
                  ))}
              </CommandGroup>
            ) : null}

            {(recent?.threads || []).length ? (
              <CommandGroup heading="Recent threads">
                {(recent?.threads || []).slice(0, 12).map((t: any) => (
                  <CommandItem
                    key={t._id}
                    value={`thread ${t.subject} ${shortFrom(t.fromAddress)}`}
                    onSelect={() =>
                      run(() => {
                        if (t.account) setAccount(t.account);
                        setSelectedThread(t._id);
                      })
                    }
                  >
                    <div className="flex min-w-0 flex-col">
                      <span className="truncate text-[12.5px]">{t.subject || '(no subject)'}</span>
                      <span className="truncate text-[10.5px] text-[var(--color-text-faint)]">{shortFrom(t.fromAddress)}</span>
                    </div>
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : null}

            <CommandGroup heading="View">
              <CommandItem value="theme dark" onSelect={() => run(() => setTheme('dark'))}>
                <Moon className="h-3.5 w-3.5" /> Switch to dark theme
              </CommandItem>
              <CommandItem value="theme light" onSelect={() => run(() => setTheme('light'))}>
                <Sun className="h-3.5 w-3.5" /> Switch to light theme
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
