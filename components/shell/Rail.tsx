'use client';

import { UserButton } from '@clerk/nextjs';
import { useQuery } from '@tanstack/react-query';
import { useConvexAuth, useQuery_experimental as useConvexQuery } from 'convex/react';
import { Search, Settings } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ProviderLogo } from '@/components/icons/provider-logos';
import { Ring } from '@/components/loading-ui/ring';
import { CalendarDaysIcon } from '@/components/ui/calendar-days';
import { CircleCheckIcon } from '@/components/ui/circle-check';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { FileTextIcon } from '@/components/ui/file-text';
import { FolderIcon } from '@/components/ui/folder';
import { MailCheckIcon } from '@/components/ui/mail-check';
import { PlusIcon } from '@/components/ui/plus';
import { RowIcon, rowIcon } from '@/components/ui/row-icon';
import { SettingsIcon } from '@/components/ui/settings';
import { ShineBorder } from '@/components/ui/shine-border';
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
import { categoricalColor } from '@/lib/shared/format';
import { normalizePrimaryView, type PrimaryView } from '@/lib/shared/types';
import { NotificationCenter } from './NotificationCenter';
import { ThemePanel } from './ThemePanel';

// Top-level surfaces of the product, in the order a person meets them: the
// day, the things being carried, then the systems those things run on.
const SURFACES: Array<{
  view: 'today' | 'albatrosses' | 'mail' | 'calendar' | 'files';
  label: string;
  Icon: any;
}> = [
  { view: 'today', label: 'Today', Icon: rowIcon(FileTextIcon) },
  { view: 'albatrosses', label: 'Albatrosses', Icon: rowIcon(CircleCheckIcon) },
  { view: 'mail', label: 'Mail', Icon: rowIcon(MailCheckIcon) },
  { view: 'calendar', label: 'Calendar', Icon: rowIcon(CalendarDaysIcon) },
  { view: 'files', label: 'Files', Icon: rowIcon(FolderIcon) },
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
  const account = useClientStore((s) => s.account);
  const setAccount = useClientStore((s) => s.setAccount);
  const accountFilter = useClientStore((s) => s.accountFilter);
  const setAccountFilter = useClientStore((s) => s.setAccountFilter);
  const setPrimaryAccount = useClientStore((s) => s.setPrimaryAccount);
  const primaryView = useClientStore((s) => s.primaryView);
  const setPrimaryView = useClientStore((s) => s.setPrimaryView);
  const visiblePrimaryView = normalizePrimaryView(activeViewOverride ?? primaryView);
  const selectedAreaId = useClientStore((s) => s.selectedAreaId);
  const setSelectedAreaId = useClientStore((s) => s.setSelectedAreaId);
  const setSelectedWorkId = useClientStore((s) => s.setSelectedWorkId);
  const setSelectedThread = useClientStore((s) => s.setSelectedThread);
  const setCaptureOpen = useClientStore((s) => s.setCaptureOpen);
  const setPaletteOpen = useClientStore((s) => s.setPaletteOpen);
  const { isMobile, setOpenMobile } = useSidebar();
  const closeMobileSidebar = () => {
    if (isMobile) setOpenMobile(false);
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
  const indexingAccounts = authedAccounts.filter(
    (a) => a.sync && !a.sync.corpusReady && (a.sync.status === 'backfilling' || a.sync.status === 'syncing'),
  );
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

        {/* The primary action of the whole product. It used to be Compose. */}
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              tooltip="Get this off my mind"
              onClick={() => {
                setCaptureOpen(true);
                closeMobileSidebar();
              }}
              className="relative bg-[var(--color-accent)] font-medium text-[var(--color-accent-foreground)] shadow-[var(--shadow-soft)] hover:bg-[var(--color-accent-hover)] hover:text-[var(--color-accent-foreground)] focus-visible:ring-[var(--color-accent)]"
            >
              <ShineBorder
                borderWidth={1}
                duration={10}
                shineColor={[
                  'var(--color-accent-shine-1)',
                  'var(--color-accent-shine-2)',
                  'var(--color-accent-shine-3)',
                ]}
              />
              <PlusIcon size={16} />
              <span>Get this off my mind</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {SURFACES.map(({ view, label, Icon }) => (
                <SidebarMenuItem key={view}>
                  <SidebarMenuButton
                    isActive={visiblePrimaryView === view}
                    tooltip={label}
                    onClick={() => {
                      if (view === 'albatrosses') setSelectedWorkId(null);
                      setPrimaryView(view);
                      closeMobileSidebar();
                    }}
                    className="relative overflow-hidden data-[active=true]:bg-[var(--color-accent-soft)] data-[active=true]:text-[var(--color-accent)] data-[active=true]:shadow-[var(--shadow-soft)] dark:data-[active=true]:bg-[var(--color-selected-soft)] dark:data-[active=true]:text-[var(--color-selected)] dark:data-[active=true]:shadow-none"
                  >
                    {visiblePrimaryView === view ? (
                      <ShineBorder
                        borderWidth={1}
                        duration={10}
                        shineColor={[
                          'var(--color-accent-shine-1)',
                          'var(--color-accent-shine-2)',
                          'var(--color-accent-shine-3)',
                        ]}
                      />
                    ) : null}
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
                      className="relative overflow-hidden data-[active=true]:bg-[var(--color-accent-soft)] data-[active=true]:text-[var(--color-accent)] data-[active=true]:shadow-[var(--shadow-soft)] dark:data-[active=true]:bg-[var(--color-selected-soft)] dark:data-[active=true]:text-[var(--color-selected)] dark:data-[active=true]:shadow-none"
                    >
                      {active ? (
                        <ShineBorder
                          borderWidth={1}
                          duration={10}
                          shineColor={[
                            'var(--color-accent-shine-1)',
                            'var(--color-accent-shine-2)',
                            'var(--color-accent-shine-3)',
                          ]}
                        />
                      ) : null}
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
                <SidebarMenuButton
                  tooltip="New area"
                  onClick={() => {
                    window.location.href = '/settings?tab=areas';
                  }}
                  className="text-[var(--color-text-muted)]"
                >
                  <PlusIcon size={16} />
                  <span>New area</span>
                </SidebarMenuButton>
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
                    <span>Areas didn't load — reload</span>
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
                  tooltip="Search"
                  onClick={() => {
                    setPaletteOpen(true);
                    closeMobileSidebar();
                  }}
                >
                  <Search className="size-4 shrink-0" aria-hidden />
                  <span>Search</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  tooltip="Settings"
                  onClick={() => {
                    window.location.href = '/settings';
                  }}
                >
                  <Settings className="size-4 shrink-0" aria-hidden />
                  <span>Settings</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        {/* One quiet control strip: profile (settings lives in its popout),
            account scope, and theme. Collapses to a vertical stack. */}
        <div className="flex items-center gap-0.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-1 shadow-[var(--shadow-soft)] group-data-[collapsible=icon]:flex-col group-data-[collapsible=icon]:gap-1 group-data-[collapsible=icon]:border-[var(--color-transparent)] group-data-[collapsible=icon]:bg-[var(--color-transparent)] group-data-[collapsible=icon]:p-0 group-data-[collapsible=icon]:shadow-none">
          <div className="grid h-7 w-7 place-items-center group-data-[collapsible=icon]:size-8">
            {clerkEnabled ? (
              <UserButton appearance={{ elements: { avatarBox: 'size-6' } }}>
                <UserButton.MenuItems>
                  <UserButton.Link label="Settings" href="/settings" labelIcon={<SettingsIcon size={14} />} />
                </UserButton.MenuItems>
              </UserButton>
            ) : (
              <div
                className="grid size-6 place-items-center rounded-full bg-[var(--color-avatar-bg)] text-[var(--color-text-muted)] shadow-[var(--shadow-control)]"
                title="Local preview"
              >
                <UserIcon size={13} />
              </div>
            )}
          </div>
          <div className="mx-0.5 h-4 w-px bg-[var(--color-border)] group-data-[collapsible=icon]:hidden" />
          <AccountScopePopover
            accounts={authedAccounts}
            accountFilter={accountFilter}
            setAccountFilter={setAccountFilter}
            indexingCount={indexingAccounts.length}
          />
          <div className="ml-auto group-data-[collapsible=icon]:ml-0">
            <NotificationCenter />
          </div>
          <div>
            <ThemePanel className="group-data-[collapsible=icon]:size-8" />
          </div>
        </div>
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

function AccountScopePopover({
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
          className="relative grid h-7 w-7 place-items-center rounded-md text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg-subtle)] hover:text-[var(--color-text)] group-data-[collapsible=icon]:size-8"
        >
          <RowIcon icon={UsersIcon} size={15} />
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
      <DropdownMenuContent align="start" side="top" className="w-64">
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
