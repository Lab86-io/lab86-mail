'use client';

import { useInfiniteQuery, useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Archive,
  Ban,
  CheckCircle2,
  Gauge,
  Inbox as InboxIcon,
  MoreHorizontal,
  RefreshCw,
  Search,
  Tag,
  Trash2,
  X,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  Confirmation,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationRequest,
  ConfirmationTitle,
} from '@/components/ai-elements/confirmation';
import { OrbitRing } from '@/components/loading-ui/orbit-ring';
import { Ring } from '@/components/loading-ui/ring';
import { TextShimmer } from '@/components/loading-ui/text-shimmer';
import { ALL_ACCOUNTS } from '@/components/shell/Rail';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { BorderBeam } from '@/components/ui/border-beam';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ShineBorder } from '@/components/ui/shine-border';
import { callTool } from '@/lib/api-client';
import { useClientStore } from '@/lib/client-state';
import { labelsForSmartCategory, SMART_CATEGORY_LABELS } from '@/lib/mail/smart-categories';
import { emailFromHeader, formatDate, shortFrom } from '@/lib/shared/format';
import { cn } from '@/lib/utils';

// An empty search (or the clear button / Esc) returns to the default unified
// inbox view across all mailboxes.
const DEFAULT_QUERY = 'in:inbox newer_than:30d';
const INBOX_PAGE_SIZE = 50;
const SKELETON_ROW_KEYS = Array.from({ length: 12 }, (_, index) => `skeleton-row-${index + 1}`);

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
  smartCategory?: any;
}

interface ThreadMessage {
  _id: string;
  from?: string;
  to?: string;
  cc?: string;
  bcc?: string;
  date?: number | string;
}

interface SearchThreadsResult {
  items: ThreadRow[];
  nextPageToken?: string;
}

interface InboxPage {
  items: ThreadRow[];
  nextPageTokens: Record<string, string>;
}

export function Inbox() {
  const account = useClientStore((s) => s.account);
  const query = useClientStore((s) => s.query);
  const setQuery = useClientStore((s) => s.setQuery);
  const smartCategory = useClientStore((s) => s.smartCategory);
  const setSmartCategory = useClientStore((s) => s.setSmartCategory);
  const searchDraft = useClientStore((s) => s.searchDraft);
  const setSearchDraft = useClientStore((s) => s.setSearchDraft);
  const nlSearchIntent = useClientStore((s) => s.nlSearchIntent);
  const translatedQuery = useClientStore((s) => s.translatedQuery);
  const setTranslatedSearch = useClientStore((s) => s.setTranslatedSearch);
  const queryError = useClientStore((s) => s.queryError);
  const setQueryError = useClientStore((s) => s.setQueryError);
  const selectedThreadId = useClientStore((s) => s.selectedThreadId);
  const setSelectedThread = useClientStore((s) => s.setSelectedThread);
  const setThreadAccount = useClientStore((s) => s.setThreadAccount);
  const selectedIds = useClientStore((s) => s.selectedIds);
  const toggleSelected = useClientStore((s) => s.toggleSelected);
  const clearSelected = useClientStore((s) => s.clearSelected);
  const railOpen = useClientStore((s) => s.railOpen);
  const aiBarOpen = useClientStore((s) => s.aiBarOpen);
  const composeMode = useClientStore((s) => s.compose.mode);

  const queryClient = useQueryClient();
  const [searchInput, setSearchInput] = useState(searchDraft || (query === DEFAULT_QUERY ? '' : query));
  const [translating, setTranslating] = useState(false);
  const [labelPreview, setLabelPreview] = useState<ThreadRow | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const loadMoreRef = useRef<HTMLDivElement>(null);

  // Reflect the active query in the bar — but show All Mail as an empty bar
  // (placeholder), so "all mail" reads as "no filter" instead of raw syntax.
  useEffect(() => {
    if (smartCategory) {
      setSearchInput(searchDraft || '');
      return;
    }
    setSearchInput(searchDraft || (query === DEFAULT_QUERY ? '' : query));
  }, [query, searchDraft, smartCategory]);

  const clearSearch = () => {
    setSearchInput('');
    setSearchDraft('');
    setTranslatedSearch(null, null, 'category');
    setQueryError(null);
    setQuery(DEFAULT_QUERY);
    setSmartCategory('main');
  };

  // Heuristic: a Gmail query has at least one operator. Natural language doesn't.
  const looksLikeGmailQuery = (s: string) =>
    /\b(from|to|cc|bcc|subject|is|in|has|label|larger|smaller|newer_than|older_than|after|before|filename|deliveredto|list)\s*:/i.test(
      s,
    );

  const runSearch = async (input: string) => {
    const raw = input.trim();
    if (!raw) {
      // Empty search returns to the unified inbox, instead of doing nothing.
      setSearchDraft('');
      setTranslatedSearch(null, null, 'category');
      setQuery(DEFAULT_QUERY);
      setSmartCategory('main');
      return;
    }
    setSearchDraft(raw);
    if (looksLikeGmailQuery(raw)) {
      setQuery(raw);
      setTranslatedSearch(null, raw, 'gmail');
      return;
    }
    // Natural language — translate via nl_search, then run.
    setTranslating(true);
    try {
      const { query: translated } = await callTool<{ query: string; model: string }>('nl_search', {
        description: raw,
      });
      const finalQuery = translated?.trim() ? translated.trim() : raw;
      setQuery(finalQuery);
      setSearchDraft(raw);
      setTranslatedSearch(raw, finalQuery, 'natural_language');
      toast.success(`Searching · ${finalQuery}`);
    } catch (err: any) {
      toast.error(`Could not translate: ${err?.message || 'unknown error'}`);
      setQueryError(err?.message || 'Could not translate search');
    } finally {
      setTranslating(false);
    }
  };
  const submitSearch = () => runSearch(searchInput);

  // When account is the synthetic ALL_ACCOUNTS marker, fan out across every
  // authed Gmail account and merge by date. Otherwise just hit one.
  const { data: accountsData } = useQuery({
    queryKey: ['accounts'],
    queryFn: async () => callTool<{ accounts: { email: string; authed: boolean }[] }>('list_accounts'),
    staleTime: 60_000,
  });
  const authedEmails = (accountsData?.accounts || []).filter((a) => a.authed).map((a) => a.email);
  const { data: smartLabelsData } = useQuery({
    queryKey: ['smart-labels'],
    queryFn: async () => callTool<{ custom: any[] }>('list_smart_labels', {}),
    staleTime: 60_000,
  });
  const customLabels = smartLabelsData?.custom || [];
  const activeSmartLabel = smartCategory?.startsWith('custom:')
    ? customLabels.find((label) => label._id === smartCategory.slice('custom:'.length))?.name || smartCategory
    : smartCategory
      ? SMART_CATEGORY_LABELS[smartCategory as keyof typeof SMART_CATEGORY_LABELS] || smartCategory
      : '';

  const { data, isLoading, isFetching, isFetchingNextPage, hasNextPage, fetchNextPage, refetch } =
    useInfiniteQuery({
      queryKey: ['search', account, query, smartCategory, authedEmails.join(',')],
      initialPageParam: {} as Record<string, string>,
      queryFn: async ({ pageParam }): Promise<InboxPage> => {
        const pageTokens = pageParam as Record<string, string>;
        if (account === ALL_ACCOUNTS) {
          const initialPage = Object.keys(pageTokens).length === 0;
          const emailsToFetch = initialPage
            ? authedEmails
            : authedEmails.filter((email) => pageTokens[email]);
          const perAccount = Math.max(8, Math.ceil(INBOX_PAGE_SIZE / Math.max(authedEmails.length, 1)));
          const results = await Promise.all(
            emailsToFetch.map((email) =>
              callTool<SearchThreadsResult>(smartCategory ? 'list_smart_category' : 'search_threads', {
                account: email,
                category: smartCategory,
                query: smartCategory ? undefined : query,
                max: perAccount,
                pageToken: pageTokens[email],
              })
                .then((r) => ({
                  email,
                  items: r.items.map((it) => ({ ...it, account: email })),
                  nextPageToken: r.nextPageToken,
                }))
                .catch(() => ({ email, items: [] as ThreadRow[], nextPageToken: undefined })),
            ),
          );
          const merged = results.flatMap((result) => result.items);
          merged.sort((a, b) => (Number(b.lastDate ?? b.date) || 0) - (Number(a.lastDate ?? a.date) || 0));
          const nextPageTokens = Object.fromEntries(
            results
              .filter((result) => result.nextPageToken)
              .map((result) => [result.email, result.nextPageToken as string]),
          );
          return { items: merged, nextPageTokens };
        }
        const result = await callTool<SearchThreadsResult>(
          smartCategory ? 'list_smart_category' : 'search_threads',
          {
            account,
            category: smartCategory,
            query: smartCategory ? undefined : query,
            max: INBOX_PAGE_SIZE,
            pageToken: pageTokens[account],
          },
        );
        return {
          items: result.items.map((it) => ({ ...it, account })),
          nextPageTokens: result.nextPageToken ? { [account]: result.nextPageToken } : {},
        };
      },
      getNextPageParam: (lastPage) =>
        Object.keys(lastPage.nextPageTokens).length ? lastPage.nextPageTokens : undefined,
      enabled: !!account && (account !== ALL_ACCOUNTS || authedEmails.length > 0),
      // Inbox freshness: any cached search result is treated as stale right
      // away, so re-mounts, window focus, and reconnects always re-hit Gmail.
      staleTime: 0,
      // Background poll while the tab is in the foreground. `refetchInterval`
      // pauses automatically when the document is hidden (browser default).
      refetchInterval: 30_000,
      // Don't keep polling a buried tab — pairs with onWindowFocus to catch up.
      refetchIntervalInBackground: false,
    });

  const refreshInbox = () => {
    queryClient.invalidateQueries({ queryKey: ['thread'] });
    refetch();
  };

  // Tabbing back to the window is the most natural "any new mail?" signal.
  // React Query already refetches active queries on focus (we enabled the
  // default), but we additionally invalidate the per-thread cache so the
  // currently-open thread also picks up any new replies.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      queryClient.invalidateQueries({ queryKey: ['search'] });
      queryClient.invalidateQueries({ queryKey: ['thread'] });
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [queryClient]);

  const items = useMemo(() => {
    const byKey = new Map<string, ThreadRow>();
    for (const item of data?.pages.flatMap((page) => page.items) || []) {
      byKey.set(`${item.account || account}:${item._id}`, item);
    }
    return [...byKey.values()].sort(
      (a, b) => (Number(b.lastDate ?? b.date) || 0) - (Number(a.lastDate ?? a.date) || 0),
    );
  }, [account, data?.pages]);
  const readerVisible = !!(selectedThreadId || composeMode);

  useEffect(() => {
    const root = scrollRef.current;
    const target = loadMoreRef.current;
    if (!root || !target || !hasNextPage || isFetchingNextPage) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) fetchNextPage();
      },
      { root, rootMargin: '600px 0px 600px 0px' },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [fetchNextPage, hasNextPage, isFetchingNextPage]);

  // Once we know the visible senders, fetch their Google profile photos.
  // The lookup is best-effort: contacts + the user's own accounts resolve,
  // everyone else stays on the boring-avatar. Cached server-side for ~7 days
  // (including negative results) so this is essentially free after first load.
  const primaryAccount = useClientStore((s) => s.primaryAccount);
  const photoAccount =
    primaryAccount && primaryAccount !== ALL_ACCOUNTS
      ? primaryAccount
      : account && account !== ALL_ACCOUNTS
        ? account
        : '';
  const photoEmails = useMemo(() => {
    const set = new Set<string>();
    for (const it of items) {
      const email = emailFromHeader(it.from || it.fromAddress);
      if (email) set.add(email);
    }
    return [...set].sort();
  }, [items]);
  const photosQuery = useQuery({
    queryKey: ['photos', photoAccount, photoEmails.join(',')],
    queryFn: async () =>
      callTool<{ photos: Record<string, string | null> }>('resolve_photos', {
        account: photoAccount,
        emails: photoEmails,
      }),
    enabled: !!photoAccount && photoEmails.length > 0,
    staleTime: 24 * 60 * 60_000,
  });
  const photos = photosQuery.data?.photos || {};

  const participantRows = useMemo(() => items.slice(0, 24), [items]);
  const participantQueries = useQueries({
    queries: participantRows.map((item) => ({
      queryKey: ['thread-participants', item.account || account, item._id],
      queryFn: async () =>
        callTool<{ messages: ThreadMessage[] }>('get_thread', {
          account: item.account || account,
          threadId: item._id,
          refresh: false,
        }),
      enabled: !!(item.account || account) && !!item._id,
      staleTime: 2 * 60_000,
    })),
  });
  const participantLabels = useMemo(() => {
    const labels = new Map<string, string>();
    participantRows.forEach((item, index) => {
      const messages = participantQueries[index]?.data?.messages || [];
      const label = formatThreadParticipants(
        messages,
        item.account || account,
        item.from || item.fromAddress,
      );
      if (label) labels.set(`${item.account || account}:${item._id}`, label);
    });
    return labels;
  }, [account, participantQueries, participantRows]);

  // Each item knows its own account (set by the fan-out above), so bulk
  // operations dispatch per-item using that account rather than the
  // currently-selected one. Required for ALL_ACCOUNTS view.
  const accountOfRow = (id: string) => items.find((it) => it._id === id)?.account || account;

  const bulkArchive = useMutation({
    mutationFn: async (ids: string[]) => {
      await Promise.allSettled(
        ids.map((id) => callTool('archive_thread', { account: accountOfRow(id), threadId: id })),
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
        ids.map((id) => callTool('trash_thread', { account: accountOfRow(id), threadId: id })),
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
      queryClient.invalidateQueries({ queryKey: ['search'] });
    },
  });

  const applyLabels = useMutation({
    mutationFn: async (item: ThreadRow) => {
      const labels = labelsForSmartCategory((item as any).smartCategory, customLabels);
      if (!labels.length) throw new Error('No smart labels available');
      return callTool('apply_smart_labels', {
        account: item.account || account,
        items: [{ threadId: item._id, labels }],
      });
    },
    onSuccess: () => {
      toast.success('Smart labels applied');
      setLabelPreview(null);
      queryClient.invalidateQueries({ queryKey: ['search'] });
      queryClient.invalidateQueries({ queryKey: ['smart-counts'] });
    },
    onError: (err: any) => toast.error(`Could not apply labels: ${err?.message || 'unknown error'}`),
  });
  const applyCorrection = useMutation({
    mutationFn: async (input: any) => callTool('apply_smart_correction', input),
    onSuccess: () => {
      toast.success('Smart rule saved');
      queryClient.invalidateQueries({ queryKey: ['search'] });
      queryClient.invalidateQueries({ queryKey: ['smart-counts'] });
      queryClient.invalidateQueries({ queryKey: ['smart-labels'] });
    },
    onError: (err: any) => toast.error(`Could not save correction: ${err?.message || 'unknown error'}`),
  });
  const undoLastRule = useMutation({
    mutationFn: async () => {
      const res = await callTool<{ rules: any[] }>('list_smart_rules', { includeDisabled: false });
      const latest = res.rules?.[0];
      if (!latest) throw new Error('No rule to undo');
      return callTool('set_smart_rule_enabled', { id: latest._id, enabled: false });
    },
    onSuccess: () => {
      toast.success('Last smart rule disabled');
      queryClient.invalidateQueries({ queryKey: ['search'] });
      queryClient.invalidateQueries({ queryKey: ['smart-counts'] });
    },
    onError: (err: any) => toast.error(`Could not undo: ${err?.message || 'unknown error'}`),
  });
  return (
    <section className="flex h-full flex-col bg-[var(--color-bg)]">
      <div
        className={cn(
          'flex flex-col gap-2 border-b border-[var(--color-border)] px-3 py-2.5',
          !railOpen && 'pl-12',
          !aiBarOpen && !readerVisible && 'pr-12',
        )}
      >
        <div className="flex items-center gap-2">
          <InputGroup className="relative flex-1 overflow-hidden bg-[var(--color-bg-elevated)]">
            {translating ? <BorderBeam size={80} duration={3} colorFrom="#4cb7c8" colorTo="#7c3aed" /> : null}
            <InputGroupAddon>
              {translating ? (
                <OrbitRing className="size-4 text-[var(--color-accent)]" />
              ) : (
                <Search className="size-4 text-[var(--color-text-faint)]" />
              )}
            </InputGroupAddon>
            <InputGroupInput
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
              placeholder='Ask for mail or type Gmail syntax, e.g. "order updates from this week"'
              className="text-[13px]"
            />
            {searchInput ? (
              <InputGroupAddon align="inline-end">
                <InputGroupButton size="icon-xs" onClick={clearSearch} title="Clear search">
                  <X className="size-3" />
                  <span className="sr-only">Clear search</span>
                </InputGroupButton>
              </InputGroupAddon>
            ) : null}
          </InputGroup>
          <button
            type="button"
            onClick={refreshInbox}
            className={cn(
              'grid h-9 w-9 place-items-center rounded-md border border-[var(--color-border)] bg-[var(--color-bg-elevated)] text-[var(--color-text-muted)] hover:bg-[var(--color-bg-subtle)]',
              isFetching && !isFetchingNextPage && 'text-[var(--color-accent)]',
            )}
            title="Refresh"
          >
            {isFetching && !isFetchingNextPage ? (
              <Ring className="size-4" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
          </button>
        </div>
        <div className="flex min-h-6 flex-wrap items-center gap-1.5">
          {smartCategory ? (
            <Badge variant="secondary" className="gap-1">
              {activeSmartLabel}
            </Badge>
          ) : null}
          {nlSearchIntent ? <Badge variant="outline">Asked: {nlSearchIntent}</Badge> : null}
          {translatedQuery && !smartCategory ? (
            <Badge variant="outline" className="gap-1">
              Filter: <span className="font-mono">{translatedQuery}</span>
              <button type="button" onClick={clearSearch} title="Clear generated filter">
                <X className="size-3" />
              </button>
            </Badge>
          ) : null}
          {!translatedQuery && !smartCategory && query !== DEFAULT_QUERY ? (
            <Badge variant="outline" className="gap-1">
              Filter: <span className="font-mono">{query}</span>
              <button type="button" onClick={clearSearch} title="Clear filter">
                <X className="size-3" />
              </button>
            </Badge>
          ) : null}
          {translating ? (
            <TextShimmer className="text-[11px] text-[var(--color-accent)]">Translating filter</TextShimmer>
          ) : null}
          {queryError ? <span className="text-[11px] text-[var(--color-danger)]">{queryError}</span> : null}
        </div>
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

      <div ref={scrollRef} className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {isLoading ? (
          <SkeletonRows />
        ) : items.length === 0 ? (
          translatedQuery || nlSearchIntent ? (
            <SearchEmptyState
              onClear={clearSearch}
              onEditGenerated={() => {
                const editable = translatedQuery || query;
                setQuery(editable);
                setSearchInput(editable);
                setSearchDraft(editable);
                setTranslatedSearch(null, editable, 'gmail');
              }}
              onRetryOriginal={() => {
                if (!nlSearchIntent) return;
                setSearchInput(nlSearchIntent);
                runSearch(nlSearchIntent);
              }}
              onUseRaw={() => {
                if (nlSearchIntent) {
                  setQuery(nlSearchIntent);
                  setSearchInput(nlSearchIntent);
                }
              }}
            />
          ) : (
            <EmptyState account={account} />
          )
        ) : (
          <>
            <AnimatePresence initial={false} mode="popLayout">
              {items.map((it) => {
                const senderEmail = emailFromHeader(it.from || it.fromAddress);
                return (
                  <ThreadRowCard
                    key={`${it.account}:${it._id}`}
                    item={it}
                    participantLabel={participantLabels.get(`${it.account || account}:${it._id}`)}
                    photoUrl={senderEmail ? (photos[senderEmail] ?? null) : null}
                    showAccount={account === ALL_ACCOUNTS}
                    selected={selectedIds.includes(it._id)}
                    active={selectedThreadId === it._id}
                    onToggle={() => toggleSelected(it._id)}
                    onApplyLabels={() => setLabelPreview(it)}
                    onCorrect={(action, payload = {}) =>
                      applyCorrection.mutate({
                        account: it.account || account,
                        threadId: it._id,
                        action,
                        scope: 'sender',
                        ...payload,
                      })
                    }
                    onUndoLast={() => undoLastRule.mutate()}
                    customLabels={customLabels}
                    onClick={() => {
                      // Unified inbox stays put; just remember which mailbox this
                      // thread belongs to so the reader can load/reply correctly.
                      setThreadAccount(it.account || account);
                      setSelectedThread(it._id);
                    }}
                  />
                );
              })}
            </AnimatePresence>
            <div ref={loadMoreRef} className="min-h-1" aria-hidden />
            {isFetchingNextPage ? <SkeletonRows count={4} /> : null}
          </>
        )}
      </div>
      <LabelConfirmDialog
        item={labelPreview}
        applying={applyLabels.isPending}
        customLabels={customLabels}
        onClose={() => setLabelPreview(null)}
        onApply={(item) => applyLabels.mutate(item)}
      />
    </section>
  );
}

function ThreadRowCard({
  item,
  participantLabel,
  photoUrl,
  selected,
  active,
  onToggle,
  onClick,
  onApplyLabels,
  onCorrect,
  onUndoLast,
  customLabels,
  showAccount,
}: {
  item: ThreadRow;
  participantLabel?: string;
  photoUrl?: string | null;
  selected: boolean;
  active: boolean;
  onToggle: () => void;
  onClick: () => void;
  onApplyLabels: () => void;
  onCorrect: (action: string, payload?: Record<string, unknown>) => void;
  onUndoLast: () => void;
  customLabels: any[];
  showAccount?: boolean;
}) {
  const triage = (item as any).triage;
  const smart = (item as any).smartCategory;
  const priorityClass =
    triage?.priority === 1
      ? 'bg-[var(--color-prio-1)]'
      : triage?.priority === 2
        ? 'bg-[var(--color-prio-2)]'
        : '';
  const senderLabel = shortFrom(item.from || item.fromAddress || '');
  const displaySenderLabel = participantLabel || senderLabel || item.account || '';
  const date = (item.date as any) || item.lastDate || 0;

  return (
    <motion.div
      layout
      onClick={onClick}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onClick();
        }
      }}
      role="button"
      tabIndex={0}
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

      <div className="flex h-full items-start pt-0.5">
        <Checkbox
          checked={selected}
          onCheckedChange={() => onToggle()}
          onClick={(e) => e.stopPropagation()}
        />
      </div>

      <Avatar name={senderLabel || item.account} src={photoUrl} size={26} />

      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              'truncate text-[13px]',
              item.unread ? 'font-semibold text-[var(--color-text)]' : 'text-[var(--color-text)]',
            )}
          >
            {displaySenderLabel}
          </span>
          {item.unread ? (
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--color-accent)]" />
          ) : null}
        </div>
        <span className="truncate text-[13px] text-[var(--color-text)]">
          {item.subject || '(no subject)'}
        </span>
        <span className="line-clamp-1 text-[11.5px] text-[var(--color-text-muted)]">
          {item.snippet || ''}
        </span>
        {triage?.reason ? (
          <span className="mt-0.5 line-clamp-1 text-[11px] text-[var(--color-accent)]">
            AI · {triage.action} · {triage.reason}
          </span>
        ) : null}
        {smart?.reason ? (
          <span className="mt-0.5 line-clamp-1 text-[11px] text-[var(--color-text-muted)]">
            Smart · {smart.reason}
          </span>
        ) : null}
      </div>

      <div className="flex flex-col items-end gap-1">
        <span className="text-[11px] text-[var(--color-text-faint)]">{formatDate(date)}</span>
        {smart?.primary ? (
          <Popover>
            <PopoverTrigger asChild>
              <button type="button" className="inline-flex cursor-help" onClick={(e) => e.stopPropagation()}>
                <Badge variant="secondary" className="max-w-24 truncate text-[9px]">
                  {SMART_CATEGORY_LABELS[smart.primary as keyof typeof SMART_CATEGORY_LABELS] ||
                    smart.primary}
                </Badge>
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-72 text-[12px]">
              <div className="space-y-2">
                <div className="font-medium text-[var(--color-text)]">Why this is here</div>
                <p className="text-[var(--color-text-muted)]">{smart.reason}</p>
                <div className="flex flex-wrap gap-1">
                  <Badge variant="outline">{Math.round((smart.confidence || 0) * 100)}%</Badge>
                  {smart.needsAttention ? <Badge variant="outline">needs attention</Badge> : null}
                  {smart.isHumanLike ? <Badge variant="outline">human-like</Badge> : null}
                </div>
              </div>
            </PopoverContent>
          </Popover>
        ) : null}
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
        {(smart?.customLabels || []).slice(0, 2).map((id: string) => {
          const label = customLabels.find((entry) => entry._id === id);
          return label ? (
            <Badge key={id} variant="outline" className="text-[9px]">
              {label.name}
            </Badge>
          ) : null;
        })}
        {smart ? (
          <div className="mt-0.5 flex items-center gap-1">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onApplyLabels();
              }}
              className="inline-flex items-center gap-1 rounded border border-[var(--color-border)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)] hover:bg-[var(--color-bg-elevated)] hover:text-[var(--color-text)]"
            >
              <Tag className="size-3" />
              Label
            </button>
            <QuickFixMenu
              customLabels={customLabels}
              onCorrect={onCorrect}
              onCreateLabel={() => createLabelFromThread(item, onCorrect)}
              onUndoLast={onUndoLast}
            />
          </div>
        ) : null}
      </div>
    </motion.div>
  );
}

function QuickFixMenu({
  customLabels,
  onCorrect,
  onCreateLabel,
  onUndoLast,
}: {
  customLabels: any[];
  onCorrect: (action: string, payload?: Record<string, unknown>) => void;
  onCreateLabel: () => void;
  onUndoLast: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          onClick={(event) => event.stopPropagation()}
          className="grid size-6 place-items-center rounded border border-[var(--color-border)] text-[var(--color-text-muted)] hover:bg-[var(--color-bg-elevated)] hover:text-[var(--color-text)]"
          title="Fix classification"
        >
          <MoreHorizontal className="size-3.5" />
          <span className="sr-only">Fix classification</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onClick={(event) => event.stopPropagation()}>
        <DropdownMenuLabel>Fix classification</DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => onCorrect('never_main')}>
          <Ban className="size-3.5" />
          Never Main
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onCorrect('always_noise')}>
          <Trash2 className="size-3.5" />
          Always Noise
        </DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <Tag className="size-3.5" />
            Move to...
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {(
              [
                'main',
                'needs_reply',
                'waiting',
                'codes',
                'orders',
                'finance_admin',
                'review',
                'noise',
              ] as const
            ).map((category) => (
              <DropdownMenuItem key={category} onSelect={() => onCorrect('move_to', { category })}>
                {SMART_CATEGORY_LABELS[category]}
              </DropdownMenuItem>
            ))}
            {customLabels.length ? <DropdownMenuSeparator /> : null}
            {customLabels.map((label) => (
              <DropdownMenuItem
                key={label._id}
                onSelect={() => onCorrect('move_to', { customLabelId: label._id })}
              >
                {label.name}
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuItem onSelect={onCreateLabel}>Create label from this</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onUndoLast}>Undo last smart rule</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function createLabelFromThread(
  item: ThreadRow,
  onCorrect: (action: string, payload?: Record<string, unknown>) => void,
) {
  const name = window.prompt('Smart label name');
  if (!name?.trim()) return;
  const description = window.prompt('What should this label match?');
  if (!description?.trim()) return;
  const positive = window.prompt(
    'Positive example',
    `${item.from || item.fromAddress}: ${item.subject || ''}`,
  );
  if (!positive?.trim()) return;
  const negative = window.prompt('Negative example');
  if (!negative?.trim()) return;
  onCorrect('create_label_from_this', {
    newLabel: {
      name,
      description,
      positiveExamples: [positive],
      negativeExamples: [negative],
    },
  });
}

function SkeletonRows({ count = 8 }: { count?: number }) {
  return (
    <div className="flex flex-col">
      {SKELETON_ROW_KEYS.slice(0, count).map((key) => (
        <div
          key={key}
          className="grid grid-cols-[28px_1fr] gap-3 border-b border-[var(--color-border)] px-3 py-3"
        >
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
    <Empty className="grid flex-1 place-items-center px-6 py-12 text-center">
      <EmptyHeader>
        <EmptyMedia>
          <InboxIcon className="h-4 w-4 text-[var(--color-text-faint)]" />
        </EmptyMedia>
        <EmptyTitle>Nothing here yet</EmptyTitle>
        <EmptyDescription>
          {account
            ? 'Try a different search, smart category, or mailbox.'
            : 'Connect a Gmail account in /scripts/auth-google.sh.'}
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function SearchEmptyState({
  onClear,
  onEditGenerated,
  onRetryOriginal,
  onUseRaw,
}: {
  onClear: () => void;
  onEditGenerated: () => void;
  onRetryOriginal: () => void;
  onUseRaw: () => void;
}) {
  return (
    <Empty className="grid flex-1 place-items-center px-6 py-12 text-center">
      <EmptyHeader>
        <EmptyMedia>
          <Search className="h-4 w-4 text-[var(--color-text-faint)]" />
        </EmptyMedia>
        <EmptyTitle>No mail matched that generated filter</EmptyTitle>
        <EmptyDescription>
          The original wording is still preserved. Edit the generated pill, retry from the same wording, or
          clear it.
        </EmptyDescription>
      </EmptyHeader>
      <div className="flex flex-wrap justify-center gap-2">
        <button
          type="button"
          onClick={onEditGenerated}
          className="h-8 rounded-md border px-2.5 text-[12px] hover:bg-[var(--color-bg-subtle)]"
        >
          Edit generated filter
        </button>
        <button
          type="button"
          onClick={onRetryOriginal}
          className="h-8 rounded-md border px-2.5 text-[12px] hover:bg-[var(--color-bg-subtle)]"
        >
          Retry original wording
        </button>
        <button
          type="button"
          onClick={onUseRaw}
          className="h-8 rounded-md border px-2.5 text-[12px] hover:bg-[var(--color-bg-subtle)]"
        >
          Use original as Gmail query
        </button>
        <button
          type="button"
          onClick={onClear}
          className="h-8 rounded-md bg-[var(--color-accent)] px-2.5 text-[12px] text-[var(--color-accent-foreground)]"
        >
          Clear
        </button>
      </div>
    </Empty>
  );
}

function LabelConfirmDialog({
  item,
  applying,
  customLabels,
  onClose,
  onApply,
}: {
  item: ThreadRow | null;
  applying: boolean;
  customLabels: any[];
  onClose: () => void;
  onApply: (item: ThreadRow) => void;
}) {
  if (!item) return null;
  const labels = labelsForSmartCategory((item as any)?.smartCategory, customLabels);
  return (
    <Dialog open={!!item} onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent className="overflow-hidden border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-4 shadow-[var(--shadow-pop)]">
        <DialogTitle className="sr-only">Apply smart Gmail labels</DialogTitle>
        <ShineBorder shineColor={['#4cb7c8', '#7c3aed', '#0b7285']} />
        <Confirmation approval={{ id: item._id }} state={'approval-requested' as any}>
          <ConfirmationTitle>Apply smart Gmail labels?</ConfirmationTitle>
          <ConfirmationRequest>
            <div className="mt-3 space-y-3">
              <div>
                <div className="line-clamp-1 text-[13px] font-semibold">{item.subject || '(no subject)'}</div>
                <div className="mt-1 text-[12px] text-[var(--color-text-muted)]">
                  {(item as any).smartCategory?.reason || 'Smart category label preview.'}
                </div>
              </div>
              <div className="flex flex-wrap gap-1">
                {labels.map((label) => (
                  <Badge key={label} variant="outline">
                    {label}
                  </Badge>
                ))}
              </div>
              <ConfirmationActions>
                <ConfirmationAction variant="outline" onClick={onClose}>
                  Cancel
                </ConfirmationAction>
                <ConfirmationAction onClick={() => onApply(item)} disabled={applying || labels.length === 0}>
                  {applying ? <Ring className="mr-1 size-3" /> : <CheckCircle2 className="mr-1 size-3" />}
                  Apply
                </ConfirmationAction>
              </ConfirmationActions>
            </div>
          </ConfirmationRequest>
        </Confirmation>
      </DialogContent>
    </Dialog>
  );
}

function formatThreadParticipants(messages: ThreadMessage[], account: string, fallbackFrom?: string): string {
  const ordered = [...messages].sort((a, b) => Number(b.date || 0) - Number(a.date || 0));
  const newestSender = ordered[0]?.from || fallbackFrom || '';
  const participants = new Map<string, string>();

  const addHeaderList = (header: string | undefined) => {
    for (const part of splitAddressHeader(header)) {
      const email = emailFromHeader(part);
      const key = email || shortFrom(part).toLowerCase();
      if (!key || participants.has(key)) continue;
      participants.set(key, formatParticipantName(part, account));
    }
  };

  addHeaderList(newestSender);
  for (const message of ordered) {
    addHeaderList(message.from);
    addHeaderList(message.to);
    addHeaderList(message.cc);
    addHeaderList(message.bcc);
  }

  const names = [...participants.values()].filter(Boolean);
  if (!names.length) return shortFrom(fallbackFrom || '');
  const visible = names.slice(0, 4);
  const remaining = names.length - visible.length;
  return remaining > 0 ? `${visible.join(', ')} +${remaining}` : visible.join(', ');
}

function splitAddressHeader(header: string | undefined): string[] {
  const raw = String(header || '').trim();
  if (!raw) return [];
  const parts: string[] = [];
  let current = '';
  let quoted = false;
  let depth = 0;
  for (const char of raw) {
    if (char === '"') quoted = !quoted;
    if (!quoted && char === '<') depth += 1;
    if (!quoted && char === '>' && depth > 0) depth -= 1;
    if (!quoted && depth === 0 && char === ',') {
      if (current.trim()) parts.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function formatParticipantName(value: string, account: string): string {
  const email = emailFromHeader(value);
  if (email && email === account.toLowerCase()) return 'me';
  return shortFrom(value);
}
