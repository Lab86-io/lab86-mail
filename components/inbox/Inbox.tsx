// biome-ignore-all lint/a11y/useSemanticElements: thread rows contain nested controls and still provide keyboard activation.

'use client';

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useQuery_experimental as useConvexQuery } from 'convex/react';
import {
  Archive,
  Ban,
  CheckCircle2,
  CheckSquare,
  Inbox as InboxIcon,
  MoreHorizontal,
  Search,
  Square,
  Star,
  Tag,
  Trash2,
  X,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import {
  Fragment,
  type KeyboardEvent,
  memo,
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
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
import { ArchiveIcon } from '@/components/ui/archive';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { BorderBeam } from '@/components/ui/border-beam';
import { Button } from '@/components/ui/button';
import { DeleteIcon } from '@/components/ui/delete';
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
import { GaugeIcon } from '@/components/ui/gauge';
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { RefreshCWIcon } from '@/components/ui/refresh-cw';
import { RowIcon } from '@/components/ui/row-icon';
import { SearchIcon } from '@/components/ui/search';
import { ShineBorder } from '@/components/ui/shine-border';
import { api } from '@/convex/_generated/api';
import { callTool } from '@/lib/api-client';
import { useClientStore } from '@/lib/client-state';
import { LIST_PREFETCH_MARGIN_PX, shouldRequestNextPage } from '@/lib/mail/list-pagination';
import { resolveAccountScopedQuery } from '@/lib/mail/search/account-scope';
import { DEFAULT_MAIL_QUERY } from '@/lib/mail/search/constants';
import { peekSenderLogo, resolveSenderLogo, senderLogoDomain } from '@/lib/mail/sender-logo';
import { labelsForSmartCategory, SMART_CATEGORY_LABELS } from '@/lib/mail/smart-categories';
import { categoricalColor, emailFromHeader, formatDate, shortFrom } from '@/lib/shared/format';
import { cn } from '@/lib/utils';

// An empty search (or the clear button / Esc) returns to the default unified
// inbox view across all mailboxes.
const DEFAULT_QUERY = DEFAULT_MAIL_QUERY;
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
  starred?: boolean;
  messageCount?: number;
  smartCategory?: any;
  accountAlias?: string;
}

interface SearchThreadsResult {
  items: ThreadRow[];
  nextPageToken?: string;
}

interface InboxPage {
  items: ThreadRow[];
  nextPageTokens: Record<string, string>;
}

interface AccountRow {
  accountId: string;
  email: string;
  authed: boolean;
  displayName?: string;
}

interface AccountsResult {
  accounts: AccountRow[];
}

// Optimistic record of a quick-fix correction (Never Main / Always Noise /
// Move to). Rows the pending rule will reclassify out of the current view are
// hidden immediately; the Convex live query and search refetch confirm it.
interface QuickFixSuppression {
  id: string;
  senderEmail: string;
  action: string;
  category?: string;
}

// Day bucket for the editorial date headers: Today / Yesterday / weekday for
// the last week / month (with year once it isn't this year).
function dateGroupLabel(ts: number): string {
  if (!ts) return 'Undated';
  const date = new Date(ts);
  const now = new Date();
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const dayMs = 86_400_000;
  const today = startOfDay(now);
  const that = startOfDay(date);
  if (that >= today) return 'Today';
  if (that >= today - dayMs) return 'Yesterday';
  if (that >= today - 6 * dayMs) return date.toLocaleDateString(undefined, { weekday: 'long' });
  if (date.getFullYear() === now.getFullYear()) return date.toLocaleDateString(undefined, { month: 'long' });
  return date.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

function suppressionHides(s: QuickFixSuppression, smartCategory: string | null) {
  // Only a category view can optimistically drop a row — in search / all-mail
  // (smartCategory null) the row still belongs to the underlying query.
  if (!smartCategory) return false;
  if (s.action === 'never_main') return smartCategory === 'main';
  if (s.action === 'always_noise') return smartCategory !== 'noise';
  if (s.action === 'move_to' && s.category) return !!smartCategory && smartCategory !== s.category;
  return false;
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
  const threadAccount = useClientStore((s) => s.threadAccount);
  const setSelectedThread = useClientStore((s) => s.setSelectedThread);
  const setThreadAccount = useClientStore((s) => s.setThreadAccount);
  const selectedIds = useClientStore((s) => s.selectedIds);
  const toggleSelected = useClientStore((s) => s.toggleSelected);
  const clearSelected = useClientStore((s) => s.clearSelected);
  const selectMany = useClientStore((s) => s.selectMany);
  const railOpen = useClientStore((s) => s.railOpen);

  const queryClient = useQueryClient();
  const [searchInput, setSearchInput] = useState(searchDraft || (query === DEFAULT_QUERY ? '' : query));
  const [translating, setTranslating] = useState(false);
  const [labelPreview, setLabelPreview] = useState<ThreadRow | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [suppressions, setSuppressions] = useState<QuickFixSuppression[]>([]);
  const [lastSelectionKey, setLastSelectionKey] = useState<string | null>(null);
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

  // Heuristic: a typed mail query has at least one operator. Natural language doesn't.
  const looksLikeTypedQuery = (s: string) =>
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
    if (looksLikeTypedQuery(raw)) {
      setQuery(raw);
      setTranslatedSearch(null, raw, 'typed');
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
  // authed mail account and merge by date. Otherwise just hit one.
  const liveAccounts = useConvexQuery({ query: (api as any).liveMail.listAccounts, args: {} });
  const { data: fallbackAccountsData } = useQuery({
    queryKey: ['accounts'],
    queryFn: async () => callTool<AccountsResult>('list_accounts'),
    enabled: liveAccounts.status !== 'success',
    staleTime: 60_000,
  });
  const accountsData =
    liveAccounts.status === 'success' ? (liveAccounts.data as AccountsResult) : fallbackAccountsData;
  const accountAliasById = useMemo(
    () =>
      Object.fromEntries(
        (accountsData?.accounts || []).map((account) => [
          account.accountId,
          account.displayName || account.email.split('@')[0],
        ]),
      ) as Record<string, string>,
    [accountsData?.accounts],
  );
  const authedAccounts = (accountsData?.accounts || []).filter((a) => a.authed);
  const allAuthedAccountIds = authedAccounts.map((a) => a.accountId);
  // The rail's account dropdown narrows the unified inbox to the checked
  // mailboxes; an empty filter means every authed account.
  const accountFilter = useClientStore((s) => s.accountFilter);
  const authedAccountIds = accountFilter.length
    ? allAuthedAccountIds.filter((id) => accountFilter.includes(id))
    : allAuthedAccountIds;
  const scopedQuery = useMemo(
    () => resolveAccountScopedQuery(query, authedAccounts),
    [authedAccounts, query],
  );
  const { data: smartLabelsData } = useQuery({
    queryKey: ['smart-labels'],
    queryFn: async () => callTool<{ custom: any[] }>('list_smart_labels', {}),
    staleTime: 60_000,
  });
  // Stable reference: this feeds every memoized row, so a fresh [] each render
  // would defeat the row memo entirely.
  const customLabels = useMemo(() => smartLabelsData?.custom || [], [smartLabelsData]);
  const activeSmartLabel = smartCategory?.startsWith('custom:')
    ? customLabels.find((label) => label._id === smartCategory.slice('custom:'.length))?.name || smartCategory
    : smartCategory
      ? SMART_CATEGORY_LABELS[smartCategory as keyof typeof SMART_CATEGORY_LABELS] || smartCategory
      : '';

  const liveInboxArgs =
    account && (account !== ALL_ACCOUNTS || authedAccountIds.length > 0)
      ? {
          accountIds:
            account === ALL_ACCOUNTS
              ? scopedQuery.accountIds?.filter((id) => authedAccountIds.includes(id)) || authedAccountIds
              : scopedQuery.accountIds && !scopedQuery.accountIds.includes(account)
                ? []
                : [account],
          category: smartCategory || undefined,
          query: smartCategory || scopedQuery.query === DEFAULT_QUERY ? undefined : scopedQuery.query,
          limit: INBOX_PAGE_SIZE * 3,
        }
      : 'skip';
  const liveInbox = useConvexQuery({
    query: (api as any).liveMail.listThreads,
    args: liveInboxArgs,
  });

  const {
    data,
    isLoading,
    isError,
    error: searchError,
    isFetching,
    isFetchingNextPage,
    hasNextPage,
    fetchNextPage,
    refetch,
  } = useInfiniteQuery({
    // Key layout matters to the placeholderData guard below: [1] = account,
    // [5] = smartCategory.
    queryKey: [
      'search',
      account,
      query,
      scopedQuery.query,
      scopedQuery.accountIds?.join(',') || '',
      smartCategory,
      accountFilter.join(','),
      authedAccountIds.join(','),
      refreshNonce,
    ],
    initialPageParam: {} as Record<string, string>,
    queryFn: async ({ pageParam }): Promise<InboxPage> => {
      const pageTokens = pageParam as Record<string, string>;
      if (account === ALL_ACCOUNTS) {
        const scopedAccountIds = scopedQuery.accountIds
          ? scopedQuery.accountIds.filter((id) => authedAccountIds.includes(id))
          : authedAccountIds;
        const initialPage = Object.keys(pageTokens).length === 0;
        const accountIdsToFetch = initialPage
          ? scopedAccountIds
          : scopedAccountIds.filter((accountId) => pageTokens[accountId]);
        const perAccount = Math.max(8, Math.ceil(INBOX_PAGE_SIZE / Math.max(scopedAccountIds.length, 1)));
        const results = await Promise.all(
          accountIdsToFetch.map((accountId) =>
            callTool<SearchThreadsResult>(smartCategory ? 'list_smart_category' : 'search_threads', {
              account: accountId,
              category: smartCategory,
              query: smartCategory ? undefined : scopedQuery.query,
              max: perAccount,
              pageToken: pageTokens[accountId],
            })
              .then((r) => ({
                accountId,
                items: r.items.map((it) => ({
                  ...it,
                  account: accountId,
                  accountAlias: accountAliasById[accountId],
                })),
                nextPageToken: r.nextPageToken,
              }))
              .catch(() => ({ accountId, items: [] as ThreadRow[], nextPageToken: undefined })),
          ),
        );
        const merged = results.flatMap((result) => result.items);
        merged.sort((a, b) => (Number(b.lastDate ?? b.date) || 0) - (Number(a.lastDate ?? a.date) || 0));
        const nextPageTokens = Object.fromEntries(
          results
            .filter((result) => result.nextPageToken)
            .map((result) => [result.accountId, result.nextPageToken as string]),
        );
        return { items: merged, nextPageTokens };
      }
      if (scopedQuery.accountIds && !scopedQuery.accountIds.includes(account)) {
        return { items: [], nextPageTokens: {} };
      }
      const result = await callTool<SearchThreadsResult>(
        smartCategory ? 'list_smart_category' : 'search_threads',
        {
          account,
          category: smartCategory,
          query: smartCategory ? undefined : scopedQuery.query,
          max: INBOX_PAGE_SIZE,
          pageToken: pageTokens[account],
        },
      );
      return {
        items: result.items.map((it) => ({ ...it, account, accountAlias: accountAliasById[account] })),
        nextPageTokens: result.nextPageToken ? { [account]: result.nextPageToken } : {},
      };
    },
    getNextPageParam: (lastPage) =>
      Object.keys(lastPage.nextPageTokens).length ? lastPage.nextPageTokens : undefined,
    enabled: !!account && (account !== ALL_ACCOUNTS || authedAccountIds.length > 0),
    // Keep the visible list warm instead of treating every mount/focus as a
    // cold provider read. The foreground poll still catches new mail.
    staleTime: 45_000,
    gcTime: 30 * 60_000,
    // Show the previous list (marked fetching) while a refined query loads —
    // but NEVER carry one category's (or account's) rows into another view:
    // that reads as "wrong emails in my category", not as a loading state.
    placeholderData: (previousData: any, previousQuery: any) => {
      const prevKey = previousQuery?.queryKey as unknown[] | undefined;
      if (!prevKey) return undefined;
      if (prevKey[1] !== account || prevKey[5] !== smartCategory) return undefined;
      return previousData;
    },
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    // The Convex live query already pushes new mail in real time; polling the
    // HTTP path on top of it only burns provider quota. Poll only when the
    // live query isn't serving this view.
    refetchInterval: liveInbox.status === 'success' ? false : 60_000,
    // Don't keep polling a buried tab — pairs with onWindowFocus to catch up.
    refetchIntervalInBackground: false,
  });

  const refreshInbox = () => {
    setRefreshNonce((nonce) => nonce + 1);
    clearSelected();
    queryClient.invalidateQueries({ queryKey: ['daily-report'], refetchType: 'inactive' });
    if (selectedThreadId) {
      const openAccount = threadAccount || (account !== ALL_ACCOUNTS ? account : '');
      if (openAccount) {
        void callTool<{ threadId: string; subject: string; messages: any[] }>('get_thread', {
          account: openAccount,
          threadId: selectedThreadId,
          refresh: true,
        })
          .then((freshThread) => {
            queryClient.setQueryData(['thread', openAccount, selectedThreadId], freshThread);
          })
          .catch(() => {
            queryClient.invalidateQueries({ queryKey: ['thread', openAccount, selectedThreadId] });
          });
      }
    }
  };

  const liveItems =
    liveInbox.status === 'success' ? (liveInbox.data?.items as ThreadRow[] | undefined) : undefined;
  // Each item knows its own account (set by the fan-out above), so row ids remain
  // stable in ALL_ACCOUNTS view and bulk operations can dispatch per mailbox.
  const rowKey = useCallback((item: ThreadRow) => `${item.account || account}:${item._id}`, [account]);
  const items = useMemo(() => {
    const byKey = new Map<string, ThreadRow>();
    for (const item of liveItems || []) {
      byKey.set(`${item.account || account}:${item._id}`, item);
    }
    for (const item of data?.pages.flatMap((page) => page.items) || []) {
      const key = `${item.account || account}:${item._id}`;
      if (!byKey.has(key)) byKey.set(key, item);
    }
    const active = suppressions.filter((s) => suppressionHides(s, smartCategory));
    const rows = [...byKey.values()].filter((item) => {
      if (!active.length) return true;
      const email = (emailFromHeader(item.from || item.fromAddress) || '').toLowerCase();
      return !email || !active.some((s) => s.senderEmail === email);
    });
    return rows.sort((a, b) => (Number(b.lastDate ?? b.date) || 0) - (Number(a.lastDate ?? a.date) || 0));
  }, [account, data?.pages, liveItems, suppressions, smartCategory]);
  const visibleRowKeys = useMemo(() => items.map((item) => rowKey(item)), [items, rowKey]);
  const smartCategoryBadge = smartCategory && smartCategory !== 'main' ? activeSmartLabel : '';
  const selectVisible = useCallback(() => {
    selectMany(visibleRowKeys);
    setLastSelectionKey(visibleRowKeys[0] || null);
  }, [selectMany, visibleRowKeys]);
  const toggleRowSelection = useCallback(
    (key: string) => {
      toggleSelected(key);
      setLastSelectionKey(key);
    },
    [toggleSelected],
  );
  const selectRangeTo = useCallback(
    (key: string) => {
      const anchor = lastSelectionKey && visibleRowKeys.includes(lastSelectionKey) ? lastSelectionKey : key;
      const a = visibleRowKeys.indexOf(anchor);
      const b = visibleRowKeys.indexOf(key);
      if (a < 0 || b < 0) {
        toggleRowSelection(key);
        return;
      }
      const [start, end] = a < b ? [a, b] : [b, a];
      selectMany([...new Set([...selectedIds, ...visibleRowKeys.slice(start, end + 1)])]);
      setLastSelectionKey(key);
    },
    [lastSelectionKey, selectMany, selectedIds, toggleRowSelection, visibleRowKeys],
  );
  // Skeleton while either source is still on its first load for this view —
  // an empty live result alone must not flash "Nothing here" while the HTTP
  // page (which can still backfill brand-new accounts) is in flight.
  const showInitialLoading = !items.length && (isLoading || liveInbox.status === 'pending');

  // --- Infinite scroll: prefetch ahead + pipelined batches -----------------
  // Fresh layout read instead of a cached observer entry, so the decision is
  // correct even right after a page of rows pushes the sentinel further down.
  const distanceToListEnd = useCallback(() => {
    const root = scrollRef.current;
    const target = loadMoreRef.current;
    if (!root || !target) return Number.POSITIVE_INFINITY;
    return target.getBoundingClientRect().top - root.getBoundingClientRect().bottom;
  }, []);
  const maybeFetchNextPage = useCallback(() => {
    if (
      !shouldRequestNextPage({
        inFlight: isFetchingNextPage,
        hasMore: !!hasNextPage,
        distanceToEnd: distanceToListEnd(),
        lastError: isError,
      })
    ) {
      return;
    }
    // cancelRefetch:false makes an already-running next-page request win, so
    // rapid observer callbacks can never restart the same cursor fetch.
    fetchNextPage({ cancelRefetch: false });
  }, [distanceToListEnd, fetchNextPage, hasNextPage, isError, isFetchingNextPage]);
  const maybeFetchNextPageRef = useRef(maybeFetchNextPage);
  useEffect(() => {
    maybeFetchNextPageRef.current = maybeFetchNextPage;
  }, [maybeFetchNextPage]);

  // The observer stays attached while pages load (tearing it down on every
  // isFetching flip is what used to stall fast scrolls); it only triggers the
  // shared decision helper. Re-attach when the list (and its sentinel) remounts.
  const listMounted = !showInitialLoading && !isError && items.length > 0;
  // biome-ignore lint/correctness/useExhaustiveDependencies: account/smartCategory key the list's motion.div, so a view switch remounts the sentinel node and the observer must re-attach to it.
  useEffect(() => {
    if (!listMounted) return;
    const root = scrollRef.current;
    const target = loadMoreRef.current;
    if (!root || !target) return;
    const observer = new IntersectionObserver(() => maybeFetchNextPageRef.current(), {
      root,
      rootMargin: `${LIST_PREFETCH_MARGIN_PX}px 0px`,
    });
    observer.observe(target);
    return () => observer.disconnect();
  }, [listMounted, account, smartCategory]);

  // Pipelining: the moment a page lands (isFetchingNextPage flips false), ask
  // again if the sentinel is still inside the prefetch window — fast scrollers
  // get back-to-back batches instead of one round-trip per scroll pause.
  useEffect(() => {
    if (!isFetchingNextPage) maybeFetchNextPage();
  }, [isFetchingNextPage, maybeFetchNextPage]);

  // Once we know the visible senders, resolve provider contact photos or
  // company-domain logos. Initials remain the fallback when no image exists.
  // Cached server-side for ~7 days, including misses.
  const primaryAccount = useClientStore((s) => s.primaryAccount);
  const photoAccount =
    primaryAccount && primaryAccount !== ALL_ACCOUNTS
      ? primaryAccount
      : account && account !== ALL_ACCOUNTS
        ? account
        : ALL_ACCOUNTS;
  const photoEmails = useMemo(() => {
    const set = new Set<string>();
    for (const it of items.slice(0, 48)) {
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
    enabled: photoEmails.length > 0,
    staleTime: 24 * 60 * 60_000,
  });
  const photos = photosQuery.data?.photos || {};

  const prefetchThread = useCallback(
    (item: ThreadRow) => {
      const rowAccount = item.account || account;
      if (!rowAccount || !item._id) return;
      queryClient.prefetchQuery({
        queryKey: ['thread', rowAccount, item._id],
        queryFn: async () =>
          callTool<{ threadId: string; subject: string; messages: any[] }>('get_thread', {
            account: rowAccount,
            threadId: item._id,
            refresh: false,
          }),
        staleTime: 5 * 60_000,
        gcTime: 30 * 60_000,
      });
    },
    [account, queryClient],
  );

  const parseRowKey = (id: string) => {
    const splitAt = id.indexOf(':');
    if (splitAt <= 0) return null;
    return { account: id.slice(0, splitAt), threadId: id.slice(splitAt + 1) };
  };
  const rowForKey = (id: string) => items.find((it) => rowKey(it) === id || it._id === id);
  const accountOfRow = (id: string) => rowForKey(id)?.account || parseRowKey(id)?.account || account;
  const threadIdOfRow = (id: string) => rowForKey(id)?._id || parseRowKey(id)?.threadId || id;

  // Optimistically drop rows from every cached search page so archive/trash
  // feel instant; a failure invalidates and refetches the truth.
  const removeRowsFromSearchCache = (ids: string[]) => {
    const keys = new Set(ids);
    queryClient.setQueriesData({ queryKey: ['search'] }, (old: any) => {
      if (!old?.pages) return old;
      return {
        ...old,
        pages: old.pages.map((page: any) => ({
          ...page,
          items: (page.items || []).filter((it: any) => !keys.has(`${it.account || account}:${it._id}`)),
        })),
      };
    });
  };

  const bulkArchive = useMutation({
    mutationFn: async (ids: string[]) => {
      const results = await Promise.allSettled(
        ids.map((id) =>
          callTool('archive_thread', { account: accountOfRow(id), threadId: threadIdOfRow(id) }),
        ),
      );
      const failures = results.filter((result) => result.status === 'rejected');
      if (failures.length) throw new Error(`Failed to archive ${failures.length} thread(s).`);
    },
    onMutate: (ids) => {
      removeRowsFromSearchCache(ids);
      clearSelected();
    },
    onSuccess: (_data, ids) => {
      toast.success(`Archived ${ids.length}`);
    },
    onError: () => {
      toast.error('Archive failed — restoring');
      queryClient.invalidateQueries({ queryKey: ['search'] });
    },
  });

  const bulkTrash = useMutation({
    mutationFn: async (ids: string[]) => {
      const results = await Promise.allSettled(
        ids.map((id) => callTool('trash_thread', { account: accountOfRow(id), threadId: threadIdOfRow(id) })),
      );
      const failures = results.filter((result) => result.status === 'rejected');
      if (failures.length) throw new Error(`Failed to trash ${failures.length} thread(s).`);
    },
    onMutate: (ids) => {
      removeRowsFromSearchCache(ids);
      clearSelected();
    },
    onSuccess: (_data, ids) => {
      toast.success(`Trashed ${ids.length}`);
    },
    onError: () => {
      toast.error('Trash failed — restoring');
      queryClient.invalidateQueries({ queryKey: ['search'] });
    },
  });

  const bulkTriage = useMutation({
    mutationFn: async () => {
      const list = items
        .filter((it) => selectedIds.includes(rowKey(it)))
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
    },
    onError: (err: any) => toast.error(`Could not apply labels: ${err?.message || 'unknown error'}`),
  });
  const applyCorrection = useMutation({
    mutationFn: async (input: any) => callTool('apply_smart_correction', input),
    // Hide the sender's rows right away — the rule is deterministic, so the
    // outcome is known before the server confirms it.
    onMutate: (input: any) => {
      const row = items.find((it) => it._id === input.threadId && (it.account || account) === input.account);
      const senderEmail = (emailFromHeader(row?.from || row?.fromAddress || '') || '').toLowerCase();
      if (!senderEmail) return {};
      const suppression: QuickFixSuppression = {
        id: `${input.action}:${senderEmail}:${Date.now()}`,
        senderEmail,
        action: input.action,
        category: input.category,
      };
      if (!suppressionHides(suppression, smartCategory)) return {};
      setSuppressions((prev) => [...prev, suppression]);
      return { suppressionId: suppression.id };
    },
    onSuccess: () => {
      toast.success('Smart rule saved');
      queryClient.invalidateQueries({ queryKey: ['search'] });
      queryClient.invalidateQueries({ queryKey: ['smart-labels'] });
    },
    onError: (err: any, _input, context: any) => {
      if (context?.suppressionId) {
        setSuppressions((prev) => prev.filter((s) => s.id !== context.suppressionId));
      }
      toast.error(`Could not save correction: ${err?.message || 'unknown error'}`);
    },
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
      setSuppressions([]);
      queryClient.invalidateQueries({ queryKey: ['search'] });
    },
    onError: (err: any) => toast.error(`Could not undo: ${err?.message || 'unknown error'}`),
  });

  // Stable per-row handlers (react-query mutate fns and zustand setters keep
  // their identity) so the memoized ThreadRowCard only re-renders when its own
  // row data changes — cheap rows are what keep fast scrolling smooth.
  const openThread = useCallback(
    (rowAccount: string, threadId: string) => {
      // Unified inbox stays put; just remember which mailbox this thread
      // belongs to so the reader can load/reply correctly.
      startTransition(() => {
        setThreadAccount(rowAccount);
        setSelectedThread(threadId);
      });
    },
    [setSelectedThread, setThreadAccount],
  );
  const archiveRow = useCallback((key: string) => bulkArchive.mutate([key]), [bulkArchive.mutate]);
  const trashRow = useCallback((key: string) => bulkTrash.mutate([key]), [bulkTrash.mutate]);
  const correctRow = useCallback(
    (item: ThreadRow, action: string, payload: Record<string, unknown> = {}) => {
      applyCorrection.mutate({
        account: item.account || account,
        threadId: item._id,
        action,
        scope: 'sender',
        ...payload,
      });
    },
    [account, applyCorrection.mutate],
  );
  const undoLast = useCallback(() => undoLastRule.mutate(), [undoLastRule.mutate]);
  const previewLabels = useCallback((item: ThreadRow) => setLabelPreview(item), []);

  return (
    <section className="flex h-full flex-col bg-[var(--color-bg)] p-2 sm:p-3">
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] shadow-[var(--shadow-soft)]">
        <div
          className={cn(
            'flex flex-col border-b border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-3 py-2.5',
            !railOpen && 'pl-12',
          )}
        >
          <div className="flex items-center gap-2">
            <InputGroup className="relative flex-1 overflow-hidden rounded-xl border-[var(--color-control-border)] bg-[var(--color-control)] shadow-[var(--shadow-control)]">
              {translating ? (
                <BorderBeam
                  size={80}
                  duration={3}
                  colorFrom="var(--color-border-beam-from)"
                  colorTo="var(--color-border-beam-to)"
                />
              ) : null}
              <InputGroupAddon>
                {translating ? (
                  <OrbitRing className="size-4 text-[var(--color-accent)]" />
                ) : (
                  <RowIcon icon={SearchIcon} size={16} className="text-[var(--color-text-faint)]" />
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
                placeholder='Ask for mail or type search filters, e.g. "order updates from this week"'
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
            <Button
              type="button"
              variant="outline"
              size="icon"
              onClick={refreshInbox}
              aria-label="Refresh inbox"
              className={cn(
                'h-9 w-9 shrink-0 rounded-xl border-[var(--color-control-border)] bg-[var(--color-control)] text-[var(--color-text-muted)] shadow-[var(--shadow-control)] hover:bg-[var(--color-control-hover)] hover:text-[var(--color-text)]',
                isFetching && !isFetchingNextPage && 'text-[var(--color-accent)]',
              )}
              title="Refresh"
            >
              {isFetching && !isFetchingNextPage ? (
                <Ring className="size-4" />
              ) : (
                <RowIcon icon={RefreshCWIcon} size={14} />
              )}
            </Button>
          </div>
        </div>
        {/* Status chips live in their own transparent row BELOW the bordered bar,
          so the search bar's bottom border lines up with the assistant header.
          Rendered only when there's something to show, so it adds no height
          otherwise. */}
        {smartCategoryBadge ||
        nlSearchIntent ||
        translatedQuery ||
        query !== DEFAULT_QUERY ||
        translating ||
        queryError ? (
          <div className="flex flex-wrap items-center gap-1.5 px-3 py-1.5">
            {smartCategoryBadge ? (
              <Badge variant="secondary" className="gap-1">
                {smartCategoryBadge}
              </Badge>
            ) : null}
            {nlSearchIntent ? <Badge variant="outline">Asked: {nlSearchIntent}</Badge> : null}
            {translatedQuery && !smartCategory ? (
              <Badge variant="outline" className="gap-1">
                Filter: <span className="font-mono">{translatedQuery}</span>
                <button
                  type="button"
                  onClick={clearSearch}
                  title="Clear generated filter"
                  aria-label="Clear generated filter"
                >
                  <X className="size-3" />
                </button>
              </Badge>
            ) : null}
            {!translatedQuery && !smartCategory && query !== DEFAULT_QUERY ? (
              <Badge variant="outline" className="gap-1">
                Filter: <span className="font-mono">{query}</span>
                <button type="button" onClick={clearSearch} title="Clear filter" aria-label="Clear filter">
                  <X className="size-3" />
                </button>
              </Badge>
            ) : null}
            {translating ? (
              <TextShimmer className="text-[11px] text-[var(--color-accent)]">Translating filter</TextShimmer>
            ) : null}
            {queryError ? <span className="text-[11px] text-[var(--color-danger)]">{queryError}</span> : null}
          </div>
        ) : null}

        <AnimatePresence>
          {selectedIds.length > 0 ? (
            <motion.div
              initial={{ opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              className="flex items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-accent-soft)] px-3 py-2 text-[12px]"
            >
              <span className="font-semibold text-[var(--color-text)]">{selectedIds.length} selected</span>
              {selectedIds.length < visibleRowKeys.length ? (
                <button
                  type="button"
                  onClick={selectVisible}
                  className="ml-2 flex items-center gap-1 rounded-lg border border-[var(--color-control-border)] bg-[var(--color-control)] px-2.5 py-1 text-[var(--color-text-muted)] shadow-[var(--shadow-control)] hover:bg-[var(--color-control-hover)] hover:text-[var(--color-text)]"
                >
                  <CheckSquare className="size-3" />
                  Select visible
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => bulkArchive.mutate(selectedIds)}
                className="flex items-center gap-1 rounded-lg border border-[var(--color-control-border)] bg-[var(--color-control)] px-2.5 py-1 shadow-[var(--shadow-control)] hover:bg-[var(--color-control-hover)]"
              >
                <RowIcon icon={ArchiveIcon} size={12} />
                Archive
              </button>
              <button
                type="button"
                onClick={() => bulkTrash.mutate(selectedIds)}
                className="flex items-center gap-1 rounded-lg border border-[var(--color-control-border)] bg-[var(--color-control)] px-2.5 py-1 shadow-[var(--shadow-control)] hover:bg-[var(--color-control-hover)]"
              >
                <RowIcon icon={DeleteIcon} size={12} />
                Trash
              </button>
              <button
                type="button"
                onClick={() => bulkTriage.mutate()}
                className="flex items-center gap-1 rounded-lg bg-[var(--color-accent)] px-2.5 py-1 text-[var(--color-accent-foreground)] shadow-[var(--shadow-control)] hover:bg-[var(--color-accent-hover)]"
              >
                <RowIcon icon={GaugeIcon} size={12} />
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

        <div ref={scrollRef} className="scrollable flex min-h-0 flex-1 flex-col">
          {showInitialLoading ? (
            <SkeletonRows />
          ) : isError ? (
            <SearchErrorState
              message={(searchError as Error | null)?.message || 'Mail search failed.'}
              onRetry={() => refetch()}
            />
          ) : items.length === 0 ? (
            translatedQuery || nlSearchIntent ? (
              <SearchEmptyState
                onClear={clearSearch}
                onEditGenerated={() => {
                  const editable = translatedQuery || query;
                  setQuery(editable);
                  setSearchInput(editable);
                  setSearchDraft(editable);
                  setTranslatedSearch(null, editable, 'typed');
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
            <motion.div
              key={`${account}:${smartCategory || 'search'}`}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
            >
              {items.map((it, index) => {
                const senderEmail = emailFromHeader(it.from || it.fromAddress);
                const key = rowKey(it);
                const rowAccount = it.account || account;
                // Provider contact photos pass straight through; company
                // `/api/logos/...` URLs are ignored here because the row runs
                // the validated client-side logo chain itself (which starts at
                // that same proxy but never accepts a placeholder).
                const rawPhoto = senderEmail ? (photos[senderEmail] ?? null) : null;
                const providerPhotoUrl = rawPhoto && !rawPhoto.startsWith('/api/logos/') ? rawPhoto : null;
                // Editorial datelines: a serif group header whenever the day
                // bucket changes (the list is already date-sorted).
                const groupLabel = dateGroupLabel(Number(it.lastDate ?? it.date) || 0);
                const previous = index > 0 ? items[index - 1] : null;
                const showHeader =
                  !previous || dateGroupLabel(Number(previous.lastDate ?? previous.date) || 0) !== groupLabel;
                return (
                  <Fragment key={key}>
                    {showHeader ? (
                      <div className="flex items-baseline gap-2.5 px-3 pb-1 pt-3.5 first:pt-2">
                        <span className="font-display text-[12.5px] italic leading-none text-[var(--color-text-muted)]">
                          {groupLabel}
                        </span>
                        <span className="h-px flex-1 self-center bg-[var(--color-border)]/70" />
                      </div>
                    ) : null}
                    <ThreadRowCard
                      item={it}
                      rowId={key}
                      rowAccount={rowAccount}
                      senderEmail={senderEmail || ''}
                      providerPhotoUrl={providerPhotoUrl}
                      showAccount={account === ALL_ACCOUNTS}
                      accountLabel={accountAliasById[rowAccount] || ''}
                      activeCategory={smartCategory}
                      selected={selectedIds.includes(key)}
                      active={selectedThreadId === it._id && threadAccount === rowAccount}
                      selecting={selectedIds.length > 0}
                      onSelectRange={selectRangeTo}
                      onToggleSelect={toggleRowSelection}
                      onPrefetch={prefetchThread}
                      onApplyLabels={previewLabels}
                      onArchive={archiveRow}
                      onTrash={trashRow}
                      onCorrect={correctRow}
                      onUndoLast={undoLast}
                      onOpen={openThread}
                      customLabels={customLabels}
                    />
                  </Fragment>
                );
              })}
              <div ref={loadMoreRef} className="min-h-1" aria-hidden />
              {/* Lightweight placeholders keep the list alive (and scrollable)
                  while the next batch is in flight instead of a dead stop. */}
              {isFetchingNextPage ? <SkeletonRows count={6} /> : null}
            </motion.div>
          )}
        </div>
        <LabelConfirmDialog
          item={labelPreview}
          applying={applyLabels.isPending}
          customLabels={customLabels}
          onClose={() => setLabelPreview(null)}
          onApply={(item) => applyLabels.mutate(item)}
        />
      </div>
    </section>
  );
}

// Company logo for a sender, resolved through the validated client-side
// chain. Cached verdicts (module map + localStorage) return synchronously, so
// rows re-mounted while scrolling render their final avatar on first paint —
// no flicker, no re-probing. Unknown domains start as initials and upgrade
// only once a candidate image actually decodes at logo quality; a placeholder
// globe can never be accepted.
function useSenderLogo(email: string): string | null {
  const domain = useMemo(() => senderLogoDomain(email), [email]);
  const [logo, setLogo] = useState<string | null>(() => (domain ? (peekSenderLogo(domain) ?? null) : null));
  useEffect(() => {
    if (!domain) {
      setLogo(null);
      return;
    }
    const settled = peekSenderLogo(domain);
    if (settled !== undefined) {
      setLogo(settled);
      return;
    }
    setLogo(null);
    let cancelled = false;
    resolveSenderLogo(domain).then((url) => {
      if (!cancelled && url) setLogo(url);
    });
    return () => {
      cancelled = true;
    };
  }, [domain]);
  return logo;
}

const ThreadRowCard = memo(function ThreadRowCard({
  item,
  rowId,
  rowAccount,
  senderEmail,
  providerPhotoUrl,
  selected,
  active,
  selecting,
  onSelectRange,
  onToggleSelect,
  onOpen,
  onPrefetch,
  onApplyLabels,
  onArchive,
  onTrash,
  onCorrect,
  onUndoLast,
  customLabels,
  showAccount,
  accountLabel,
  activeCategory,
}: {
  item: ThreadRow;
  rowId: string;
  rowAccount: string;
  senderEmail: string;
  providerPhotoUrl: string | null;
  selected: boolean;
  active: boolean;
  selecting: boolean;
  onSelectRange: (rowId: string) => void;
  onToggleSelect: (rowId: string) => void;
  onOpen: (rowAccount: string, threadId: string) => void;
  onPrefetch: (item: ThreadRow) => void;
  onApplyLabels: (item: ThreadRow) => void;
  onArchive: (rowId: string) => void;
  onTrash: (rowId: string) => void;
  onCorrect: (item: ThreadRow, action: string, payload?: Record<string, unknown>) => void;
  onUndoLast: () => void;
  customLabels: any[];
  showAccount?: boolean;
  accountLabel?: string;
  activeCategory?: string | null;
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
  const displaySenderLabel = senderLabel || item.account || '';
  const date = (item.date as any) || item.lastDate || 0;
  // Unified-inbox rows carry their mailbox; a 3px colour rail lets the eye scan
  // account membership without reading the same alias text on every row. Colour
  // comes from the shared Tableau-10 set the calendar uses, so the palette is
  // consistent across surfaces.
  const accountColor = showAccount ? categoricalColor(item.account || '') : '';
  // Already-read threads recede so unread genuinely pops (shade inactive rows).
  const dim = !item.unread;
  // A real contact photo always wins; otherwise the validated company logo;
  // otherwise the designed initials avatar.
  const companyLogo = useSenderLogo(providerPhotoUrl ? '' : senderEmail);
  const avatarSrc = providerPhotoUrl || companyLogo;
  const correct = useCallback(
    (action: string, payload: Record<string, unknown> = {}) => onCorrect(item, action, payload),
    [item, onCorrect],
  );
  const prefetchTimer = useRef<number | null>(null);

  const schedulePrefetch = useCallback(() => {
    if (prefetchTimer.current != null) return;
    prefetchTimer.current = window.setTimeout(() => {
      prefetchTimer.current = null;
      onPrefetch(item);
    }, 120);
  }, [item, onPrefetch]);

  const cancelPrefetch = useCallback(() => {
    if (prefetchTimer.current == null) return;
    window.clearTimeout(prefetchTimer.current);
    prefetchTimer.current = null;
  }, []);

  useEffect(() => cancelPrefetch, [cancelPrefetch]);

  return (
    <div
      onClick={(event) => {
        if (event.shiftKey) {
          event.preventDefault();
          onSelectRange(rowId);
          return;
        }
        if (event.metaKey || event.ctrlKey || selecting) {
          event.preventDefault();
          onToggleSelect(rowId);
          return;
        }
        onOpen(rowAccount, item._id);
      }}
      onPointerEnter={schedulePrefetch}
      onPointerLeave={cancelPrefetch}
      onFocus={() => onPrefetch(item)}
      onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key === ' ') {
          event.preventDefault();
          if (event.shiftKey) {
            onSelectRange(rowId);
            return;
          }
          onToggleSelect(rowId);
          return;
        }
        if (event.key === 'Enter') {
          event.preventDefault();
          if (event.shiftKey) {
            onSelectRange(rowId);
            return;
          }
          if (event.metaKey || event.ctrlKey || selecting) {
            onToggleSelect(rowId);
            return;
          }
          onOpen(rowAccount, item._id);
        }
      }}
      role="button"
      tabIndex={0}
      className={cn(
        // No transition on the row itself: the hover highlight is a selection
        // cue, so it must be instant for snappy up/down scanning.
        'group relative grid grid-cols-[30px_minmax(0,1fr)_auto] items-center gap-2.5 border-b border-[var(--color-border)]/45 px-3 py-2 text-left last:border-b-0 hover:bg-[var(--color-hover-soft)]',
        active && 'bg-[var(--color-selected-soft)]',
        selected && 'bg-[var(--color-selected-soft)]',
      )}
      style={active ? { borderLeft: '3px solid var(--color-accent)' } : undefined}
    >
      {priorityClass ? (
        <span className={cn('absolute left-0 inset-y-1.5 w-0.5 rounded-r-full', priorityClass)} />
      ) : null}

      <Avatar name={senderLabel || item.account} src={avatarSrc} size={28} />

      {/* Two-line row: sender, then subject + preview inline. */}
      <div className={cn('flex min-w-0 flex-col gap-0.5', dim && 'opacity-90')}>
        <div className="flex items-center gap-1.5">
          {item.starred ? (
            <Star
              role="img"
              aria-label="Starred"
              className="size-3 shrink-0 fill-[var(--color-warning)] text-[var(--color-warning)]"
            />
          ) : null}
          <span
            className={cn(
              'truncate font-display text-[13.5px]',
              item.unread ? 'font-semibold text-[var(--color-text)]' : 'text-[var(--color-text)]/90',
            )}
          >
            {displaySenderLabel}
          </span>
          {(item.messageCount || 0) > 1 ? (
            <span
              title={`${item.messageCount} messages in this thread`}
              className="shrink-0 rounded-full bg-[var(--color-bg-subtle)] px-1.5 text-[10px] font-medium leading-[1.45] tabular-nums text-[var(--color-text-muted)]"
            >
              {item.messageCount}
            </span>
          ) : null}
          {item.unread ? <span className="size-1.5 shrink-0 rounded-full bg-[var(--color-accent)]" /> : null}
        </div>
        <span className="truncate text-[12.5px] leading-tight">
          <span className={item.unread ? 'font-medium text-[var(--color-text)]' : 'text-[var(--color-text)]'}>
            {item.subject || '(no subject)'}
          </span>
          {item.snippet ? <span className="text-[var(--color-text-muted)]"> — {item.snippet}</span> : null}
        </span>
      </div>

      {/* Compact meta: date, then a single category chip (its reason lives in the
          popover) + an Important dot + the account chip in all-accounts mode. */}
      <div className="flex min-h-[40px] flex-col items-end justify-center gap-1 self-center">
        <div className="flex h-7 items-center justify-end gap-1.5">
          <div
            className={cn(
              'pointer-events-none flex w-[112px] items-center justify-end gap-0.5 opacity-0 transition-opacity duration-75 ease-out group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 has-[[data-state=open]]:pointer-events-auto has-[[data-state=open]]:opacity-100',
              selected && 'pointer-events-auto opacity-100',
            )}
          >
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onToggleSelect(rowId);
              }}
              title={selected ? 'Deselect' : 'Select'}
              aria-pressed={selected}
              className={cn(
                'grid size-6 place-items-center rounded-md border border-[var(--color-control-border)] bg-[var(--color-control)] text-[var(--color-text-muted)] shadow-[var(--shadow-control)] transition-colors hover:bg-[var(--color-control-hover)] hover:text-[var(--color-accent)]',
                selected && 'border-[var(--color-accent)] text-[var(--color-accent)]',
              )}
            >
              {selected ? <CheckSquare className="size-3.5" /> : <Square className="size-3.5" />}
              <span className="sr-only">{selected ? 'Deselect' : 'Select'}</span>
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onArchive(rowId);
              }}
              title="Archive"
              className="grid size-6 place-items-center rounded-md border border-[var(--color-control-border)] bg-[var(--color-control)] text-[var(--color-text-muted)] shadow-[var(--shadow-control)] transition-colors hover:bg-[var(--color-control-hover)] hover:text-[var(--color-accent)]"
            >
              <Archive className="size-3.5" />
              <span className="sr-only">Archive</span>
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onTrash(rowId);
              }}
              title="Delete"
              className="grid size-6 place-items-center rounded-md border border-[var(--color-control-border)] bg-[var(--color-control)] text-[var(--color-text-muted)] shadow-[var(--shadow-control)] transition-colors hover:bg-[var(--color-control-hover)] hover:text-[var(--color-danger)]"
            >
              <Trash2 className="size-3.5" />
              <span className="sr-only">Delete</span>
            </button>
            <QuickFixMenu
              customLabels={customLabels}
              onApplyLabels={() => onApplyLabels(item)}
              onCorrect={correct}
              onCreateLabel={() => createLabelFromThread(item, correct)}
              onUndoLast={onUndoLast}
            />
          </div>
          {showAccount && accountColor ? (
            <Popover>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  onClick={(e) => e.stopPropagation()}
                  title="Which mailbox"
                  className="rounded-md border px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-[var(--color-text)] shadow-[inset_0_1px_0_rgb(255_255_255/0.38)] hover:text-[var(--color-text)]"
                  style={{
                    backgroundColor: `color-mix(in srgb, ${accountColor} 18%, var(--color-bg-elevated))`,
                    borderColor: `color-mix(in srgb, ${accountColor} 34%, var(--color-border))`,
                  }}
                >
                  {formatDate(date)}
                </button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-auto px-3 py-2 text-[12px]">
                <div className="flex items-center gap-2">
                  <span className="size-2.5 rounded-full" style={{ backgroundColor: accountColor }} />
                  <span className="font-medium text-[var(--color-text)]">
                    {accountLabel || item.accountAlias || item.account}
                  </span>
                </div>
                <p className="mt-1 text-[var(--color-text-muted)]">Mailbox this thread arrived in</p>
              </PopoverContent>
            </Popover>
          ) : (
            <span className="rounded-md px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-[var(--color-text-muted)]">
              {formatDate(date)}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {(item.labels || []).includes('IMPORTANT') ? (
            <span
              title="Important"
              className="size-1.5 shrink-0 rounded-full bg-[var(--color-warning)]"
              aria-hidden
            />
          ) : null}
          {/* The category chip only earns its place when it says something the
              view doesn't already — inside a category view every row would
              repeat the view's own name. */}
          {smart?.primary && smart.primary !== activeCategory ? (
            <Popover>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className="inline-flex cursor-help"
                  onClick={(e) => e.stopPropagation()}
                >
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
          {/* Mailbox identity now rides the date's colour wash (above) — no
              repeated alias text down every row. */}
        </div>
      </div>
    </div>
  );
});

function QuickFixMenu({
  customLabels,
  onApplyLabels,
  onCorrect,
  onCreateLabel,
  onUndoLast,
}: {
  customLabels: any[];
  onApplyLabels: () => void;
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
          className="grid size-6 place-items-center rounded-md border border-[var(--color-control-border)] bg-[var(--color-control)] text-[var(--color-text-muted)] shadow-[var(--shadow-control)] transition-colors hover:bg-[var(--color-control-hover)] hover:text-[var(--color-text)]"
          title="More actions"
        >
          <MoreHorizontal className="size-3.5" />
          <span className="sr-only">Fix classification</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onClick={(event) => event.stopPropagation()}>
        <DropdownMenuItem onSelect={() => onApplyLabels()}>
          <Tag className="size-3.5" />
          Apply smart labels
        </DropdownMenuItem>
        <DropdownMenuSeparator />
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
            {(['main', 'needs_reply', 'codes', 'orders', 'finance_admin', 'review', 'noise'] as const).map(
              (category) => (
                <DropdownMenuItem key={category} onSelect={() => onCorrect('move_to', { category })}>
                  {SMART_CATEGORY_LABELS[category]}
                </DropdownMenuItem>
              ),
            )}
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

// Placeholder rows mirror the real ThreadRowCard geometry (same grid, padding,
// 28px avatar, 40px meta column) so appending them during a fetch never shifts
// scroll position. The shimmer is theme-neutral and pauses for reduced motion.
function SkeletonRows({ count = 8 }: { count?: number }) {
  return (
    <div className="flex flex-col" aria-hidden>
      {SKELETON_ROW_KEYS.slice(0, count).map((key) => (
        <div
          key={key}
          className="grid grid-cols-[30px_minmax(0,1fr)_auto] items-center gap-2.5 border-b border-[var(--color-border)]/45 px-3 py-2"
        >
          <div className="size-7 rounded-full shimmer motion-reduce:animate-none" />
          <div className="flex min-w-0 flex-col gap-1.5">
            <div className="h-3 w-2/5 rounded shimmer motion-reduce:animate-none" />
            <div className="h-3 w-3/4 rounded shimmer motion-reduce:animate-none" />
          </div>
          <div className="flex min-h-[40px] flex-col items-end justify-center">
            <div className="h-3 w-12 rounded shimmer motion-reduce:animate-none" />
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
        <EmptyTitle className="font-display italic">Nothing here yet</EmptyTitle>
        <EmptyDescription>
          {account
            ? 'Try a different search, smart category, or mailbox.'
            : 'Connect a mail account in settings.'}
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

// A failed fetch must look like a failure, not an empty mailbox — empty-state
// rendering silently masked a broken search transport once already.
function SearchErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <Empty className="grid flex-1 place-items-center px-6 py-12 text-center">
      <EmptyHeader>
        <EmptyMedia>
          <InboxIcon className="h-4 w-4 text-[var(--color-danger,#b91c1c)]" />
        </EmptyMedia>
        <EmptyTitle>Could not load mail</EmptyTitle>
        <EmptyDescription>{message}</EmptyDescription>
      </EmptyHeader>
      <Button size="sm" variant="outline" onClick={onRetry}>
        Retry
      </Button>
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
          Use original as typed query
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
        <ShineBorder
          shineColor={[
            'var(--color-accent-shine-1)',
            'var(--color-accent-shine-2)',
            'var(--color-accent-shine-3)',
          ]}
        />
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
