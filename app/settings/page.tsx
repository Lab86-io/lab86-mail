'use client';

import { UserButton } from '@clerk/nextjs';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  Check,
  CreditCard,
  KeyRound,
  Loader2,
  Pencil,
  Plus,
  ShieldCheck,
  Sparkles,
  Trash2,
} from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';
import {
  LAB86_MODEL_FAMILIES,
  type Lab86ModelFamily,
  normalizeOpenRouterFastModel,
  normalizeOpenRouterPrimaryModel,
  OPENROUTER_FAST_MODEL_OPTIONS,
  OPENROUTER_PRIMARY_MODEL_OPTIONS,
  type Provider,
  resolveLab86Family,
  setProviderForByok,
} from '@/components/hosted/ai-options';
import { ProviderLogo, providerDisplayName } from '@/components/icons/provider-logos';
import { Ring } from '@/components/loading-ui/ring';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

export default function SettingsPage() {
  return (
    <main className="min-h-dvh bg-[var(--color-bg)] text-[var(--color-text)]">
      <div className="mx-auto max-w-3xl px-5 py-8 sm:py-12">
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
          <AiSection />
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
        ? 5_000
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
  onDisconnect,
  busy,
}: {
  account: any;
  sync?: SyncState;
  onSaveAlias: (displayName: string) => void;
  onDisconnect: () => void;
  busy: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [alias, setAlias] = useState(account.displayName || '');
  const connected = account.status === 'connected';

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
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        onClick={onDisconnect}
        disabled={busy}
        className="shrink-0 text-[var(--color-text-muted)] hover:text-[var(--color-danger)]"
        title="Disconnect mailbox"
      >
        <Trash2 className="size-3.5" />
      </Button>
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
// AI
// ---------------------------------------------------------------------------

function AiSection() {
  const qc = useQueryClient();
  const [aiMode, setAiMode] = useState<'lab86' | 'byok'>('byok');
  const [lab86Family, setLab86Family] = useState<Lab86ModelFamily>('openai');
  const [provider, setProvider] = useState<Provider>('openrouter');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');
  const [fastModel, setFastModel] = useState('');

  const { data: ai } = useQuery({
    queryKey: ['ai-settings'],
    queryFn: async () => {
      const data = await fetchJson('/api/ai/settings');
      const requireOpenRouter = Boolean(data.requiresUserOpenRouterKey);
      const computedProvider = (
        requireOpenRouter ? 'openrouter' : data.settings?.provider || data.key?.provider || 'openrouter'
      ) as Provider;
      setAiMode(requireOpenRouter ? 'byok' : data.settings?.mode || 'lab86');
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
      setLab86Family(resolveLab86Family(data.settings?.model, data.settings?.fastModel));
      return data;
    },
  });
  // Saving before the server settings hydrate would persist these defaults
  // over the user's real configuration — gate every write on first load.
  const aiLoaded = Boolean(ai);

  const saveAi = useMutation({
    mutationFn: async () => {
      const selected = LAB86_MODEL_FAMILIES[lab86Family];
      return postJson('/api/ai/settings', {
        mode: aiMode,
        provider: aiMode === 'lab86' ? 'openrouter' : provider,
        model:
          aiMode === 'lab86'
            ? selected.primary
            : provider === 'openrouter'
              ? normalizeOpenRouterPrimaryModel(model)
              : undefined,
        fastModel:
          aiMode === 'lab86'
            ? selected.fast
            : provider === 'openrouter'
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
  const primaryModelDetail = OPENROUTER_PRIMARY_MODEL_OPTIONS.find((option) => option.id === model)?.detail;
  const fastModelDetail = OPENROUTER_FAST_MODEL_OPTIONS.find((option) => option.id === fastModel)?.detail;

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
              icon={<Sparkles className="size-4" />}
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
              <Label>{aiMode === 'lab86' ? 'Model family' : 'Provider'}</Label>
              <Select
                value={aiMode === 'lab86' ? lab86Family : provider}
                onValueChange={(value) =>
                  aiMode === 'lab86'
                    ? setLab86Family(value as Lab86ModelFamily)
                    : setProviderForByok(value as Provider, setProvider, setModel, setFastModel)
                }
                disabled={requireOpenRouter && aiMode === 'byok'}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {aiMode === 'lab86' ? (
                    <>
                      <SelectItem value="openai">OpenAI</SelectItem>
                      <SelectItem value="claude">Claude</SelectItem>
                    </>
                  ) : (
                    <>
                      <SelectItem value="openrouter">OpenRouter</SelectItem>
                      {!requireOpenRouter ? <SelectItem value="openai">OpenAI</SelectItem> : null}
                      {!requireOpenRouter ? <SelectItem value="anthropic">Anthropic</SelectItem> : null}
                    </>
                  )}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Primary model</Label>
              {aiMode === 'lab86' ? (
                <Input value={LAB86_MODEL_FAMILIES[lab86Family].primary} readOnly />
              ) : provider === 'openrouter' ? (
                <Select value={model} onValueChange={setModel}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {OPENROUTER_PRIMARY_MODEL_OPTIONS.map((option) => (
                      <SelectItem key={option.id} value={option.id}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Input value="Provider default" readOnly />
              )}
              {aiMode === 'byok' && primaryModelDetail ? (
                <p className="text-[11px] text-[var(--color-text-muted)]">{primaryModelDetail}</p>
              ) : null}
            </div>
            <div className="space-y-1.5">
              <Label>Fast model</Label>
              {aiMode === 'lab86' ? (
                <Input value={LAB86_MODEL_FAMILIES[lab86Family].fast} readOnly />
              ) : provider === 'openrouter' ? (
                <Select value={fastModel} onValueChange={setFastModel}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {OPENROUTER_FAST_MODEL_OPTIONS.map((option) => (
                      <SelectItem key={option.id} value={option.id}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Input value="Provider default" readOnly />
              )}
              {aiMode === 'byok' && fastModelDetail ? (
                <p className="text-[11px] text-[var(--color-text-muted)]">{fastModelDetail}</p>
              ) : null}
            </div>
            {aiMode === 'lab86' ? (
              <div className="self-end rounded-md bg-[var(--color-bg-muted)] px-3 py-2 text-[11.5px] text-[var(--color-text-muted)]">
                {LAB86_MODEL_FAMILIES[lab86Family].detail}
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
