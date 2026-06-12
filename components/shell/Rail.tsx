'use client';

import { UserButton } from '@clerk/nextjs';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useQuery_experimental as useConvexQuery } from 'convex/react';
import { SquareKanban, Terminal } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ProviderLogo } from '@/components/icons/provider-logos';
import { Ring } from '@/components/loading-ui/ring';
import { AlarmClockIcon } from '@/components/ui/alarm-clock';
import { ArchiveIcon } from '@/components/ui/archive';
import { Badge } from '@/components/ui/badge';
import { BellIcon } from '@/components/ui/bell';
import { BookmarkIcon } from '@/components/ui/bookmark';
import { CalendarDaysIcon } from '@/components/ui/calendar-days';
import { CreditCardIcon } from '@/components/ui/credit-card';
import { DeleteIcon } from '@/components/ui/delete';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
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
import { FlameIcon } from '@/components/ui/flame';
import { KeyIcon } from '@/components/ui/key';
import { LayersIcon } from '@/components/ui/layers';
import { MailCheckIcon } from '@/components/ui/mail-check';
import { MessageCircleIcon } from '@/components/ui/message-circle';
import { PlusIcon } from '@/components/ui/plus';
import { ReceiptIcon } from '@/components/ui/receipt';
import { RowIcon, rowIcon } from '@/components/ui/row-icon';
import { SendIcon } from '@/components/ui/send';
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
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
  useSidebar,
} from '@/components/ui/sidebar';
import { SquarePenIcon } from '@/components/ui/square-pen';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { UserIcon } from '@/components/ui/user';
import { UsersIcon } from '@/components/ui/users';
import { api } from '@/convex/_generated/api';
import { callTool } from '@/lib/api-client';
import { useClientStore } from '@/lib/client-state';
import { QUICK_SEARCH_QUERIES } from '@/lib/mail/search/constants';
import { ThemePanel } from './ThemePanel';

interface MailboxItem {
  query: string;
  label: string;
  Icon: any;
}

// Animated registry icons (lucide-animated): each carries its own unique
// hover animation, triggered by row hover via the rowIcon adapter.
const MAILBOXES: MailboxItem[] = [
  { query: QUICK_SEARCH_QUERIES.unread, label: 'Unread', Icon: rowIcon(BellIcon) },
  { query: QUICK_SEARCH_QUERIES.starred, label: 'Starred', Icon: rowIcon(BookmarkIcon) },
  { query: QUICK_SEARCH_QUERIES.important, label: 'Important', Icon: rowIcon(FlameIcon) },
  { query: QUICK_SEARCH_QUERIES.attachments, label: 'Attachments', Icon: rowIcon(LayersIcon) },
  { query: QUICK_SEARCH_QUERIES.thisWeek, label: 'This week', Icon: rowIcon(CalendarDaysIcon) },
  { query: QUICK_SEARCH_QUERIES.sent, label: 'Sent', Icon: rowIcon(SendIcon) },
  { query: QUICK_SEARCH_QUERIES.drafts, label: 'Drafts', Icon: rowIcon(SquarePenIcon) },
  { query: QUICK_SEARCH_QUERIES.allMail, label: 'All mail', Icon: rowIcon(ArchiveIcon) },
  { query: 'label:MailOS/Snoozed', label: 'Snoozed', Icon: rowIcon(AlarmClockIcon) },
  { query: QUICK_SEARCH_QUERIES.trash, label: 'Trash', Icon: rowIcon(DeleteIcon) },
];

export const ALL_ACCOUNTS = '__all__';

// Top-level surfaces of the workspace. Mail itself is reached through the
// Smart/Mailboxes groups below (those force primaryView back to 'mail').
const SURFACES: Array<{ view: 'daily_report' | 'calendar' | 'tasks'; label: string; Icon: any }> = [
  { view: 'daily_report', label: 'Daily Report', Icon: rowIcon(FileTextIcon) },
  { view: 'calendar', label: 'Calendar', Icon: rowIcon(CalendarDaysIcon) },
  { view: 'tasks', label: 'Tasks', Icon: SquareKanban },
];

const SMART_CATEGORIES = [
  {
    id: 'main',
    label: 'Main',
    Icon: rowIcon(MailCheckIcon),
    help: 'Personal human conversations, plus only urgent unread automated exceptions.',
  },
  {
    id: 'needs_reply',
    label: 'Needs Reply',
    Icon: rowIcon(MessageCircleIcon),
    help: 'Human conversations likely worth a response.',
  },
  {
    id: 'codes',
    label: 'Codes',
    Icon: rowIcon(KeyIcon),
    help: 'Verification codes, login links, and account security.',
  },
  {
    id: 'orders',
    label: 'Orders',
    Icon: rowIcon(ReceiptIcon),
    help: 'Receipts, shipping, refunds, returns, bookings, and order problems.',
  },
  {
    id: 'finance_admin',
    label: 'Finance/Admin',
    Icon: rowIcon(CreditCardIcon),
    help: 'Billing, legal, contracts, tax, and admin.',
  },
  { id: 'review', label: 'Review', Icon: rowIcon(UserIcon), help: 'Uncertain mail that needs a decision.' },
  {
    id: 'noise',
    label: 'Noise',
    Icon: rowIcon(DeleteIcon),
    help: 'Bulk, subscribed, platform, publisher, rewards, and promo mail.',
  },
];

export function Rail() {
  const account = useClientStore((s) => s.account);
  const setAccount = useClientStore((s) => s.setAccount);
  const accountFilter = useClientStore((s) => s.accountFilter);
  const setAccountFilter = useClientStore((s) => s.setAccountFilter);
  const setPrimaryAccount = useClientStore((s) => s.setPrimaryAccount);
  const primaryView = useClientStore((s) => s.primaryView);
  const setPrimaryView = useClientStore((s) => s.setPrimaryView);
  const query = useClientStore((s) => s.query);
  const setQuery = useClientStore((s) => s.setQuery);
  const smartCategory = useClientStore((s) => s.smartCategory);
  const setSmartCategory = useClientStore((s) => s.setSmartCategory);
  const openComposeNew = useClientStore((s) => s.openComposeNew);
  const { isMobile, setOpenMobile } = useSidebar();
  const queryClient = useQueryClient();
  const [smartSettingsOpen, setSmartSettingsOpen] = useState(false);
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
  // Scope the badge counts to exactly the mailboxes the inbox is showing: a
  // single account when scoped, otherwise the account-filter subset (or all
  // authed mailboxes when the filter is empty). Keeps badges from drifting
  // away from the visible list in the unified view.
  const countAccountIds =
    account && account !== ALL_ACCOUNTS
      ? [account]
      : accountFilter.length
        ? authedAccounts.map((item) => item.accountId).filter((id) => accountFilter.includes(id))
        : undefined;

  // Live unread-per-category badges straight from the indexed corpus — Convex
  // pushes updates as rows change, so the rail never needs manual refresh.
  const liveCounts = useConvexQuery({
    query: (api as any).liveMail.categoryCounts,
    args: { accountIds: countAccountIds },
  });
  const smartCounts =
    liveCounts.status === 'success'
      ? (liveCounts.data?.counts as Record<string, { unread: number; attention: boolean }> | undefined)
      : undefined;
  const { data: smartLabels } = useQuery({
    queryKey: ['smart-labels'],
    queryFn: async () => callTool<{ custom: any[] }>('list_smart_labels', {}),
    staleTime: 60_000,
  });
  const customLabels = (smartLabels?.custom || []).filter((label) => label.sidebarVisible);

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
      className="rail-wash bg-[var(--rail-bg)]"
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
        {/* Title bar: the title only shows when expanded; the trigger centers
            itself when collapsed so it doubles as the expand button. */}
        {/* gap-0 when collapsed: the zero-width title span would otherwise
            still contribute its flex gap and nudge the trigger off the icon
            column's center axis. Gap/padding both ease so the trigger glides
            into place instead of snapping. */}
        <div className="flex items-center justify-between gap-2 overflow-hidden px-1 pt-1 transition-[padding,gap] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:gap-0 group-data-[collapsible=icon]:px-0">
          <span className="max-w-40 whitespace-nowrap font-display text-[16px] font-semibold tracking-tight text-[var(--color-text)] opacity-100 transition-[max-width,opacity,transform] duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] group-data-[collapsible=icon]:max-w-0 group-data-[collapsible=icon]:translate-x-1 group-data-[collapsible=icon]:opacity-0">
            <span className="text-[var(--color-accent)]">Lab86</span> Mail
          </span>
          <SidebarTrigger
            title="Toggle navigation rail"
            className="shrink-0 text-[var(--color-text-muted)] transition-transform duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] hover:bg-[var(--color-bg-muted)] hover:text-[var(--color-text)] group-data-[collapsible=icon]:mx-auto"
          />
        </div>

        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              tooltip="Compose"
              onClick={() => {
                openComposeNew();
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
              <span>Compose</span>
              <span className="ml-auto text-[10px] text-[var(--color-accent-foreground)]/75">c</span>
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
                    isActive={primaryView === view}
                    tooltip={label}
                    onClick={() => {
                      setPrimaryView(view);
                      closeMobileSidebar();
                    }}
                    className="relative overflow-hidden data-[active=true]:bg-[var(--color-accent-soft)] data-[active=true]:text-[var(--color-accent)] data-[active=true]:shadow-[var(--shadow-soft)] dark:data-[active=true]:bg-[var(--color-selected-soft)] dark:data-[active=true]:text-[var(--color-selected)] dark:data-[active=true]:shadow-none"
                  >
                    {primaryView === view ? (
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
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel className="flex items-center gap-1 text-[10px] uppercase tracking-[0.09em]">
            Smart
            <button
              type="button"
              onClick={() => setSmartSettingsOpen(true)}
              className="ml-auto grid size-5 place-items-center rounded text-[var(--color-text-faint)] hover:bg-[var(--color-bg-muted)] hover:text-[var(--color-text)] group-data-[collapsible=icon]:hidden"
              title="Smart label settings"
            >
              <SettingsIcon size={12} />
            </button>
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {SMART_CATEGORIES.map(({ id, label, Icon, help }) => (
                <SidebarMenuItem key={id}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <SidebarMenuButton
                        isActive={primaryView === 'mail' && smartCategory === id}
                        tooltip={label}
                        onClick={() => {
                          setSmartCategory(id);
                          closeMobileSidebar();
                        }}
                        className="relative overflow-hidden data-[active=true]:bg-[var(--color-accent-soft)] data-[active=true]:text-[var(--color-accent)] data-[active=true]:shadow-[var(--shadow-soft)] dark:data-[active=true]:bg-[var(--color-selected-soft)] dark:data-[active=true]:text-[var(--color-selected)] dark:data-[active=true]:shadow-none"
                      >
                        {primaryView === 'mail' && smartCategory === id ? (
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
                        <SmartCountBadge stat={smartCounts?.[id]} />
                      </SidebarMenuButton>
                    </TooltipTrigger>
                    <TooltipContent side="right" className="max-w-[240px] text-[11.5px]">
                      <div className="space-y-1">
                        <div>{help}</div>
                        {smartCounts?.[id]?.unread ? (
                          <div className="text-[10.5px] text-[var(--color-text-faint)]">
                            {smartCounts[id].unread >= 100 ? '99+' : smartCounts[id].unread} unread
                            {smartCounts[id].attention ? ' · needs attention' : ''}
                          </div>
                        ) : null}
                      </div>
                    </TooltipContent>
                  </Tooltip>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
            {customLabels.length ? (
              <>
                <SidebarGroupLabel className="mt-3 text-[10px] uppercase tracking-[0.09em]">
                  Custom
                </SidebarGroupLabel>
                <SidebarMenu>
                  {customLabels.map((label) => {
                    const id = `custom:${label._id}`;
                    return (
                      <SidebarMenuItem key={id}>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <SidebarMenuButton
                              isActive={primaryView === 'mail' && smartCategory === id}
                              tooltip={label.name}
                              onClick={() => {
                                setSmartCategory(id);
                                closeMobileSidebar();
                              }}
                              className="relative overflow-hidden data-[active=true]:bg-[var(--color-accent-soft)] data-[active=true]:text-[var(--color-accent)] data-[active=true]:shadow-[var(--shadow-soft)] dark:data-[active=true]:bg-[var(--color-selected-soft)] dark:data-[active=true]:text-[var(--color-selected)] dark:data-[active=true]:shadow-none"
                            >
                              {primaryView === 'mail' && smartCategory === id ? (
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
                              <Terminal />
                              <span>{label.name}</span>
                              <SmartCountBadge stat={smartCounts?.[id]} />
                            </SidebarMenuButton>
                          </TooltipTrigger>
                          <TooltipContent side="right" className="max-w-[260px] text-[11.5px]">
                            {label.description}
                          </TooltipContent>
                        </Tooltip>
                      </SidebarMenuItem>
                    );
                  })}
                </SidebarMenu>
              </>
            ) : null}
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel className="text-[10px] uppercase tracking-[0.09em]">
            Mail
            <Badge
              variant="outline"
              className="ml-2 px-1.5 py-0 text-[9px] group-data-[collapsible=icon]:hidden"
            >
              Providers
            </Badge>
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {MAILBOXES.map(({ query: q, label, Icon }) => (
                <SidebarMenuItem key={q}>
                  <SidebarMenuButton
                    isActive={primaryView === 'mail' && q === query}
                    tooltip={label}
                    onClick={() => {
                      setQuery(q);
                      closeMobileSidebar();
                    }}
                    className="data-[active=true]:bg-[var(--color-bg-elevated)] data-[active=true]:text-[var(--color-text)] data-[active=true]:shadow-[var(--shadow-soft)] dark:data-[active=true]:bg-[var(--color-selected-soft)] dark:data-[active=true]:text-[var(--color-selected)] dark:data-[active=true]:shadow-none"
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
        {/* One quiet control strip: profile (settings lives in its popout),
            account scope, and theme. Collapses to a vertical stack. */}
        <div className="flex items-center gap-0.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-1 shadow-[var(--shadow-soft)] group-data-[collapsible=icon]:flex-col group-data-[collapsible=icon]:gap-1 group-data-[collapsible=icon]:border-[var(--color-transparent)] group-data-[collapsible=icon]:bg-[var(--color-transparent)] group-data-[collapsible=icon]:p-0 group-data-[collapsible=icon]:shadow-none">
          <div className="grid h-7 w-7 place-items-center">
            <UserButton appearance={{ elements: { avatarBox: 'size-6' } }}>
              <UserButton.MenuItems>
                <UserButton.Link
                  label="Mail settings"
                  href="/settings"
                  labelIcon={<SettingsIcon size={14} />}
                />
              </UserButton.MenuItems>
            </UserButton>
          </div>
          <div className="mx-0.5 h-4 w-px bg-[var(--color-border)] group-data-[collapsible=icon]:hidden" />
          <AccountScopePopover
            accounts={authedAccounts}
            accountFilter={accountFilter}
            setAccountFilter={setAccountFilter}
            indexingCount={indexingAccounts.length}
          />
          <div className="ml-auto group-data-[collapsible=icon]:ml-0">
            <ThemePanel />
          </div>
        </div>
      </SidebarFooter>
      <SmartLabelsSettings
        open={smartSettingsOpen}
        onOpenChange={setSmartSettingsOpen}
        labels={customLabels}
        onChanged={() => {
          queryClient.invalidateQueries({ queryKey: ['smart-labels'] });
        }}
      />
    </Sidebar>
  );
}

// One number: unread. Zero (or still loading) renders nothing — no ghost
// pill, no skeleton. Needs-attention is an ambient dot, not another number.
function SmartCountBadge({ stat }: { stat?: { unread: number; attention: boolean } }) {
  if (!stat?.unread) return null;
  return (
    <SidebarMenuBadge className="gap-1 tabular-nums text-[var(--color-text-muted)] group-data-[collapsible=icon]:hidden">
      {stat.attention ? (
        <span
          role="img"
          aria-label="Needs attention"
          className="size-1.5 rounded-full bg-[var(--color-accent)]"
        />
      ) : null}
      <span>{stat.unread >= 100 ? '99+' : stat.unread}</span>
    </SidebarMenuBadge>
  );
}

function SmartLabelsSettings({
  open,
  onOpenChange,
  labels,
  onChanged,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  labels: any[];
  onChanged: () => void;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [positive, setPositive] = useState('');
  const [negative, setNegative] = useState('');
  const [previewItems, setPreviewItems] = useState<any[]>([]);
  const { data: rulesData } = useQuery({
    queryKey: ['smart-rules', open],
    queryFn: async () =>
      callTool<{ rules: any[]; corrections: any[] }>('list_smart_rules', { correctionLimit: 20 }),
    enabled: open,
  });
  const createLabel = useMutation({
    mutationFn: async () =>
      callTool('create_smart_label', {
        name,
        description,
        positiveExamples: [positive],
        negativeExamples: [negative],
      }),
    onSuccess: () => {
      setName('');
      setDescription('');
      setPositive('');
      setNegative('');
      setPreviewItems([]);
      onChanged();
    },
  });
  const previewLabel = useMutation({
    mutationFn: async () =>
      callTool<{ items: any[] }>('preview_smart_label', {
        name,
        description,
        positiveExamples: [positive],
        negativeExamples: [negative],
        max: 8,
      }),
    onSuccess: (res) => setPreviewItems(res.items || []),
  });
  const toggleLabel = useMutation({
    mutationFn: async ({ id, enabled }: { id: string; enabled: boolean }) =>
      callTool('update_smart_label', { id, enabled }),
    onSuccess: onChanged,
  });
  const disableRule = useMutation({
    mutationFn: async (id: string) => callTool('set_smart_rule_enabled', { id, enabled: false }),
    onSuccess: onChanged,
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[84vh] max-w-2xl overflow-y-auto">
        <DialogTitle>Smart Labels</DialogTitle>
        <div className="space-y-5">
          <section className="space-y-2">
            <h3 className="text-[13px] font-semibold">Create custom label</h3>
            <div className="grid gap-2">
              <label htmlFor="smart-label-name" className="sr-only">
                Name
              </label>
              <input
                id="smart-label-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Name"
                className="h-9 rounded-md border bg-background px-2 text-[13px]"
              />
              <label htmlFor="smart-label-description" className="sr-only">
                Description
              </label>
              <textarea
                id="smart-label-description"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="What should this label match?"
                className="min-h-20 rounded-md border bg-background px-2 py-2 text-[13px]"
              />
              <label htmlFor="smart-label-positive" className="sr-only">
                Positive example
              </label>
              <input
                id="smart-label-positive"
                value={positive}
                onChange={(event) => setPositive(event.target.value)}
                placeholder="Positive example"
                className="h-9 rounded-md border bg-background px-2 text-[13px]"
              />
              <label htmlFor="smart-label-negative" className="sr-only">
                Negative example
              </label>
              <input
                id="smart-label-negative"
                value={negative}
                onChange={(event) => setNegative(event.target.value)}
                placeholder="Negative example"
                className="h-9 rounded-md border bg-background px-2 text-[13px]"
              />
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={previewLabel.isPending || !name || !description || !positive || !negative}
                  onClick={() => previewLabel.mutate()}
                  className="h-9 flex-1 rounded-md border border-[var(--color-border)] px-3 text-[13px] disabled:opacity-50"
                >
                  {previewLabel.isPending ? 'Previewing...' : 'Preview matches'}
                </button>
                <button
                  type="button"
                  disabled={createLabel.isPending || !name || !description || !positive || !negative}
                  onClick={() => createLabel.mutate()}
                  className="h-9 flex-1 rounded-md bg-[var(--color-accent)] px-3 text-[13px] text-[var(--color-accent-foreground)] disabled:opacity-50"
                >
                  {createLabel.isPending ? 'Saving...' : 'Create label'}
                </button>
              </div>
              {previewItems.length ? (
                <div className="space-y-1 rounded-md border border-[var(--color-border)] p-2">
                  <div className="text-[11px] font-medium text-[var(--color-text-muted)]">
                    Preview matches
                  </div>
                  {previewItems.map((item) => (
                    <div key={`${item.account}:${item._id}`} className="text-[12px]">
                      <div className="line-clamp-1 font-medium">{item.subject || '(no subject)'}</div>
                      <div className="line-clamp-1 text-[var(--color-text-muted)]">
                        {item.fromAddress || item.from || item.snippet}
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          </section>

          <section className="space-y-2">
            <h3 className="text-[13px] font-semibold">Custom labels</h3>
            <div className="space-y-2">
              {labels.map((label) => (
                <div key={label._id} className="rounded-md border p-2">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-[13px]">{label.name}</span>
                    <Badge variant="outline">{label.enabled ? 'enabled' : 'disabled'}</Badge>
                    <button
                      type="button"
                      onClick={() => toggleLabel.mutate({ id: label._id, enabled: !label.enabled })}
                      className="ml-auto rounded border px-2 py-1 text-[11px]"
                    >
                      {label.enabled ? 'Disable' : 'Enable'}
                    </button>
                  </div>
                  <p className="mt-1 line-clamp-2 text-[12px] text-[var(--color-text-muted)]">
                    {label.description}
                  </p>
                </div>
              ))}
            </div>
          </section>

          <section className="space-y-2">
            <h3 className="text-[13px] font-semibold">Recent rules</h3>
            <div className="space-y-2">
              {(rulesData?.rules || []).slice(0, 12).map((rule) => (
                <div key={rule._id} className="flex items-center gap-2 rounded-md border p-2 text-[12px]">
                  <span className="font-medium">{rule.name}</span>
                  <span className="text-[var(--color-text-muted)]">
                    {rule.scope}: {rule.match}
                  </span>
                  <button
                    type="button"
                    onClick={() => disableRule.mutate(rule._id)}
                    className="ml-auto rounded border px-2 py-1 text-[11px]"
                  >
                    Disable
                  </button>
                </div>
              ))}
            </div>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}

type AccountSync =
  | {
      status: string;
      corpusReady: boolean;
      messagesSynced?: number;
      error?: string;
    }
  | undefined;

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
          className="relative grid h-7 w-7 place-items-center rounded-md text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg-subtle)] hover:text-[var(--color-text)]"
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
        <DropdownMenuLabel className="text-[11px] uppercase tracking-wide text-[var(--color-text-faint)]">
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
            <span className="min-w-0 flex-1 truncate">{mailbox.displayName || mailbox.email}</span>
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
