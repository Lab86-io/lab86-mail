'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlarmClock,
  Archive,
  Calendar,
  ClipboardList,
  CreditCard,
  Flag,
  Inbox,
  Keyboard,
  Layers,
  MailOpen,
  MessageCircle,
  Pencil,
  Plus,
  Receipt,
  Send,
  Settings2,
  Star,
  Terminal,
  Trash2,
  UserRound,
  WandSparkles,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { Ring } from '@/components/loading-ui/ring';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
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
  SidebarMenuSkeleton,
  SidebarTrigger,
} from '@/components/ui/sidebar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { callTool } from '@/lib/api-client';
import { useClientStore } from '@/lib/client-state';
import { ThemeSwitcher } from './ThemeSwitcher';

interface MailboxItem {
  query: string;
  label: string;
  Icon: any;
}

const MAILBOXES: MailboxItem[] = [
  { query: 'is:unread newer_than:30d', label: 'Unread', Icon: MailOpen },
  { query: 'is:starred newer_than:365d', label: 'Starred', Icon: Star },
  { query: 'is:important newer_than:60d', label: 'Important', Icon: Flag },
  { query: 'has:attachment newer_than:90d', label: 'Attachments', Icon: Layers },
  { query: 'newer_than:7d', label: 'This week', Icon: Calendar },
  { query: 'in:sent newer_than:365d', label: 'Sent', Icon: Send },
  { query: 'in:drafts', label: 'Drafts', Icon: Pencil },
  { query: '-in:trash newer_than:365d', label: 'All mail', Icon: Archive },
  { query: 'label:MailOS/Snoozed', label: 'Snoozed', Icon: AlarmClock },
  { query: 'in:trash newer_than:365d', label: 'Trash', Icon: Trash2 },
];

export const ALL_ACCOUNTS = '__all__';

const SMART_CATEGORIES = [
  {
    id: 'main',
    label: 'Main',
    Icon: Inbox,
    help: 'Personal human conversations, plus only urgent unread automated exceptions.',
  },
  {
    id: 'needs_reply',
    label: 'Needs Reply',
    Icon: MessageCircle,
    help: 'Human conversations likely worth a response.',
  },
  { id: 'waiting', label: 'Waiting', Icon: ClipboardList, help: 'Threads where the next move is waiting.' },
  {
    id: 'codes',
    label: 'Codes',
    Icon: WandSparkles,
    help: 'Verification codes, login links, and account security.',
  },
  {
    id: 'orders',
    label: 'Orders',
    Icon: Receipt,
    help: 'Receipts, shipping, refunds, returns, bookings, and order problems.',
  },
  {
    id: 'finance_admin',
    label: 'Finance/Admin',
    Icon: CreditCard,
    help: 'Billing, legal, contracts, tax, and admin.',
  },
  { id: 'review', label: 'Review', Icon: UserRound, help: 'Uncertain mail that needs a decision.' },
  {
    id: 'noise',
    label: 'Noise',
    Icon: Trash2,
    help: 'Bulk, subscribed, platform, publisher, rewards, and promo mail.',
  },
];

export function Rail() {
  const account = useClientStore((s) => s.account);
  const setAccount = useClientStore((s) => s.setAccount);
  const setPrimaryAccount = useClientStore((s) => s.setPrimaryAccount);
  const query = useClientStore((s) => s.query);
  const setQuery = useClientStore((s) => s.setQuery);
  const smartCategory = useClientStore((s) => s.smartCategory);
  const setSmartCategory = useClientStore((s) => s.setSmartCategory);
  const openComposeNew = useClientStore((s) => s.openComposeNew);
  const setShortcutsOpen = useClientStore((s) => s.setShortcutsOpen);
  const queryClient = useQueryClient();
  const [smartSettingsOpen, setSmartSettingsOpen] = useState(false);

  const { data: accountsData } = useQuery({
    queryKey: ['accounts'],
    queryFn: async () =>
      callTool<{ accounts: { email: string; authed: boolean; primary?: boolean }[] }>('list_accounts'),
  });
  const accounts = accountsData?.accounts || [];
  const authedAccounts = accounts.filter((a) => a.authed);
  const countAccount = account && account !== ALL_ACCOUNTS ? account : authedAccounts[0]?.email || '';

  const { data: smartCounts, isLoading: countsLoading } = useQuery({
    queryKey: ['smart-counts', countAccount],
    queryFn: async () => {
      const labels = await callTool<{ custom: any[] }>('list_smart_labels', {});
      const visibleCustom = (labels.custom || []).filter((label) => label.sidebarVisible);
      const entries = await Promise.all(
        [...SMART_CATEGORIES, ...visibleCustom.map((label) => ({ id: `custom:${label._id}` }))].map(
          async (category) => {
            const result = await callTool<{ items: any[] }>('list_smart_category', {
              account: countAccount,
              category: category.id,
              max: 24,
            }).catch(() => ({ items: [] }));
            return [category.id, result.items.length] as const;
          },
        ),
      );
      return Object.fromEntries(entries) as Record<string, number>;
    },
    enabled: !!countAccount,
    staleTime: 60_000,
  });
  const { data: smartLabels } = useQuery({
    queryKey: ['smart-labels'],
    queryFn: async () => callTool<{ custom: any[] }>('list_smart_labels', {}),
    staleTime: 60_000,
  });
  const customLabels = (smartLabels?.custom || []).filter((label) => label.sidebarVisible);

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
          <SidebarGroupLabel className="flex items-center gap-1">
            Smart
            {countsLoading ? <Ring className="ml-1 size-3 text-[var(--color-accent)]" /> : null}
            <button
              type="button"
              onClick={() => setSmartSettingsOpen(true)}
              className="ml-auto grid size-5 place-items-center rounded text-[var(--color-text-faint)] hover:bg-[var(--color-bg-muted)] hover:text-[var(--color-text)] group-data-[collapsible=icon]:hidden"
              title="Smart label settings"
            >
              <Settings2 className="size-3" />
            </button>
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {SMART_CATEGORIES.map(({ id, label, Icon, help }) => (
                <SidebarMenuItem key={id}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <SidebarMenuButton
                        isActive={smartCategory === id}
                        tooltip={label}
                        onClick={() => setSmartCategory(id)}
                        className="relative overflow-hidden data-[active=true]:bg-[var(--color-bg-elevated)] data-[active=true]:text-[var(--color-text)] data-[active=true]:shadow-[var(--shadow-soft)]"
                      >
                        {smartCategory === id ? (
                          <ShineBorder
                            borderWidth={1}
                            duration={10}
                            shineColor={['#4cb7c8', '#7c3aed', '#0b7285']}
                          />
                        ) : null}
                        <Icon />
                        <span>{label}</span>
                        {countsLoading ? (
                          <SidebarMenuSkeleton
                            showIcon={false}
                            className="ml-auto h-4 w-7 group-data-[collapsible=icon]:hidden"
                          />
                        ) : (
                          <SidebarMenuBadge className="group-data-[collapsible=icon]:hidden">
                            {smartCounts?.[id] ?? 0}
                          </SidebarMenuBadge>
                        )}
                      </SidebarMenuButton>
                    </TooltipTrigger>
                    <TooltipContent side="right" className="max-w-[240px] text-[11.5px]">
                      {help}
                    </TooltipContent>
                  </Tooltip>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
            {customLabels.length ? (
              <>
                <SidebarGroupLabel className="mt-3">Custom</SidebarGroupLabel>
                <SidebarMenu>
                  {customLabels.map((label) => {
                    const id = `custom:${label._id}`;
                    return (
                      <SidebarMenuItem key={id}>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <SidebarMenuButton
                              isActive={smartCategory === id}
                              tooltip={label.name}
                              onClick={() => setSmartCategory(id)}
                              className="relative overflow-hidden data-[active=true]:bg-[var(--color-bg-elevated)] data-[active=true]:text-[var(--color-text)] data-[active=true]:shadow-[var(--shadow-soft)]"
                            >
                              {smartCategory === id ? (
                                <ShineBorder
                                  borderWidth={1}
                                  duration={10}
                                  shineColor={['#4cb7c8', '#7c3aed', '#0b7285']}
                                />
                              ) : null}
                              <Terminal />
                              <span>{label.name}</span>
                              {countsLoading ? (
                                <SidebarMenuSkeleton
                                  showIcon={false}
                                  className="ml-auto h-4 w-7 group-data-[collapsible=icon]:hidden"
                                />
                              ) : (
                                <SidebarMenuBadge className="group-data-[collapsible=icon]:hidden">
                                  {smartCounts?.[id] ?? 0}
                                </SidebarMenuBadge>
                              )}
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
          <SidebarGroupLabel>
            Mail
            <Badge
              variant="outline"
              className="ml-2 px-1.5 py-0 text-[9px] group-data-[collapsible=icon]:hidden"
            >
              Gmail
            </Badge>
          </SidebarGroupLabel>
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
      <SmartLabelsSettings
        open={smartSettingsOpen}
        onOpenChange={setSmartSettingsOpen}
        labels={customLabels}
        onChanged={() => {
          queryClient.invalidateQueries({ queryKey: ['smart-labels'] });
          queryClient.invalidateQueries({ queryKey: ['smart-counts'] });
        }}
      />
    </Sidebar>
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
      onChanged();
    },
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
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Name"
                className="h-9 rounded-md border bg-background px-2 text-[13px]"
              />
              <textarea
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="What should this label match?"
                className="min-h-20 rounded-md border bg-background px-2 py-2 text-[13px]"
              />
              <input
                value={positive}
                onChange={(event) => setPositive(event.target.value)}
                placeholder="Positive example"
                className="h-9 rounded-md border bg-background px-2 text-[13px]"
              />
              <input
                value={negative}
                onChange={(event) => setNegative(event.target.value)}
                placeholder="Negative example"
                className="h-9 rounded-md border bg-background px-2 text-[13px]"
              />
              <button
                type="button"
                disabled={createLabel.isPending || !name || !description || !positive || !negative}
                onClick={() => createLabel.mutate()}
                className="h-9 rounded-md bg-[var(--color-accent)] px-3 text-[13px] text-[var(--color-accent-foreground)] disabled:opacity-50"
              >
                {createLabel.isPending ? 'Saving...' : 'Create label'}
              </button>
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
