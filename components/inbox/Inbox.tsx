'use client';

import { useEffect, useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { motion, AnimatePresence } from 'motion/react';
import { RefreshCw, Search, Archive, Trash2, Gauge, Inbox as InboxIcon, X, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { callTool } from '@/lib/api-client';
import { useClientStore } from '@/lib/client-state';
import { ALL_ACCOUNTS } from '@/components/shell/Rail';
import { Avatar } from '@/components/ui/avatar';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { formatDate, shortFrom } from '@/lib/shared/format';

// An empty search means "show everything" — map it to Gmail's All Mail
// (everything except Trash). Matches the "All mail" mailbox in the rail.
const ALL_MAIL_QUERY = '-in:trash newer_than:365d';

interface ThreadRow {
  _id: string;
  account?: string;
  subject?: string;
  from?: string;
  fromAddress?: string;
  date?: number | string;
  lastDate?: number;
  snippet?: string;
  labels?: string[];
  unread?: boolean;
}

export function Inbox() {
  const account = useClientStore((s) => s.account);
  const query = useClientStore((s) => s.query);
  const setQuery = useClientStore((s) => s.setQuery);
  const selectedThreadId = useClientStore((s) => s.selectedThreadId);
  const setSelectedThread = useClientStore((s) => s.setSelectedThread);
  const selectedIds = useClientStore((s) => s.selectedIds);
  const toggleSelected = useClientStore((s) => s.toggleSelected);
  const clearSelected = useClientStore((s) => s.clearSelected);

  const queryClient = useQueryClient();
  const [searchInput, setSearchInput] = useState(query);
  const [translating, setTranslating] = useState(false);

  // Reflect the active query in the bar — but show All Mail as an empty bar
  // (placeholder), so "all mail" reads as "no filter" instead of raw syntax.
  useEffect(() => setSearchInput(query === ALL_MAIL_QUERY ? '' : query), [query]);

  const clearSearch = () => {
    setSearchInput('');
    setQuery(ALL_MAIL_QUERY);
  };

  // Heuristic: a Gmail query has at least one operator. Natural language doesn't.
  const looksLikeGmailQuery = (s: string) =>
    /\b(from|to|cc|bcc|subject|is|in|has|label|larger|smaller|newer_than|older_than|after|before|filename|deliveredto|list)\s*:/i.test(s);

  const submitSearch = async () => {
    const raw = searchInput.trim();
    if (!raw) {
      // Empty search = all mail, instead of silently doing nothing.
      setQuery(ALL_MAIL_QUERY);
      return;
    }
    if (looksLikeGmailQuery(raw)) {
      setQuery(raw);
      return;
    }
    // Natural language — translate via nl_search, then run.
    setTranslating(true);
    try {
      const { query: translated } = await callTool<{ query: string; model: string }>('nl_search', {
        description: raw,
      });
      const finalQuery = translated && translated.trim() ? translated.trim() : raw;
      setQuery(finalQuery);
      setSearchInput(finalQuery);
      toast.success(`Searching · ${finalQuery}`);
    } catch (err: any) {
      toast.error(`Could not translate: ${err?.message || 'unknown error'}`);
      setQuery(raw);
    } finally {
      setTranslating(false);
    }
  };

  // When account is the synthetic ALL_ACCOUNTS marker, fan out across every
  // authed Gmail account and merge by date. Otherwise just hit one.
  const { data: accountsData } = useQuery({
    queryKey: ['accounts'],
    queryFn: async () =>
      callTool<{ accounts: { email: string; authed: boolean }[] }>('list_accounts'),
    staleTime: 60_000,
  });
  const authedEmails = (accountsData?.accounts || []).filter((a) => a.authed).map((a) => a.email);

  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ['search', account, query, authedEmails.join(',')],
    queryFn: async () => {
      if (account === ALL_ACCOUNTS) {
        const perAccount = Math.max(8, Math.ceil(50 / Math.max(authedEmails.length, 1)));
        const results = await Promise.all(
          authedEmails.map((email) =>
            callTool<{ items: ThreadRow[] }>('search_threads', { account: email, query, max: perAccount })
              .then((r) => r.items.map((it) => ({ ...it, account: email })))
              .catch(() => [] as ThreadRow[]),
          ),
        );
        const merged = results.flat();
        merged.sort((a, b) => (Number(b.lastDate ?? b.date) || 0) - (Number(a.lastDate ?? a.date) || 0));
        return { items: merged.slice(0, 80) };
      }
      return callTool<{ items: ThreadRow[] }>('search_threads', { account, query, max: 50 });
    },
    enabled: !!account && (account !== ALL_ACCOUNTS || authedEmails.length > 0),
  });

  const items = data?.items || [];

  // Each item knows its own account (set by the fan-out above), so bulk
  // operations dispatch per-item using that account rather than the
  // currently-selected one. Required for ALL_ACCOUNTS view.
  const accountOfRow = (id: string) => items.find((it) => it._id === id)?.account || account;

  const bulkArchive = useMutation({
    mutationFn: async (ids: string[]) => {
      await Promise.allSettled(
        ids.map((id) =>
          callTool('archive_thread', { account: accountOfRow(id), threadId: id }),
        ),
      );
    },
    onSuccess: () => {
      toast.success(`Archived ${selectedIds.length}`);
      clearSelected();
      refetch();
    },
  });

  const bulkTrash = useMutation({
    mutationFn: async (ids: string[]) => {
      await Promise.allSettled(
        ids.map((id) =>
          callTool('trash_thread', { account: accountOfRow(id), threadId: id }),
        ),
      );
    },
    onSuccess: () => {
      toast.success(`Trashed ${selectedIds.length}`);
      clearSelected();
      refetch();
    },
  });

  const bulkTriage = useMutation({
    mutationFn: async () => {
      const list = items
        .filter((it) => selectedIds.includes(it._id))
        .map((it) => ({
          id: it._id,
          from: it.from || it.fromAddress,
          subject: it.subject,
          snippet: it.snippet,
        }));
      return callTool<{ verdicts: any[] }>('bulk_triage', { items: list });
    },
    onSuccess: (res) => {
      toast.success(`Triaged ${res.verdicts.length}`);
      queryClient.setQueryData(['search', account, query], (old: any) => {
        if (!old?.items) return old;
        const updated = old.items.map((it: any) => {
          const v = res.verdicts.find((x: any) => x.id === it._id);
          if (v) return { ...it, triage: { priority: v.priority, action: v.action, reason: v.reason, at: Date.now() } };
          return it;
        });
        return { ...old, items: updated };
      });
    },
  });

  return (
    <section className="flex h-full flex-col bg-[var(--color-bg)]">
      <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-3 py-2.5">
        <div className="relative flex-1">
          {translating ? (
            <Loader2 className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 animate-spin text-[var(--color-accent)]" />
          ) : (
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--color-text-faint)]" />
          )}
          <input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                submitSearch();
              } else if (e.key === 'Escape' && searchInput) {
                e.preventDefault();
                clearSearch();
              }
            }}
            placeholder='Gmail query, or just say what you want ("emails from board members last quarter")'
            className={cn(
              'h-8 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg-elevated)] pl-8 text-[13px] outline-none focus:border-[var(--color-accent)] focus:ring-2 focus:ring-[var(--color-accent)]/30',
              searchInput ? 'pr-8' : 'pr-3',
            )}
          />
          {searchInput ? (
            <button
              type="button"
              onClick={clearSearch}
              className="absolute right-2 top-1/2 grid h-5 w-5 -translate-y-1/2 place-items-center rounded text-[var(--color-text-faint)] hover:bg-[var(--color-bg-muted)] hover:text-[var(--color-text)]"
              title="Clear search (show all mail)"
            >
              <X className="h-3 w-3" />
              <span className="sr-only">Clear search</span>
            </button>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => refetch()}
          className={cn(
            'grid h-8 w-8 place-items-center rounded-md border border-[var(--color-border)] bg-[var(--color-bg-elevated)] text-[var(--color-text-muted)] hover:bg-[var(--color-bg-subtle)]',
            isFetching && 'animate-spin',
          )}
          title="Refresh"
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
      </div>

      <AnimatePresence>
        {selectedIds.length > 0 ? (
          <motion.div
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            className="flex items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-accent-soft)] px-3 py-2 text-[12px]"
          >
            <span className="font-semibold text-[var(--color-text)]">{selectedIds.length} selected</span>
            <button
              type="button"
              onClick={() => bulkArchive.mutate(selectedIds)}
              className="ml-2 flex items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-2.5 py-1 hover:bg-[var(--color-bg-subtle)]"
            >
              <Archive className="h-3 w-3" />
              Archive
            </button>
            <button
              type="button"
              onClick={() => bulkTrash.mutate(selectedIds)}
              className="flex items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-2.5 py-1 hover:bg-[var(--color-bg-subtle)]"
            >
              <Trash2 className="h-3 w-3" />
              Trash
            </button>
            <button
              type="button"
              onClick={() => bulkTriage.mutate()}
              className="flex items-center gap-1 rounded-md bg-[var(--color-accent)] px-2.5 py-1 text-[var(--color-accent-foreground)] hover:bg-[var(--color-accent-hover)]"
            >
              <Gauge className="h-3 w-3" />
              AI: triage
            </button>
            <button
              type="button"
              onClick={() => clearSelected()}
              className="ml-auto grid h-5 w-5 place-items-center rounded text-[var(--color-text-muted)] hover:bg-[var(--color-bg-elevated)] hover:text-[var(--color-text)]"
              title="Clear selection"
            >
              <X className="h-3 w-3" />
            </button>
          </motion.div>
        ) : null}
      </AnimatePresence>

      <div className="flex flex-1 flex-col overflow-y-auto">
        {isLoading ? (
          <SkeletonRows />
        ) : items.length === 0 ? (
          <EmptyState account={account} />
        ) : (
          <AnimatePresence initial={false} mode="popLayout">
            {items.map((it) => (
              <ThreadRowCard
                key={`${it.account}:${it._id}`}
                item={it}
                showAccount={account === ALL_ACCOUNTS}
                selected={selectedIds.includes(it._id)}
                active={selectedThreadId === it._id}
                onToggle={() => toggleSelected(it._id)}
                onClick={() => {
                  if (it.account && it.account !== account) {
                    useClientStore.getState().setAccount(it.account);
                  }
                  setSelectedThread(it._id);
                }}
              />
            ))}
          </AnimatePresence>
        )}
      </div>
    </section>
  );
}

function ThreadRowCard({
  item,
  selected,
  active,
  onToggle,
  onClick,
  showAccount,
}: {
  item: ThreadRow;
  selected: boolean;
  active: boolean;
  onToggle: () => void;
  onClick: () => void;
  showAccount?: boolean;
}) {
  const triage = (item as any).triage;
  const priorityClass =
    triage?.priority === 1 ? 'bg-[var(--color-prio-1)]' : triage?.priority === 2 ? 'bg-[var(--color-prio-2)]' : '';
  const senderLabel = shortFrom(item.from || item.fromAddress || '');
  const date = (item.date as any) || item.lastDate || 0;

  return (
    <motion.button
      layout
      type="button"
      onClick={onClick}
      initial={{ opacity: 0, filter: 'blur(6px)' }}
      animate={{ opacity: 1, filter: 'blur(0)' }}
      exit={{ opacity: 0, filter: 'blur(4px)' }}
      transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
      className={cn(
        'relative grid grid-cols-[20px_28px_1fr_auto] gap-2.5 border-b border-[var(--color-border)] px-3 py-2.5 text-left transition-colors hover:bg-[var(--color-bg-subtle)]',
        active && 'bg-[var(--color-bg-subtle)]',
        selected && 'bg-[var(--color-accent-soft)]',
      )}
    >
      <span className={cn('absolute left-0 top-2.5 bottom-2.5 w-0.5 rounded-r-full', priorityClass)} />

      <div className="flex h-full items-start pt-0.5" onClick={(e) => e.stopPropagation()}>
        <Checkbox checked={selected} onCheckedChange={() => onToggle()} />
      </div>

      <Avatar name={senderLabel || item.account} size={26} />

      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              'truncate text-[13px]',
              item.unread ? 'font-semibold text-[var(--color-text)]' : 'text-[var(--color-text)]',
            )}
          >
            {senderLabel || item.account}
          </span>
          {item.unread ? <span className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--color-accent)]" /> : null}
        </div>
        <span className="truncate text-[13px] text-[var(--color-text)]">{item.subject || '(no subject)'}</span>
        <span className="line-clamp-1 text-[11.5px] text-[var(--color-text-muted)]">{item.snippet || ''}</span>
        {triage?.reason ? (
          <span className="mt-0.5 line-clamp-1 text-[11px] text-[var(--color-accent)]">
            AI · {triage.action} · {triage.reason}
          </span>
        ) : null}
      </div>

      <div className="flex flex-col items-end gap-1">
        <span className="text-[11px] text-[var(--color-text-faint)]">{formatDate(date)}</span>
        {showAccount && item.account ? (
          <Badge variant="outline" className="font-mono text-[9px] normal-case">
            {item.account.split('@')[0]}
          </Badge>
        ) : null}
        {(item.labels || []).slice(0, 1).map((l) =>
          l.startsWith('CATEGORY_') || l === 'INBOX' || l === 'UNREAD' ? null : (
            <Badge key={l} variant="outline">
              {l.replace(/^MailOS\//, '')}
            </Badge>
          ),
        )}
      </div>
    </motion.button>
  );
}

function SkeletonRows() {
  return (
    <div className="flex flex-col">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="grid grid-cols-[28px_1fr] gap-3 border-b border-[var(--color-border)] px-3 py-3">
          <div className="h-6 w-6 rounded-full shimmer" />
          <div className="flex flex-col gap-1.5">
            <div className="h-3 w-2/5 rounded shimmer" />
            <div className="h-3 w-3/4 rounded shimmer" />
          </div>
        </div>
      ))}
    </div>
  );
}

function EmptyState({ account }: { account: string }) {
  return (
    <div className="grid flex-1 place-items-center px-6 py-12 text-center">
      <div className="flex flex-col items-center gap-2">
        <div className="grid h-10 w-10 place-items-center rounded-full bg-[var(--color-bg-subtle)]">
          <InboxIcon className="h-4 w-4 text-[var(--color-text-faint)]" />
        </div>
        <h3 className="text-sm font-medium text-[var(--color-text)]">Nothing here yet</h3>
        <p className="max-w-[280px] text-[12px] text-[var(--color-text-muted)]">
          {account ? 'Try a different search or mailbox.' : 'Connect a Gmail account in /scripts/auth-google.sh.'}
        </p>
      </div>
    </div>
  );
}
