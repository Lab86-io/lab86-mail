'use client';

import { UserButton } from '@clerk/nextjs';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  Brain,
  CalendarDays,
  Check,
  CreditCard,
  GitBranch,
  Hash,
  KeyRound,
  Loader2,
  MoreHorizontal,
  Pencil,
  Plug,
  Plus,
  RefreshCw,
  ShieldCheck,
  SquareKanban,
  Trash2,
} from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';
import {
  type ModelOption,
  normalizeOpenRouterFastModel,
  normalizeOpenRouterPrimaryModel,
  OPENROUTER_FAST_MODEL_OPTIONS,
  OPENROUTER_PRIMARY_MODEL_OPTIONS,
  type Provider,
  setProviderForByok,
} from '@/components/hosted/ai-options';
import { ProviderLogo, providerDisplayName } from '@/components/icons/provider-logos';
import { Ring } from '@/components/loading-ui/ring';
import { SHORTCUTS } from '@/components/shell/ShortcutsSheet';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DotGridGlow } from '@/components/ui/dot-grid-glow';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { DEFAULT_UNDO_SEND_SECONDS, UNDO_SEND_CHOICES } from '@/lib/shared/sending';

export default function SettingsPage() {
  return (
    <main className="app-paper relative min-h-dvh text-[var(--color-text)]">
      <DotGridGlow />
      <div className="relative z-10 mx-auto max-w-3xl px-5 py-8 sm:py-12">
        <header className="mb-8">
          <Link
            href="/"
            className="mb-5 inline-flex items-center gap-1.5 text-[12.5px] text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text)]"
          >
            <ArrowLeft className="size-3.5" />
            Back to inbox
          </Link>
          <h1 className="text-[26px] font-semibold tracking-tight">Settings</h1>
          <p className="mt-1 text-[13.5px] text-[var(--color-text-muted)]">
            Your mailboxes, your models, your rules.
          </p>
        </header>
        <div className="space-y-10">
          <MailboxesSection />
          <ConnectionsSection />
          <SendingSection />
          <AiSection />
          <ShortcutsSection />
          <AccountSection />
        </div>
      </div>
    </main>
  );
}

function SectionHeading({ title, blurb }: { title: string; blurb: string }) {
  return (
    <div className="mb-4">
      <h2 className="text-[16px] font-semibold tracking-tight">{title}</h2>
      <p className="mt-0.5 text-[12.5px] text-[var(--color-text-muted)]">{blurb}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Keyboard shortcuts (moved here from the rail's footer sheet)
// ---------------------------------------------------------------------------

function ShortcutsSection() {
  return (
    <section>
      <SectionHeading title="Keyboard shortcuts" blurb="Everything is reachable without the mouse." />
      <div className="grid grid-cols-1 gap-x-10 gap-y-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-4 text-[13px] shadow-[var(--shadow-soft)] sm:grid-cols-2">
        {SHORTCUTS.map(([keys, label]) => (
          <div key={label} className="flex items-center justify-between gap-3 py-0.5">
            <span className="text-[var(--color-text-muted)]">{label}</span>
            <span className="flex shrink-0 items-center gap-1">
              {keys.map((k) => (
                <kbd
                  key={k}
                  className="rounded border border-[var(--color-border)] bg-[var(--color-bg-subtle)] px-1.5 py-0.5 font-mono text-[10.5px] text-[var(--color-text)]"
                >
                  {k}
                </kbd>
              ))}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

function SendingSection() {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['prefs'],
    queryFn: async () => (await fetchJson('/api/prefs')).prefs as { undoSendSeconds: number },
  });
  const undoSendSeconds = data?.undoSendSeconds ?? DEFAULT_UNDO_SEND_SECONDS;

  const save = useMutation({
    mutationFn: async (seconds: number) => postJson('/api/prefs', { undoSendSeconds: seconds }),
    onSuccess: () => {
      toast.success('Saved');
      qc.invalidateQueries({ queryKey: ['prefs'] });
    },
    onError: (err: any) => toast.error(err?.message || 'Could not save'),
  });

  return (
    <section>
      <SectionHeading title="Sending" blurb="How long a sent email is held so you can change your mind." />
      <div className="flex items-center justify-between rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-4 py-3">
        <div>
          <div className="text-[13px] font-medium">Undo send window</div>
          <div className="text-[12px] text-[var(--color-text-muted)]">
            Sends are held on the server for this long; an Undo toast lets you cancel.
          </div>
        </div>
        <Select value={String(undoSendSeconds)} onValueChange={(value) => save.mutate(Number(value))}>
          <SelectTrigger size="sm" className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="end">
            {UNDO_SEND_CHOICES.map((choice) => (
              <SelectItem key={choice.value} value={String(choice.value)}>
                {choice.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Mailboxes
// ---------------------------------------------------------------------------

interface SyncState {
  accountId: string;
  status: string;
  corpusReady: boolean;
  messagesSynced?: number;
  error?: string;
}

function MailboxesSection() {
  const qc = useQueryClient();
  const { data: nylas } = useQuery({
    queryKey: ['nylas-status'],
    queryFn: async () => fetchJson('/api/nylas/status'),
    refetchInterval: (query) =>
      (query.state.data?.syncStates || []).some(
        (s: SyncState) => !s.corpusReady && s.status !== 'error' && s.status !== 'idle',
      )
        ? 15_000
        : false,
  });

  const disconnect = useMutation({
    mutationFn: async (accountId: string) => postJson('/api/nylas/disconnect', { accountId }),
    onSuccess: () => {
      toast.success('Account disconnected');
      qc.invalidateQueries({ queryKey: ['nylas-status'] });
      qc.invalidateQueries({ queryKey: ['accounts'] });
    },
    onError: (err: any) => toast.error(err?.message || 'Could not disconnect account'),
  });
  const saveAlias = useMutation({
    mutationFn: async ({ accountId, displayName }: { accountId: string; displayName: string }) =>
      patchJson('/api/nylas/account', { accountId, displayName }),
    onSuccess: () => {
      toast.success('Alias saved');
      qc.invalidateQueries({ queryKey: ['nylas-status'] });
      qc.invalidateQueries({ queryKey: ['accounts'] });
    },
    onError: (err: any) => toast.error(err?.message || 'Could not save alias'),
  });
  const resyncMail = useMutation({
    mutationFn: async (accountId: string) => postJson('/api/mail/resync', { accountId }),
    onSuccess: () => {
      toast.success('Re-indexing started — the mailbox stays usable while it rebuilds');
      qc.invalidateQueries({ queryKey: ['nylas-status'] });
    },
    onError: (err: any) => toast.error(err?.message || 'Could not start resync'),
  });
  const resyncCalendar = useMutation({
    mutationFn: async (accountId: string) => postJson('/api/calendar/resync', { accountId }),
    onSuccess: () => toast.success('Calendar resync started'),
    onError: (err: any) => toast.error(err?.message || 'Could not start calendar resync'),
  });

  const accounts: any[] = nylas?.accounts || [];
  const syncByAccount = new Map<string, SyncState>(
    ((nylas?.syncStates || []) as SyncState[]).map((s) => [s.accountId, s]),
  );
  const capabilities = (nylas?.capabilities || []).filter((c: any) => c.visible);
  const icloud = capabilities.find((c: any) => c.provider === 'icloud');

  return (
    <section>
      <SectionHeading
        title="Mailboxes"
        blurb="Every connected account is downloaded into your private search index — that's what makes search instant."
      />
      <div className="space-y-2.5">
        {accounts.map((account) => (
          <MailboxCard
            key={account.accountId}
            account={account}
            sync={syncByAccount.get(account.accountId)}
            onSaveAlias={(displayName) => saveAlias.mutate({ accountId: account.accountId, displayName })}
            onResyncMail={() => resyncMail.mutate(account.accountId)}
            onResyncCalendar={() => resyncCalendar.mutate(account.accountId)}
            onDisconnect={() => {
              if (
                window.confirm(
                  `Disconnect ${account.email}? Its indexed mail is removed from Lab86 as part of disconnect.`,
                )
              ) {
                disconnect.mutate(account.accountId);
              }
            }}
            busy={disconnect.isPending || saveAlias.isPending}
          />
        ))}
        {!accounts.length ? (
          <div className="rounded-xl border border-dashed border-[var(--color-border)] px-4 py-6 text-center text-[13px] text-[var(--color-text-muted)]">
            No mailboxes yet — connect one below and watch the index fill up.
          </div>
        ) : null}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {capabilities.map((capability: any) => (
          <Button
            key={capability.provider}
            variant="outline"
            size="sm"
            asChild={capability.connectable}
            disabled={!capability.connectable}
            className="gap-2"
          >
            {capability.connectable ? (
              <a href={`/api/nylas/connect?provider=${capability.provider}`}>
                <ProviderLogo provider={capability.provider} className="size-3.5" />
                Connect {capability.label}
                <Plus className="size-3 text-[var(--color-text-faint)]" />
              </a>
            ) : (
              <span>
                <ProviderLogo provider={capability.provider} className="size-3.5 opacity-50" />
                {capability.label}
              </span>
            )}
          </Button>
        ))}
      </div>
      {icloud ? (
        <p className="mt-2 text-[11.5px] text-[var(--color-text-muted)]">
          {icloud.connectable
            ? 'iCloud needs an app-specific password — create one at appleid.apple.com, then connect.'
            : icloud.reason}
        </p>
      ) : null}
    </section>
  );
}

function MailboxCard({
  account,
  sync,
  onSaveAlias,
  onResyncMail,
  onResyncCalendar,
  onDisconnect,
  busy,
}: {
  account: any;
  sync?: SyncState;
  onSaveAlias: (displayName: string) => void;
  onResyncMail: () => void;
  onResyncCalendar: () => void;
  onDisconnect: () => void;
  busy: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [alias, setAlias] = useState(account.displayName || '');
  const connected = account.status === 'connected';
  // Re-running OAuth on the same address upserts the existing grant with the
  // connector's current scope list — this is how an account picks up newly
  // added scopes (e.g. calendar) without being removed first.
  const reconnectHref = `/api/nylas/connect?provider=${account.provider}&redirectTo=/settings`;

  return (
    <div className="flex items-center gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-4 py-3 shadow-[var(--shadow-soft)]">
      <div className="grid size-9 shrink-0 place-items-center rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]">
        <ProviderLogo provider={account.provider} className="size-4.5" />
      </div>
      <div className="min-w-0 flex-1">
        {editing ? (
          <form
            className="flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              onSaveAlias(alias);
              setEditing(false);
            }}
          >
            <Input
              value={alias}
              onChange={(event) => setAlias(event.target.value)}
              placeholder="Alias (e.g. Work)"
              className="h-7 w-44 text-[13px]"
              autoFocus
            />
            <Button type="submit" size="sm" variant="outline" className="h-7 px-2">
              <Check className="size-3" />
            </Button>
          </form>
        ) : (
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[13.5px] font-medium">{account.displayName || account.email}</span>
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="grid size-5 place-items-center rounded text-[var(--color-text-faint)] hover:bg-[var(--color-bg-muted)] hover:text-[var(--color-text)]"
              title="Rename mailbox"
            >
              <Pencil className="size-3" />
            </button>
          </div>
        )}
        <div className="truncate text-[11.5px] text-[var(--color-text-muted)]">
          {account.email} · {providerDisplayName(account.provider)}
        </div>
        <SyncStatusLine sync={sync} connected={connected} />
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            disabled={busy}
            className="shrink-0 text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
            title="Account actions"
          >
            <MoreHorizontal className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuItem onSelect={() => onResyncMail()} className="gap-2 text-[12.5px]">
            <RefreshCw className="size-3.5" />
            Re-index mail
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onResyncCalendar()} className="gap-2 text-[12.5px]">
            <CalendarDays className="size-3.5" />
            Resync calendar
          </DropdownMenuItem>
          <DropdownMenuItem asChild className="gap-2 text-[12.5px]">
            <a href={reconnectHref}>
              <KeyRound className="size-3.5" />
              Reconnect / update permissions
            </a>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={() => onDisconnect()}
            className="gap-2 text-[12.5px] text-[var(--color-danger)] focus:text-[var(--color-danger)]"
          >
            <Trash2 className="size-3.5" />
            Remove account & data
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function SyncStatusLine({ sync, connected }: { sync?: SyncState; connected: boolean }) {
  if (!connected) {
    return <div className="mt-1 text-[11px] font-medium text-[var(--color-danger)]">Disconnected</div>;
  }
  if (!sync || sync.status === 'idle') {
    return <div className="mt-1 text-[11px] text-[var(--color-text-faint)]">Waiting for first sync</div>;
  }
  if (sync.status === 'error') {
    return (
      <div className="mt-1 text-[11px] font-medium text-[var(--color-danger)]">
        Sync error — {sync.error || 'will retry automatically'}
      </div>
    );
  }
  const indexed = sync.messagesSynced ? `${sync.messagesSynced.toLocaleString()} messages` : null;
  if (sync.corpusReady) {
    return (
      <div className="mt-1 flex items-center gap-1 text-[11px] text-emerald-600 dark:text-emerald-400">
        <ShieldCheck className="size-3" />
        Indexed{indexed ? ` · ${indexed}` : ''} — instant search ready
      </div>
    );
  }
  return (
    <div className="mt-1 flex items-center gap-1.5 text-[11px] text-[var(--color-accent)]">
      <Loader2 className="size-3 animate-spin" />
      Downloading &amp; indexing{indexed ? ` · ${indexed} so far` : '…'}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Connections (connected tools)
// ---------------------------------------------------------------------------

type McpServer = 'github' | 'jira' | 'slack';

interface McpConnectionRow {
  connectionId: string;
  server: McpServer;
  serverUrl: string;
  status: 'connected' | 'disconnected' | 'error';
  displayName?: string;
  scopes: string[];
  includeInBrief: boolean;
  includeInSearch: boolean;
  lastSyncedAt?: number;
  error?: string;
}

interface McpServerInfo {
  id: McpServer;
  label: string;
  tokenLabel: string;
  tokenHelp: string;
}

function connectionServerIcon(server: string, className: string) {
  if (server === 'github') return <GitBranch className={className} />;
  if (server === 'jira') return <SquareKanban className={className} />;
  if (server === 'slack') return <Hash className={className} />;
  return <Plug className={className} />;
}

function relativeTime(ms: number) {
  const diff = Date.now() - ms;
  if (diff < 60_000) return 'just now';
  const minutes = Math.round(diff / 60_000);
  if (minutes < 60) return `${minutes} min${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

function ConnectionsSection() {
  const qc = useQueryClient();
  const [tokenInputs, setTokenInputs] = useState<Record<string, string>>({});
  const [nameInputs, setNameInputs] = useState<Record<string, string>>({});

  const { data } = useQuery({
    queryKey: ['mcp-status'],
    queryFn: async () => fetchJson('/api/mcp/status'),
  });

  const connect = useMutation({
    mutationFn: async ({
      server,
      token,
      displayName,
    }: {
      server: McpServer;
      token: string;
      displayName?: string;
    }) => postJson('/api/mcp/connect', { server, token, displayName }),
    onSuccess: (_result, variables) => {
      toast.success('Connected');
      setTokenInputs((prev) => ({ ...prev, [variables.server]: '' }));
      setNameInputs((prev) => ({ ...prev, [variables.server]: '' }));
      qc.invalidateQueries({ queryKey: ['mcp-status'] });
    },
    onError: (err: any) => toast.error(err?.message || 'Could not connect'),
  });

  const resync = useMutation({
    mutationFn: async (connectionId: string) => postJson('/api/mcp/resync', { connectionId }),
    onSuccess: () => {
      toast.success('Resync started');
      qc.invalidateQueries({ queryKey: ['mcp-status'] });
    },
    onError: (err: any) => toast.error(err?.message || 'Could not start resync'),
  });

  const disconnect = useMutation({
    mutationFn: async (connectionId: string) => postJson('/api/mcp/disconnect', { connectionId }),
    onSuccess: () => {
      toast.success('Disconnected');
      qc.invalidateQueries({ queryKey: ['mcp-status'] });
    },
    onError: (err: any) => toast.error(err?.message || 'Could not disconnect'),
  });

  const toggle = useMutation({
    mutationFn: async (body: { connectionId: string; includeInBrief?: boolean; includeInSearch?: boolean }) =>
      postJson('/api/mcp/toggle', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['mcp-status'] }),
    onError: (err: any) => toast.error(err?.message || 'Could not update'),
  });

  const connections: McpConnectionRow[] = data?.connections || [];
  const servers: McpServerInfo[] = data?.servers || [];
  const connectedServers = new Set(connections.map((c) => c.server));
  const availableServers = servers.filter((s) => !connectedServers.has(s.id));

  return (
    <section>
      <SectionHeading title="Connections" blurb="Bring GitHub, Jira, and Slack into your brief and search." />
      <div className="space-y-2.5">
        {connections.map((connection) => (
          <div
            key={connection.connectionId}
            className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-4 py-3 shadow-[var(--shadow-soft)]"
          >
            <div className="flex items-center gap-3">
              <div className="grid size-9 shrink-0 place-items-center rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]">
                {connectionServerIcon(connection.server, 'size-4.5')}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-[13.5px] font-medium capitalize">{connection.server}</span>
                  {connection.displayName ? (
                    <span className="truncate text-[12px] text-[var(--color-text-muted)]">
                      · {connection.displayName}
                    </span>
                  ) : null}
                </div>
                {connection.status === 'error' ? (
                  <div className="mt-1 text-[11px] font-medium text-[var(--color-danger)]">
                    Connection error — {connection.error || 'will retry automatically'}
                  </div>
                ) : connection.status === 'connected' ? (
                  <div className="mt-1 flex items-center gap-1 text-[11px] text-emerald-600 dark:text-emerald-400">
                    <ShieldCheck className="size-3" />
                    Connected
                    {connection.lastSyncedAt ? ` · synced ${relativeTime(connection.lastSyncedAt)}` : ''}
                  </div>
                ) : (
                  <div className="mt-1 text-[11px] font-medium text-[var(--color-danger)]">Disconnected</div>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => resync.mutate(connection.connectionId)}
                  disabled={resync.isPending}
                  className="text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                >
                  <RefreshCw className="size-3.5" />
                  Resync
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    if (window.confirm(`Disconnect ${connection.displayName || connection.server}?`)) {
                      disconnect.mutate(connection.connectionId);
                    }
                  }}
                  disabled={disconnect.isPending}
                  className="text-[var(--color-danger)] hover:text-[var(--color-danger)]"
                >
                  <Trash2 className="size-3.5" />
                  Disconnect
                </Button>
              </div>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-[var(--color-border)] pt-3">
              <div className="flex items-center gap-2 text-[12.5px] text-[var(--color-text-muted)]">
                <Switch
                  id={`brief-${connection.connectionId}`}
                  checked={connection.includeInBrief}
                  onCheckedChange={(checked) =>
                    toggle.mutate({ connectionId: connection.connectionId, includeInBrief: checked })
                  }
                />
                <Label
                  htmlFor={`brief-${connection.connectionId}`}
                  className="text-[12.5px] font-normal text-[var(--color-text-muted)]"
                >
                  In daily brief
                </Label>
              </div>
              <div className="flex items-center gap-2 text-[12.5px] text-[var(--color-text-muted)]">
                <Switch
                  id={`search-${connection.connectionId}`}
                  checked={connection.includeInSearch}
                  onCheckedChange={(checked) =>
                    toggle.mutate({ connectionId: connection.connectionId, includeInSearch: checked })
                  }
                />
                <Label
                  htmlFor={`search-${connection.connectionId}`}
                  className="text-[12.5px] font-normal text-[var(--color-text-muted)]"
                >
                  In search
                </Label>
              </div>
            </div>
          </div>
        ))}
      </div>

      {availableServers.length ? (
        <div className="mt-4 space-y-2.5">
          {availableServers.map((server) => {
            const token = tokenInputs[server.id] || '';
            return (
              <form
                key={server.id}
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!token.trim()) return;
                  connect.mutate({
                    server: server.id,
                    token: token.trim(),
                    displayName: nameInputs[server.id]?.trim() || undefined,
                  });
                }}
                className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-4 py-3 shadow-[var(--shadow-soft)]"
              >
                <div className="flex items-center gap-2">
                  <div className="grid size-7 shrink-0 place-items-center rounded-md border border-[var(--color-border)] bg-[var(--color-bg)]">
                    {connectionServerIcon(server.id, 'size-3.5')}
                  </div>
                  <span className="text-[13.5px] font-medium">{server.label}</span>
                </div>
                <div className="mt-2.5 grid gap-2 sm:grid-cols-2">
                  <div className="space-y-1">
                    <Label className="text-[12px]">{server.tokenLabel}</Label>
                    <Input
                      value={token}
                      onChange={(event) =>
                        setTokenInputs((prev) => ({ ...prev, [server.id]: event.target.value }))
                      }
                      placeholder={server.tokenLabel}
                      type="password"
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-[12px]">Display name (optional)</Label>
                    <Input
                      value={nameInputs[server.id] || ''}
                      onChange={(event) =>
                        setNameInputs((prev) => ({ ...prev, [server.id]: event.target.value }))
                      }
                      placeholder="e.g. Work"
                    />
                  </div>
                </div>
                <p className="mt-1.5 text-[11px] text-[var(--color-text-muted)]">{server.tokenHelp}</p>
                <div className="mt-2.5">
                  <Button type="submit" size="sm" disabled={!token.trim() || connect.isPending}>
                    {connect.isPending ? <Ring className="size-3" /> : <Plus className="size-3.5" />}
                    Connect
                  </Button>
                </div>
              </form>
            );
          })}
        </div>
      ) : null}

      {!connections.length && !availableServers.length ? (
        <div className="rounded-xl border border-dashed border-[var(--color-border)] px-4 py-6 text-center text-[13px] text-[var(--color-text-muted)]">
          No connected tools available yet.
        </div>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// AI
// ---------------------------------------------------------------------------

function AiSection() {
  const qc = useQueryClient();
  const [aiMode, setAiMode] = useState<'lab86' | 'byok'>('byok');
  const [provider, setProvider] = useState<Provider>('openrouter');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');
  const [fastModel, setFastModel] = useState('');

  const { data: ai } = useQuery({
    queryKey: ['ai-settings'],
    queryFn: async () => {
      const data = await fetchJson('/api/ai/settings');
      const requireOpenRouter = Boolean(data.requiresUserOpenRouterKey);
      const nextMode = requireOpenRouter ? 'byok' : data.settings?.mode || 'lab86';
      const computedProvider = (
        nextMode === 'lab86' ? 'openrouter' : data.settings?.provider || data.key?.provider || 'openrouter'
      ) as Provider;
      setAiMode(nextMode);
      setProvider(computedProvider);
      setModel(
        computedProvider === 'openrouter'
          ? normalizeOpenRouterPrimaryModel(data.settings?.model)
          : data.settings?.model || '',
      );
      setFastModel(
        computedProvider === 'openrouter'
          ? normalizeOpenRouterFastModel(data.settings?.fastModel)
          : data.settings?.fastModel || '',
      );
      return data;
    },
  });
  // Saving before the server settings hydrate would persist these defaults
  // over the user's real configuration — gate every write on first load.
  const aiLoaded = Boolean(ai);

  const saveAi = useMutation({
    mutationFn: async () => {
      return postJson('/api/ai/settings', {
        mode: aiMode,
        provider: aiMode === 'lab86' ? 'openrouter' : provider,
        model:
          aiMode === 'lab86' || provider === 'openrouter'
            ? normalizeOpenRouterPrimaryModel(model)
            : undefined,
        fastModel:
          aiMode === 'lab86' || provider === 'openrouter'
            ? normalizeOpenRouterFastModel(fastModel)
            : undefined,
        apiKey: aiMode === 'byok' ? apiKey || undefined : undefined,
      });
    },
    onSuccess: () => {
      setApiKey('');
      toast.success('AI settings saved');
      qc.invalidateQueries({ queryKey: ['ai-settings'] });
    },
    onError: (err: any) => toast.error(err?.message || 'Could not save AI settings'),
  });

  const deleteKey = useMutation({
    // Delete the key that is actually stored, not whatever the selector
    // currently points at.
    mutationFn: async () => {
      const storedProvider = ai?.key?.provider;
      if (!storedProvider) throw new Error('No stored API key to remove.');
      return fetch(`/api/ai/settings?provider=${encodeURIComponent(storedProvider)}`, {
        method: 'DELETE',
      }).then(check);
    },
    onSuccess: () => {
      toast.success('API key removed');
      qc.invalidateQueries({ queryKey: ['ai-settings'] });
    },
    onError: (err: any) => toast.error(err?.message || 'Could not remove key'),
  });

  const checkout = useMutation({
    mutationFn: async () => postJson('/api/billing/checkout', {}),
    onSuccess: (data) => {
      if (data.url) window.location.href = data.url;
    },
    onError: (err: any) => toast.error(err?.message || 'Could not start checkout'),
  });
  const portal = useMutation({
    mutationFn: async () => postJson('/api/billing/portal', {}),
    onSuccess: (data) => {
      if (data.url) window.location.href = data.url;
    },
    onError: (err: any) => toast.error(err?.message || 'Could not open billing portal'),
  });

  const requireOpenRouter = Boolean(ai?.requiresUserOpenRouterKey);
  const subscriptionsDisabled = Boolean(ai?.subscriptionsDisabled);
  const paidPlan = ai?.usage?.paidPlan;
  const pricesPresent =
    typeof paidPlan?.monthlyUsd === 'number' &&
    typeof paidPlan?.annualUsd === 'number' &&
    typeof paidPlan?.byokMonthlyUsd === 'number' &&
    typeof paidPlan?.byokAnnualUsd === 'number';
  const priceLine = pricesPresent
    ? `Pro (hosted AI) is $${paidPlan.monthlyUsd}/mo or $${paidPlan.annualUsd}/yr · bring-your-own-key is $${paidPlan.byokMonthlyUsd}/mo or $${paidPlan.byokAnnualUsd}/yr.`
    : 'Two plans: hosted AI, or bring your own key for less.';
  const primaryOptions = (ai?.modelOptions?.openrouter?.primary ||
    OPENROUTER_PRIMARY_MODEL_OPTIONS) as ModelOption[];
  const fastOptions = (ai?.modelOptions?.openrouter?.fast || OPENROUTER_FAST_MODEL_OPTIONS) as ModelOption[];
  const primaryModelDetail = primaryOptions.find((option) => option.id === model)?.detail;
  const fastModelDetail = fastOptions.find((option) => option.id === fastModel)?.detail;
  const showOpenRouterModels = aiMode === 'lab86' || provider === 'openrouter';

  return (
    <section>
      <SectionHeading
        title="AI"
        blurb="Summaries, triage, drafts, and the daily brief. Use Lab86's hosted models or bring your own key."
      />
      {!aiLoaded ? (
        <div className="flex items-center gap-2 rounded-xl border border-[var(--color-border)] px-4 py-6 text-[13px] text-[var(--color-text-muted)]">
          <Ring className="size-3.5" /> Loading your AI configuration…
        </div>
      ) : (
        <div className="space-y-4">
          <div className="grid gap-2.5 sm:grid-cols-2">
            <ModeCard
              active={aiMode === 'lab86'}
              disabled={requireOpenRouter}
              title="Lab86 AI"
              description="Included with Pro. Curated models, zero setup, budgeted for you."
              icon={<Brain className="size-4" />}
              onClick={() => setAiMode('lab86')}
            />
            <ModeCard
              active={aiMode === 'byok'}
              title="My own API key"
              description="Bring an OpenRouter, OpenAI, or Anthropic key. You pay your provider directly."
              icon={<KeyRound className="size-4" />}
              onClick={() => setAiMode('byok')}
            />
          </div>

          <div className="grid gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-4 shadow-[var(--shadow-soft)] sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Provider</Label>
              {aiMode === 'lab86' ? (
                <Input value="OpenRouter (Lab86 managed)" readOnly />
              ) : (
                <Select
                  value={provider}
                  onValueChange={(value) =>
                    setProviderForByok(value as Provider, setProvider, setModel, setFastModel)
                  }
                  disabled={requireOpenRouter}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="openrouter">OpenRouter</SelectItem>
                    {!requireOpenRouter ? <SelectItem value="openai">OpenAI</SelectItem> : null}
                    {!requireOpenRouter ? <SelectItem value="anthropic">Anthropic</SelectItem> : null}
                  </SelectContent>
                </Select>
              )}
            </div>
            <div className="space-y-1.5">
              <Label>Normal model</Label>
              {showOpenRouterModels ? (
                <Select value={model} onValueChange={setModel}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {primaryOptions.map((option) => (
                      <SelectItem key={option.id} value={option.id}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Input value="Provider default" readOnly />
              )}
              {showOpenRouterModels && primaryModelDetail ? (
                <p className="text-[11px] text-[var(--color-text-muted)]">{primaryModelDetail}</p>
              ) : null}
            </div>
            <div className="space-y-1.5">
              <Label>Fast model</Label>
              {showOpenRouterModels ? (
                <Select value={fastModel} onValueChange={setFastModel}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {fastOptions.map((option) => (
                      <SelectItem key={option.id} value={option.id}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Input value="Provider default" readOnly />
              )}
              {showOpenRouterModels && fastModelDetail ? (
                <p className="text-[11px] text-[var(--color-text-muted)]">{fastModelDetail}</p>
              ) : null}
            </div>
            {aiMode === 'lab86' ? (
              <div className="self-end rounded-md bg-[var(--color-bg-muted)] px-3 py-2 text-[11.5px] text-[var(--color-text-muted)]">
                Lab86 AI runs through OpenRouter. Normal handles deep work; fast uses nano by default.
              </div>
            ) : (
              <div className="space-y-1.5">
                <Label>API key</Label>
                <div className="flex gap-2">
                  <Input
                    value={apiKey}
                    onChange={(event) => setApiKey(event.target.value)}
                    placeholder={ai?.key?.masked || 'Paste key to save or replace'}
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                  />
                  {ai?.key ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => deleteKey.mutate()}
                      disabled={deleteKey.isPending}
                      title={`Remove stored ${ai.key.provider} key`}
                      className="shrink-0 self-center text-[var(--color-text-muted)] hover:text-[var(--color-danger)]"
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  ) : null}
                </div>
              </div>
            )}
            <div className="sm:col-span-2">
              <Button
                type="button"
                onClick={() => saveAi.mutate()}
                disabled={!aiLoaded || saveAi.isPending}
                className="w-full sm:w-auto"
              >
                {saveAi.isPending ? <Ring className="size-3" /> : <Check className="size-3.5" />}
                Save AI settings
              </Button>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-[var(--color-border)] px-4 py-3 text-[12.5px]">
            <span className="text-[var(--color-text-muted)]">
              {subscriptionsDisabled
                ? 'Subscriptions are paused. AI usage requires your OpenRouter key.'
                : ai?.usage?.status === 'reduced_cost'
                  ? 'AI is using reduced-cost routing for the rest of this billing period.'
                  : ai?.usage?.status === 'exhausted'
                    ? 'AI chat is paused for this billing period — core mail automation continues.'
                    : priceLine}
            </span>
            {!subscriptionsDisabled ? (
              <span className="ml-auto flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => checkout.mutate()}
                  disabled={checkout.isPending}
                >
                  <CreditCard className="size-3.5" />
                  Upgrade
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => portal.mutate()}
                  disabled={portal.isPending}
                >
                  Manage
                </Button>
              </span>
            ) : null}
          </div>
        </div>
      )}
    </section>
  );
}

function ModeCard({
  active,
  disabled,
  title,
  description,
  icon,
  onClick,
}: {
  active: boolean;
  disabled?: boolean;
  title: string;
  description: string;
  icon: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`rounded-xl border p-4 text-left transition-all disabled:cursor-not-allowed disabled:opacity-50 ${
        active
          ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)] shadow-[var(--shadow-soft)]'
          : 'border-[var(--color-border)] bg-[var(--color-bg-elevated)] hover:border-[var(--color-text-faint)]'
      }`}
    >
      <div className="flex items-center gap-2">
        <span className={active ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-muted)]'}>
          {icon}
        </span>
        <span className="text-[13.5px] font-semibold">{title}</span>
        {active ? (
          <Badge className="ml-auto bg-[var(--color-accent)] text-[10px] text-[var(--color-accent-foreground)]">
            Active
          </Badge>
        ) : null}
      </div>
      <p className="mt-1.5 text-[12px] leading-relaxed text-[var(--color-text-muted)]">{description}</p>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------

function AccountSection() {
  const qc = useQueryClient();
  const clerkEnabled = Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);

  const deleteAccount = useMutation({
    mutationFn: async () => check(await fetch('/api/account', { method: 'DELETE' })),
    onSuccess: () => {
      toast.success('Account deletion started');
      qc.clear();
      window.location.href = '/';
    },
    onError: (err: any) => toast.error(err?.message || 'Could not delete account'),
  });

  if (!clerkEnabled) return null;
  return (
    <section>
      <SectionHeading title="Account" blurb="Sign-in, sessions, and the big red button." />
      <div className="space-y-2.5">
        <div className="flex items-center justify-between gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-4 py-3 shadow-[var(--shadow-soft)]">
          <span className="text-[12.5px] text-[var(--color-text-muted)]">Signed in with Clerk</span>
          <UserButton />
        </div>
        <div className="flex items-center justify-between gap-3 rounded-xl border border-[var(--color-danger)]/30 px-4 py-3">
          <div className="min-w-0 text-[12px] text-[var(--color-text-muted)]">
            <span className="font-medium text-[var(--color-text)]">Delete everything.</span> Mail grants, the
            search index, AI settings, usage records, and your Lab86 account — gone for good.
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={deleteAccount.isPending}
            onClick={() => {
              const confirmed = window.confirm(
                'Delete your Lab86 Mail account and all Lab86-hosted mail data? This cannot be undone.',
              );
              if (confirmed) deleteAccount.mutate();
            }}
            className="shrink-0 text-[var(--color-danger)]"
          >
            {deleteAccount.isPending ? <Ring className="size-3" /> : <Trash2 className="size-3.5" />}
            Delete
          </Button>
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------

async function fetchJson(url: string) {
  return check(await fetch(url, { cache: 'no-store' }));
}

async function postJson(url: string, body: any) {
  return check(
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

async function patchJson(url: string, body: any) {
  return check(
    await fetch(url, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

async function check(res: Response) {
  const data = await res.json().catch(() => null);
  if (!res.ok || data?.ok === false) throw new Error(data?.error || `Request failed (${res.status})`);
  return data;
}
