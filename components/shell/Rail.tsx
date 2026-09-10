'use client';

import { UserButton } from '@clerk/nextjs';
import { useQuery } from '@tanstack/react-query';
import {
  useConvexAuth,
  useMutation as useConvexMutation,
  useQuery_experimental as useConvexQuery,
} from 'convex/react';
import { History, Settings } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ProviderLogo } from '@/components/icons/provider-logos';
import { Ring } from '@/components/loading-ui/ring';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { PlusIcon } from '@/components/ui/plus';
import { RowIcon, rowIcon } from '@/components/ui/row-icon';
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
  useSidebar,
} from '@/components/ui/sidebar';
import { UserIcon } from '@/components/ui/user';
import { UsersIcon } from '@/components/ui/users';
import { api } from '@/convex/_generated/api';
import { railAreaRows } from '@/lib/albatross/area-home';
import { orderedAreaImageSources } from '@/lib/albatross/area-image';
import { railWorkBadge } from '@/lib/albatross/work-state';
import { callTool } from '@/lib/api-client';
import { useClientStore } from '@/lib/client-state';
import { mailSearchShortcutLabel } from '@/lib/mail/search/focus-contract';
import { categoricalColor } from '@/lib/shared/format';
import { normalizePrimaryView, type PrimaryView } from '@/lib/shared/types';
import { NotificationCenter } from './NotificationCenter';
import { RAIL_SURFACE_ICONS } from './navigation-icons';
import { RailPrimaryActions } from './ShellActions';
import { useApplyThemeExtras } from './ThemePanel';

// Top-level surfaces of the product, in the order a person meets them: the
// day, the things being carried, then the systems those things run on.
const SURFACES: Array<{
  view: 'today' | 'albatrosses' | 'mail' | 'calendar' | 'files' | 'chat';
  label: string;
  Icon: any;
}> = [
  { view: 'today', label: 'Today', Icon: rowIcon(RAIL_SURFACE_ICONS.today) },
  { view: 'albatrosses', label: 'Albatrosses', Icon: rowIcon(RAIL_SURFACE_ICONS.albatrosses) },
  { view: 'chat', label: 'Chat', Icon: rowIcon(RAIL_SURFACE_ICONS.chat) },
  { view: 'mail', label: 'Mail', Icon: rowIcon(RAIL_SURFACE_ICONS.mail) },
  { view: 'calendar', label: 'Calendar', Icon: rowIcon(RAIL_SURFACE_ICONS.calendar) },
  { view: 'files', label: 'Files', Icon: rowIcon(RAIL_SURFACE_ICONS.files) },
];

export const ALL_ACCOUNTS = '__all__';

// Icon-mode group separator: a short centered hairline (macOS-dock style)
// with symmetric breathing room, so the collapsed tile column reads as
// deliberate groups instead of one lumpy run. The expanded rail's group
// labels carry this job, so it renders nothing there.
function RailDivider() {
  return (
    <div
      aria-hidden
      className="mx-auto my-1 hidden h-px w-6 shrink-0 bg-[var(--color-border)] group-data-[collapsible=icon]:block"
    />
  );
}

function AreaRailIcon({
  area,
}: {
  area: { _id: string; name: string; faviconUrl?: string | null; imageUrl?: string | null };
}) {
  // Tracks how many sources have failed so far (not just a single boolean) —
  // the image is tried first, then the favicon, before falling back to the
  // colored dot.
  const [attempt, setAttempt] = useState(0);
  const sources = orderedAreaImageSources(area);
  const src = sources[attempt] ?? null;
  return (
    <div className="grid size-4 shrink-0 place-items-center">
      {src ? (
        // biome-ignore lint/performance/noImgElement: rail area marks use arbitrary favicon/image URLs.
        <img
          src={src}
          alt=""
          className="size-4 rounded-sm object-cover"
          referrerPolicy="no-referrer"
          onError={() => setAttempt((a) => a + 1)}
        />
      ) : (
        <span
          className="size-2 rounded-full"
          style={{ backgroundColor: categoricalColor(area._id) }}
          aria-hidden
        />
      )}
    </div>
  );
}

export function Rail({
  clerkEnabled = false,
  activeViewOverride,
}: {
  clerkEnabled?: boolean;
  activeViewOverride?: PrimaryView;
}) {
  useApplyThemeExtras();
  const account = useClientStore((s) => s.account);
  const setAccount = useClientStore((s) => s.setAccount);
  const chatOpen = useClientStore((s) => s.aiBarOpen);
  const presentation = useClientStore((s) => s.assistantPresentation);
  const chatActive = chatOpen && presentation !== 'corner';
  const setPrimaryAccount = useClientStore((s) => s.setPrimaryAccount);
  const primaryView = useClientStore((s) => s.primaryView);
  const setPrimaryView = useClientStore((s) => s.setPrimaryView);
  const visiblePrimaryView = normalizePrimaryView(activeViewOverride ?? primaryView);
  const selectedAreaId = useClientStore((s) => s.selectedAreaId);
  const setSelectedAreaId = useClientStore((s) => s.setSelectedAreaId);
  const setSelectedWorkId = useClientStore((s) => s.setSelectedWorkId);
  const setSelectedThread = useClientStore((s) => s.setSelectedThread);
  const paletteOpen = useClientStore((s) => s.paletteOpen);
  const setPaletteOpen = useClientStore((s) => s.setPaletteOpen);
  const { isMobile, openMobile, setOpenMobile } = useSidebar();
  useEffect(() => {
    if (isMobile && openMobile && paletteOpen) setOpenMobile(false);
  }, [isMobile, openMobile, paletteOpen, setOpenMobile]);
  const closeMobileSidebar = () => {
    if (isMobile) setOpenMobile(false);
  };
  const [addingArea, setAddingArea] = useState(false);
  const [newAreaName, setNewAreaName] = useState('');
  const [creatingArea, setCreatingArea] = useState(false);
  // Keep the server and first client render identical, then specialize the
  // label once the browser platform is known.
  const [searchShortcut, setSearchShortcut] = useState('⌘/Ctrl F');
  useEffect(() => {
    setSearchShortcut(mailSearchShortcutLabel(navigator.platform));
  }, []);
  const createAreaMutation = useConvexMutation(api.albatross.createArea);
  const createArea = async () => {
    const name = newAreaName.trim();
    if (!name || creatingArea) return;
    setCreatingArea(true);
    try {
      const areaId = await createAreaMutation({ name });
      setNewAreaName('');
      setAddingArea(false);
      if (areaId) openArea(String(areaId));
    } catch {
      // Leave the field open with what the user typed; the rail must not eat
      // the name it just asked for.
    } finally {
      setCreatingArea(false);
    }
  };

  const { data: accountsData } = useQuery({
    queryKey: ['accounts'],
    queryFn: async () =>
      callTool<{
        accounts: {
          accountId: string;
          email: string;
          provider: string;
          authed: boolean;
          primary?: boolean;
          displayName?: string;
          sync?: {
            status: string;
            corpusReady: boolean;
            messagesSynced?: number;
            error?: string;
          };
        }[];
      }>('list_accounts'),
    // Poll quickly while any mailbox is still indexing so the status dots and
    // message counts move; settle down once everything is ready.
    refetchInterval: (query) =>
      (query.state.data?.accounts || []).some(
        (a) => a.sync && !a.sync.corpusReady && a.sync.status !== 'error',
      )
        ? 15_000
        : 60_000,
  });
  const accounts = accountsData?.accounts || [];
  const authedAccounts = accounts.filter((a) => a.authed);
  // Live areas — one rail row per active area, so areas behave like first-class
  // places instead of hiding behind one door. Auth-gated: a first-paint query
  // before the Clerk token lands would error.
  const { isAuthenticated: convexAuthed } = useConvexAuth();
  const areasResult = useConvexQuery({
    query: (api as any).albatross.listAreasOverview,
    args: convexAuthed ? { status: 'active' } : 'skip',
  });
  const railAreas =
    areasResult.status === 'success'
      ? ((areasResult.data as
          | Array<{
              _id: string;
              name: string;
              kind: string;
              faviconUrl?: string | null;
              imageUrl?: string | null;
            }>
          | undefined) ?? [])
      : undefined;
  const { rows: areaRows, overflow: areaOverflow } = railAreaRows(railAreas);

  // The Albatrosses badge. Words, never a count of everything being carried.
  const workResult = useConvexQuery({
    query: (api as any).albatrossWorkV2.allWork,
    args: convexAuthed ? {} : 'skip',
  });
  const workBadge = workResult.status === 'success' ? railWorkBadge((workResult.data as any[]) || []) : null;

  const openArea = (areaId: string | null) => {
    // A fresh area context should not carry a stale open thread with it.
    setSelectedThread(null);
    setSelectedWorkId(null);
    setSelectedAreaId(areaId);
    setPrimaryView('areas');
    closeMobileSidebar();
  };

  // Default to the unified "all mailboxes" view, but let the user scope the
  // inbox to a single account from the rail. Only repair the selection when
  // it points at an account that no longer exists.
  useEffect(() => {
    if (!accounts.length) return;
    const primary = authedAccounts.find((a) => a.primary) || authedAccounts[0] || accounts[0];
    if (primary) setPrimaryAccount(primary.accountId);
    const valid = account === ALL_ACCOUNTS || accounts.some((a) => a.accountId === account);
    if (!account || !valid) {
      setAccount(authedAccounts.length > 1 ? ALL_ACCOUNTS : primary ? primary.accountId : ALL_ACCOUNTS);
    }
  }, [accounts, authedAccounts, account, setAccount, setPrimaryAccount]);

  return (
    <Sidebar
      collapsible="icon"
      className="rail-wash bg-[var(--rail-bg)] font-display"
      onMobileCloseAutoFocus={(event) => {
        if (!paletteOpen) return;
        event.preventDefault();
        document.querySelector<HTMLInputElement>('[data-global-search-input]')?.focus();
      }}
      onClickCapture={(event) => {
        if (!isMobile) return;
        const target = event.target as HTMLElement | null;
        if (!target || target.closest('input, textarea, select, [contenteditable="true"]')) return;
        if (target.closest('button, a, [role="button"], [role="menuitem"]')) {
          window.setTimeout(() => setOpenMobile(false), 0);
        }
      }}
    >
      <SidebarHeader className="gap-3">
        {/* Albatross is the product; Lab86 is the company that makes it. The
            wordmark only shows when the rail is expanded; the trigger centres
            itself when collapsed so it doubles as the expand button. */}
        <div className="flex items-center justify-between gap-2 overflow-hidden px-1 pt-1 transition-[padding,gap] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:gap-0 group-data-[collapsible=icon]:px-0">
          <span className="max-w-40 whitespace-nowrap opacity-100 transition-[max-width,opacity,transform] delay-150 duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] group-data-[collapsible=icon]:max-w-0 group-data-[collapsible=icon]:translate-x-1 group-data-[collapsible=icon]:opacity-0 group-data-[collapsible=icon]:delay-0 motion-reduce:transition-none">
            <span className="block font-display text-[17px] font-semibold leading-none tracking-tight text-[var(--color-text)]">
              Albatross
            </span>
            <span className="mt-0.5 block text-[10.5px] leading-none text-[var(--color-text-faint)]">
              by Lab86
            </span>
          </span>
          <SidebarTrigger
            title="Toggle navigation rail"
            className="shrink-0 text-[var(--color-text-muted)] transition-transform duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] hover:bg-[var(--color-bg-muted)] hover:text-[var(--color-text)] group-data-[collapsible=icon]:mx-auto"
          />
        </div>

        <RailPrimaryActions searchShortcut={searchShortcut} onSearch={() => setPaletteOpen(true)} />
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {SURFACES.map(({ view, label, Icon }) => (
                <SidebarMenuItem key={view}>
                  <SidebarMenuButton
                    isActive={view === 'chat' ? chatActive : !chatActive && visiblePrimaryView === view}
                    tooltip={label}
                    data-rail-target={view}
                    onClick={() => {
                      if (view === 'albatrosses') setSelectedWorkId(null);
                      setPrimaryView(view);
                      closeMobileSidebar();
                    }}
                    className="rail-selection"
                  >
                    <Icon />
                    <span>{label}</span>
                    {/* Words, never a count. A number here would be a tally of
                        everything the user is still carrying. */}
                    {view === 'albatrosses' && workBadge ? (
                      <span className="ml-auto whitespace-nowrap text-[10.5px] text-[var(--color-text-muted)] group-data-[collapsible=icon]:hidden">
                        {workBadge}
                      </span>
                    ) : null}
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          <RailDivider />
          <SidebarGroupLabel className="text-[11px]">Areas</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {areaRows.map((area) => {
                const active = visiblePrimaryView === 'areas' && selectedAreaId === area._id;
                return (
                  <SidebarMenuItem key={area._id}>
                    <SidebarMenuButton
                      isActive={active}
                      tooltip={area.name}
                      onClick={() => openArea(area._id)}
                      className="rail-selection"
                    >
                      <AreaRailIcon area={area} />
                      <span className="truncate">{area.name}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
              {areaOverflow > 0 ? (
                <SidebarMenuItem>
                  <SidebarMenuButton
                    tooltip="All areas"
                    onClick={() => openArea(null)}
                    className="text-[var(--color-text-muted)]"
                  >
                    <div className="grid size-4 shrink-0 place-items-center" aria-hidden />
                    <span>{areaOverflow} more</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ) : null}
              <SidebarMenuItem>
                {/* Naming a part of your life is a one-field act. It used to
                    throw the user out of the app into a settings tab. */}
                {addingArea ? (
                  <form
                    className="px-2 py-1"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void createArea();
                    }}
                  >
                    <input
                      // biome-ignore lint/a11y/noAutofocus: the field only exists because the user just asked for it.
                      autoFocus
                      value={newAreaName}
                      onChange={(event) => setNewAreaName(event.target.value)}
                      onBlur={() => {
                        if (!newAreaName.trim()) setAddingArea(false);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Escape') {
                          setNewAreaName('');
                          setAddingArea(false);
                        }
                      }}
                      placeholder="Work, Money, Home…"
                      aria-label="Name the new area"
                      disabled={creatingArea}
                      className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-2 py-1 text-[12.5px] outline-none focus:border-[var(--color-accent)]"
                    />
                  </form>
                ) : (
                  <SidebarMenuButton
                    tooltip="New area"
                    onClick={() => setAddingArea(true)}
                    className="text-[var(--color-text-muted)]"
                  >
                    <PlusIcon size={16} />
                    <span>New area</span>
                  </SidebarMenuButton>
                )}
              </SidebarMenuItem>
              {/* A failed query must not silently erase the section. */}
              {areasResult.status === 'error' ? (
                <SidebarMenuItem>
                  <SidebarMenuButton
                    tooltip="Reload to retry"
                    onClick={() => window.location.reload()}
                    className="text-[var(--color-text-muted)]"
                  >
                    <div className="grid size-4 shrink-0 place-items-center" aria-hidden />
                    <span>Areas didn&apos;t load — reload</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ) : null}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          <RailDivider />
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  isActive={visiblePrimaryView === 'activity'}
                  tooltip="Activity"
                  onClick={() => {
                    setPrimaryView('activity');
                    closeMobileSidebar();
                  }}
                >
                  <History className="size-4 shrink-0" aria-hidden />
                  <span>Activity</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <nav
          aria-label="Account controls"
          className="flex items-center justify-between gap-2 border-t border-[var(--color-list-divider)] px-1 pt-3 group-data-[collapsible=icon]:flex-col group-data-[collapsible=icon]:px-0"
        >
          <Button asChild variant="ghost" size="icon" title="Settings">
            <Link href="/settings" aria-label="Settings" onClick={closeMobileSidebar}>
              <Settings className="size-4" aria-hidden />
            </Link>
          </Button>
          <NotificationCenter
            onOpen={() => {
              setPrimaryView('notifications');
              closeMobileSidebar();
            }}
          />
          <div className="rail-profile grid size-9 shrink-0 place-items-center" title="Profile">
            {clerkEnabled ? (
              <UserButton />
            ) : (
              <div
                className="grid size-6 place-items-center rounded-full bg-[var(--color-avatar-bg)] text-[var(--color-text-muted)]"
                title="Local preview"
              >
                <UserIcon size={13} />
              </div>
            )}
          </div>
        </nav>
      </SidebarFooter>
    </Sidebar>
  );
}

// One number: unread. Zero (or still loading) renders nothing — no ghost
// pill, no skeleton. Needs-attention is an ambient dot, not another number.

type AccountSync =
  | {
      status: string;
      corpusReady: boolean;
      messagesSynced?: number;
      error?: string;
    }
  | undefined;

// One line of truth per mailbox: what the index is doing and how far it is.
function syncCaption(sync: AccountSync, authed: boolean): string {
  if (!authed) return 'Reconnect needed';
  if (!sync || sync.status === 'idle') return 'Waiting for first sync';
  const count =
    typeof sync.messagesSynced === 'number' ? `${sync.messagesSynced.toLocaleString()} indexed` : '';
  if (sync.status === 'error') return sync.error ? `Error — ${sync.error}` : 'Sync error — retrying';
  if (sync.corpusReady) return count ? `${count} · live` : 'Indexed · live';
  return count ? `${count} · indexing…` : 'Indexing…';
}

// Green = indexed and searchable locally; pulsing accent = actively indexing;
// red = sync error or needs reconnect; gray = waiting for its first sync.
function AccountSyncDot({ sync, authed }: { sync: AccountSync; authed: boolean }) {
  const color = !authed
    ? 'bg-[var(--color-danger)]'
    : sync?.status === 'error'
      ? 'bg-[var(--color-danger)]'
      : sync?.corpusReady
        ? 'bg-emerald-500'
        : sync?.status === 'backfilling' || sync?.status === 'syncing'
          ? 'animate-pulse bg-[var(--color-accent)]'
          : 'bg-[var(--color-text-faint)]';
  return <span className={`ml-auto size-1.5 shrink-0 rounded-full ${color}`} />;
}

export function AccountScopePopover({
  accounts,
  accountFilter,
  setAccountFilter,
  indexingCount,
}: {
  accounts: Array<{
    accountId: string;
    email: string;
    provider: string;
    displayName?: string;
    authed: boolean;
    sync?: { status: string; corpusReady: boolean; messagesSynced?: number; error?: string };
  }>;
  accountFilter: string[];
  setAccountFilter: (accountIds: string[]) => void;
  indexingCount: number;
}) {
  const allIds = accounts.map((a) => a.accountId);
  // Empty filter means "all accounts" — the default.
  const effective = accountFilter.length ? accountFilter.filter((id) => allIds.includes(id)) : allIds;
  const allSelected = effective.length === allIds.length;
  const label = allSelected ? 'All accounts' : `${effective.length} of ${allIds.length} accounts`;

  const toggle = (accountId: string, checked: boolean) => {
    const next = checked
      ? [...new Set([...effective, accountId])]
      : effective.filter((id) => id !== accountId);
    if (!next.length) return; // at least one mailbox stays selected
    setAccountFilter(next.length === allIds.length ? [] : next);
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title={label}
          aria-label={`Choose mailboxes: ${label}`}
          className="corner-smooth relative flex h-9 shrink-0 items-center gap-2 rounded-[var(--radius-control)] border border-[var(--color-control-border)] bg-[var(--color-control)] px-2.5 text-xs text-[var(--color-text-muted)] outline-none transition-colors hover:bg-[var(--color-control-hover)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)]"
        >
          <RowIcon icon={UsersIcon} size={15} />
          <span className="hidden lg:inline">{label}</span>
          {!allSelected ? (
            <span className="absolute right-0.5 top-0.5 grid size-3 place-items-center rounded-full bg-[var(--color-accent)] text-[7px] font-semibold leading-none text-[var(--color-accent-foreground)]">
              {effective.length}
            </span>
          ) : indexingCount ? (
            <span className="absolute right-0.5 top-0.5">
              <Ring className="size-2.5 text-[var(--color-accent)]" />
            </span>
          ) : null}
          <span className="sr-only">Choose accounts</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="bottom" className="w-64">
        <DropdownMenuLabel className="text-[11px] text-[var(--color-text-faint)]">
          Inbox shows · {label}
        </DropdownMenuLabel>
        <DropdownMenuItem
          onSelect={(event) => {
            event.preventDefault();
            setAccountFilter([]);
          }}
          className="gap-2 text-[12.5px]"
        >
          <RowIcon icon={UsersIcon} size={14} />
          All accounts
          {allSelected ? <span className="ml-auto text-[var(--color-accent)]">✓</span> : null}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {accounts.map((mailbox) => (
          <DropdownMenuCheckboxItem
            key={mailbox.accountId}
            checked={effective.includes(mailbox.accountId)}
            onCheckedChange={(checked) => toggle(mailbox.accountId, Boolean(checked))}
            onSelect={(event) => event.preventDefault()}
            className="gap-2 text-[12.5px]"
          >
            <ProviderLogo provider={mailbox.provider} className="size-3.5 shrink-0" />
            <span className="min-w-0 flex-1">
              <span className="block truncate">{mailbox.displayName || mailbox.email}</span>
              <span className="block truncate text-[10.5px] leading-tight text-[var(--color-text-faint)]">
                {syncCaption(mailbox.sync, mailbox.authed)}
              </span>
            </span>
            <AccountSyncDot sync={mailbox.sync} authed={mailbox.authed} />
          </DropdownMenuCheckboxItem>
        ))}
        {indexingCount ? (
          <>
            <DropdownMenuSeparator />
            <div className="flex items-center gap-1.5 px-2 py-1.5 text-[11px] text-[var(--color-accent)]">
              <Ring className="size-3" />
              {indexingCount === 1 ? '1 mailbox indexing…' : `${indexingCount} mailboxes indexing…`}
            </div>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
