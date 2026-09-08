'use client';

import { useQuery } from '@tanstack/react-query';
import { ArrowUpRight, CornerDownLeft, Loader2, Mail, Moon, Pencil, Sun, X } from 'lucide-react';
import { usePathname, useRouter } from 'next/navigation';
import { useTheme } from 'next-themes';
import { useEffect, useRef, useState } from 'react';
import { SearchResultIcon } from '@/components/palette/SearchResultIcon';
import { Command, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { callTool, readSearchSource } from '@/lib/api-client';
import { useClientStore } from '@/lib/client-state';
import { DEFAULT_MAIL_QUERY, QUICK_SEARCH_QUERIES } from '@/lib/mail/search/constants';
import { isGlobalMailSearchShortcut } from '@/lib/mail/search/focus-contract';
import {
  localFileResults,
  matchesSearch,
  SEARCH_SCOPES,
  type SearchGroup,
  type SearchResult,
  type SearchScope,
  type SearchTool,
  searchCalendar,
  searchCloudFiles,
  searchMail,
  searchPages,
} from '@/lib/search/global-search';
import {
  focusSearchAfterSelection,
  navigateSearchTarget,
  searchScopeForArrow,
} from '@/lib/search/navigation';
import { cn } from '@/lib/utils';

const tool: SearchTool = (name, args, signal) => callTool(name, args, {}, signal);

/** Opening or dismissing global search never changes the underlying page. */
export function CommandPalette() {
  const open = useClientStore((s) => s.paletteOpen);
  const setOpen = useClientStore((s) => s.setPaletteOpen);
  const input = useRef<HTMLInputElement>(null);
  const pendingAction = useRef<(() => void) | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      const command = (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey;
      if (
        isGlobalMailSearchShortcut(event, event.target) ||
        (command && (event.key.toLowerCase() === 'p' || (open && event.key.toLowerCase() === 'f')))
      ) {
        event.preventDefault();
        setOpen(true);
        input.current?.focus();
        input.current?.select();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, setOpen]);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {open ? (
        <DialogContent
          data-global-search-dialog
          showCloseButton={false}
          className="top-[max(1rem,12vh)] max-h-[calc(100dvh-2rem)] translate-y-0 gap-0 overflow-hidden rounded-2xl border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-0 shadow-[0_24px_90px_-20px_rgba(0,0,0,0.45)] sm:max-w-[680px]"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            returnFocus.current =
              document.activeElement instanceof HTMLElement ? document.activeElement : null;
            input.current?.focus();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (!pendingAction.current) {
              if (returnFocus.current?.isConnected) returnFocus.current.focus();
              return;
            }
            const action = pendingAction.current;
            pendingAction.current = null;
            // The global launcher survives in-place page and result changes.
            focusSearchAfterSelection(document, returnFocus.current);
            action();
          }}
        >
          <DialogTitle className="sr-only">Search Albatross</DialogTitle>
          <DialogDescription className="sr-only">
            Switch pages or find mail, files, and calendar events. Use up and down to choose, Enter to open,
            and Escape to return to your page. Left and right switch categories at the edges of your query.
          </DialogDescription>
          {open ? (
            <SearchContent
              inputRef={input}
              onClose={() => setOpen(false)}
              onNavigate={(action) => {
                pendingAction.current = action;
                setOpen(false);
              }}
            />
          ) : null}
        </DialogContent>
      ) : null}
    </Dialog>
  );
}

function SearchContent({
  inputRef,
  onClose,
  onNavigate,
}: {
  inputRef: React.RefObject<HTMLInputElement | null>;
  onClose: () => void;
  onNavigate: (action: () => void) => void;
}) {
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<SearchScope>('all');
  const [natural, setNatural] = useState(false);
  const [selected, setSelected] = useState('');
  // Async groups mount after cmdk's initial selection pass. Keep Enter useful
  // when the old row disappears, without moving a user's valid selection.
  useEffect(() => {
    const rows = inputRef.current?.closest('[data-slot="command"]')?.querySelectorAll('[cmdk-item]');
    const values = Array.from(rows || [], (row) => row.getAttribute('data-value') || '');
    if (!values.includes(selected)) setSelected(values[0] || '');
  });
  const router = useRouter();
  const pathname = usePathname();
  const { setTheme } = useTheme();
  const accountFilter = useClientStore((s) => s.accountFilter);
  const activeView = useClientStore((s) => s.primaryView);
  const trimmed = draft.trim();
  const settled = trimmed === query;
  const searchEnabled = query.length >= 2 && settled;
  useEffect(() => {
    const timer = setTimeout(() => setQuery(trimmed), 300);
    return () => clearTimeout(timer);
  }, [trimmed]);
  const accounts = useQuery({
    queryKey: ['accounts'],
    queryFn: ({ signal }) =>
      tool<{ accounts: Array<{ accountId: string; email: string; authed: boolean }> }>(
        'list_accounts',
        {},
        signal,
      ),
    staleTime: 60_000,
  });
  const mailAccounts = (accounts.data?.accounts || []).filter(
    (account) => account.authed && (!accountFilter.length || accountFilter.includes(account.accountId)),
  );
  const translation = useQuery({
    queryKey: ['global-search', 'interpret', query],
    queryFn: ({ signal }) => tool<{ query: string }>('nl_search', { description: query }, signal),
    enabled: natural && searchEnabled,
    staleTime: 60_000,
    retry: false,
  });
  const mailQuery = natural ? translation.data?.query : query;
  const mail = useQuery({
    queryKey: ['global-search', 'mail', mailQuery, mailAccounts.map((account) => account.accountId)],
    queryFn: ({ signal }) => searchMail(mailQuery!, mailAccounts, tool, signal),
    enabled: searchEnabled && (scope === 'all' || scope === 'mail') && accounts.isSuccess && !!mailQuery,
    staleTime: 30_000,
    retry: false,
  });
  const calendar = useQuery({
    queryKey: ['global-search', 'calendar', query],
    queryFn: ({ signal }) => searchCalendar(query, tool, signal),
    enabled: searchEnabled && (scope === 'all' || scope === 'calendar'),
    staleTime: 30_000,
    retry: false,
  });
  const cloud = useQuery({
    queryKey: ['global-search', 'cloud-files', query],
    queryFn: ({ signal }) => searchCloudFiles(query, tool, signal),
    enabled: searchEnabled && (scope === 'all' || scope === 'files'),
    staleTime: 30_000,
    retry: false,
  });
  const documents = useQuery({
    queryKey: ['documents', { limit: 200 }],
    queryFn: ({ signal }) =>
      readSearchSource<{ documents: Array<{ documentId: string; title: string; kind: string }> }>(
        '/api/documents?limit=200',
        signal,
      ),
    enabled: scope === 'all' || scope === 'files',
    staleTime: 60_000,
    retry: false,
  });
  const uploads = useQuery({
    queryKey: ['albatross-files'],
    queryFn: ({ signal }) =>
      readSearchSource<{ files: Array<{ id: string; name: string; url?: string }> }>(
        '/api/agent/uploads',
        signal,
      ),
    enabled: scope === 'all' || scope === 'files',
    staleTime: 60_000,
    retry: false,
  });
  const pages = scope === 'all' ? searchPages(trimmed) : [];
  const narrative = useQuery({
    queryKey: ['global-search', 'narrative', query],
    queryFn: async ({ signal }) => {
      const data = await readSearchSource<{
        entries: Array<{ _id: string; title: string; text: string; occurredAt: number }>;
      }>(`/api/narrative?q=${encodeURIComponent(query)}`, signal);
      return (data.entries || []).slice(0, 5).map(
        (entry): SearchResult => ({
          id: `narrative:${entry._id}`,
          title: entry.title,
          detail: entry.text.slice(0, 140),
          timestamp: entry.occurredAt,
          target: { kind: 'narrative', id: entry._id },
        }),
      );
    },
    enabled: scope === 'all' && (query.length >= 2 || !trimmed),
    staleTime: 0,
    retry: false,
  });
  const files = localFileResults(trimmed, documents.data?.documents || [], uploads.data?.files || []);
  const go = (path: string) => {
    if (pathname !== '/' || !path.startsWith('/?')) router.push(path);
    else {
      // Clear stale document/area/work links even when switching in-place.
      window.history.pushState(window.history.state, '', path);
      window.dispatchEvent(new CustomEvent('lab86-mail:files-navigate'));
    }
  };
  const navigate = (result: SearchResult) => {
    const target = result.target;
    if (target.kind === 'external') {
      window.open(target.url, '_blank', 'noopener,noreferrer');
      onClose();
      return;
    }
    onNavigate(() => navigateSearchTarget(target, useClientStore.getState(), go));
  };
  const row = (result: SearchResult) => {
    const current = result.target.kind === 'page' && pathname === '/' && result.target.view === activeView;
    return (
      <CommandItem
        key={result.id}
        value={result.id}
        data-icon-row
        onSelect={() => navigate(result)}
        className="group mx-1 gap-3 rounded-lg px-3 py-2.5 data-[selected=true]:bg-[var(--color-accent-soft)] data-[selected=true]:text-[var(--color-text)]"
      >
        <div aria-hidden="true" className="grid size-8 shrink-0 place-items-center">
          <SearchResultIcon target={result.target} active={selected === result.id} />
        </div>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium">{result.title}</span>
          <span className="block truncate text-[11px] text-[var(--color-text-muted)]">
            {result.timestamp && result.target.kind === 'calendar'
              ? `${new Date(result.timestamp).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} · `
              : ''}
            {result.detail}
          </span>
        </span>
        {current ? (
          <span className="text-[10px] text-[var(--color-text-faint)]">Current</span>
        ) : result.target.kind === 'external' ? (
          <ArrowUpRight className="size-3.5" />
        ) : (
          <CornerDownLeft className="size-3.5 opacity-0 group-data-[selected=true]:opacity-60" />
        )}
      </CommandItem>
    );
  };
  const section = (
    label: string,
    result: { data?: SearchGroup; isFetching: boolean; error: Error | null; refetch: () => unknown },
    extraItems: SearchResult[] = [],
    extraErrors: string[] = [],
  ) => {
    const items = settled ? [...extraItems, ...(result.data?.items || [])] : [];
    const warnings = [...extraErrors, ...(settled ? result.data?.warnings || [] : [])];
    return (
      <CommandGroup forceMount heading={label}>
        {items.map(row)}
        <div role="status" className="px-4 text-[11px] text-[var(--color-text-muted)]">
          {!settled || result.isFetching ? (
            <span className="flex items-center gap-2 py-3">
              <Loader2 className="size-3 motion-safe:animate-spin" />
              Searching…
            </span>
          ) : null}
          {result.error ? <p className="py-2 text-[var(--color-danger)]">{result.error.message}</p> : null}
          {warnings.map((warning) => (
            <p key={warning} className="py-2">
              {warning}
            </p>
          ))}
          {settled && !result.isFetching && (result.error || warnings.length) ? (
            <button
              type="button"
              className="pb-2 text-[var(--color-accent)] hover:underline"
              onClick={() => {
                void result.refetch();
                if (label.startsWith('Mail')) {
                  void accounts.refetch();
                  if (natural) void translation.refetch();
                }
                if (label === 'Files') {
                  void documents.refetch();
                  void uploads.refetch();
                }
              }}
            >
              Retry search
            </button>
          ) : null}
          {label === 'Files' && (result.error || warnings.length) ? (
            <button
              type="button"
              className="ml-4 pb-2 text-[var(--color-accent)] hover:underline"
              onClick={() =>
                onNavigate(() =>
                  navigateSearchTarget({ kind: 'page', view: 'files' }, useClientStore.getState(), go),
                )
              }
            >
              Check file connections
            </button>
          ) : null}
          {settled && !result.isFetching && !result.error && !warnings.length && !items.length ? (
            <p className="py-3">No matches in {label.toLowerCase()}.</p>
          ) : null}
        </div>
      </CommandGroup>
    );
  };
  return (
    <Command
      value={selected}
      onValueChange={setSelected}
      shouldFilter={false}
      loop
      onKeyDown={(event) => {
        const input = inputRef.current;
        const fromInput = event.target === input;
        if (!fromInput && !(event.target instanceof Element && event.target.closest('[data-search-scope]')))
          return;
        const next = searchScopeForArrow(event.nativeEvent, scope, fromInput ? input! : undefined);
        if (!next) return;
        event.preventDefault();
        event.stopPropagation();
        setScope(next);
        setNatural(false);
        setSelected('');
        input?.focus();
      }}
      className="rounded-none bg-transparent text-[var(--color-text)]"
    >
      <div className="relative border-b border-[var(--color-border)] [&_[data-slot=command-input-wrapper]]:h-16 [&_[data-slot=command-input-wrapper]]:border-0 [&_[data-slot=command-input-wrapper]]:pl-5 [&_[data-slot=command-input-wrapper]]:pr-14 [&_[data-slot=command-input-wrapper]>svg]:size-5 [&_[data-slot=command-input-wrapper]>svg]:text-[var(--color-accent)]">
        <CommandInput
          ref={inputRef}
          data-global-search-input
          aria-label="Search pages, mail, files, and calendar"
          placeholder="Search anything, or jump to a page…"
          value={draft}
          maxLength={200}
          onValueChange={(value) => {
            setDraft(value);
            setNatural(false);
          }}
          className="h-16 text-[16px]"
        />
        <button
          type="button"
          onClick={onClose}
          aria-label="Close search"
          className="absolute right-4 top-5 rounded-md border border-[var(--color-border)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)] hover:bg-[var(--color-bg-muted)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]"
        >
          Esc
        </button>
      </div>
      <fieldset
        className="flex items-center gap-1 border-b border-[var(--color-border)] px-4 py-2"
        aria-label="Search sources"
      >
        {SEARCH_SCOPES.map((option) => (
          <button
            key={option.id}
            type="button"
            data-search-scope={option.id}
            aria-pressed={scope === option.id}
            onClick={() => {
              setScope(option.id);
              setNatural(false);
              setSelected('');
              inputRef.current?.focus();
            }}
            className={cn(
              'rounded-md px-2.5 py-1 text-[11px] transition-colors focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]',
              scope === option.id
                ? 'bg-[var(--color-accent-soft)] font-medium text-[var(--color-accent)]'
                : 'text-[var(--color-text-muted)] hover:bg-[var(--color-bg-muted)]',
            )}
          >
            {option.label}
          </button>
        ))}
        {draft ? (
          <button
            type="button"
            aria-label="Clear search"
            onClick={() => {
              setDraft('');
              setNatural(false);
              inputRef.current?.focus();
            }}
            className="ml-auto rounded p-1 text-[var(--color-text-muted)]"
          >
            <X className="size-3.5" />
          </button>
        ) : null}
      </fieldset>
      <CommandList className="max-h-[min(430px,55dvh)] min-h-[160px] p-2">
        {pages.length ? <CommandGroup heading="Jump to">{pages.map(row)}</CommandGroup> : null}
        {trimmed.length >= 2 ? (
          <>
            {scope === 'all' || scope === 'mail'
              ? section(
                  accountFilter.length ? 'Mail · selected accounts' : 'Mail',
                  {
                    ...mail,
                    isFetching: mail.isFetching || accounts.isFetching || (natural && translation.isFetching),
                    error: accounts.error || translation.error || mail.error,
                  },
                  [],
                  natural && translation.data ? [`Interpreted as: ${translation.data.query}`] : [],
                )
              : null}
            {scope === 'all' || scope === 'files'
              ? section(
                  'Files',
                  { ...cloud, isFetching: cloud.isFetching || documents.isFetching || uploads.isFetching },
                  files,
                  [
                    documents.error ? 'Albatross documents are unavailable.' : '',
                    uploads.error ? 'Uploaded files are unavailable.' : '',
                  ].filter(Boolean),
                )
              : null}
            {scope === 'all' || scope === 'calendar' ? section('Calendar', calendar) : null}
          </>
        ) : (
          <p className="px-4 py-3 text-[12px] text-[var(--color-text-muted)]">
            {trimmed
              ? 'Keep typing to search across your sources.'
              : 'Jump to a page, or type to find mail, files, and events.'}
          </p>
        )}
        {scope === 'all' && narrative.data?.length ? (
          <CommandGroup heading={trimmed ? 'Related history' : 'Pick up a thread'}>
            {narrative.data.map(row)}
          </CommandGroup>
        ) : null}
        {scope === 'all' ? (
          <CommandGroup heading="Actions">
            {matchesSearch('compose new message email', trimmed) ? (
              <CommandItem
                value="action:compose"
                onSelect={() =>
                  onNavigate(() => {
                    if (pathname !== '/')
                      navigateSearchTarget({ kind: 'page', view: 'mail' }, useClientStore.getState(), go);
                    useClientStore.getState().openComposeNew();
                  })
                }
              >
                <Pencil className="size-4" />
                Compose new message
              </CommandItem>
            ) : null}
            {matchesSearch('switch dark theme', trimmed) ? (
              <CommandItem
                value="action:dark"
                onSelect={() => {
                  setTheme('dark');
                  onClose();
                }}
              >
                <Moon className="size-4" />
                Dark theme
              </CommandItem>
            ) : null}
            {matchesSearch('switch light theme', trimmed) ? (
              <CommandItem
                value="action:light"
                onSelect={() => {
                  setTheme('light');
                  onClose();
                }}
              >
                <Sun className="size-4" />
                Light theme
              </CommandItem>
            ) : null}
          </CommandGroup>
        ) : null}
        {scope === 'all' && trimmed ? (
          <CommandGroup heading="Mail shortcuts">
            {Object.entries({
              Inbox: DEFAULT_MAIL_QUERY,
              ...QUICK_SEARCH_QUERIES,
              Snoozed: 'label:MailOS/Snoozed',
            })
              .filter(([label]) => matchesSearch(`mail ${label}`, trimmed))
              .map(([label, value]) => (
                <CommandItem
                  key={label}
                  value={`mailbox:${label}`}
                  onSelect={() =>
                    onNavigate(() => {
                      navigateSearchTarget({ kind: 'page', view: 'mail' }, useClientStore.getState(), go);
                      useClientStore.getState().setQuery(value);
                    })
                  }
                >
                  <Mail className="size-4" />
                  <span className="capitalize">{label}</span>
                </CommandItem>
              ))}
          </CommandGroup>
        ) : null}
        {scope === 'all' && pathname === '/' && trimmed ? (
          <CommandGroup heading="AI commands">
            {[
              ['Triage newest 25', 'Triage my newest 25 inbox threads'],
              ['Summarize today', 'Summarize my unread from today and propose 3 replies'],
            ]
              .filter(([label]) => matchesSearch(`ai ${label}`, trimmed))
              .map(([label, request]) => (
                <CommandItem
                  key={label}
                  value={`ai:${label}`}
                  onSelect={() =>
                    onNavigate(() =>
                      document.dispatchEvent(new CustomEvent('lab86-mail:ask', { detail: request })),
                    )
                  }
                >
                  {label}
                </CommandItem>
              ))}
          </CommandGroup>
        ) : null}
      </CommandList>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-[var(--color-border)] bg-[var(--color-bg)] px-5 py-3 text-[10px] text-[var(--color-text-muted)]">
        <span>
          <kbd>↑ ↓</kbd> navigate
        </span>
        <span title="Switch categories when the query is empty or the caret is at its beginning or end">
          <kbd>← →</kbd> categories
        </span>
        <span>
          <kbd>↵</kbd> open
        </span>
        <span>
          <kbd>esc</kbd> back to your page
        </span>
        {scope === 'mail' && trimmed.length >= 2 && !natural ? (
          <button
            type="button"
            className="ml-auto text-[var(--color-accent)] hover:underline"
            onClick={() => setNatural(true)}
          >
            Interpret as a mail request
          </button>
        ) : null}
        {scope === 'files' ? (
          <span className="basis-full">Connected drives and recent Albatross files · searches names</span>
        ) : null}
      </div>
    </Command>
  );
}
